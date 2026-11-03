import {
  BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional, type OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { builderProfiles, paperOrders } from '../../database/schema';
import { councilMessages, councilReports, councilSessions } from '../../database/council.schema';
import { llmBudgetUsage } from '../../database/llm-budget.schema';
import { LlmService } from '../multi-agent/llm.service';
import { EvidenceService } from '../multi-agent/evidence.service';
import { PortfolioContextService } from '../multi-agent/portfolio-context.service';
import { MultiAgentService } from '../multi-agent/multi-agent.service';
import { safeAnalysisError } from '../multi-agent/analysis-report';
import { normalizeBuilderConfig, normalizeCouncil } from '../paper-trading/agent-builder.rules';
import type { BuilderConfig, BuilderProfile } from '@shared/api.interface';
import type {
  CouncilCandidate, CouncilMember, CouncilReport, CouncilReviewResult, CouncilSession, CreateCouncilSession, ResearchAcquisition,
} from '@shared/council.interface';
import {
  cacheKey, criticalEvidenceGaps, DEFAULT_MEMBERS, eligibleApproval,
  isRuleCandidate, normalizeCandidate, normalizeTicker,
  type CouncilEvidence, type CouncilOpinion,
} from './council.rules';
import { discussionPrompt, evidenceKind, newCheckpoint, parseContribution, type DiscussionContribution } from './council.dialogue';
import type { DialogueTurn } from './council.types';
import { packDiscussionContext } from './council.context';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { LocalAgentError } from '../local-agents/local-agents.types';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { agentAssignment, agentContribution, agentErrorMessage } from './council.native';
import type { ResearchEvent } from '../../../shared/research-events.interface';
import { publicText } from '../local-agents/research-journal';

type SessionRow = typeof councilSessions.$inferSelect;
type ReportRow = typeof councilReports.$inferSelect;
interface ResearchSnapshot { evidence: CouncilEvidence[]; sourceRunId: string | null }
interface MemberOutput { member: CouncilMember; contribution: DiscussionContribution; tokens: number; replyToMessageId: string | null;
  externalUsageUnknown?: boolean; sources?: CouncilEvidence[]; taskId?: string }

@Injectable()
export class CouncilService implements OnModuleInit {
  private readonly logger = new Logger(CouncilService.name);
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly candidateJobs = new Map<string, Promise<CouncilReviewResult>>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly llm: LlmService,
    private readonly evidence: EvidenceService,
    private readonly portfolio: PortfolioContextService,
    private readonly research: MultiAgentService,
    @Optional() private readonly localAgents?: LocalAgentsService,
    @Optional() private readonly budgets?: LlmBudgetService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Recovery changes lifecycle only. It never resumes model calls or touches order execution.
    await this.db.update(councilSessions).set({ status: 'paused', revision: sql`${councilSessions.revision} + 1`,
      checkpoint: sql`${councilSessions.checkpoint} - 'inflight'`,
      error: 'Server restarted. Resume this discussion explicitly.', updatedAt: new Date() })
      .where(eq(councilSessions.status, 'running'));
  }

  async listSessions(userId: string): Promise<CouncilSession[]> {
    const rows = await this.db.select().from(councilSessions).where(eq(councilSessions.owner, userId))
      .orderBy(desc(councilSessions.updatedAt)).limit(50);
    return Promise.all(rows.map((row) => this.hydrate(userId, row)));
  }

  async createSession(userId: string, input: CreateCouncilSession): Promise<CouncilSession> {
    if (!input || typeof input !== 'object') throw new BadRequestException('Council input is required');
    const ticker = this.validateTicker(input.ticker);
    if (input.language !== undefined && input.language !== 'en' && input.language !== 'zh-CN') {
      throw new BadRequestException('Language must be zh-CN or en');
    }
    const source = input.profileId === undefined ? null : await this.getProfile(userId, input.profileId);
    let team: ReturnType<typeof normalizeCouncil>;
    try {
      team = normalizeCouncil({ enabled: true, members: input.members ?? source?.config.council?.members ?? DEFAULT_MEMBERS,
        webResearch: input.webResearch ?? source?.config.council?.webResearch ?? false });
    } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid research team'); }
    await this.validateMembers(userId, team.members);
    const config = source ? { ...source.config, council: team } : normalizeBuilderConfig({
      name: 'Research room', template: 'guard', tickers: [ticker], minimumRating: 'Buy', customPrompt: '',
      maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false,
      priceRules: [], language: input.language ?? 'zh-CN', council: team,
    });
    const profile = { id: source?.id ?? null, version: source?.version ?? 1, config };
    const row = await this.insertSession(userId, profile, ticker, input.language ?? 'zh-CN');
    return this.hydrate(userId, row);
  }

  async getSession(userId: string, id: string): Promise<CouncilSession> {
    return this.hydrate(userId, await this.requireSession(userId, id));
  }

  async addMessage(userId: string, id: string, content: unknown): Promise<CouncilSession> {
    this.assertId(id);
    if (typeof content !== 'string' || !content.trim() || content.trim().length > 2000) {
      throw new BadRequestException('Message must contain 1–2000 characters');
    }
    await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id))).for('update');
      if (!current) throw new NotFoundException('Council session not found');
      const [counts] = await tx.select({ count: sql<number>`count(*)` }).from(councilMessages)
        .where(and(eq(councilMessages.owner, userId), eq(councilMessages.sessionId, id), eq(councilMessages.role, 'user')));
      if (Number(counts?.count) >= 30) throw new BadRequestException('This discussion has reached 30 user messages');
      const revision = current.revision + 1;
      await tx.insert(councilMessages).values({ owner: userId, sessionId: id, role: 'user', memberName: 'You',
        content: content.trim(), revision, tokensUsed: 0 });
      const held = current.status === 'failed' || current.status === 'paused';
      await tx.update(councilSessions).set({ revision, updatedAt: new Date(), error: held ? current.error : null,
        status: current.status === 'running' || held ? current.status : 'idle' })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id)));
    });
    return this.getSession(userId, id);
  }

  async pauseSession(userId: string, id: string): Promise<CouncilSession> {
    this.assertId(id);
    const [row] = await this.db.update(councilSessions).set({ status: 'paused',
      revision: sql`${councilSessions.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id))).returning();
    if (!row) throw new NotFoundException('Council session not found');
    return this.hydrate(userId, row);
  }

  async runSession(userId: string, id: string): Promise<CouncilSession> {
    this.assertId(id);
    const previous = await this.requireSession(userId, id);
    if (previous.status === 'running') return this.hydrate(userId, previous);
    const members = this.members(previous.profileSnapshot);
    await this.validateMembers(userId, members);
    if (members.some((member) => member.connectionId || member.executionMode === 'local')) {
      const configured = await Promise.all(members.map((member) => member.executionMode === 'local' ? true : this.llm.isConfigured(userId, member.connectionId)));
      if (configured.some((value) => !value)) throw new BadRequestException('Configure a model connection for every team member before starting');
    }
    const { row, started } = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id))).for('update');
      if (!current) throw new NotFoundException('Council session not found');
      if (current.status === 'running') return { row: current, started: false };
      const resume = current.checkpoint && current.checkpoint.nextTurn < current.checkpoint.turns.length;
      // The task budget is deliberately retained across resumes and user revisions.
      const [started] = await tx.update(councilSessions).set({ status: 'running',
        revision: current.revision + 1, error: null, updatedAt: new Date(),
        checkpoint: resume ? current.checkpoint : newCheckpoint(this.members(current.profileSnapshot)),
        // Explicit follow-ups use current credentials/data, without erasing old reports or budget usage.
        ...(!resume && (!current.candidate || current.revision > 1)
          ? { evidenceSnapshot: [], sourceRunId: null, cacheKey: null } : {}) })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id))).returning();
      return { row: started, started: true };
    });
    if (!started) return this.hydrate(userId, row);
    const active = this.jobs.get(`${userId}:${id}`);
    if (active) {
      // A resume can arrive while a paused provider request is still draining.
      // Enqueue exactly that explicit resume after the old job releases its slot.
      void active.then(async () => {
        const current = await this.requireSession(userId, id);
        if (current.status === 'running') this.launch(userId, id);
      }).catch(() => this.logger.error(`Council session ${id} could not resume`));
    } else this.launch(userId, row.id);
    return this.hydrate(userId, row);
  }

  async reviewCandidate(userId: string, profile: BuilderProfile, input: CouncilCandidate): Promise<CouncilReviewResult> {
    let candidate: CouncilCandidate;
    try { candidate = normalizeCandidate(input); } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid candidate');
    }
    const current = await this.getProfile(userId, profile.id);
    if (current.version !== profile.version) throw new BadRequestException('Agent profile changed before council review');
    const key = `${userId}:${profile.id}:${profile.version}:${candidate.ticker}:${candidate.side}`;
    const active = this.candidateJobs.get(key);
    if (active) {
      await active;
      // A concurrent scan must revalidate its own exact candidate against the persisted result.
    }
    const work = this.reviewCandidateOnce(userId, current, candidate);
    this.candidateJobs.set(key, work);
    try { return await work; } finally {
      if (this.candidateJobs.get(key) === work) this.candidateJobs.delete(key);
    }
  }

  async attachPaperOrder(userId: string, reportId: string, orderId: string): Promise<void> {
    this.assertId(reportId);
    this.assertId(orderId);
    const [report] = await this.db.select().from(councilReports)
      .where(and(eq(councilReports.owner, userId), eq(councilReports.id, reportId)));
    if (!report) throw new NotFoundException('Council report not found');
    await this.db.transaction(async (tx) => {
      const [session] = await tx.select().from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, report.sessionId))).for('update');
      const [order] = await tx.select().from(paperOrders)
        .where(and(eq(paperOrders.owner, userId), eq(paperOrders.id, orderId)));
      if (!session || !order) throw new NotFoundException('Council session or paper order not found');
      if (report.decision !== 'approve' || report.revision !== session.revision || session.status !== 'completed'
        || !report.candidate || report.candidate.ticker !== order.ticker || report.candidate.side !== order.side
        || report.candidate.quantity !== Number(order.quantity)) {
        throw new BadRequestException('Paper order does not match a current council approval');
      }
      const [linked] = await tx.update(councilReports).set({ paperOrderId: orderId })
        .where(and(eq(councilReports.owner, userId), eq(councilReports.id, reportId),
          sql`(${councilReports.paperOrderId} IS NULL OR ${councilReports.paperOrderId} = ${orderId})`)).returning();
      if (!linked) throw new BadRequestException('Council approval was already used');
    });
  }

  private async reviewCandidateOnce(userId: string, profile: BuilderProfile, candidate: CouncilCandidate): Promise<CouncilReviewResult> {
    const snapshot = await this.collectSnapshot(userId, candidate.ticker, profile.config.language ?? 'zh-CN', profile.config, candidate);
    const key = cacheKey(userId, profile.id, profile.version, candidate, snapshot.evidence, snapshot.sourceRunId);
    const rows = await this.db.select().from(councilSessions).where(and(eq(councilSessions.owner, userId),
      eq(councilSessions.cacheKey, key), gte(councilSessions.createdAt, new Date(Date.now() - 24 * 3600_000))))
      .orderBy(desc(councilSessions.createdAt)).limit(8);
    const modelConfigured = (await Promise.all(this.members(profile.config)
      .map((member) => member.executionMode === 'local' ? true : this.llm.isConfigured(userId, member.connectionId)))).every(Boolean);
    for (const row of rows) {
      const session = await this.hydrate(userId, row);
      const report = session.reports.at(-1);
      if (!report || report.revision !== session.revision || !['completed', 'failed'].includes(session.status)) continue;
      // Configuring a previously absent model is actionable new information.
      if (report.engine === 'basic' && modelConfigured) continue;
      if (report.decision !== 'approve') return this.reviewResult(row, report, candidate);
      if (Date.now() - Date.parse(report.createdAt) <= 30 * 60_000
        && this.reviewResult(row, report, candidate).approved) return this.reviewResult(row, report, candidate);
    }
    const row = await this.insertSession(userId, profile, candidate.ticker, profile.config.language ?? 'zh-CN', candidate, snapshot, key);
    await this.runSession(userId, row.id);
    await this.jobs.get(`${userId}:${row.id}`);
    const latest = await this.requireSession(userId, row.id);
    const session = await this.hydrate(userId, latest);
    return this.reviewResult(latest, session.reports.at(-1) ?? null, candidate);
  }

  private reviewResult(row: SessionRow, report: CouncilReport | null, candidate: CouncilCandidate): CouncilReviewResult {
    const approved = Boolean(report && eligibleApproval({ status: row.status, revision: row.revision,
      reportRevision: report.revision, decision: report.decision, candidate, reviewedCandidate: report.candidate,
      hasCriticalGaps: criticalEvidenceGaps(row.evidenceSnapshot), ruleOnly: isRuleCandidate(row.profileSnapshot, candidate),
      paperOrderId: report.paperOrderId }));
    return { approved, reason: report?.summary ?? 'Council review is paused or incomplete',
      sessionId: row.id, reportId: report?.id ?? null };
  }

  private launch(userId: string, id: string): void {
    const key = `${userId}:${id}`;
    if (this.jobs.has(key)) return;
    const job = this.execute(userId, id).catch(async () => {
      this.logger.error(`Council session ${id} could not finish`);
      await this.db.update(councilSessions).set({ status: 'failed', error: 'Council could not finish. Please retry.', updatedAt: new Date() })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id), eq(councilSessions.status, 'running')));
    }).finally(() => { this.jobs.delete(key); });
    this.jobs.set(key, job);
    // The catch above persists a safe terminal status. Avoid an unhandled rejection if storage is down too.
    void job.catch(() => this.logger.error(`Council session ${id} storage unavailable`));
  }

  private async execute(userId: string, id: string): Promise<void> {
    // A fixed turn plan, plus bounded retries of a superseded summary. No whole-round replay.
    for (let attempt = 0; attempt < 12; attempt++) {
      let row = await this.requireSession(userId, id);
      if (row.status !== 'running' || !row.checkpoint) return;
      if (row.checkpoint.inflight) return; // Another draining process owns this paid turn.
      if (!row.evidenceSnapshot.length && this.members(row.profileSnapshot).some((member) => member.executionMode !== 'local')) {
        const cycleId = row.checkpoint.cycleId;
        const snapshot = await this.collectSnapshot(userId, row.ticker, row.language, row.profileSnapshot, row.candidate, true, row);
        await this.db.update(councilSessions).set({ evidenceSnapshot: snapshot.evidence, sourceRunId: snapshot.sourceRunId })
          .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id), eq(councilSessions.status, 'running'),
            sql`${councilSessions.checkpoint}->>'cycleId' = ${cycleId}`));
        row = await this.requireSession(userId, id);
        if (row.status !== 'running' || !row.checkpoint) return;
      }
      if (row.checkpoint.pendingResearch.length) {
        await this.runResearch(userId, row);
        row = await this.requireSession(userId, id);
        if (row.status !== 'running' || !row.checkpoint) return;
      }
      const checkpoint = row.checkpoint;
      const turn = checkpoint.turns[checkpoint.nextTurn];
      if (!turn) return;
      let claimId: string | null = null;
      try {
        const members = this.members(row.profileSnapshot);
        if (!members.some((member) => member.connectionId || member.executionMode === 'local') && !(await this.llm.isConfigured(userId))) {
          await this.publish(userId, row, { decision: 'wait', summary: row.language === 'en'
            ? 'Basic mode: no model is configured. No AI discussion occurred. Configure a model to discuss the verified sources.'
            : '基础模式：尚未配置模型，未进行 AI 讨论。配置模型后可共同讨论已核实资料。',
          dissent: [], nextReviewCondition: row.language === 'en' ? 'Configure a model connection.' : '请配置模型连接。', evidenceIds: [] }, 'basic', null);
          return;
        }
        const member = members.find((item) => item.id === turn.memberId);
        if (!member) throw new Error('Research team member is unavailable');
        claimId = await this.claimTurn(userId, row);
        if (!claimId) {
          const latest = await this.requireSession(userId, id);
          if (latest.status !== 'running' || latest.checkpoint?.inflight) return;
          continue;
        }
        const output = await this.runMember(userId, row, member, turn);
        const recorded = await this.recordTurn(userId, row, turn, claimId, output);
        claimId = null;
        if (!recorded) continue;
        if (output.sources?.length) row = { ...row, evidenceSnapshot: [...row.evidenceSnapshot, ...output.sources].slice(-60) };
        if (turn.phase === 'summary' && output.contribution.opinion) {
          const opinion = output.contribution.opinion;
          if (row.candidate && opinion.decision === 'approve' && criticalEvidenceGaps(row.evidenceSnapshot)
            && !isRuleCandidate(row.profileSnapshot, row.candidate)) {
            opinion.decision = 'wait';
            opinion.summary = (row.language === 'en' ? 'Critical research evidence is missing; approval is withheld. ' : '关键研究证据缺失，暂缓批准。') + opinion.summary;
            opinion.nextReviewCondition = row.language === 'en' ? 'Obtain verified financial statements and current market evidence.' : '补齐经核实的财务报表和当前市场证据。';
          }
          await this.publish(userId, row, opinion, this.executionEngine(members), null, row.candidate ? null : output.contribution.researchStance);
        }
      } catch (error) {
        if (claimId) await this.releaseTurn(userId, id, claimId);
        const current = await this.requireSession(userId, id);
        const code = error instanceof Error ? error.message : '';
        if (code.startsWith('LOCAL_')) {
          await this.db.transaction(async (tx) => {
            const [locked] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id))).for('update');
            if (!locked?.checkpoint) return;
            const remote = locked.checkpoint.remote;
            await tx.update(councilSessions).set({ status: 'paused', error: agentErrorMessage(code, row.language), updatedAt: new Date(),
              checkpoint: { ...locked.checkpoint, inflight: undefined,
                remote: code === 'LOCAL_CANCELLED' ? undefined : remote ? { ...remote, awaitingInput: code === 'LOCAL_INPUT_REQUIRED' || remote.awaitingInput } : undefined } })
              .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id)));
          });
          return;
        }
        if (current.status !== 'running') return;
        if (current.revision !== row.revision) continue;
        const reason = safeAnalysisError(error, row.language);
        await this.publish(userId, row, { decision: 'wait', summary: reason, dissent: [],
          nextReviewCondition: row.language === 'en' ? 'Resolve the reported issue and continue from this turn; the same task budget applies.'
            : '解决提示的问题后从当前发言继续；仍使用本次讨论的累计预算。', evidenceIds: [] }, 'llm', reason);
      }
    }
    const row = await this.requireSession(userId, id);
    if (row.status === 'running') {
      await this.db.update(councilSessions).set({ status: 'paused', error: row.language === 'en'
        ? 'Steering changed repeatedly. Resume explicitly; completed turns and the task budget are retained.'
        : '引导内容多次变化，已暂停；继续时保留完成的发言和累计预算。', updatedAt: new Date() })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id), eq(councilSessions.status, 'running')));
    }
  }

  private async claimTurn(userId: string, row: SessionRow): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id))).for('update');
      const checkpoint = current?.checkpoint;
      if (!checkpoint || current.status !== 'running' || current.revision !== row.revision || checkpoint.inflight
        || checkpoint.cycleId !== row.checkpoint?.cycleId || checkpoint.nextTurn !== row.checkpoint.nextTurn) return null;
      const id = randomUUID();
      await tx.update(councilSessions).set({ checkpoint: { ...checkpoint, inflight: { id, turn: checkpoint.nextTurn, revision: row.revision } } })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
      return id;
    });
  }

  private async releaseTurn(userId: string, id: string, claimId: string): Promise<void> {
    await this.db.update(councilSessions).set({ checkpoint: sql`${councilSessions.checkpoint} - 'inflight'` })
      .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id),
        sql`${councilSessions.checkpoint}->'inflight'->>'id' = ${claimId}`));
  }

  private async recordTurn(userId: string, row: SessionRow, turn: DialogueTurn, claimId: string, output: MemberOutput): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id))).for('update');
      const checkpoint = current?.checkpoint;
      if (!checkpoint || checkpoint.inflight?.id !== claimId || checkpoint.cycleId !== row.checkpoint?.cycleId) return false;
      if (output.member.executionMode === 'local' && (current.status !== 'running' || current.revision !== row.revision)) {
        await tx.update(councilSessions).set({ checkpoint: { ...checkpoint, inflight: undefined, remote: undefined } })
          .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
        return false;
      }
      const contribution = output.contribution;
      await tx.insert(councilMessages).values({ owner: userId, sessionId: row.id, role: output.member.role,
        memberName: output.member.name, revision: row.revision, tokensUsed: output.tokens, content: contribution.content,
        metadata: { cycleId: checkpoint.cycleId, turn: checkpoint.nextTurn, phase: turn.phase, memberId: output.member.id,
          taskId: output.taskId,
          replyToMessageId: output.replyToMessageId, evidenceIds: contribution.evidenceIds,
          reasoningSummary: contribution.reasoningSummary, questions: contribution.questions } });
      if (output.member.executionMode === 'local') await tx.update(councilMessages).set({ metadata: {
        cycleId: checkpoint.cycleId, turn: checkpoint.nextTurn, phase: turn.phase, memberId: output.member.id,
        replyToMessageId: output.replyToMessageId, evidenceIds: contribution.evidenceIds, reasoningSummary: contribution.reasoningSummary,
        questions: contribution.questions, externalAgent: true, externalUsageUnknown: output.externalUsageUnknown, taskId: output.taskId,
      } }).where(and(eq(councilMessages.owner, userId), eq(councilMessages.sessionId, row.id),
        sql`${councilMessages.metadata}->>'cycleId' = ${checkpoint.cycleId}`, sql`(${councilMessages.metadata}->>'turn')::int = ${checkpoint.nextTurn}`));
      await tx.update(councilSessions).set({ updatedAt: new Date(),
        ...(output.sources?.length ? { evidenceSnapshot: [...current.evidenceSnapshot, ...output.sources].slice(-60) } : {}),
        checkpoint: { ...checkpoint, inflight: undefined, remote: undefined,
        nextTurn: checkpoint.nextTurn + (turn.phase === 'summary' ? 0 : 1),
        pendingResearch: turn.phase === 'summary' ? [] : contribution.researchRequests } })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
      return true;
    });
  }

  private async runMember(userId: string, row: SessionRow, member: CouncilMember, turn: DialogueTurn): Promise<MemberOutput> {
    if (member.executionMode === 'local') return this.runAgentMember(userId, row, member, turn);
    const messages = await this.db.select().from(councilMessages)
      .where(and(eq(councilMessages.owner, userId), eq(councilMessages.sessionId, row.id))).orderBy(councilMessages.createdAt);
    const discussion = messages.filter((item) => ['researcher', 'challenger', 'manager'].includes(item.role)
      && !(item.metadata?.cycleId === row.checkpoint?.cycleId && item.metadata?.phase === 'summary'));
    const systemPrompt = discussionPrompt(turn, row.language, !!row.candidate);
    const data = packDiscussionContext({ ticker: row.ticker, candidate: row.candidate, turn,
      config: row.profileSnapshot, member, evidence: row.evidenceSnapshot, systemPrompt,
      userMessages: messages.filter((item) => item.role === 'user').map((item) => item.content),
      currentDiscussion: discussion.filter((item) => item.metadata?.cycleId === row.checkpoint?.cycleId),
      previousDiscussion: discussion.filter((item) => item.metadata?.cycleId !== row.checkpoint?.cycleId),
    });
    const prompt = [{ role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: JSON.stringify(data) }];
    const options = { taskId: row.taskId, purpose: `council:${turn.phase}:${member.id}`, maxOutputTokens: 900,
      retryPolicy: 'none' as const, timeoutMs: 120_000,
      connectionId: member.connectionId, shouldContinue: async () => {
        const latest = await this.requireSession(userId, row.id);
        return latest.status === 'running' && latest.revision === row.revision;
      } };
    const taskId = `model:${row.checkpoint!.cycleId}:${row.checkpoint!.nextTurn}:${row.revision}`;
    const started = Date.now();
    const activity = (status: ResearchEvent['status'], summary: string) => this.recordActivity(userId, row, {
      id: randomUUID(), kind: 'task', status, summary, at: new Date().toISOString(), taskId, sessionId: row.id,
      memberId: member.id, memberName: member.name, turn: row.checkpoint!.nextTurn, revision: row.revision,
      sequence: 0, durationMs: Date.now() - started,
    });
    await activity('queued', row.language === 'en' ? 'Preparing the assigned model request' : '正在准备本轮模型请求');
    await activity('running', row.language === 'en' ? 'Waiting for the model’s research response' : '正在等待模型的研究回复');
    try {
      const result = member.model === 'slow' ? await this.llm.chatSlowJSON(prompt, userId, options)
        : await this.llm.chatFastJSON(prompt, userId, options);
      const contribution = parseContribution(result.data, new Set(data.evidence.map((item) => item.id)), turn, row.candidate);
      await activity('succeeded', row.language === 'en' ? 'Research response received' : '已收到研究回复');
      return { member, taskId, contribution, tokens: Number.isFinite(result.tokens) ? Math.max(0, Math.trunc(result.tokens)) : 0,
        replyToMessageId: data.conversation.at(-1)?.id ?? messages.filter((item) => item.role === 'user').at(-1)?.id ?? null };
    } catch (error) {
      await activity('failed', safeAnalysisError(error, row.language));
      throw error;
    }
  }

  private async recordActivity(userId: string, row: SessionRow, event: ResearchEvent, acquisition?: ResearchAcquisition): Promise<void> {
    if (!row.checkpoint) return;
    await this.db.transaction(async tx => {
      const [current] = await tx.select().from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id))).for('update');
      if (!current || current.status !== 'running' || current.revision !== row.revision || current.checkpoint?.cycleId !== row.checkpoint!.cycleId) return;
      const [count] = await tx.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(councilMessages)
        .where(and(eq(councilMessages.owner, userId), eq(councilMessages.sessionId, row.id),
          sql`${councilMessages.metadata}->'researchEvent'->>'taskId' = ${event.taskId}`));
      if (count.count >= 256) return;
      const safe: ResearchEvent = { ...event, summary: publicText(event.summary), sequence: count.count + 1 };
      await tx.insert(councilMessages).values({ owner: userId, sessionId: row.id, role: 'system',
        memberName: safe.memberName, revision: row.revision, content: safe.summary, tokensUsed: 0,
        metadata: { phase: 'progress', cycleId: row.checkpoint!.cycleId, researchEvent: safe, ...(acquisition ? { acquisition } : {}) } });
    });
  }

  private async recordAcquisition(userId: string, row: SessionRow, acquisition: ResearchAcquisition): Promise<void> {
    if (!row.checkpoint) return;
    const taskId = `evidence:${row.checkpoint.cycleId}:${row.revision}`;
    const callId = createHash('sha256').update(`${acquisition.source}:${acquisition.kind ?? 'initial'}`).digest('hex').slice(0, 24);
    await this.recordActivity(userId, row, { id: randomUUID(), kind: 'tool', taskId, callId, sequence: 0,
      sessionId: row.id, revision: row.revision, memberId: 'research-tools', memberName: row.language === 'en' ? 'Research tools' : '资料检索',
      turn: row.checkpoint.nextTurn, toolName: acquisition.kind ?? 'research', at: new Date().toISOString(),
      status: acquisition.status === 'started' ? 'running' : acquisition.status === 'failed' ? 'failed'
        : acquisition.status === 'skipped' ? 'unavailable' : 'succeeded',
      summary: `${acquisition.source} · ${acquisition.detail}`,
    }, { ...acquisition, detail: publicText(acquisition.detail, 1000) });
  }

  private async validateMembers(userId: string, members: CouncilMember[]): Promise<void> {
    await this.llm.validateConnectionIds(userId, members.flatMap((member) => member.executionMode !== 'local' && member.connectionId ? [member.connectionId] : []));
    for (const member of members.filter((item) => item.executionMode === 'local')) {
      if (!this.localAgents || !member.agentId) throw new BadRequestException('Local agent service unavailable');
      try { await this.localAgents.validate(userId, member.agentId, member.agentSettings); }
      catch (error) {
        if (error instanceof LocalAgentError) throw new BadRequestException(error.code);
        throw error;
      }
    }
  }

  private executionEngine(members: CouncilMember[]): CouncilReport['engine'] {
    const count = members.filter((member) => member.executionMode === 'local').length;
    return count === members.length ? 'local' : count ? 'mixed' : 'llm';
  }

  private async runAgentMember(userId: string, row: SessionRow, member: CouncilMember, turn: DialogueTurn): Promise<MemberOutput> {
    if (!this.localAgents || !member.agentId || !row.checkpoint) throw new Error('LOCAL_UNAVAILABLE');
    const current = await this.requireSession(userId, row.id);
    const saved = current.checkpoint?.remote;
    const messages = await this.db.select().from(councilMessages).where(and(eq(councilMessages.owner, userId), eq(councilMessages.sessionId, row.id)))
      .orderBy(councilMessages.createdAt);
    const lastUserMessageId = messages.filter((message) => message.role === 'user').at(-1)?.id;
    const resumeInput = saved?.awaitingInput === true && lastUserMessageId !== saved.lastUserMessageId;
    if (saved && ((!saved.taskId && saved.dispatchStarted) || saved.turn !== row.checkpoint.nextTurn || saved.agentId !== member.agentId)) throw new Error('LOCAL_DISPATCH_UNCERTAIN');
    const remote = resumeInput ? { ...saved!, messageId: randomUUID(), revision: row.revision, dispatchStarted: false }
      : saved ?? { agentId: member.agentId, messageId: randomUUID(), turn: row.checkpoint.nextTurn,
        revision: row.revision, dispatchStarted: false, lastUserMessageId };
    if (!saved || resumeInput) await this.db.update(councilSessions).set({ checkpoint: { ...current.checkpoint!, remote } })
      .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
    const result = await this.localAgents.execute(userId, { agentId: member.agentId, messageId: remote.messageId,
      researchScope: { sessionId: row.id, revision: row.revision, memberId: member.id, memberName: member.name,
        turn: row.checkpoint.nextTurn, ticker: row.ticker, language: row.language,
        webResearch: row.profileSnapshot.council?.webResearch === true, expiresAt: Date.now() + 600_000 },
      agentSettings: member.agentSettings,
      remoteTaskId: remote.taskId, contextId: remote.contextId, resumeInput,
      prompt: agentAssignment({ ticker: row.ticker, language: row.language, member, turn,
        candidate: row.candidate, messages: messages.filter((message) => message.role !== 'system'), evidence: row.evidenceSnapshot }),
      onDispatch: async () => {
        const dispatched = { ...remote, lastUserMessageId, awaitingInput: false, dispatchStarted: true };
        const marked = await this.db.update(councilSessions).set({ checkpoint: sql`jsonb_set(${councilSessions.checkpoint}, '{remote}', (${councilSessions.checkpoint}->'remote') || ${JSON.stringify(dispatched)}::jsonb)` })
          .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id),
            eq(councilSessions.status, 'running'), eq(councilSessions.revision, row.revision),
            sql`${councilSessions.checkpoint}->'remote'->>'messageId' = ${remote.messageId}`)).returning({ id: councilSessions.id });
        if (!marked.length) throw new LocalAgentError('LOCAL_PAUSED');
      },
      onTask: async (ref) => {
        await this.db.transaction(async (tx) => {
          const [latest] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id))).for('update');
          if (latest?.checkpoint?.remote?.messageId !== remote.messageId) throw new Error('LOCAL_PAUSED');
          await tx.update(councilSessions).set({ checkpoint: { ...latest.checkpoint, remote: { ...remote, ...ref, lastUserMessageId, awaitingInput: false, dispatchStarted: true } } })
            .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
        });
      },
      // Structured task activity is read from the durable journal; no duplicate generic chat rows.
      onProgress: async () => undefined,
      shouldContinue: async () => { const latest = await this.requireSession(userId, row.id);
        return latest.status === 'running' && latest.revision === row.revision; },
    });
    try {
      return { member, ...agentContribution(result, row.evidenceSnapshot, turn, row.candidate, row.language),
        taskId: result.taskId,
        tokens: result.usageTokens ?? 0, externalUsageUnknown: result.usageTokens === null,
        replyToMessageId: messages.filter((item) => item.role !== 'system').at(-1)?.id ?? null };
    } catch { throw new LocalAgentError('LOCAL_INVALID_RESULT'); }
  }

  private async runResearch(userId: string, row: SessionRow): Promise<void> {
    for (let count = 0; count < 2; count++) {
      const request = await this.db.transaction(async (tx) => {
        const [current] = await tx.select().from(councilSessions)
          .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id))).for('update');
        const checkpoint = current?.checkpoint;
        if (current?.status !== 'running' || checkpoint?.cycleId !== row.checkpoint?.cycleId || !checkpoint.pendingResearch.length) return null;
        const [next, ...rest] = checkpoint.pendingResearch;
        const allowed = checkpoint.toolKindsUsed.length < 2 && !checkpoint.toolKindsUsed.includes(next.kind)
          && (next.kind !== 'web' || current.profileSnapshot.council?.webResearch === true);
        await tx.update(councilSessions).set({ checkpoint: { ...checkpoint, pendingResearch: rest,
          toolKindsUsed: allowed ? [...checkpoint.toolKindsUsed, next.kind] : checkpoint.toolKindsUsed } })
          .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
        return { ...next, allowed };
      });
      if (!request) return;
      if (!request.allowed) {
        await this.recordAcquisition(userId, row, { source: 'Research tools', kind: request.kind, status: 'skipped',
          detail: row.language === 'en' ? 'This category was already checked, is disabled, or the two-category round limit was reached.'
            : '该类资料已检索、未启用，或已达到本轮两类资料的上限。' });
        continue;
      }
      try {
        const collected = await this.evidence.collectResearch(row.ticker, userId, request.kind, row.language, {
          taskId: row.taskId, query: request.query, webResearch: row.profileSnapshot.council?.webResearch ?? false,
          onAcquisition: (event) => this.recordAcquisition(userId, row, event), shouldContinue: async () => {
            const latest = await this.requireSession(userId, row.id);
            return latest.status === 'running' && latest.checkpoint?.cycleId === row.checkpoint?.cycleId;
          },
        });
        if (!collected.length) {
          await this.recordAcquisition(userId, row, { source: 'Research tools', kind: request.kind, status: 'skipped',
            detail: row.language === 'en' ? 'No new facts were returned; existing evidence and gaps are retained.'
              : '未返回新资料，保留现有证据和数据缺口。' });
          continue;
        }
        await this.db.transaction(async (tx) => {
          const [current] = await tx.select().from(councilSessions)
            .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id))).for('update');
          if (current?.checkpoint?.cycleId !== row.checkpoint?.cycleId) return;
          const fresh = collected.map((item) => ({ ...item,
            ...(request.kind === 'web' ? { evidenceType: 'other' as const, role: 'news' as const } : {}),
            id: current.evidenceSnapshot.find((existing) => existing.title === item.title && existing.content === item.content
              && existing.sourceName === item.sourceName && existing.sourceUrl === (item.sourceUrl ?? null))?.id ?? randomUUID(),
            sourceUrl: item.sourceUrl ?? null, sourceName: item.sourceName ?? null,
            fetchedAt: new Date().toISOString(), researchKind: request.kind }));
          const retained = current.evidenceSnapshot.filter((item) => evidenceKind(item) !== request.kind);
          const archive = [...(current.checkpoint.evidenceArchive ?? []), ...current.evidenceSnapshot.filter((item) =>
            evidenceKind(item) === request.kind && item.sourceName !== 'Data Unavailable' && !fresh.some((next) => next.id === item.id))];
          await tx.update(councilSessions).set({ evidenceSnapshot: [...fresh, ...retained].slice(0, 40),
            checkpoint: { ...current.checkpoint, evidenceArchive: [...new Map(archive.map((item) => [item.id, item])).values()] } })
            .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
        });
      } catch {
        await this.recordAcquisition(userId, row, { source: 'Research tools', kind: request.kind, status: 'failed',
          detail: row.language === 'en' ? 'The requested source could not complete; existing evidence and gaps are retained.'
            : '请求的数据源未能完成检索，保留现有证据与数据缺口。' });
      }
    }
  }

  private async publish(userId: string, row: SessionRow, opinion: CouncilOpinion, engine: CouncilReport['engine'], error: string | null,
    researchStance: CouncilReport['researchStance'] = null): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id))).for('update');
      if (!current || current.status !== 'running' || current.revision !== row.revision) return false;
      const [latest] = await tx.select({ version: councilReports.version }).from(councilReports)
        .where(and(eq(councilReports.owner, userId), eq(councilReports.sessionId, row.id)))
        .orderBy(desc(councilReports.version)).limit(1);
      const [usage] = await tx.select({ total: sql<number>`coalesce(sum(${llmBudgetUsage.chargedTokens}), 0)` })
        .from(llmBudgetUsage).where(and(eq(llmBudgetUsage.owner, userId), eq(llmBudgetUsage.taskId, row.taskId)));
      const [external] = await tx.select({ total: sql<number>`coalesce(sum(${councilMessages.tokensUsed}), 0)` }).from(councilMessages)
        .where(and(eq(councilMessages.owner, userId), eq(councilMessages.sessionId, row.id), sql`${councilMessages.metadata}->>'externalAgent' = 'true'`));
      const historical = (current.checkpoint?.evidenceArchive ?? []).filter((item) => !row.evidenceSnapshot.some((fact) => fact.id === item.id))
        .map((item) => ({ ...item, title: (row.language === 'en' ? 'Earlier source: ' : '本轮较早资料：') + item.title }));
      await tx.insert(councilReports).values({ owner: userId, sessionId: row.id, version: (latest?.version ?? 0) + 1,
        revision: row.revision, decision: opinion.decision, summary: opinion.summary, dissent: opinion.dissent,
        nextReviewCondition: opinion.nextReviewCondition, sourceRunId: row.sourceRunId,
        candidate: row.candidate, engine, researchStance, tokensUsed: Math.min(2_147_483_647, Number(usage?.total ?? 0) + Number(external?.total ?? 0)),
        evidence: [...row.evidenceSnapshot, ...historical].map(({ id, title, content, sourceUrl, fetchedAt }) => ({ id, title, content, sourceUrl, fetchedAt })) });
      await tx.update(councilSessions).set({ status: error ? 'failed' : 'completed', error, updatedAt: new Date(),
        ...(error || !current.checkpoint ? {} : { checkpoint: { ...current.checkpoint,
          nextTurn: current.checkpoint.turns.length, pendingResearch: [], inflight: undefined } }) })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
      return true;
    });
  }

  private async collectSnapshot(userId: string, ticker: string, language: 'zh-CN' | 'en',
    config: BuilderConfig, candidate: CouncilCandidate | null, fresh = false, session?: SessionRow): Promise<ResearchSnapshot> {
    const evidence: CouncilEvidence[] = [];
    let sourceRunId: string | null = null;
    const now = new Date().toISOString();
    // Delegated teams gather their own research. Do not run the legacy collector before dispatch.
    if (this.members(config).every((member) => member.executionMode === 'local')) return { evidence, sourceRunId };
    if (!fresh) try {
      const runs = await this.research.listRuns(userId, { ticker, status: 'completed', limit: 1 });
      const latest = runs.items[0];
      if (latest && Date.now() - Date.parse(latest.completedAt ?? latest.createdAt) < 48 * 3600_000) {
        const saved = await this.research.getEvidence(userId, latest.id);
        if (saved.length && !saved.some((item) => item.sourceName === 'Data Unavailable')) {
          sourceRunId = latest.id;
          evidence.push(...saved.map((item) => ({ ...item, relevanceScore: Number(item.relevanceScore ?? 0) })));
        }
      }
    } catch {
      // A missing saved report must not prevent direct provider collection.
      this.logger.warn('Council saved research unavailable; collecting fresh evidence');
    }
    let portfolio: Awaited<ReturnType<PortfolioContextService['getPortfolioContext']>> | null = null;
    try {
      portfolio = await this.portfolio.getPortfolioContext(userId);
    } catch {
      evidence.push({ id: randomUUID(), role: 'fundamental', evidenceType: 'other',
        title: language === 'en' ? 'Current portfolio data unavailable' : '当前组合数据不可用',
        content: language === 'en' ? 'Portfolio valuation or FX could not be verified. Stock research continues; portfolio sizing is withheld.'
          : '组合估值或汇率暂时无法核实。个股研究仍会继续，暂不计算组合仓位建议。',
        sourceName: 'Data Unavailable', sourceUrl: null, fetchedAt: now, relevanceScore: 0 });
    }
    if (!sourceRunId) {
      try {
        const collected = await this.evidence.collectEvidence(ticker, userId, portfolio, language, session ? {
          taskId: session.taskId, webResearch: config.council?.webResearch ?? false,
          onAcquisition: (event) => this.recordAcquisition(userId, session, event), shouldContinue: async () => {
            const current = await this.requireSession(userId, session.id);
            return current.status === 'running' && current.checkpoint?.cycleId === session.checkpoint?.cycleId;
          },
        } : undefined);
        evidence.push(...collected.map((item) => ({ ...item, id: randomUUID(), sourceUrl: item.sourceUrl ?? null,
          sourceName: item.sourceName ?? null, fetchedAt: now })));
      } catch {
        evidence.push({ id: randomUUID(), role: 'fundamental', evidenceType: 'other',
          title: language === 'en' ? 'Stock research data unavailable' : '个股研究数据不可用',
          content: language === 'en' ? 'Stock data collection failed. Check the data provider and retry.' : '个股数据采集失败，请检查金融数据服务后重试。',
          sourceName: 'Data Unavailable', sourceUrl: null, fetchedAt: now, relevanceScore: 0 });
      }
    }
    if (portfolio) {
      evidence.push({ id: randomUUID(), role: 'fundamental', evidenceType: 'other',
        title: language === 'en' ? 'Current portfolio snapshot (USD)' : '当前组合快照（美元）',
        content: JSON.stringify({ totalValue: portfolio.totalValue, cash: portfolio.cash,
          holdings: portfolio.holdings.filter((holding) => holding.ticker.toUpperCase() === ticker) }),
        sourceName: 'Portfolio Data', sourceUrl: null, fetchedAt: now, relevanceScore: 1 });
    }
    if (isRuleCandidate(config, candidate)) {
      const rule = config.priceRules.find((item) => item.ticker.toUpperCase() === ticker);
      evidence.push({ id: randomUUID(), role: 'fundamental', evidenceType: 'other',
        title: language === 'en' ? 'Investor-authored price rule (not an AI forecast)' : '投资者自设价格规则（非 AI 预测）',
        content: JSON.stringify(rule), sourceName: 'Investor configuration', sourceUrl: null, fetchedAt: now, relevanceScore: 1 });
      evidence.push({ id: randomUUID(), role: 'technical', evidenceType: 'price',
        title: language === 'en' ? 'Paper scanner candidate quote' : '模拟交易扫描报价',
        content: JSON.stringify({ ticker, price: candidate.price, side: candidate.side, quantity: candidate.quantity }),
        sourceName: 'Paper scan quote', sourceUrl: null, fetchedAt: now, relevanceScore: 1 });
    }
    return { evidence: evidence.slice(0, 40), sourceRunId };
  }

  private async insertSession(userId: string, profile: { id: string | null; version: number; config: BuilderConfig }, ticker: string, language: 'zh-CN' | 'en',
    candidate: CouncilCandidate | null = null, snapshot: ResearchSnapshot = { evidence: [], sourceRunId: null }, key: string | null = null): Promise<SessionRow> {
    const [row] = await this.db.insert(councilSessions).values({ owner: userId, profileId: profile.id,
      profileVersion: profile.version, profileSnapshot: profile.config, ticker, language, candidate,
      evidenceSnapshot: snapshot.evidence, sourceRunId: snapshot.sourceRunId, cacheKey: key }).returning();
    return row;
  }

  private async getProfile(userId: string, id: string): Promise<BuilderProfile> {
    this.assertId(id);
    const [row] = await this.db.select().from(builderProfiles)
      .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.id, id)));
    if (!row) throw new NotFoundException('Agent profile not found');
    return { id: row.id, config: normalizeBuilderConfig(row.config as BuilderConfig),
      status: row.status as BuilderProfile['status'], version: row.version,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }

  private members(config: BuilderConfig): CouncilMember[] {
    return normalizeCouncil(config.council).members;
  }

  private async requireSession(userId: string, id: string): Promise<SessionRow> {
    this.assertId(id);
    const [row] = await this.db.select().from(councilSessions)
      .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id)));
    if (!row) throw new NotFoundException('Council session not found');
    return row;
  }

  private async hydrate(userId: string, row: SessionRow): Promise<CouncilSession> {
    const [messages, reports] = await Promise.all([
      this.db.select().from(councilMessages)
        .where(and(eq(councilMessages.owner, userId), eq(councilMessages.sessionId, row.id))).orderBy(councilMessages.createdAt),
      this.db.select().from(councilReports)
        .where(and(eq(councilReports.owner, userId), eq(councilReports.sessionId, row.id))).orderBy(councilReports.version),
    ]);
    const activity = this.localAgents?.store ? await this.localAgents.store.eventsForSession(userId, row.id) : undefined;
    const events = [...(activity?.events ?? []), ...messages.flatMap(message => message.metadata?.researchEvent ? [message.metadata.researchEvent] : [])]
      .sort((a, b) => a.at.localeCompare(b.at) || a.sequence - b.sequence);
    return { id: row.id, profileId: row.profileId, profileVersion: row.profileVersion,
      researchEvents: events.slice(-2048), researchEventsTruncated: activity?.truncated || events.length > 2048,
      ticker: row.ticker, language: row.language, status: row.status, revision: row.revision,
      messages: messages.map(({ id, role, memberName, content, revision, tokensUsed, createdAt, metadata }) => ({
        id, role, memberName, content, revision, tokensUsed, createdAt: createdAt.toISOString(),
        ...(metadata ? { memberId: metadata.memberId, phase: metadata.phase, replyToMessageId: metadata.replyToMessageId,
          evidenceIds: metadata.evidenceIds, reasoningSummary: metadata.reasoningSummary, questions: metadata.questions,
          acquisition: metadata.acquisition, externalAgent: metadata.externalAgent, externalUsageUnknown: metadata.externalUsageUnknown, taskId: metadata.taskId } : {}),
      })), reports: reports.map((report) => ({ ...this.mapReport(report), externalUsageUnknown: messages.some((message) =>
        message.createdAt <= report.createdAt && message.metadata?.externalUsageUnknown === true) })), error: row.error,
      members: this.members(row.profileSnapshot), webResearch: row.profileSnapshot.council?.webResearch ?? false,
      progress: row.checkpoint && row.checkpoint.nextTurn < row.checkpoint.turns.length ? {
        phase: row.checkpoint.turns[row.checkpoint.nextTurn].phase, memberId: row.checkpoint.turns[row.checkpoint.nextTurn].memberId,
        turn: row.checkpoint.nextTurn + 1, totalTurns: row.checkpoint.turns.length,
      } : null,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }

  private mapReport(row: ReportRow): CouncilReport {
    return { id: row.id, version: row.version, revision: row.revision, decision: row.decision, summary: row.summary,
      dissent: row.dissent, nextReviewCondition: row.nextReviewCondition, evidence: row.evidence,
      sourceRunId: row.sourceRunId, candidate: row.candidate, paperOrderId: row.paperOrderId,
      tokensUsed: row.tokensUsed, engine: row.engine, createdAt: row.createdAt.toISOString(), researchStance: row.researchStance };
  }

  private assertId(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
      throw new BadRequestException('Invalid identifier');
    }
  }

  private validateTicker(value: unknown): string {
    try { return normalizeTicker(value); } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid ticker');
    }
  }
}
