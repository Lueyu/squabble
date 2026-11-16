/**
 * council.service.ts — 研究委员会（Council）会话编排服务。
 *
 * 职责边界：
 *  - 管理 council 会话生命周期：创建/查询/发言/运行/暂停，落库于 councilSessions、councilMessages、councilReports。
 *  - 驱动固定轮次的讨论循环：外部模型成员走 LlmService，本地助手成员走 LocalAgentsService，资料检索走 EvidenceService。
 *  - 负责 candidate 复核（reviewCandidate）与审批判定；不管订单执行本身（由 paper-trading 侧处理）。
 * 上下游：
 *  - 上游：CouncilController 路由；paper-trading 编排通过 reviewCandidate 发起 candidate 复核。
 *  - 下游：council.rules（成员/证据规则）、council.dialogue（提示词与贡献解析）、council.context（上下文打包）、
 *    council.native（本地智能体任务书）、LlmService、EvidenceService、MultiAgentService、LocalAgentsService、LlmBudgetService。
 * 关键约定：
 *  - 单轮模型调用：maxOutputTokens=900、timeoutMs=120_000、retryPolicy='none'（见 runMember 的 options）。
 *  - 会话内任务预算跨恢复与用户修订保留；恢复不重放已完成轮次。
 *  - 每轮资料检索最多 2 类、每类只查一次；web 类需 profile 开启 webResearch。
 *  - 主循环最多 12 次 attempt；证据快照采集上限 40 条，成员自带来源追加后保留最近 60 条。
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleInit,
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
  CouncilCandidate,
  CouncilMember,
  CouncilReport,
  CouncilReviewResult,
  CouncilSession,
  CreateCouncilSession,
  ResearchAcquisition,
} from '@shared/council.interface';
import {
  cacheKey,
  criticalEvidenceGaps,
  DEFAULT_MEMBERS,
  eligibleApproval,
  isRuleCandidate,
  normalizeCandidate,
  normalizeTicker,
  type CouncilEvidence,
  type CouncilOpinion,
} from './council.rules';
import {
  discussionPrompt,
  evidenceKind,
  newCheckpoint,
  parseContribution,
  type DiscussionContribution,
} from './council.dialogue';
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
interface ResearchSnapshot {
  evidence: CouncilEvidence[];
  sourceRunId: string | null;
}
interface MemberOutput {
  member: CouncilMember;
  contribution: DiscussionContribution;
  tokens: number;
  replyToMessageId: string | null;
  externalUsageUnknown?: boolean;
  sources?: CouncilEvidence[];
  taskId?: string;
}

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
    // 恢复流程只改变会话生命周期：既不恢复模型调用，也不触碰订单执行。
    await this.db
      .update(councilSessions)
      .set({
        status: 'paused',
        revision: sql`${councilSessions.revision} + 1`,
        checkpoint: sql`${councilSessions.checkpoint} - 'inflight'`,
        error: 'Server restarted. Resume this discussion explicitly.',
        updatedAt: new Date(),
      })
      .where(eq(councilSessions.status, 'running'));
  }

  /** 列出当前用户最近 50 个委员会会话，按更新时间倒序。 */
  async listSessions(userId: string): Promise<CouncilSession[]> {
    const rows = await this.db
      .select()
      .from(councilSessions)
      .where(eq(councilSessions.owner, userId))
      .orderBy(desc(councilSessions.updatedAt))
      .limit(50);
    return Promise.all(rows.map((row) => this.hydrate(userId, row)));
  }

  /**
   * 创建委员会会话：校验代码/语言/成员配置，套用或新建 agent 档案，随后落库。
   * @throws BadRequestException 输入非法、研究团队配置无效或成员校验失败。
   */
  async createSession(userId: string, input: CreateCouncilSession): Promise<CouncilSession> {
    if (!input || typeof input !== 'object')
      throw new BadRequestException('Council input is required');
    const ticker = this.validateTicker(input.ticker);
    if (input.language !== undefined && input.language !== 'en' && input.language !== 'zh-CN') {
      throw new BadRequestException('Language must be zh-CN or en');
    }
    const source =
      input.profileId === undefined ? null : await this.getProfile(userId, input.profileId);
    let team: ReturnType<typeof normalizeCouncil>;
    try {
      team = normalizeCouncil({
        enabled: true,
        members: input.members ?? source?.config.council?.members ?? DEFAULT_MEMBERS,
        webResearch: input.webResearch ?? source?.config.council?.webResearch ?? false,
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid research team',
      );
    }
    await this.validateMembers(userId, team.members);
    const config = source
      ? { ...source.config, council: team }
      : normalizeBuilderConfig({
          name: 'Research room',
          template: 'guard',
          tickers: [ticker],
          minimumRating: 'Buy',
          customPrompt: '',
          maxOrderPct: 5,
          dailyLossLimitPct: 3,
          maxOrdersPerDay: 1,
          notifyOnProposal: false,
          priceRules: [],
          language: input.language ?? 'zh-CN',
          council: team,
        });
    const profile = { id: source?.id ?? null, version: source?.version ?? 1, config };
    const row = await this.insertSession(userId, profile, ticker, input.language ?? 'zh-CN');
    return this.hydrate(userId, row);
  }

  /** 读取单个委员会会话（含消息、报告与进度）。 */
  async getSession(userId: string, id: string): Promise<CouncilSession> {
    return this.hydrate(userId, await this.requireSession(userId, id));
  }

  /**
   * 追加一条用户发言：事务内锁定会话、校验 30 条用户消息上限并推进 revision。
   * 失败/暂停会话保留原状态与错误信息，其余会话回到 idle。
   */
  async addMessage(userId: string, id: string, content: unknown): Promise<CouncilSession> {
    this.assertId(id);
    if (typeof content !== 'string' || !content.trim() || content.trim().length > 2000) {
      throw new BadRequestException('Message must contain 1–2000 characters');
    }
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id)))
        .for('update');
      if (!current) throw new NotFoundException('Council session not found');
      const [counts] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(councilMessages)
        .where(
          and(
            eq(councilMessages.owner, userId),
            eq(councilMessages.sessionId, id),
            eq(councilMessages.role, 'user'),
          ),
        );
      if (Number(counts?.count) >= 30)
        throw new BadRequestException('This discussion has reached 30 user messages');
      const revision = current.revision + 1;
      await tx.insert(councilMessages).values({
        owner: userId,
        sessionId: id,
        role: 'user',
        memberName: 'You',
        content: content.trim(),
        revision,
        tokensUsed: 0,
      });
      const held = current.status === 'failed' || current.status === 'paused';
      await tx
        .update(councilSessions)
        .set({
          revision,
          updatedAt: new Date(),
          error: held ? current.error : null,
          status: current.status === 'running' || held ? current.status : 'idle',
        })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id)));
    });
    return this.getSession(userId, id);
  }

  /** 暂停会话：状态置为 paused 并推进 revision（用于打断仍在排队的轮次）。 */
  async pauseSession(userId: string, id: string): Promise<CouncilSession> {
    this.assertId(id);
    const [row] = await this.db
      .update(councilSessions)
      .set({
        status: 'paused',
        revision: sql`${councilSessions.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id)))
      .returning();
    if (!row) throw new NotFoundException('Council session not found');
    return this.hydrate(userId, row);
  }

  /**
   * 运行（或恢复）一次委员会讨论：校验成员连接，事务内锁定并标记 running，再异步启动执行循环。
   * @returns 更新后的会话视图；后台循环通过 this.jobs 跟踪。
   */
  async runSession(userId: string, id: string): Promise<CouncilSession> {
    this.assertId(id);
    const previous = await this.requireSession(userId, id);
    if (previous.status === 'running') return this.hydrate(userId, previous);
    const members = this.members(previous.profileSnapshot);
    await this.validateMembers(userId, members);
    if (members.some((member) => member.connectionId || member.executionMode === 'local')) {
      const configured = await Promise.all(
        members.map((member) =>
          member.executionMode === 'local'
            ? true
            : this.llm.isConfigured(userId, member.connectionId),
        ),
      );
      if (configured.some((value) => !value))
        throw new BadRequestException(
          'Configure a model connection for every team member before starting',
        );
    }
    const { row, started } = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id)))
        .for('update');
      if (!current) throw new NotFoundException('Council session not found');
      if (current.status === 'running') return { row: current, started: false };
      const resume =
        current.checkpoint && current.checkpoint.nextTurn < current.checkpoint.turns.length;
      // 任务预算在多次恢复与用户修订之间被有意保留。
      const [started] = await tx
        .update(councilSessions)
        .set({
          status: 'running',
          revision: current.revision + 1,
          error: null,
          updatedAt: new Date(),
          checkpoint: resume
            ? current.checkpoint
            : newCheckpoint(this.members(current.profileSnapshot)),
          // 显式追问使用当前凭证与数据，但不清除既有报告与预算用量。
          ...(!resume && (!current.candidate || current.revision > 1)
            ? { evidenceSnapshot: [], sourceRunId: null, cacheKey: null }
            : {}),
        })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id)))
        .returning();
      return { row: started, started: true };
    });
    if (!started) return this.hydrate(userId, row);
    const active = this.jobs.get(`${userId}:${id}`);
    if (active) {
      // 暂停中的上游请求可能尚未收尾，此时又收到了恢复请求：
      // 等旧任务释放执行槽后，精确地补排这一次显式恢复。
      void active
        .then(async () => {
          const current = await this.requireSession(userId, id);
          if (current.status === 'running') this.launch(userId, id);
        })
        .catch(() => this.logger.error(`Council session ${id} could not resume`));
    } else this.launch(userId, row.id);
    return this.hydrate(userId, row);
  }

  /**
   * 发起 candidate 复核（由 paper-trading 扫描调用）：同一 `${userId}:${profileId}:${version}:${ticker}:${side}`
   * 键的在跑任务会被复用，避免并发扫描重复评审同一 candidate。
   */
  async reviewCandidate(
    userId: string,
    profile: BuilderProfile,
    input: CouncilCandidate,
  ): Promise<CouncilReviewResult> {
    let candidate: CouncilCandidate;
    try {
      candidate = normalizeCandidate(input);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid candidate');
    }
    const current = await this.getProfile(userId, profile.id);
    if (current.version !== profile.version)
      throw new BadRequestException('Agent profile changed before council review');
    const key = `${userId}:${profile.id}:${profile.version}:${candidate.ticker}:${candidate.side}`;
    const active = this.candidateJobs.get(key);
    if (active) {
      await active;
      // 并发扫描必须拿持久化结果重新校验自己那份完全一致的 candidate。
    }
    const work = this.reviewCandidateOnce(userId, current, candidate);
    this.candidateJobs.set(key, work);
    try {
      return await work;
    } finally {
      if (this.candidateJobs.get(key) === work) this.candidateJobs.delete(key);
    }
  }

  /**
   * 将报告与模拟盘订单绑定：校验报告仍是当前有效的 approve 结论，且订单与被审 candidate 完全一致。
   * 绑定操作幂等（同一订单可重复绑定），但一个审批只能被使用一次。
   */
  async attachPaperOrder(userId: string, reportId: string, orderId: string): Promise<void> {
    this.assertId(reportId);
    this.assertId(orderId);
    const [report] = await this.db
      .select()
      .from(councilReports)
      .where(and(eq(councilReports.owner, userId), eq(councilReports.id, reportId)));
    if (!report) throw new NotFoundException('Council report not found');
    // 事务内锁定会话与订单，校验报告仍是当前有效审批且与订单匹配。
    await this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, report.sessionId)))
        .for('update');
      const [order] = await tx
        .select()
        .from(paperOrders)
        .where(and(eq(paperOrders.owner, userId), eq(paperOrders.id, orderId)));
      if (!session || !order)
        throw new NotFoundException('Council session or paper order not found');
      if (
        report.decision !== 'approve' ||
        report.revision !== session.revision ||
        session.status !== 'completed' ||
        !report.candidate ||
        report.candidate.ticker !== order.ticker ||
        report.candidate.side !== order.side ||
        report.candidate.quantity !== Number(order.quantity)
      ) {
        throw new BadRequestException('Paper order does not match a current council approval');
      }
      // 条件更新绑定订单（仍未绑定时才生效），重复使用会被拒绝。
      const [linked] = await tx
        .update(councilReports)
        .set({ paperOrderId: orderId })
        .where(
          and(
            eq(councilReports.owner, userId),
            eq(councilReports.id, reportId),
            sql`(${councilReports.paperOrderId} IS NULL OR ${councilReports.paperOrderId} = ${orderId})`,
          ),
        )
        .returning();
      if (!linked) throw new BadRequestException('Council approval was already used');
    });
  }

  /** 复核单次执行体：收集证据 → 查 24h 内同键缓存 → 未命中则新建会话同步跑完并返回结论。 */
  private async reviewCandidateOnce(
    userId: string,
    profile: BuilderProfile,
    candidate: CouncilCandidate,
  ): Promise<CouncilReviewResult> {
    const snapshot = await this.collectSnapshot(
      userId,
      candidate.ticker,
      profile.config.language ?? 'zh-CN',
      profile.config,
      candidate,
    );
    const key = cacheKey(
      userId,
      profile.id,
      profile.version,
      candidate,
      snapshot.evidence,
      snapshot.sourceRunId,
    );
    // 24h 内同键会话若已有可用结论则直接复用。
    const rows = await this.db
      .select()
      .from(councilSessions)
      .where(
        and(
          eq(councilSessions.owner, userId),
          eq(councilSessions.cacheKey, key),
          gte(councilSessions.createdAt, new Date(Date.now() - 24 * 3600_000)),
        ),
      )
      .orderBy(desc(councilSessions.createdAt))
      .limit(8);
    const modelConfigured = (
      await Promise.all(
        this.members(profile.config).map((member) =>
          member.executionMode === 'local'
            ? true
            : this.llm.isConfigured(userId, member.connectionId),
        ),
      )
    ).every(Boolean);
    for (const row of rows) {
      const session = await this.hydrate(userId, row);
      const report = session.reports.at(-1);
      if (
        !report ||
        report.revision !== session.revision ||
        !['completed', 'failed'].includes(session.status)
      )
        continue;
      // 此前未配置模型、现在配置好了，属于可行动的新信息（basic 结果不再直接复用）。
      if (report.engine === 'basic' && modelConfigured) continue;
      if (report.decision !== 'approve') return this.reviewResult(row, report, candidate);
      if (
        Date.now() - Date.parse(report.createdAt) <= 30 * 60_000 &&
        this.reviewResult(row, report, candidate).approved
      )
        return this.reviewResult(row, report, candidate);
    }
    const row = await this.insertSession(
      userId,
      profile,
      candidate.ticker,
      profile.config.language ?? 'zh-CN',
      candidate,
      snapshot,
      key,
    );
    await this.runSession(userId, row.id);
    await this.jobs.get(`${userId}:${row.id}`);
    const latest = await this.requireSession(userId, row.id);
    const session = await this.hydrate(userId, latest);
    return this.reviewResult(latest, session.reports.at(-1) ?? null, candidate);
  }

  /** 依据规则判定报告是否构成一次可执行的批准。 */
  private reviewResult(
    row: SessionRow,
    report: CouncilReport | null,
    candidate: CouncilCandidate,
  ): CouncilReviewResult {
    const approved = Boolean(
      report &&
      eligibleApproval({
        status: row.status,
        revision: row.revision,
        reportRevision: report.revision,
        decision: report.decision,
        candidate,
        reviewedCandidate: report.candidate,
        hasCriticalGaps: criticalEvidenceGaps(row.evidenceSnapshot),
        ruleOnly: isRuleCandidate(row.profileSnapshot, candidate),
        paperOrderId: report.paperOrderId,
      }),
    );
    return {
      approved,
      reason: report?.summary ?? 'Council review is paused or incomplete',
      sessionId: row.id,
      reportId: report?.id ?? null,
    };
  }

  /** 启动后台执行任务：失败时把会话落为 failed 终态，结束后释放任务槽。 */
  private launch(userId: string, id: string): void {
    const key = `${userId}:${id}`;
    if (this.jobs.has(key)) return;
    const job = this.execute(userId, id)
      .catch(async () => {
        this.logger.error(`Council session ${id} could not finish`);
        await this.db
          .update(councilSessions)
          .set({
            status: 'failed',
            error: 'Council could not finish. Please retry.',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(councilSessions.owner, userId),
              eq(councilSessions.id, id),
              eq(councilSessions.status, 'running'),
            ),
          );
      })
      .finally(() => {
        this.jobs.delete(key);
      });
    this.jobs.set(key, job);
    // 上面的 catch 已持久化安全的终止状态；若连存储也不可用，这里兜底处理避免未处理的 rejection。
    void job.catch(() => this.logger.error(`Council session ${id} storage unavailable`));
  }

  /**
   * 执行循环（后台任务主体）：按 checkpoint 里的固定轮次计划推进讨论。
   * 每轮先认领（claimTurn）再执行；出错释放认领并按错误类型降级处理。
   */
  private async execute(userId: string, id: string): Promise<void> {
    // 固定轮次计划 + 对被取代 summary 的有界重试；绝不整轮重放。
    for (let attempt = 0; attempt < 12; attempt++) {
      // 读取会话最新状态：非 running、无 checkpoint 或他人正在收尾时直接结束。
      let row = await this.requireSession(userId, id);
      if (row.status !== 'running' || !row.checkpoint) return;
      if (row.checkpoint.inflight) return; // 另一个正在收尾的进程持有这一已付费轮次。
      // 证据快照缺失时先补采一轮资料并写回（仅非本地团队需要）。
      if (
        !row.evidenceSnapshot.length &&
        this.members(row.profileSnapshot).some((member) => member.executionMode !== 'local')
      ) {
        const cycleId = row.checkpoint.cycleId;
        const snapshot = await this.collectSnapshot(
          userId,
          row.ticker,
          row.language,
          row.profileSnapshot,
          row.candidate,
          true,
          row,
        );
        await this.db
          .update(councilSessions)
          .set({ evidenceSnapshot: snapshot.evidence, sourceRunId: snapshot.sourceRunId })
          .where(
            and(
              eq(councilSessions.owner, userId),
              eq(councilSessions.id, id),
              eq(councilSessions.status, 'running'),
              sql`${councilSessions.checkpoint}->>'cycleId' = ${cycleId}`,
            ),
          );
        row = await this.requireSession(userId, id);
        if (row.status !== 'running' || !row.checkpoint) return;
      }
      // 执行待处理的研究请求（每轮最多两类，每类一次）。
      if (row.checkpoint.pendingResearch.length) {
        await this.runResearch(userId, row);
        row = await this.requireSession(userId, id);
        if (row.status !== 'running' || !row.checkpoint) return;
      }
      // 取当前轮次；计划走完即正常结束。
      const checkpoint = row.checkpoint;
      const turn = checkpoint.turns[checkpoint.nextTurn];
      if (!turn) return;
      let claimId: string | null = null;
      try {
        // 基础模式（无任何可用模型连接）：直接发布 wait 结论，不产生 AI 讨论。
        const members = this.members(row.profileSnapshot);
        if (
          !members.some((member) => member.connectionId || member.executionMode === 'local') &&
          !(await this.llm.isConfigured(userId))
        ) {
          await this.publish(
            userId,
            row,
            {
              decision: 'wait',
              summary:
                row.language === 'en'
                  ? 'Basic mode: no model is configured. No AI discussion occurred. Configure a model to discuss the verified sources.'
                  : '基础模式：尚未配置模型，未进行 AI 讨论。配置模型后可共同讨论已核实资料。',
              dissent: [],
              nextReviewCondition:
                row.language === 'en' ? 'Configure a model connection.' : '请配置模型连接。',
              evidenceIds: [],
            },
            'basic',
            null,
          );
          return;
        }
        // 找到当前轮次的成员并认领轮次；抢不到就让位重试。
        const member = members.find((item) => item.id === turn.memberId);
        if (!member) throw new Error('Research team member is unavailable');
        claimId = await this.claimTurn(userId, row);
        if (!claimId) {
          const latest = await this.requireSession(userId, id);
          if (latest.status !== 'running' || latest.checkpoint?.inflight) return;
          continue;
        }
        // 执行成员发言并把结果写回；结果被取代时直接让位重试。
        const output = await this.runMember(userId, row, member, turn);
        const recorded = await this.recordTurn(userId, row, turn, claimId, output);
        claimId = null;
        if (!recorded) continue;
        if (output.sources?.length)
          row = {
            ...row,
            evidenceSnapshot: [...row.evidenceSnapshot, ...output.sources].slice(-60),
          };
        // summary 阶段：关键证据缺失时把批准降级为暂缓，随后发布报告。
        if (turn.phase === 'summary' && output.contribution.opinion) {
          const opinion = output.contribution.opinion;
          if (
            row.candidate &&
            opinion.decision === 'approve' &&
            criticalEvidenceGaps(row.evidenceSnapshot) &&
            !isRuleCandidate(row.profileSnapshot, row.candidate)
          ) {
            opinion.decision = 'wait';
            opinion.summary =
              (row.language === 'en'
                ? 'Critical research evidence is missing; approval is withheld. '
                : '关键研究证据缺失，暂缓批准。') + opinion.summary;
            opinion.nextReviewCondition =
              row.language === 'en'
                ? 'Obtain verified financial statements and current market evidence.'
                : '补齐经核实的财务报表和当前市场证据。';
          }
          await this.publish(
            userId,
            row,
            opinion,
            this.executionEngine(members),
            null,
            row.candidate ? null : output.contribution.researchStance,
          );
        }
      } catch (error) {
        // 出错：先释放认领，再按错误类型处置（本地智能体错误 → 暂停；其余 → 发布 wait 报告）。
        if (claimId) await this.releaseTurn(userId, id, claimId);
        const current = await this.requireSession(userId, id);
        const code = error instanceof Error ? error.message : '';
        if (code.startsWith('LOCAL_')) {
          await this.db.transaction(async (tx) => {
            const [locked] = await tx
              .select()
              .from(councilSessions)
              .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id)))
              .for('update');
            if (!locked?.checkpoint) return;
            const remote = locked.checkpoint.remote;
            await tx
              .update(councilSessions)
              .set({
                status: 'paused',
                error: agentErrorMessage(code, row.language),
                updatedAt: new Date(),
                checkpoint: {
                  ...locked.checkpoint,
                  inflight: undefined,
                  remote:
                    code === 'LOCAL_CANCELLED'
                      ? undefined
                      : remote
                        ? {
                            ...remote,
                            awaitingInput: code === 'LOCAL_INPUT_REQUIRED' || remote.awaitingInput,
                          }
                        : undefined,
                },
              })
              .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id)));
          });
          return;
        }
        if (current.status !== 'running') return;
        if (current.revision !== row.revision) continue;
        const reason = safeAnalysisError(error, row.language);
        await this.publish(
          userId,
          row,
          {
            decision: 'wait',
            summary: reason,
            dissent: [],
            nextReviewCondition:
              row.language === 'en'
                ? 'Resolve the reported issue and continue from this turn; the same task budget applies.'
                : '解决提示的问题后从当前发言继续；仍使用本次讨论的累计预算。',
            evidenceIds: [],
          },
          'llm',
          reason,
        );
      }
    }
    // 循环预算耗尽：会话仍在 running 则暂停，等待用户显式恢复（已完成发言与任务预算保留）。
    const row = await this.requireSession(userId, id);
    if (row.status === 'running') {
      await this.db
        .update(councilSessions)
        .set({
          status: 'paused',
          error:
            row.language === 'en'
              ? 'Steering changed repeatedly. Resume explicitly; completed turns and the task budget are retained.'
              : '引导内容多次变化，已暂停；继续时保留完成的发言和累计预算。',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(councilSessions.owner, userId),
            eq(councilSessions.id, id),
            eq(councilSessions.status, 'running'),
          ),
        );
    }
  }

  /** 在事务内认领当前轮次：校验状态/revision/轮次一致后写入 inflight 标记，返回认领 id。 */
  private async claimTurn(userId: string, row: SessionRow): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)))
        .for('update');
      const checkpoint = current?.checkpoint;
      if (
        !checkpoint ||
        current.status !== 'running' ||
        current.revision !== row.revision ||
        checkpoint.inflight ||
        checkpoint.cycleId !== row.checkpoint?.cycleId ||
        checkpoint.nextTurn !== row.checkpoint.nextTurn
      )
        return null;
      const id = randomUUID();
      await tx
        .update(councilSessions)
        .set({
          checkpoint: {
            ...checkpoint,
            inflight: { id, turn: checkpoint.nextTurn, revision: row.revision },
          },
        })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
      return id;
    });
  }

  /** 按 claimId 条件清除 inflight 认领（仅当仍由本次认领持有时生效）。 */
  private async releaseTurn(userId: string, id: string, claimId: string): Promise<void> {
    await this.db
      .update(councilSessions)
      .set({ checkpoint: sql`${councilSessions.checkpoint} - 'inflight'` })
      .where(
        and(
          eq(councilSessions.owner, userId),
          eq(councilSessions.id, id),
          sql`${councilSessions.checkpoint}->'inflight'->>'id' = ${claimId}`,
        ),
      );
  }

  /** 事务内把成员发言写回：校验认领归属、插入消息、推进 checkpoint；返回是否成功记录。 */
  private async recordTurn(
    userId: string,
    row: SessionRow,
    turn: DialogueTurn,
    claimId: string,
    output: MemberOutput,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)))
        .for('update');
      const checkpoint = current?.checkpoint;
      // 认领已不归属本次执行（被他人接管或周期已变）时放弃写回。
      if (
        !checkpoint ||
        checkpoint.inflight?.id !== claimId ||
        checkpoint.cycleId !== row.checkpoint?.cycleId
      )
        return false;
      // 本地成员：会话已暂停或修订后，丢弃结果并清理认领/远端引用。
      if (
        output.member.executionMode === 'local' &&
        (current.status !== 'running' || current.revision !== row.revision)
      ) {
        await tx
          .update(councilSessions)
          .set({ checkpoint: { ...checkpoint, inflight: undefined, remote: undefined } })
          .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
        return false;
      }
      const contribution = output.contribution;
      await tx.insert(councilMessages).values({
        owner: userId,
        sessionId: row.id,
        role: output.member.role,
        memberName: output.member.name,
        revision: row.revision,
        tokensUsed: output.tokens,
        content: contribution.content,
        metadata: {
          cycleId: checkpoint.cycleId,
          turn: checkpoint.nextTurn,
          phase: turn.phase,
          memberId: output.member.id,
          taskId: output.taskId,
          replyToMessageId: output.replyToMessageId,
          evidenceIds: contribution.evidenceIds,
          reasoningSummary: contribution.reasoningSummary,
          questions: contribution.questions,
        },
      });
      if (output.member.executionMode === 'local')
        await tx
          .update(councilMessages)
          .set({
            metadata: {
              cycleId: checkpoint.cycleId,
              turn: checkpoint.nextTurn,
              phase: turn.phase,
              memberId: output.member.id,
              replyToMessageId: output.replyToMessageId,
              evidenceIds: contribution.evidenceIds,
              reasoningSummary: contribution.reasoningSummary,
              questions: contribution.questions,
              externalAgent: true,
              externalUsageUnknown: output.externalUsageUnknown,
              taskId: output.taskId,
            },
          })
          .where(
            and(
              eq(councilMessages.owner, userId),
              eq(councilMessages.sessionId, row.id),
              sql`${councilMessages.metadata}->>'cycleId' = ${checkpoint.cycleId}`,
              sql`(${councilMessages.metadata}->>'turn')::int = ${checkpoint.nextTurn}`,
            ),
          );
      await tx
        .update(councilSessions)
        .set({
          updatedAt: new Date(),
          ...(output.sources?.length
            ? { evidenceSnapshot: [...current.evidenceSnapshot, ...output.sources].slice(-60) }
            : {}),
          checkpoint: {
            ...checkpoint,
            inflight: undefined,
            remote: undefined,
            nextTurn: checkpoint.nextTurn + (turn.phase === 'summary' ? 0 : 1),
            pendingResearch: turn.phase === 'summary' ? [] : contribution.researchRequests,
          },
        })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
      return true;
    });
  }

  /** 执行单个成员的发言：本地成员走 runAgentMember，模型成员组装上下文后调用 LLM。 */
  private async runMember(
    userId: string,
    row: SessionRow,
    member: CouncilMember,
    turn: DialogueTurn,
  ): Promise<MemberOutput> {
    // 本地成员走独立执行路径。
    if (member.executionMode === 'local') return this.runAgentMember(userId, row, member, turn);
    // 读取全部消息，筛出本轮可引用的讨论上下文。
    const messages = await this.db
      .select()
      .from(councilMessages)
      .where(and(eq(councilMessages.owner, userId), eq(councilMessages.sessionId, row.id)))
      .orderBy(councilMessages.createdAt);
    const discussion = messages.filter(
      (item) =>
        ['researcher', 'challenger', 'manager'].includes(item.role) &&
        !(item.metadata?.cycleId === row.checkpoint?.cycleId && item.metadata?.phase === 'summary'),
    );
    // 组装系统提示词与按预算打包的讨论上下文。
    const systemPrompt = discussionPrompt(turn, row.language, !!row.candidate);
    const data = packDiscussionContext({
      ticker: row.ticker,
      candidate: row.candidate,
      turn,
      config: row.profileSnapshot,
      member,
      evidence: row.evidenceSnapshot,
      systemPrompt,
      userMessages: messages.filter((item) => item.role === 'user').map((item) => item.content),
      currentDiscussion: discussion.filter(
        (item) => item.metadata?.cycleId === row.checkpoint?.cycleId,
      ),
      previousDiscussion: discussion.filter(
        (item) => item.metadata?.cycleId !== row.checkpoint?.cycleId,
      ),
    });
    const prompt = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: JSON.stringify(data) },
    ];
    // 单轮调用预算：最多 900 输出 token、120s 超时、失败不重试。
    const options = {
      taskId: row.taskId,
      purpose: `council:${turn.phase}:${member.id}`,
      maxOutputTokens: 900,
      retryPolicy: 'none' as const,
      timeoutMs: 120_000,
      connectionId: member.connectionId,
      shouldContinue: async () => {
        const latest = await this.requireSession(userId, row.id);
        return latest.status === 'running' && latest.revision === row.revision;
      },
    };
    // 活动事件（queued→running→succeeded/failed）写入会话消息流，供前端展示进度。
    const taskId = `model:${row.checkpoint!.cycleId}:${row.checkpoint!.nextTurn}:${row.revision}`;
    const started = Date.now();
    const activity = (status: ResearchEvent['status'], summary: string) =>
      this.recordActivity(userId, row, {
        id: randomUUID(),
        kind: 'task',
        status,
        summary,
        at: new Date().toISOString(),
        taskId,
        sessionId: row.id,
        memberId: member.id,
        memberName: member.name,
        turn: row.checkpoint!.nextTurn,
        revision: row.revision,
        sequence: 0,
        durationMs: Date.now() - started,
      });
    await activity(
      'queued',
      row.language === 'en' ? 'Preparing the assigned model request' : '正在准备本轮模型请求',
    );
    await activity(
      'running',
      row.language === 'en'
        ? 'Waiting for the model’s research response'
        : '正在等待模型的研究回复',
    );
    // 按成员模型档位调用 LLM 并解析其贡献。
    try {
      const result =
        member.model === 'slow'
          ? await this.llm.chatSlowJSON(prompt, userId, options)
          : await this.llm.chatFastJSON(prompt, userId, options);
      const contribution = parseContribution(
        result.data,
        new Set(data.evidence.map((item) => item.id)),
        turn,
        row.candidate,
      );
      await activity(
        'succeeded',
        row.language === 'en' ? 'Research response received' : '已收到研究回复',
      );
      return {
        member,
        taskId,
        contribution,
        tokens: Number.isFinite(result.tokens) ? Math.max(0, Math.trunc(result.tokens)) : 0,
        replyToMessageId:
          data.conversation.at(-1)?.id ??
          messages.filter((item) => item.role === 'user').at(-1)?.id ??
          null,
      };
    } catch (error) {
      await activity('failed', safeAnalysisError(error, row.language));
      throw error;
    }
  }

  /** 把研究活动事件作为 system 消息写入会话（含 256 条限流与 publicText 脱敏）。 */
  private async recordActivity(
    userId: string,
    row: SessionRow,
    event: ResearchEvent,
    acquisition?: ResearchAcquisition,
  ): Promise<void> {
    if (!row.checkpoint) return;
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)))
        .for('update');
      if (
        !current ||
        current.status !== 'running' ||
        current.revision !== row.revision ||
        current.checkpoint?.cycleId !== row.checkpoint!.cycleId
      )
        return;
      // 每个任务的进度事件上限 256 条。
      const [count] = await tx
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(councilMessages)
        .where(
          and(
            eq(councilMessages.owner, userId),
            eq(councilMessages.sessionId, row.id),
            sql`${councilMessages.metadata}->'researchEvent'->>'taskId' = ${event.taskId}`,
          ),
        );
      if (count.count >= 256) return;
      const safe: ResearchEvent = {
        ...event,
        summary: publicText(event.summary),
        sequence: count.count + 1,
      };
      await tx.insert(councilMessages).values({
        owner: userId,
        sessionId: row.id,
        role: 'system',
        memberName: safe.memberName,
        revision: row.revision,
        content: safe.summary,
        tokensUsed: 0,
        metadata: {
          phase: 'progress',
          cycleId: row.checkpoint!.cycleId,
          researchEvent: safe,
          ...(acquisition ? { acquisition } : {}),
        },
      });
    });
  }

  /** 记录一次资料获取事件（工具调用动态），供前端展示研究进度。 */
  private async recordAcquisition(
    userId: string,
    row: SessionRow,
    acquisition: ResearchAcquisition,
  ): Promise<void> {
    if (!row.checkpoint) return;
    const taskId = `evidence:${row.checkpoint.cycleId}:${row.revision}`;
    const callId = createHash('sha256')
      .update(`${acquisition.source}:${acquisition.kind ?? 'initial'}`)
      .digest('hex')
      .slice(0, 24);
    await this.recordActivity(
      userId,
      row,
      {
        id: randomUUID(),
        kind: 'tool',
        taskId,
        callId,
        sequence: 0,
        sessionId: row.id,
        revision: row.revision,
        memberId: 'research-tools',
        memberName: row.language === 'en' ? 'Research tools' : '资料检索',
        turn: row.checkpoint.nextTurn,
        toolName: acquisition.kind ?? 'research',
        at: new Date().toISOString(),
        status:
          acquisition.status === 'started'
            ? 'running'
            : acquisition.status === 'failed'
              ? 'failed'
              : acquisition.status === 'skipped'
                ? 'unavailable'
                : 'succeeded',
        summary: `${acquisition.source} · ${acquisition.detail}`,
      },
      { ...acquisition, detail: publicText(acquisition.detail, 1000) },
    );
  }

  /** 校验成员配置：远端成员的连接 id 必须有效，本地成员的智能体配置必须可用。 */
  private async validateMembers(userId: string, members: CouncilMember[]): Promise<void> {
    await this.llm.validateConnectionIds(
      userId,
      members.flatMap((member) =>
        member.executionMode !== 'local' && member.connectionId ? [member.connectionId] : [],
      ),
    );
    // 本地成员逐个校验智能体及其设置。
    for (const member of members.filter((item) => item.executionMode === 'local')) {
      if (!this.localAgents || !member.agentId)
        throw new BadRequestException('Local agent service unavailable');
      try {
        await this.localAgents.validate(userId, member.agentId, member.agentSettings);
      } catch (error) {
        if (error instanceof LocalAgentError) throw new BadRequestException(error.code);
        throw error;
      }
    }
  }

  /** 依据本地成员占比返回报告引擎标记：local / mixed / llm。 */
  private executionEngine(members: CouncilMember[]): CouncilReport['engine'] {
    const count = members.filter((member) => member.executionMode === 'local').length;
    return count === members.length ? 'local' : count ? 'mixed' : 'llm';
  }

  /** 本地智能体成员的执行路径：管理远端任务引用、派发与结果归一化。 */
  private async runAgentMember(
    userId: string,
    row: SessionRow,
    member: CouncilMember,
    turn: DialogueTurn,
  ): Promise<MemberOutput> {
    if (!this.localAgents || !member.agentId || !row.checkpoint)
      throw new Error('LOCAL_UNAVAILABLE');
    // 读取已保存的远端任务引用，判断是续传（awaitingInput）还是新派发。
    const current = await this.requireSession(userId, row.id);
    const saved = current.checkpoint?.remote;
    const messages = await this.db
      .select()
      .from(councilMessages)
      .where(and(eq(councilMessages.owner, userId), eq(councilMessages.sessionId, row.id)))
      .orderBy(councilMessages.createdAt);
    const lastUserMessageId = messages.filter((message) => message.role === 'user').at(-1)?.id;
    const resumeInput =
      saved?.awaitingInput === true && lastUserMessageId !== saved.lastUserMessageId;
    // 已派发但 taskId 缺失、轮次或成员不匹配：派发结果不确定，必须停止而非重发。
    if (
      saved &&
      ((!saved.taskId && saved.dispatchStarted) ||
        saved.turn !== row.checkpoint.nextTurn ||
        saved.agentId !== member.agentId)
    )
      throw new Error('LOCAL_DISPATCH_UNCERTAIN');
    // 组装远端任务引用（续传时刷新 messageId），并落库供崩溃后恢复。
    const remote = resumeInput
      ? { ...saved!, messageId: randomUUID(), revision: row.revision, dispatchStarted: false }
      : (saved ?? {
          agentId: member.agentId,
          messageId: randomUUID(),
          turn: row.checkpoint.nextTurn,
          revision: row.revision,
          dispatchStarted: false,
          lastUserMessageId,
        });
    if (!saved || resumeInput)
      await this.db
        .update(councilSessions)
        .set({ checkpoint: { ...current.checkpoint!, remote } })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
    // 下发任务给本地智能体；onDispatch/onTask 回调持久化派发状态，shouldContinue 感知暂停/修订。
    const result = await this.localAgents.execute(userId, {
      agentId: member.agentId,
      messageId: remote.messageId,
      researchScope: {
        sessionId: row.id,
        revision: row.revision,
        memberId: member.id,
        memberName: member.name,
        turn: row.checkpoint.nextTurn,
        ticker: row.ticker,
        language: row.language,
        webResearch: row.profileSnapshot.council?.webResearch === true,
        expiresAt: Date.now() + 600_000,
      },
      agentSettings: member.agentSettings,
      remoteTaskId: remote.taskId,
      contextId: remote.contextId,
      resumeInput,
      prompt: agentAssignment({
        ticker: row.ticker,
        language: row.language,
        member,
        turn,
        candidate: row.candidate,
        messages: messages.filter((message) => message.role !== 'system'),
        evidence: row.evidenceSnapshot,
      }),
      onDispatch: async () => {
        const dispatched = {
          ...remote,
          lastUserMessageId,
          awaitingInput: false,
          dispatchStarted: true,
        };
        const marked = await this.db
          .update(councilSessions)
          .set({
            checkpoint: sql`jsonb_set(${councilSessions.checkpoint}, '{remote}', (${councilSessions.checkpoint}->'remote') || ${JSON.stringify(dispatched)}::jsonb)`,
          })
          .where(
            and(
              eq(councilSessions.owner, userId),
              eq(councilSessions.id, row.id),
              eq(councilSessions.status, 'running'),
              eq(councilSessions.revision, row.revision),
              sql`${councilSessions.checkpoint}->'remote'->>'messageId' = ${remote.messageId}`,
            ),
          )
          .returning({ id: councilSessions.id });
        if (!marked.length) throw new LocalAgentError('LOCAL_PAUSED');
      },
      onTask: async (ref) => {
        await this.db.transaction(async (tx) => {
          const [latest] = await tx
            .select()
            .from(councilSessions)
            .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)))
            .for('update');
          if (latest?.checkpoint?.remote?.messageId !== remote.messageId)
            throw new Error('LOCAL_PAUSED');
          await tx
            .update(councilSessions)
            .set({
              checkpoint: {
                ...latest.checkpoint,
                remote: {
                  ...remote,
                  ...ref,
                  lastUserMessageId,
                  awaitingInput: false,
                  dispatchStarted: true,
                },
              },
            })
            .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
        });
      },
      // 结构化任务动态改从持久化日志读取；这里不再重复写入通用聊天行。
      onProgress: async () => undefined,
      shouldContinue: async () => {
        const latest = await this.requireSession(userId, row.id);
        return latest.status === 'running' && latest.revision === row.revision;
      },
    });
    try {
      return {
        member,
        ...agentContribution(result, row.evidenceSnapshot, turn, row.candidate, row.language),
        taskId: result.taskId,
        tokens: result.usageTokens ?? 0,
        externalUsageUnknown: result.usageTokens === null,
        replyToMessageId: messages.filter((item) => item.role !== 'system').at(-1)?.id ?? null,
      };
    } catch {
      throw new LocalAgentError('LOCAL_INVALID_RESULT');
    }
  }

  /** 执行待处理的研究请求：每轮最多两类，事务内出队并登记类别后调用证据服务。 */
  private async runResearch(userId: string, row: SessionRow): Promise<void> {
    for (let count = 0; count < 2; count++) {
      // 事务内取出队头请求并登记类别（超限或重复类别则标记为不允许）。
      const request = await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(councilSessions)
          .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)))
          .for('update');
        const checkpoint = current?.checkpoint;
        if (
          current?.status !== 'running' ||
          checkpoint?.cycleId !== row.checkpoint?.cycleId ||
          !checkpoint.pendingResearch.length
        )
          return null;
        const [next, ...rest] = checkpoint.pendingResearch;
        const allowed =
          checkpoint.toolKindsUsed.length < 2 &&
          !checkpoint.toolKindsUsed.includes(next.kind) &&
          (next.kind !== 'web' || current.profileSnapshot.council?.webResearch === true);
        await tx
          .update(councilSessions)
          .set({
            checkpoint: {
              ...checkpoint,
              pendingResearch: rest,
              toolKindsUsed: allowed
                ? [...checkpoint.toolKindsUsed, next.kind]
                : checkpoint.toolKindsUsed,
            },
          })
          .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
        return { ...next, allowed };
      });
      if (!request) return;
      // 类别不允许（已查过/未启用/超限）时记录跳过事件。
      if (!request.allowed) {
        await this.recordAcquisition(userId, row, {
          source: 'Research tools',
          kind: request.kind,
          status: 'skipped',
          detail:
            row.language === 'en'
              ? 'This category was already checked, is disabled, or the two-category round limit was reached.'
              : '该类资料已检索、未启用，或已达到本轮两类资料的上限。',
        });
        continue;
      }
      // 调用证据服务收集资料；随后合并进证据快照（同类旧资料移入归档）。
      try {
        const collected = await this.evidence.collectResearch(
          row.ticker,
          userId,
          request.kind,
          row.language,
          {
            taskId: row.taskId,
            query: request.query,
            webResearch: row.profileSnapshot.council?.webResearch ?? false,
            onAcquisition: (event) => this.recordAcquisition(userId, row, event),
            shouldContinue: async () => {
              const latest = await this.requireSession(userId, row.id);
              return (
                latest.status === 'running' &&
                latest.checkpoint?.cycleId === row.checkpoint?.cycleId
              );
            },
          },
        );
        if (!collected.length) {
          await this.recordAcquisition(userId, row, {
            source: 'Research tools',
            kind: request.kind,
            status: 'skipped',
            detail:
              row.language === 'en'
                ? 'No new facts were returned; existing evidence and gaps are retained.'
                : '未返回新资料，保留现有证据和数据缺口。',
          });
          continue;
        }
        await this.db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(councilSessions)
            .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)))
            .for('update');
          if (current?.checkpoint?.cycleId !== row.checkpoint?.cycleId) return;
          const fresh = collected.map((item) => ({
            ...item,
            ...(request.kind === 'web'
              ? { evidenceType: 'other' as const, role: 'news' as const }
              : {}),
            id:
              current.evidenceSnapshot.find(
                (existing) =>
                  existing.title === item.title &&
                  existing.content === item.content &&
                  existing.sourceName === item.sourceName &&
                  existing.sourceUrl === (item.sourceUrl ?? null),
              )?.id ?? randomUUID(),
            sourceUrl: item.sourceUrl ?? null,
            sourceName: item.sourceName ?? null,
            fetchedAt: new Date().toISOString(),
            researchKind: request.kind,
          }));
          const retained = current.evidenceSnapshot.filter(
            (item) => evidenceKind(item) !== request.kind,
          );
          const archive = [
            ...(current.checkpoint.evidenceArchive ?? []),
            ...current.evidenceSnapshot.filter(
              (item) =>
                evidenceKind(item) === request.kind &&
                item.sourceName !== 'Data Unavailable' &&
                !fresh.some((next) => next.id === item.id),
            ),
          ];
          await tx
            .update(councilSessions)
            .set({
              evidenceSnapshot: [...fresh, ...retained].slice(0, 40),
              checkpoint: {
                ...current.checkpoint,
                evidenceArchive: [...new Map(archive.map((item) => [item.id, item])).values()],
              },
            })
            .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
        });
      } catch {
        await this.recordAcquisition(userId, row, {
          source: 'Research tools',
          kind: request.kind,
          status: 'failed',
          detail:
            row.language === 'en'
              ? 'The requested source could not complete; existing evidence and gaps are retained.'
              : '请求的数据源未能完成检索，保留现有证据与数据缺口。',
        });
      }
    }
  }

  /** 发布委员会报告：汇总预算用量与历史证据，写入报告并把会话置为 completed/failed。 */
  private async publish(
    userId: string,
    row: SessionRow,
    opinion: CouncilOpinion,
    engine: CouncilReport['engine'],
    error: string | null,
    researchStance: CouncilReport['researchStance'] = null,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(councilSessions)
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)))
        .for('update');
      if (!current || current.status !== 'running' || current.revision !== row.revision)
        return false;
      const [latest] = await tx
        .select({ version: councilReports.version })
        .from(councilReports)
        .where(and(eq(councilReports.owner, userId), eq(councilReports.sessionId, row.id)))
        .orderBy(desc(councilReports.version))
        .limit(1);
      // 汇总本次任务预算用量与外部智能体消息 token（写入报告 tokensUsed）。
      const [usage] = await tx
        .select({ total: sql<number>`coalesce(sum(${llmBudgetUsage.chargedTokens}), 0)` })
        .from(llmBudgetUsage)
        .where(and(eq(llmBudgetUsage.owner, userId), eq(llmBudgetUsage.taskId, row.taskId)));
      const [external] = await tx
        .select({ total: sql<number>`coalesce(sum(${councilMessages.tokensUsed}), 0)` })
        .from(councilMessages)
        .where(
          and(
            eq(councilMessages.owner, userId),
            eq(councilMessages.sessionId, row.id),
            sql`${councilMessages.metadata}->>'externalAgent' = 'true'`,
          ),
        );
      const historical = (current.checkpoint?.evidenceArchive ?? [])
        .filter((item) => !row.evidenceSnapshot.some((fact) => fact.id === item.id))
        .map((item) => ({
          ...item,
          title: (row.language === 'en' ? 'Earlier source: ' : '本轮较早资料：') + item.title,
        }));
      // 写入新版报告（版本号在上一份基础上递增）。
      await tx.insert(councilReports).values({
        owner: userId,
        sessionId: row.id,
        version: (latest?.version ?? 0) + 1,
        revision: row.revision,
        decision: opinion.decision,
        summary: opinion.summary,
        dissent: opinion.dissent,
        nextReviewCondition: opinion.nextReviewCondition,
        sourceRunId: row.sourceRunId,
        candidate: row.candidate,
        engine,
        researchStance,
        tokensUsed: Math.min(
          2_147_483_647,
          Number(usage?.total ?? 0) + Number(external?.total ?? 0),
        ),
        evidence: [...row.evidenceSnapshot, ...historical].map(
          ({ id, title, content, sourceUrl, fetchedAt }) => ({
            id,
            title,
            content,
            sourceUrl,
            fetchedAt,
          }),
        ),
      });
      // 关闭会话：正常完成把 checkpoint 推进到末尾；失败保留现场等待恢复。
      await tx
        .update(councilSessions)
        .set({
          status: error ? 'failed' : 'completed',
          error,
          updatedAt: new Date(),
          ...(error || !current.checkpoint
            ? {}
            : {
                checkpoint: {
                  ...current.checkpoint,
                  nextTurn: current.checkpoint.turns.length,
                  pendingResearch: [],
                  inflight: undefined,
                },
              }),
        })
        .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, row.id)));
      return true;
    });
  }

  /** 组装讨论所需的证据快照：优先复用近期研究报告，否则现场采集，并附组合与规则证据。 */
  private async collectSnapshot(
    userId: string,
    ticker: string,
    language: 'zh-CN' | 'en',
    config: BuilderConfig,
    candidate: CouncilCandidate | null,
    fresh = false,
    session?: SessionRow,
  ): Promise<ResearchSnapshot> {
    const evidence: CouncilEvidence[] = [];
    let sourceRunId: string | null = null;
    const now = new Date().toISOString();
    // 委派型团队自行收集资料：下发任务前不运行旧版采集器。
    if (this.members(config).every((member) => member.executionMode === 'local'))
      return { evidence, sourceRunId };
    // 非强制刷新时优先复用 48h 内已完成的现有研究报告。
    if (!fresh)
      try {
        const runs = await this.research.listRuns(userId, {
          ticker,
          status: 'completed',
          limit: 1,
        });
        const latest = runs.items[0];
        if (
          latest &&
          Date.now() - Date.parse(latest.completedAt ?? latest.createdAt) < 48 * 3600_000
        ) {
          const saved = await this.research.getEvidence(userId, latest.id);
          if (saved.length && !saved.some((item) => item.sourceName === 'Data Unavailable')) {
            sourceRunId = latest.id;
            evidence.push(
              ...saved.map((item) => ({
                ...item,
                relevanceScore: Number(item.relevanceScore ?? 0),
              })),
            );
          }
        }
      } catch {
        // 保存的报告缺失时不得阻断直接采集；记录告警后继续。
        this.logger.warn('Council saved research unavailable; collecting fresh evidence');
      }
    // 组合上下文；获取失败时写入“数据不可用”证据但不中断研究。
    let portfolio: Awaited<ReturnType<PortfolioContextService['getPortfolioContext']>> | null =
      null;
    try {
      portfolio = await this.portfolio.getPortfolioContext(userId);
    } catch {
      evidence.push({
        id: randomUUID(),
        role: 'fundamental',
        evidenceType: 'other',
        title: language === 'en' ? 'Current portfolio data unavailable' : '当前组合数据不可用',
        content:
          language === 'en'
            ? 'Portfolio valuation or FX could not be verified. Stock research continues; portfolio sizing is withheld.'
            : '组合估值或汇率暂时无法核实。个股研究仍会继续，暂不计算组合仓位建议。',
        sourceName: 'Data Unavailable',
        sourceUrl: null,
        fetchedAt: now,
        relevanceScore: 0,
      });
    }
    // 没有可复用的报告时，直接向数据源采集个股证据。
    if (!sourceRunId) {
      try {
        const collected = await this.evidence.collectEvidence(
          ticker,
          userId,
          portfolio,
          language,
          session
            ? {
                taskId: session.taskId,
                webResearch: config.council?.webResearch ?? false,
                onAcquisition: (event) => this.recordAcquisition(userId, session, event),
                shouldContinue: async () => {
                  const current = await this.requireSession(userId, session.id);
                  return (
                    current.status === 'running' &&
                    current.checkpoint?.cycleId === session.checkpoint?.cycleId
                  );
                },
              }
            : undefined,
        );
        evidence.push(
          ...collected.map((item) => ({
            ...item,
            id: randomUUID(),
            sourceUrl: item.sourceUrl ?? null,
            sourceName: item.sourceName ?? null,
            fetchedAt: now,
          })),
        );
      } catch {
        evidence.push({
          id: randomUUID(),
          role: 'fundamental',
          evidenceType: 'other',
          title: language === 'en' ? 'Stock research data unavailable' : '个股研究数据不可用',
          content:
            language === 'en'
              ? 'Stock data collection failed. Check the data provider and retry.'
              : '个股数据采集失败，请检查金融数据服务后重试。',
          sourceName: 'Data Unavailable',
          sourceUrl: null,
          fetchedAt: now,
          relevanceScore: 0,
        });
      }
    }
    // 附上组合快照证据（仅含当前标的持仓）。
    if (portfolio) {
      evidence.push({
        id: randomUUID(),
        role: 'fundamental',
        evidenceType: 'other',
        title: language === 'en' ? 'Current portfolio snapshot (USD)' : '当前组合快照（美元）',
        content: JSON.stringify({
          totalValue: portfolio.totalValue,
          cash: portfolio.cash,
          holdings: portfolio.holdings.filter((holding) => holding.ticker.toUpperCase() === ticker),
        }),
        sourceName: 'Portfolio Data',
        sourceUrl: null,
        fetchedAt: now,
        relevanceScore: 1,
      });
    }
    // 规则型 candidate 附上投资者价格规则与扫描报价证据。
    if (isRuleCandidate(config, candidate)) {
      const rule = config.priceRules.find((item) => item.ticker.toUpperCase() === ticker);
      evidence.push({
        id: randomUUID(),
        role: 'fundamental',
        evidenceType: 'other',
        title:
          language === 'en'
            ? 'Investor-authored price rule (not an AI forecast)'
            : '投资者自设价格规则（非 AI 预测）',
        content: JSON.stringify(rule),
        sourceName: 'Investor configuration',
        sourceUrl: null,
        fetchedAt: now,
        relevanceScore: 1,
      });
      evidence.push({
        id: randomUUID(),
        role: 'technical',
        evidenceType: 'price',
        title: language === 'en' ? 'Paper scanner candidate quote' : '模拟交易扫描报价',
        content: JSON.stringify({
          ticker,
          price: candidate.price,
          side: candidate.side,
          quantity: candidate.quantity,
        }),
        sourceName: 'Paper scan quote',
        sourceUrl: null,
        fetchedAt: now,
        relevanceScore: 1,
      });
    }
    return { evidence: evidence.slice(0, 40), sourceRunId };
  }

  /** 新建会话行：档案快照与证据快照在创建时固化。 */
  private async insertSession(
    userId: string,
    profile: { id: string | null; version: number; config: BuilderConfig },
    ticker: string,
    language: 'zh-CN' | 'en',
    candidate: CouncilCandidate | null = null,
    snapshot: ResearchSnapshot = { evidence: [], sourceRunId: null },
    key: string | null = null,
  ): Promise<SessionRow> {
    const [row] = await this.db
      .insert(councilSessions)
      .values({
        owner: userId,
        profileId: profile.id,
        profileVersion: profile.version,
        profileSnapshot: profile.config,
        ticker,
        language,
        candidate,
        evidenceSnapshot: snapshot.evidence,
        sourceRunId: snapshot.sourceRunId,
        cacheKey: key,
      })
      .returning();
    return row;
  }

  /** 读取并规范化 agent 档案；不存在时抛 404。 */
  private async getProfile(userId: string, id: string): Promise<BuilderProfile> {
    this.assertId(id);
    const [row] = await this.db
      .select()
      .from(builderProfiles)
      .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.id, id)));
    if (!row) throw new NotFoundException('Agent profile not found');
    return {
      id: row.id,
      config: normalizeBuilderConfig(row.config as BuilderConfig),
      status: row.status as BuilderProfile['status'],
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** 从档案配置解析研究团队成员列表。 */
  private members(config: BuilderConfig): CouncilMember[] {
    return normalizeCouncil(config.council).members;
  }

  /** 读取属主匹配的会话行；不存在时抛 404。 */
  private async requireSession(userId: string, id: string): Promise<SessionRow> {
    this.assertId(id);
    const [row] = await this.db
      .select()
      .from(councilSessions)
      .where(and(eq(councilSessions.owner, userId), eq(councilSessions.id, id)));
    if (!row) throw new NotFoundException('Council session not found');
    return row;
  }

  /** 组装对外会话视图：消息、报告、合并后的研究事件流与进度。 */
  private async hydrate(userId: string, row: SessionRow): Promise<CouncilSession> {
    const [messages, reports] = await Promise.all([
      this.db
        .select()
        .from(councilMessages)
        .where(and(eq(councilMessages.owner, userId), eq(councilMessages.sessionId, row.id)))
        .orderBy(councilMessages.createdAt),
      this.db
        .select()
        .from(councilReports)
        .where(and(eq(councilReports.owner, userId), eq(councilReports.sessionId, row.id)))
        .orderBy(councilReports.version),
    ]);
    const activity = this.localAgents?.store
      ? await this.localAgents.store.eventsForSession(userId, row.id)
      : undefined;
    const events = [
      ...(activity?.events ?? []),
      ...messages.flatMap((message) =>
        message.metadata?.researchEvent ? [message.metadata.researchEvent] : [],
      ),
    ].sort((a, b) => a.at.localeCompare(b.at) || a.sequence - b.sequence);
    return {
      id: row.id,
      profileId: row.profileId,
      profileVersion: row.profileVersion,
      researchEvents: events.slice(-2048),
      researchEventsTruncated: activity?.truncated || events.length > 2048,
      ticker: row.ticker,
      language: row.language,
      status: row.status,
      revision: row.revision,
      messages: messages.map(
        ({ id, role, memberName, content, revision, tokensUsed, createdAt, metadata }) => ({
          id,
          role,
          memberName,
          content,
          revision,
          tokensUsed,
          createdAt: createdAt.toISOString(),
          ...(metadata
            ? {
                memberId: metadata.memberId,
                phase: metadata.phase,
                replyToMessageId: metadata.replyToMessageId,
                evidenceIds: metadata.evidenceIds,
                reasoningSummary: metadata.reasoningSummary,
                questions: metadata.questions,
                acquisition: metadata.acquisition,
                externalAgent: metadata.externalAgent,
                externalUsageUnknown: metadata.externalUsageUnknown,
                taskId: metadata.taskId,
              }
            : {}),
        }),
      ),
      reports: reports.map((report) => ({
        ...this.mapReport(report),
        externalUsageUnknown: messages.some(
          (message) =>
            message.createdAt <= report.createdAt &&
            message.metadata?.externalUsageUnknown === true,
        ),
      })),
      error: row.error,
      members: this.members(row.profileSnapshot),
      webResearch: row.profileSnapshot.council?.webResearch ?? false,
      progress:
        row.checkpoint && row.checkpoint.nextTurn < row.checkpoint.turns.length
          ? {
              phase: row.checkpoint.turns[row.checkpoint.nextTurn].phase,
              memberId: row.checkpoint.turns[row.checkpoint.nextTurn].memberId,
              turn: row.checkpoint.nextTurn + 1,
              totalTurns: row.checkpoint.turns.length,
            }
          : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** 数据库报告行 → API 报告 DTO。 */
  private mapReport(row: ReportRow): CouncilReport {
    return {
      id: row.id,
      version: row.version,
      revision: row.revision,
      decision: row.decision,
      summary: row.summary,
      dissent: row.dissent,
      nextReviewCondition: row.nextReviewCondition,
      evidence: row.evidence,
      sourceRunId: row.sourceRunId,
      candidate: row.candidate,
      paperOrderId: row.paperOrderId,
      tokensUsed: row.tokensUsed,
      engine: row.engine,
      createdAt: row.createdAt.toISOString(),
      researchStance: row.researchStance,
    };
  }

  /** 校验 UUID 形态的标识符，防止任意字符串被拼进路由/查询。 */
  private assertId(value: unknown): asserts value is string {
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ) {
      throw new BadRequestException('Invalid identifier');
    }
  }

  /** 规范化股票代码，失败时转换为 BadRequest。 */
  private validateTicker(value: unknown): string {
    try {
      return normalizeTicker(value);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid ticker');
    }
  }
}
