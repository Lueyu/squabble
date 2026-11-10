import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import * as tables from '../../database/channel.schema';
import { cashAccounts, holdings, paperAccounts, paperPositions } from '../../database/schema';
import { councilMessages, councilSessions } from '../../database/council.schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { simulationCash } from '../../database/simulation-experiments.schema';
import { userInvestmentStrategies } from '../../database/user-investment-strategies.schema';
import { QuoteService } from '../quote/quote.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { channelAssignments, readChannelRuntime, readRuntimeInSnapshot, sumChannelDecimals } from './channel-runtime';
import { ChannelMemoryService } from './channel-memory.service';
import { syncChannelExecutions } from './channel-executions';
import { builtinChannelTemplates } from './channel-templates';
import { TemplateRegistry } from './template-registry';
import { assertSemanticDelta, canPublish, renderApprovedFinding, sealFinding, type ChannelPublicationContext } from './channel-contract';
import { renderRegisteredTemplate, resolveAuthoritativeSlots } from './channel-slots';
import type { BackgroundFinding, ChannelAction, ChannelBubble, ChannelEpisode, ChannelEvent, ChannelEvidenceCard, ChannelFact, ChannelProjection, ChannelRuntimeSnapshot, ChannelSpeaker, ChannelStance, ChannelVibe, ChannelWeight, DeferredQuestion, FindingCandidate, SupplementRequest } from '../../../shared/channel.interface';
import type { ConfirmedInvestmentStrategy } from '../../../shared/user-investment-strategy.interface';

type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type ReadDb = Pick<PostgresJsDatabase, 'select' | 'insert' | 'update' | 'execute'>;
export const channelHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ChannelReportInput {
  id: string; revision: number; title: string; content: string; createdAt: string;
  sections?: Array<{ id: string; title?: string; content?: string }>;
  source?: Record<string, unknown>;
}
export interface ChannelPublicationInput {
  accountId?: string; accountName?: string;
  runtimeAuthority?: { accountId: string; strategyId: string; strategyRevision: number; entryId: string };
  episodeId: string; entityId: string; title: string; eventKind: ChannelEvent['kind']; semanticDeltaId: string;
  facts: Array<{ fact: ChannelFact; card: ChannelEvidenceCard }>;
  templateId: string; stance: ChannelStance; weight: ChannelWeight; layer: 2 | 3 | 4;
  posture: ChannelBubble['posture']; evidence: ChannelEvidenceCard;
  reportAnchor?: { reportId: string; reportRevision: number; sectionId: string };
  action?: ChannelAction[]; priorOwnBubbleId?: string; relationshipMemoryIds?: string[]; correctionOf?: string; speaker?: ChannelSpeaker; thesis?: { id: string; revision: number };
  deliveryCause?: ChannelBubble['deliveryCause']; briefId?: string; templateRevision?: number;
}
const requestSchema = z.object({ message: z.string().trim().min(1).max(4000), requestKey: z.string().min(1).max(150),
  accountId: z.string().uuid().optional(), selectedQuestionId: z.string().max(100).optional(), context: z.record(z.string(), z.unknown()).optional() }).strict();

/** Freeze independent questions before selecting a tool; conjunctions must not hide a second fact. */
export function splitChannelQuestions(message: string): string[] {
  const knownFact = /现价|股价|价格|现金|余额|多少股|持股|数量|毛利率|净利润|营业收入|营收|资产负债率|净资产|总资产|上次|之前|EPS|price|quote|cash|shares|position/iu;
  return message.split(/[？?\n]+/u).map(s => s.trim()).filter(Boolean).flatMap(sentence => {
    const parts = sentence.split(/\s*(?:以及|同时|另外|并且|还有|和|及|\band\b)\s*/iu).map(p => p.trim()).filter(Boolean);
    return parts.length > 1 && (parts.filter(p => knownFact.test(p)).length >= 2 || (sentence.match(/\b[A-Z][A-Z0-9.\-]{0,14}\b/gu)?.length ?? 0) > 1 && knownFact.test(sentence)) ? parts : [sentence];
  });
}

@Injectable()
export class ChannelService implements OnModuleInit {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase, private readonly quotes: QuoteService,
    @Optional() @Inject('CHANNEL_COMPILER_VERSION') private readonly compilerVersion = 'channel-contract-v1',
    @Optional() private readonly memory?: ChannelMemoryService) {}

  async onModuleInit() {
    for (const template of builtinChannelTemplates()) await this.db.insert(tables.channelTemplateRegistry)
      .values({ id: template.id, revision: template.revision, data: template }).onConflictDoNothing();
    await this.recoverInterruptedSupplements();
  }
  private async preferences(owner: string, tx: ReadDb = this.db) {
    const inserted = await tx.insert(tables.channelPreferences).values({ owner }).onConflictDoNothing().returning();
    if (inserted.length) {
      const traits = [
        ['laozhou', '只对事前风险、保护线观察和自己的判断修正开口；不夸收益，不借宏观闲聊制造压力。'],
        ['ajie', '只报告已经满足的机会条件和可核验的模拟执行结果；不以意向冒充成交。'],
        ['xiaoqi', '只核对资料、口径和来源；没有取得依据就明说缺口。'],
      ] as const;
      for (const [speaker, content] of traits) {
        const id = channelHash([owner, 'persona_trait_v1', speaker]);
        await tx.insert(tables.channelMemories).values({ id, owner, data: { id, ownerId: owner, speaker, kind: 'persona_trait', content, recordedAt: new Date().toISOString() } }).onConflictDoNothing();
      }
    }
    return (await tx.select().from(tables.channelPreferences).where(eq(tables.channelPreferences.owner, owner)))[0];
  }
  async savePreferences(owner: string, body: unknown) {
    const parsed = z.object({ vibe: z.enum(['quiet', 'deskmate', 'chatty']) }).strict().safeParse(body);
    if (!parsed.success) throw new BadRequestException('INVALID_CHANNEL_PREFERENCES');
    await this.preferences(owner);
    await this.db.update(tables.channelPreferences).set({ vibe: parsed.data.vibe, updatedAt: new Date() }).where(eq(tables.channelPreferences.owner, owner));
    return { vibe: parsed.data.vibe };
  }
  async projection(owner: string, accountId?: string): Promise<ChannelProjection & { userMessages: Array<{ id: string; text: string; createdAt: string; requestId: string }>; notifications: Array<{ id: string; bubbleId: string }> }> {
    const [preferences, runtime, episodeRows, bubbleRows, reportRows, deferred, requests, running, findings, notifications] = await Promise.all([
      this.db.select().from(tables.channelPreferences).where(eq(tables.channelPreferences.owner, owner))
        .then(rows => rows[0] ?? { vibe: 'deskmate' as const, pinnedBubbleId: null }), readChannelRuntime(this.db, owner, accountId),
      this.db.select().from(tables.channelEpisodes).where(eq(tables.channelEpisodes.owner, owner)).orderBy(desc(tables.channelEpisodes.updatedAt)).limit(40),
      this.db.select().from(tables.channelBubbles).where(eq(tables.channelBubbles.owner, owner)).orderBy(desc(tables.channelBubbles.createdAt)).limit(150),
      this.db.select().from(tables.channelReports).where(eq(tables.channelReports.owner, owner)).orderBy(desc(tables.channelReports.createdAt)).limit(1),
      this.db.select().from(tables.channelDeferredQuestions).where(eq(tables.channelDeferredQuestions.owner, owner)).orderBy(desc(tables.channelDeferredQuestions.createdAt)).limit(100),
      this.db.select().from(tables.channelSupplementRequests).where(eq(tables.channelSupplementRequests.owner, owner)).orderBy(desc(tables.channelSupplementRequests.createdAt)).limit(50),
      this.db.select().from(councilSessions).where(and(isNull(councilSessions.deletedAt), eq(councilSessions.owner, owner), eq(councilSessions.status, 'running'))),
      this.db.select().from(tables.channelFindings).where(eq(tables.channelFindings.owner, owner)).limit(100),
      this.db.select().from(tables.channelOutbox).where(and(eq(tables.channelOutbox.owner, owner), eq(tables.channelOutbox.destination, 'notification'), eq(tables.channelOutbox.state, 'pending'))).orderBy(desc(tables.channelOutbox.createdAt)).limit(20),
    ]);
    const belongs = (bubble: ChannelBubble) => bubble.episodeId.startsWith('question:')
      ? (bubble.accountId ?? null) === runtime.accountId : !bubble.accountId || bubble.accountId === runtime.accountId;
    const visibleRows = bubbleRows.filter(row => belongs(row.data));
    const questionBelongs = (question: { accountId?: string }) => (question.accountId ?? null) === runtime.accountId;
    const staleReports = await this.db.select({ id: tables.channelReports.id, revision: tables.channelReports.revision }).from(tables.channelReports).where(and(eq(tables.channelReports.owner, owner), sql`${tables.channelReports.source}->>'supersededBy' IS NOT NULL`));
    const decorate = (bubble: ChannelBubble): ChannelBubble => ({ ...bubble, sourceState: bubbleRows.some(row => row.data.correctionOf === bubble.id) ? 'corrected' : bubble.anchors.primary.kind === 'report_section' && staleReports.some(r => bubble.anchors.primary.kind === 'report_section' && r.id === bubble.anchors.primary.reportId && r.revision === bubble.anchors.primary.reportRevision) ? 'superseded' : 'current' });
    const pending = (await this.pending(owner)).items.filter(belongs).map(decorate).filter(b => b.sourceState !== 'superseded'), pinned = pending.find(b => b.id === preferences.pinnedBubbleId) ?? pending[0];
    return { runtime, vibe: preferences.vibe, pinned: pinned ?? null, pendingCount: pending.length,
      episodes: episodeRows.map(row => ({ episode: row.data, bubbles: visibleRows.filter(b => b.episodeId === row.id && b.data.weight !== 'tap').map(b => decorate(b.data)).reverse() })).filter(e => e.bubbles.length),
      visibleTaps: visibleRows.filter(b => b.data.weight === 'tap').map(b => decorate(b.data)).filter(b => b.sourceState !== 'superseded').slice(0, preferences.vibe === 'chatty' ? 3 : preferences.vibe === 'quiet' ? 1 : 2).reverse(),
      progress: { runningCount: running.length + requests.filter(r => questionBelongs(r.data) && r.data.status === 'running').length, gapCount: findings.filter(f => f.data.kind === 'material_gap' && f.data.review.state === 'approved').length },
      report: reportRows[0] ? { id: reportRows[0].id, title: reportRows[0].title, createdAt: reportRows[0].createdAt.toISOString(), href: `/analysis/reports/${encodeURIComponent(reportRows[0].id)}` } : null,
      deferredQuestions: deferred.filter(q => questionBelongs(q.data) && q.data.status === 'pending').map(q => q.data), sourcesAvailable: Boolean(reportRows.length || bubbleRows.some(b => b.data.evidence.sources.length)),
      userMessages: requests.filter(r => questionBelongs(r.data)).map(r => ({ id: r.data.userMessageId, text: r.message, createdAt: r.createdAt.toISOString(), requestId: r.id })).reverse(),
      notifications: notifications.filter(n => visibleRows.some(b => b.id === n.bubbleId)).map(n => ({ id: n.id, bubbleId: n.bubbleId })),
    };
  }
  async pending(owner: string, accountId?: string) {
    if (accountId) {
      if (!z.string().uuid().safeParse(accountId).success) throw new BadRequestException('INVALID_ACCOUNT_ID');
      const [account] = await this.db.select({ id: paperAccounts.id }).from(paperAccounts)
        .where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
      if (!account) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    }
    const rows = await this.db.select().from(tables.channelBubbles).where(and(eq(tables.channelBubbles.owner, owner), isNull(tables.channelBubbles.resolvedAt), sql`${tables.channelBubbles.data}->>'layer' = '4'`)).orderBy(desc(tables.channelBubbles.createdAt));
    return { items: rows.map(r => r.data).filter(bubble => !accountId || (bubble.episodeId.startsWith('question:')
      ? bubble.accountId === accountId : !bubble.accountId || bubble.accountId === accountId)) };
  }
  async bubble(owner: string, id: string) {
    const [row] = await this.db.select().from(tables.channelBubbles).where(and(eq(tables.channelBubbles.owner, owner), eq(tables.channelBubbles.id, id)));
    if (!row) throw new NotFoundException('CHANNEL_BUBBLE_UNAVAILABLE');
    return row.data;
  }
  async logs(owner: string) {
    const [rows, activity] = await Promise.all([
      this.db.select().from(tables.channelEvents).where(eq(tables.channelEvents.owner, owner)).orderBy(desc(tables.channelEvents.createdAt)).limit(100),
      this.db.select({ id: councilMessages.id, metadata: councilMessages.metadata, createdAt: councilMessages.createdAt }).from(councilMessages).where(and(eq(councilMessages.owner, owner), sql`${councilMessages.metadata}->'researchEvent' IS NOT NULL`)).orderBy(desc(councilMessages.createdAt)).limit(150),
    ]);
    // researchEvent is already the public, sanitized activity contract. Never expose raw agent output or reasoning_content.
    const steps = activity.flatMap(row => {
      const event = row.metadata?.researchEvent;
      return event ? [{ id: row.id, kind: `research.${event.kind}`, summary: event.summary, createdAt: event.at, status: event.status, toolName: event.toolName, durationMs: event.durationMs }] : [];
    });
    return { items: [...rows.map(r => ({ id: r.id, kind: r.data.kind, summary: this.eventSummary(r.data.kind), createdAt: r.createdAt.toISOString(), status: 'recorded' })), ...steps].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 200) };
  }
  private eventSummary(kind: string) {
    const labels: Record<string, string> = { 'research.day_closed': '当日研究已归档', 'research.finding': '研究发现已核查', 'user.question': '补充核查已记录', 'monitor.near': '接近已确认的模拟保护线', 'monitor.persisted': '持续接近保护线', 'monitor.recovered': '已离开观察区', 'monitor.breached': '已确认的模拟保护条件触发', 'paper.execution_changed': '模拟成交状态变化', 'fact.corrected': '事实来源已更正' };
    return labels[kind] ?? '核查记录已保存';
  }
  async acknowledgeNotifications(owner: string, ids: string[]) {
    if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== 'string')) throw new BadRequestException('INVALID_NOTIFICATION_IDS');
    for (const id of ids) await this.db.update(tables.channelOutbox).set({ state: 'delivered' }).where(and(eq(tables.channelOutbox.owner, owner), eq(tables.channelOutbox.id, id)));
    return { acknowledged: ids.length };
  }
  async ingestReport(owner: string, report: ChannelReportInput) {
    if (!report.id || !Number.isSafeInteger(report.revision) || report.revision < 1) throw new BadRequestException('INVALID_REPORT');
    const sectionIds = report.sections?.map(s => s.id) ?? ['summary'];
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const familyId = typeof report.source?.documentId === 'string' ? report.source.documentId : null;
      const relatives = familyId ? await tx.select().from(tables.channelReports).where(and(eq(tables.channelReports.owner, owner), sql`${tables.channelReports.source}->>'documentId'=${familyId}`)) : [];
      const newer = relatives.find(r => r.createdAt.getTime() > Date.parse(report.createdAt) || r.id === report.id && r.revision > report.revision);
      const [row] = await tx.insert(tables.channelReports).values({ id: report.id, owner, revision: report.revision, title: report.title, content: report.content,
        sectionIds, source: { ...report.source, publicSections: report.sections ?? [], ...(newer ? { supersededBy: newer.id } : {}) }, createdAt: new Date(report.createdAt) }).onConflictDoNothing().returning();
      if (row && !newer) for (const old of relatives.filter(r => r.id !== report.id || r.revision < report.revision)) {
        await tx.update(tables.channelReports).set({ source: { ...old.source, supersededBy: report.id } }).where(and(eq(tables.channelReports.owner, owner), eq(tables.channelReports.id, old.id), eq(tables.channelReports.revision, old.revision)));
        const stale = await tx.update(tables.channelBubbles).set({ resolvedAt: new Date() }).where(and(eq(tables.channelBubbles.owner, owner), sql`${tables.channelBubbles.data}->'anchors'->'primary'->>'reportId'=${old.id}`, sql`(${tables.channelBubbles.data}->'anchors'->'primary'->>'reportRevision')::integer=${old.revision}`)).returning({ id: tables.channelBubbles.id });
        if (stale.length) await tx.update(tables.channelOutbox).set({ state: 'superseded' }).where(and(eq(tables.channelOutbox.owner, owner), eq(tables.channelOutbox.state, 'pending'), inArray(tables.channelOutbox.bubbleId, stale.map(b => b.id))));
      }
      return row ?? null;
    });
  }
  async ingestFact(owner: string, fact: ChannelFact, card: ChannelEvidenceCard, tx: ReadDb = this.db) {
    if (tx === this.db) return this.db.transaction(async transaction => { await lockMemoryOwner(transaction, owner); return this.ingestFact(owner, fact, card, transaction); });
    if (fact.ownerId !== owner || !fact.id || !Number.isSafeInteger(fact.revision) || fact.revision < 1) throw new BadRequestException('FACT_OWNER_OR_REVISION_MISMATCH');
    const [latest] = await tx.select().from(tables.channelFacts).where(and(eq(tables.channelFacts.owner, owner), eq(tables.channelFacts.id, fact.id))).orderBy(desc(tables.channelFacts.revision)).limit(1);
    if (latest && fact.revision > latest.revision && Date.parse(fact.observedAt) < Date.parse(latest.data.observedAt)) throw new ConflictException('FACT_OBSERVATION_OLDER');
    await tx.insert(tables.channelFacts).values({ id: fact.id, owner, revision: fact.revision, data: fact, card }).onConflictDoNothing();
    if (!latest || fact.revision > latest.revision) {
      const invalidated = await tx.update(tables.channelBubbles).set({ resolvedAt: new Date() }).where(and(eq(tables.channelBubbles.owner, owner),
        sql`${tables.channelBubbles.data}->'anchors'->'primary'->>'factId' = ${fact.id}`,
        sql`(${tables.channelBubbles.data}->'anchors'->'primary'->>'factRevision')::integer < ${fact.revision}`)).returning({ id: tables.channelBubbles.id });
      if (invalidated.length) await tx.update(tables.channelOutbox).set({ state: 'superseded' }).where(and(eq(tables.channelOutbox.owner, owner), eq(tables.channelOutbox.state, 'pending'), inArray(tables.channelOutbox.bubbleId, invalidated.map(b => b.id))));
    }
  }
  async recordUserDecision(owner: string, episodeId: string, decisionId: string) {
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [episode] = await tx.select().from(tables.channelEpisodes).where(and(eq(tables.channelEpisodes.owner, owner), eq(tables.channelEpisodes.id, episodeId)));
      if (!episode || episode.data.userDecisionIds.includes(decisionId)) return;
      await tx.update(tables.channelEpisodes).set({ data: { ...episode.data, revision: episode.data.revision + 1, userDecisionIds: [...episode.data.userDecisionIds, decisionId] }, updatedAt: new Date() }).where(and(eq(tables.channelEpisodes.owner, owner), eq(tables.channelEpisodes.id, episodeId)));
    });
  }
  /** Explicit verified source amendment only. New quotes/periods and ordinary superseding reports do not call this. */
  async ingestSourceCorrection(owner: string, input: { previousFactId: string; previousRevision: number; fact: ChannelFact; card: ChannelEvidenceCard }) {
    const [previous] = await this.db.select().from(tables.channelFacts).where(and(eq(tables.channelFacts.owner, owner), eq(tables.channelFacts.id, input.previousFactId), eq(tables.channelFacts.revision, input.previousRevision)));
    if (!previous || input.fact.id !== previous.id || input.fact.key !== previous.data.key || input.fact.revision <= previous.revision
      || input.card.id === previous.card.id || !previous.data.sourceId || !input.card.sources.some(s => s.verification === 'checked' && s.originId === previous.data.sourceId)) throw new BadRequestException('EXPLICIT_SOURCE_AMENDMENT_REQUIRED');
    // Same observation identity is required: later quotes and a different accounting period are not admissions of error.
    if (input.fact.observedAt !== previous.data.observedAt || input.fact.value === previous.data.value) throw new BadRequestException('SOURCE_AMENDMENT_OBSERVATION_MISMATCH');
    if (/^-?\d+(?:\.\d+)?$/u.test(String(input.fact.value)) && /^-?\d+(?:\.\d+)?$/u.test(String(previous.data.value))
      && sumChannelDecimals([String(input.fact.value), String(previous.data.value).startsWith('-') ? String(previous.data.value).slice(1) : '-' + previous.data.value]) === '0') throw new BadRequestException('SOURCE_AMENDMENT_FORMAT_ONLY');
    const priors = await this.db.select().from(tables.channelBubbles).where(and(eq(tables.channelBubbles.owner, owner), sql`${tables.channelBubbles.data}->'anchors'->'primary'->>'factId' = ${previous.id}`, sql`(${tables.channelBubbles.data}->'anchors'->'primary'->>'factRevision')::integer = ${previous.revision}`));
    await this.ingestFact(owner, input.fact, input.card);
    const registry = new TemplateRegistry((await this.db.select().from(tables.channelTemplateRegistry)).map(t => t.data));
    const published: ChannelBubble[] = [];
    for (const prior of priors) {
      const historical = registry.resolveTemplate(prior.data, 'bubble', 'history');
      // Only a public sentence that actually used the now-corrected value can be retracted automatically.
      if (prior.data.stance === 'mood' || !historical.slotSchema.some(s => s.source.kind === 'fact' && s.source.factKey === previous.data.key)) continue;
      const memoryId = `history:${prior.id}`;
      const [memory] = await this.db.select().from(tables.channelMemories).where(and(eq(tables.channelMemories.owner, owner), eq(tables.channelMemories.id, memoryId)));
      if (!memory) continue;
      const bubble = await this.publishTemplate(owner, { episodeId: prior.episodeId, entityId: previous.id, title: '原始来源明确更正', eventKind: 'fact.corrected', semanticDeltaId: channelHash([prior.id, 'source-amendment', input.fact.id, input.fact.revision]),
        facts: [{ fact: input.fact, card: input.card }], templateId: 'channel.judgment.retracted', speaker: prior.data.speaker, stance: 'admit_wrong', weight: 'nudge', layer: 3, posture: 'standalone', evidence: input.card,
        priorOwnBubbleId: prior.id, relationshipMemoryIds: [memoryId], correctionOf: prior.id });
      if (bubble) published.push(bubble);
    }
    return published;
  }
  async recordDecisionSnapshot(owner: string, decisionId: string) {
    return (this.memory ?? new ChannelMemoryService(this.db)).recordDecisionSnapshot(owner, decisionId);
  }
  async syncExecutions(owner: string, accountId?: string) { return syncChannelExecutions(this.db, this, owner, accountId); }

  /** Checks quoted conditions only. It never submits orders or changes protection levels. */
  async monitorOwner(owner: string) {
    const accounts = await this.db.select({ id: paperAccounts.id }).from(paperAccounts)
      .where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.isActive, true)));
    for (const account of accounts) {
      await this.syncExecutions(owner, account.id);
      await this.monitorAccount(owner, account.id);
    }
  }
  private async monitorAccount(owner: string, accountId: string) {
    const runtime = await readChannelRuntime(this.db, owner, accountId);
    if (!runtime.accountId || runtime.monitoringStatus !== 'running') return;
    const [policy] = await this.db.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, runtime.accountId), eq(investmentPolicies.status, 'running'))).limit(1);
    if (!policy) return;
    for (const assignment of channelAssignments(policy.baseConfig)) {
      await this.monitorStrategy(owner, runtime, policy, assignment.snapshot);
    }
  }
  private async monitorStrategy(owner: string, runtime: ChannelRuntimeSnapshot,
    policy: typeof investmentPolicies.$inferSelect, strategy: ConfirmedInvestmentStrategy) {
    const accountId = runtime.accountId;
    if (!accountId || Date.parse(strategy.content.startsAt) > Date.now() || Date.parse(strategy.content.endsAt) <= Date.now()) return;
    for (const entry of strategy.content.entries) {
      const level = entry.directive?.stopLossPrice, ticker = entry.directive?.ticker;
      if (!ticker || !level || !runtime.current.positions.some(p => p.symbol.toUpperCase() === ticker.toUpperCase() && Number(p.quantity) > 0)) continue;
      const now = Date.now();
      if (entry.endsAt && Date.parse(entry.endsAt) <= now || entry.startsAt && Date.parse(entry.startsAt) > now) continue;
      const quote = await this.quotes.getQuote(ticker);
      if (!quote?.quoteAt || !Number.isFinite(Date.parse(quote.quoteAt)) || now - Date.parse(quote.quoteAt) > 180000 || Date.parse(quote.quoteAt) > now + 5000 || Number(quote.price) <= 0) continue;
      const entityId = `account:${accountId}:rule:${strategy.id}:${strategy.revision}:${entry.id}`;
      const previous = (await this.db.select().from(tables.channelEpisodes).where(and(eq(tables.channelEpisodes.owner, owner), sql`${tables.channelEpisodes.data}->>'entityId' = ${entityId}`)).orderBy(desc(tables.channelEpisodes.createdAt)).limit(1))[0];
      const price = Number(quote.price), distance = price - level;
      // Watch-zone parameters affect presentation only, never the authorized trading threshold.
      const near = distance > 0 && distance / level <= 0.01;
      const recovered = distance / level > 0.015;
      let kind: ChannelEvent['kind'] | undefined, templateId = '', stance: ChannelStance = 'plain_fact', weight: ChannelWeight = 'tap', posture: ChannelBubble['posture'] = 'standalone';
      const current = previous?.data.phase !== 'closed' ? previous : undefined;
      if (price <= level && !current?.data.hadBreach) { kind = 'monitor.breached'; templateId = 'channel.monitor.breached'; weight = 'poke'; posture = 'alarm'; }
      else if (near && !current) { kind = 'monitor.near'; templateId = 'channel.monitor.near'; stance = 'watchful'; posture = 'alarm'; }
      else if (near && current?.data.phase === 'alarm' && !current.data.hadBreach && now - current.createdAt.getTime() >= 600000) { kind = 'monitor.persisted'; templateId = 'channel.monitor.persisted'; stance = 'watchful'; posture = 'accompany'; }
      else if (recovered && current && current.data.phase !== 'idle') { kind = 'monitor.recovered'; templateId = current.data.userDecisionIds.length || current.data.hadBreach || current.data.executionIds.length ? 'channel.monitor.recovered_after_user' : 'channel.monitor.recovered'; stance = templateId.endsWith('after_user') ? 'plain_fact' : 'quiet_win'; posture = 'close'; }
      if (!kind) continue;
      const episodeId = current?.id ?? `${entityId}:${quote.quoteAt}`, factId = channelHash([entityId, quote.quoteAt, kind]);
      const card: ChannelEvidenceCard = { id: `card:${factId}`, kind: 'evidence', summary: `${runtime.accountName} · ${ticker} 行情 ${quote.price}，已确认模拟保护线 ${level}`,
        sources: [{ id: `${quote.source}:${ticker}:${quote.quoteAt}`, kind: 'market_data', title: `${ticker} · ${quote.source ?? '行情'}`, uri: `/holdings?ticker=${encodeURIComponent(ticker)}`, publishedAt: quote.quoteAt, observedAt: new Date(now).toISOString(), verification: 'retrieved' },
          { id: `${accountId}:${strategy.id}:${strategy.revision}:${entry.id}`, kind: 'ledger', title: `${runtime.accountName} · 当前已确认的模拟策略规则`, uri: `/paper/${accountId}/strategies`, publishedAt: policy.confirmedAt.toISOString(), observedAt: policy.updatedAt.toISOString(), verification: 'checked' }],
        asOf: quote.quoteAt, gaps: ['观察区为距保护线 1% 内，恢复需离开至 1.5% 外；仅用于频道提醒，不修改策略或保证成交。'], supports: [{ factId, scope: '保护线与行情的距离及监控条件' }] };
      const facts = [{ id: factId, revision: 1, ownerId: owner, key: 'monitor.distance', value: Math.max(0, distance).toFixed(4), observedAt: quote.quoteAt, subject: 'verified_fact' as const, sourceId: card.sources[0].id },
        { id: `${factId}:symbol`, revision: 1, ownerId: owner, key: 'monitor.symbol', value: ticker.toUpperCase(), observedAt: quote.quoteAt, subject: 'verified_fact' as const, sourceId: card.sources[0].id },
        { id: `${factId}:minutes`, revision: 1, ownerId: owner, key: 'monitor.persistedMinutes', value: current ? Math.floor((now - current.createdAt.getTime()) / 60000) : 0, observedAt: quote.quoteAt, subject: 'verified_fact' as const, sourceId: card.sources[0].id }];
      await this.publishTemplate(owner, { episodeId, entityId, accountId, accountName: runtime.accountName ?? undefined,
        runtimeAuthority: { accountId, strategyId: strategy.id, strategyRevision: strategy.revision, entryId: entry.id },
        title: `${runtime.accountName} · ${ticker} · 模拟保护线`, eventKind: kind, semanticDeltaId: channelHash([entityId, episodeId, kind, kind === 'monitor.persisted' ? 'first-dwell' : price <= level ? 'breached' : near ? 'near' : 'recovered']), facts: facts.map(fact => ({ fact, card })), templateId, stance, weight, layer: weight === 'poke' ? 3 : 2, posture, evidence: card });
    }
  }
  private newEpisode(id: string, entityId: string): ChannelEpisode {
    return { id, revision: 1, entityId, phase: 'idle', severity: 'ordinary', lastEventSequence: 0, consumedDeltaIds: [], hadBreach: false, executionIds: [], userDecisionIds: [] };
  }
  private async publicationContext(tx: ReadDb, owner: string, episode: ChannelEpisode, event: ChannelEvent): Promise<ChannelPublicationContext> {
    const [templates, facts, reports, bubbles, memories, findings] = await Promise.all([
      // A concurrent global retirement must serialize with this publication.
      tx.select().from(tables.channelTemplateRegistry).for('share'),
      tx.select().from(tables.channelFacts).where(eq(tables.channelFacts.owner, owner)),
      tx.select().from(tables.channelReports).where(eq(tables.channelReports.owner, owner)),
      tx.select().from(tables.channelBubbles).where(eq(tables.channelBubbles.owner, owner)).orderBy(desc(tables.channelBubbles.createdAt)).limit(300),
      tx.select().from(tables.channelMemories).where(eq(tables.channelMemories.owner, owner)).limit(200),
      tx.select().from(tables.channelFindings).where(eq(tables.channelFindings.owner, owner)),
    ]);
    const projectedFacts = facts.map(row => {
      const newer = facts.find(other => other.id === row.id && other.revision > row.revision && Date.parse(other.data.observedAt) >= Date.parse(row.data.observedAt));
      return newer ? { ...row.data, correctedBy: `${newer.id}:${newer.revision}` } : row.data;
    });
    const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const publishedGapPremises = new Set(findings.filter(row => row.data.kind === 'material_gap' && row.data.review.state === 'approved'
      && bubbles.some(b => b.episodeId === row.data.episodeId && b.semanticDeltaId === row.data.semanticDeltaId))
      .flatMap(row => row.data.affectedPremiseIds.map(normalize)));
    return { ownerId: owner, registry: new TemplateRegistry(templates.map(t => t.data)), facts: projectedFacts, evidenceCards: facts.map(f => f.card),
      reportRefs: reports.filter(row => !row.source.supersededBy && !reports.some(other => other.id === row.id && other.revision > row.revision)).map(r => ({ id: r.id, revision: r.revision, sectionIds: r.sectionIds })), episode, event,
      priorBubbles: bubbles.map(b => b.data), memories: memories.map(m => m.data), consumedDeltaIds: episode.consumedDeltaIds,
      now: new Date().toISOString(), compilerVersion: this.compilerVersion, correctedSourceIds: facts.filter(f => f.data.correctedBy).map(f => f.data.sourceId).filter((id): id is string => Boolean(id)),
      hasNewMaterialGap: (finding: FindingCandidate) => finding.kind === 'material_gap' && finding.affectedPremiseIds.some(id => !publishedGapPremises.has(normalize(id))),
    } as ChannelPublicationContext;
  }
  private async commitBubble(tx: Tx, owner: string, episode: ChannelEpisode, event: ChannelEvent, bubble: ChannelBubble, context: ChannelPublicationContext, finding?: BackgroundFinding) {
    assertSemanticDelta(finding, event, bubble);
    const allowed = canPublish(bubble, context);
    if (!allowed.allowed) return null;
    const advance = async (published: boolean) => {
      const next: ChannelEpisode = { ...episode, revision: episode.revision + 1, lastEventSequence: event.sequence,
        phase: bubble.posture === 'standalone' ? episode.phase : bubble.posture === 'close' ? 'closed' : bubble.posture,
        severity: bubble.weight === 'poke' ? 'critical' : bubble.weight === 'nudge' ? 'important' : episode.severity,
        hadBreach: episode.hadBreach || event.kind === 'monitor.breached',
        ...(published ? { lastPublishedAt: bubble.createdAt } : {}),
        consumedDeltaIds: published ? [...episode.consumedDeltaIds, bubble.semanticDeltaId] : episode.consumedDeltaIds };
      await tx.update(tables.channelEpisodes).set({ data: next, updatedAt: new Date() }).where(and(eq(tables.channelEpisodes.owner, owner), eq(tables.channelEpisodes.id, episode.id)));
    };
    const prefs = await this.preferences(owner, tx);
    if (bubble.weight === 'tap' && bubble.deliveryCause !== 'user_reply') {
      const since = new Date(Date.now() - ({ quiet: 20 * 60000, deskmate: 5 * 60000, chatty: 90000 }[prefs.vibe]));
      const recent = await tx.select().from(tables.channelBubbles).where(and(eq(tables.channelBubbles.owner, owner), gte(tables.channelBubbles.createdAt, since)));
      if (recent.filter(b => b.data.weight === 'tap').length >= ({ quiet: 1, deskmate: 2, chatty: 3 }[prefs.vibe])) { await advance(false); return null; }
    }
    const [inserted] = await tx.insert(tables.channelBubbles).values({ id: bubble.id, owner, episodeId: episode.id, semanticDeltaId: bubble.semanticDeltaId, data: bubble }).onConflictDoNothing().returning();
    if (!inserted) return null;
    if (bubble.stance !== 'mood') await tx.insert(tables.channelMemories).values({ id: `history:${bubble.id}`, owner,
      data: { id: `history:${bubble.id}`, ownerId: owner, speaker: bubble.speaker, kind: 'shared_history', recordedAt: bubble.createdAt, sourceBubbleId: bubble.id, content: bubble.text } }).onConflictDoNothing();
    await advance(true);
    for (const destination of bubble.weight === 'poke' ? ['stream', 'notification'] : ['stream']) await tx.insert(tables.channelOutbox).values({ id: randomUUID(), owner, bubbleId: bubble.id, destination }).onConflictDoNothing();
    if (bubble.layer === 4) await tx.update(tables.channelPreferences).set({ pinnedBubbleId: bubble.id, revision: prefs.revision + 1, updatedAt: new Date() }).where(eq(tables.channelPreferences.owner, owner));
    return bubble;
  }
  async publishTemplate(owner: string, input: ChannelPublicationInput): Promise<ChannelBubble | null> {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      if (input.runtimeAuthority) {
        const authority = input.runtimeAuthority;
        const runtime = await readRuntimeInSnapshot(tx, owner, authority.accountId);
        if (runtime.monitoringStatus !== 'running' || !runtime.current.rules.some(rule => rule.effective
          && rule.strategyId === authority.strategyId && rule.strategyRevision === authority.strategyRevision
          && rule.entryId === authority.entryId)) return null;
      }
      if (input.briefId) {
        const [stored] = await tx.select().from(tables.channelBriefs).where(and(eq(tables.channelBriefs.owner, owner), eq(tables.channelBriefs.id, input.briefId)));
        if (!stored || stored.data.status !== 'ready' || Date.parse(stored.data.expiresAt) <= Date.now()) return null;
        const brief = stored.data as typeof stored.data & { compilation?: { strategyId: string | null; strategyRevision: number | null } };
        const [latest] = await tx.select().from(tables.channelReports).where(eq(tables.channelReports.owner, owner)).orderBy(desc(tables.channelReports.createdAt), desc(tables.channelReports.revision)).limit(1);
        const runtime = await readRuntimeInSnapshot(tx, owner);
        let invalid = !latest || latest.id !== brief.reportId || latest.revision !== brief.reportRevision
          || Boolean(brief.compilation && (brief.compilation.strategyId !== runtime.current.strategyId || brief.compilation.strategyRevision !== runtime.current.strategyRevision));
        if (z.string().uuid().safeParse(brief.reportId).success) {
          const source = await new ResearchDocumentsService(this.db).getVersionInTransaction(tx, owner, brief.reportId).catch(() => null);
          invalid ||= !source || source.status !== 'valid' || source.sourceStatus !== 'available';
        }
        if (invalid) { await tx.update(tables.channelBriefs).set({ data: { ...stored.data, status: 'invalidated' } }).where(and(eq(tables.channelBriefs.owner, owner), eq(tables.channelBriefs.id, stored.id))); return null; }
      }
      await tx.insert(tables.channelEpisodes).values({ id: input.episodeId, owner, title: input.title, data: this.newEpisode(input.episodeId, input.entityId) }).onConflictDoNothing();
      const episode = (await tx.select().from(tables.channelEpisodes).where(and(eq(tables.channelEpisodes.owner, owner), eq(tables.channelEpisodes.id, input.episodeId))))[0].data;
      if (episode.consumedDeltaIds.includes(input.semanticDeltaId)) return null;
      for (const item of input.facts) await this.ingestFact(owner, item.fact, item.card, tx);
      const event: ChannelEvent = { id: randomUUID(), ownerId: owner, episodeId: input.episodeId, entityId: input.entityId, sequence: episode.lastEventSequence + 1,
        occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(), kind: input.eventKind, factRefs: input.facts.map(i => ({ id: i.fact.id, revision: i.fact.revision })), semanticDeltaId: input.semanticDeltaId };
      const context = await this.publicationContext(tx, owner, episode, event);
      if (input.priorOwnBubbleId) {
        const [prior] = await tx.select().from(tables.channelBubbles).where(and(eq(tables.channelBubbles.owner, owner), eq(tables.channelBubbles.id, input.priorOwnBubbleId)));
        if (prior && !context.priorBubbles.some(b => b.id === prior.id)) context.priorBubbles.push(prior.data);
        const linked = await tx.select().from(tables.channelMemories).where(and(eq(tables.channelMemories.owner, owner), sql`${tables.channelMemories.data}->>'sourceBubbleId'=${input.priorOwnBubbleId}`));
        for (const memory of linked) if (!context.memories.some(m => m.id === memory.id)) context.memories.push(memory.data);
      }
      context.directReply = input.deliveryCause === 'user_reply';
      if (event.kind === 'research.day_closed') context.completedActions = [{ eventId: event.id, kind: 'research_day_closed', status: 'completed' }];
      if (event.kind === 'monitor.recovered') context.completedActions = [{ eventId: event.id, kind: 'monitor_episode_closed', status: 'completed' }];
      if (event.kind === 'paper.execution_changed' && input.facts.some(f => f.fact.key === 'execution.remainingQuantity' && Number(f.fact.value) === 0) && input.facts.some(f => f.fact.key === 'execution.filledQuantity' && Number(f.fact.value) > 0)) context.completedActions = [{ eventId: event.id, kind: 'paper_order_filled', status: 'completed' }];
      let template;
      try { template = context.registry.resolveTemplate({ templateId: input.templateId, templateRevision: input.templateRevision ?? 1 }, 'bubble', 'publish'); }
      catch { return null; }
      const anchor = input.reportAnchor ? { kind: 'report_section' as const, ...input.reportAnchor } : input.facts[0] ? { kind: 'fact' as const, factId: input.facts[0].fact.id, factRevision: input.facts[0].fact.revision } : null;
      if (!anchor) return null;
      const anchors = { primary: anchor, triggerEventId: event.id, priorOwnBubbleId: input.priorOwnBubbleId, relationshipMemoryIds: input.relationshipMemoryIds, thesis: input.thesis };
      const slots = resolveAuthoritativeSlots(template, anchors, context);
      const bubble = { id: randomUUID(), ownerId: owner, episodeId: episode.id, speaker: template.speaker ?? input.speaker ?? 'xiaoqi', posture: input.posture, anchors,
        ...(input.accountId ? { accountId: input.accountId, accountName: input.accountName } : {}),
        text: renderRegisteredTemplate(template, slots), evidence: input.evidence, templateId: template.id, templateRevision: template.revision,
        semanticDeltaId: input.semanticDeltaId, createdAt: new Date().toISOString(), deliveryCause: input.deliveryCause ?? 'monitor',
        stance: input.stance, weight: input.weight, layer: input.layer, ...(input.action?.length ? { action: input.action } : {}), ...(input.correctionOf ? { correctionOf: input.correctionOf } : {}) } as ChannelBubble;
      assertSemanticDelta(undefined, event, bubble);
      await tx.insert(tables.channelEvents).values({ id: event.id, owner, episodeId: episode.id, data: event });
      return this.commitBubble(tx, owner, episode, event, bubble, context);
    });
  }
  async ingestFinding(owner: string, candidate: FindingCandidate): Promise<ChannelBubble | null> {
    if (candidate.ownerId !== owner) throw new BadRequestException('FINDING_OWNER_MISMATCH');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      await tx.insert(tables.channelEpisodes).values({ id: candidate.episodeId, owner, title: '研究发现', data: this.newEpisode(candidate.episodeId, candidate.thesis?.id ?? candidate.researchRunId) }).onConflictDoNothing();
      const episode = (await tx.select().from(tables.channelEpisodes).where(and(eq(tables.channelEpisodes.owner, owner), eq(tables.channelEpisodes.id, candidate.episodeId))))[0].data;
      const refs = candidate.anchor.kind === 'fact' ? [{ id: candidate.anchor.factId, revision: candidate.anchor.factRevision }] : [];
      const event: ChannelEvent = { id: randomUUID(), ownerId: owner, entityId: episode.entityId, episodeId: episode.id, sequence: episode.lastEventSequence + 1,
        occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(), kind: 'research.finding', findingId: candidate.id, factRefs: refs, semanticDeltaId: candidate.semanticDeltaId };
      const context = await this.publicationContext(tx, owner, episode, event);
      if (candidate.reverseCheckOutcome === 'no_counterevidence_found') return null;
      if (candidate.reverseCheckOutcome === 'unable_to_verify' && !(candidate.kind === 'material_gap' && context.hasNewMaterialGap?.(candidate))) return null;
      const { finding, seal } = await sealFinding(candidate, context);
      await tx.insert(tables.channelFindings).values({ id: finding.id, owner, data: finding, seal }).onConflictDoUpdate({ target: [tables.channelFindings.owner, tables.channelFindings.id], set: { data: finding, seal } });
      if (finding.review.state !== 'approved' || !seal) return null;
      const cardRows = await tx.select().from(tables.channelFacts).where(eq(tables.channelFacts.owner, owner));
      const evidence = cardRows.find(f => f.card.id === finding.evidenceCardId)?.card;
      if (!evidence) return null;
      const finalContext = { ...context, sealedFinding: finding, seal, evidenceCards: [...(context.evidenceCards ?? []), evidence] } as ChannelPublicationContext;
      const bubble = renderApprovedFinding(finding, finalContext);
      if (bubble.weight === 'tap' || bubble.weight !== finding.weight) throw new BadRequestException('BACKGROUND_FINDING_WEIGHT_MISMATCH');
      assertSemanticDelta(finding, event, bubble);
      await tx.insert(tables.channelEvents).values({ id: event.id, owner, episodeId: episode.id, data: event });
      return this.commitBubble(tx, owner, episode, event, bubble, finalContext, finding);
    });
  }

  async ask(owner: string, body: unknown) {
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('INVALID_CHANNEL_QUESTION');
    const input = parsed.data, inputHash = channelHash(input);
    const claimed = await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [prior] = await tx.select().from(tables.channelSupplementRequests).where(and(eq(tables.channelSupplementRequests.owner, owner), eq(tables.channelSupplementRequests.requestKey, input.requestKey)));
      if (prior) {
        if (prior.inputHash !== inputHash) throw new ConflictException('REQUEST_KEY_CONFLICT');
        return { prior, fresh: false };
      }
      let accountId = input.accountId;
      let context = input.context;
      let originalQuestions: Array<{ id: string; text: string }> = splitChannelQuestions(input.message).map(text => ({ id: randomUUID(), text }));
      let selected = originalQuestions.length === 1 ? originalQuestions[0] : undefined;
      if (input.selectedQuestionId) {
        const [deferred] = await tx.select().from(tables.channelDeferredQuestions).where(and(eq(tables.channelDeferredQuestions.owner, owner), eq(tables.channelDeferredQuestions.id, input.selectedQuestionId)));
        if (!deferred || deferred.data.status !== 'pending') throw new ConflictException('QUESTION_UNAVAILABLE');
        const [origin] = await tx.select().from(tables.channelSupplementRequests).where(and(eq(tables.channelSupplementRequests.owner, owner), eq(tables.channelSupplementRequests.id, deferred.requestId)));
        if (!origin) throw new NotFoundException('QUESTION_SOURCE_UNAVAILABLE');
        if (input.accountId && input.accountId !== origin.data.accountId) throw new ConflictException('QUESTION_ACCOUNT_CHANGED');
        if (input.context && !isDeepStrictEqual(input.context, origin.data.context ?? null)) throw new ConflictException('QUESTION_CONTEXT_CHANGED');
        accountId = origin.data.accountId;
        context = origin.data.context;
        originalQuestions = origin.data.originalQuestions.map(q => ({ ...q })); selected = originalQuestions.find(q => q.id === deferred.id);
        await tx.update(tables.channelDeferredQuestions).set({ data: { ...deferred.data, status: 'selected' } }).where(and(eq(tables.channelDeferredQuestions.owner, owner), eq(tables.channelDeferredQuestions.id, deferred.id)));
      }
      const [account] = accountId ? await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId))).for('share') : [];
      if (accountId && !account) throw new NotFoundException('ACCOUNT_NOT_FOUND');
      const questionScope = { ...(account ? { accountId: account.id, accountName: account.name } : {}), ...(context ? { context } : {}) };
      if (!originalQuestions.length || originalQuestions.length > 20) throw new BadRequestException('QUESTION_COUNT_LIMIT');
      const requestId = randomUUID(), now = new Date().toISOString();
      const deferredIds: string[] = [];
      for (const q of originalQuestions.filter(q => q.id !== selected?.id)) {
        const [existing] = await tx.select().from(tables.channelDeferredQuestions).where(and(eq(tables.channelDeferredQuestions.owner, owner), eq(tables.channelDeferredQuestions.id, q.id)));
        if (existing && existing.data.status !== 'pending') continue;
        const question: DeferredQuestion = { ...questionScope, id: q.id, ownerId: owner, originatingRequestId: requestId, text: q.text, status: 'pending', createdAt: now };
        await tx.insert(tables.channelDeferredQuestions).values({ id: q.id, owner, requestId, data: question }).onConflictDoNothing();
        deferredIds.push(q.id);
      }
      const request: SupplementRequest = { ...questionScope, id: requestId, ownerId: owner, userMessageId: randomUUID(), requestKey: input.requestKey,
        factQuestion: selected?.text ?? '', selectedToolId: this.selectTool(selected?.text ?? ''), maxToolCalls: 1,
        claimedToolCalls: selected ? 1 : 0, deferredQuestionIds: deferredIds, originalQuestions,
        status: selected ? 'running' : 'needs_scope' };
      const [created] = await tx.insert(tables.channelSupplementRequests).values({ id: requestId, owner, requestKey: input.requestKey, inputHash, message: input.message, data: request, leaseUntil: selected ? new Date(Date.now() + 35000) : null }).returning();
      return { prior: created, fresh: true };
    });
    const row = claimed.prior;
    if (!claimed.fresh) return row.result ?? { request: row.data };
    const request = row.data;
    if (request.status === 'needs_scope') {
      const scopeCard = this.scopeCard(request);
      const now = new Date().toISOString(), fact = this.processFact(owner, request.id, 'supplement.scope.originalQuestionCount', request.originalQuestions.length, now);
      scopeCard.supports = [{ factId: fact.id, scope: '本次已冻结的问题与未选择范围' }];
      const bubble = await this.publishTemplate(owner, { accountId: request.accountId, accountName: request.accountName, episodeId: `question:${request.id}`, entityId: request.id, title: '选择一个事实核查', eventKind: 'user.question', semanticDeltaId: channelHash([request.id, 'scope']),
        facts: [{ fact, card: scopeCard }], templateId: 'channel.supplement.scope_needed', stance: 'plain_fact', weight: 'nudge', layer: 3, posture: 'standalone', evidence: scopeCard,
        deliveryCause: 'user_reply' });
      const result = { request, bubble, deferredQuestions: request.originalQuestions.map(q => ({ id: q.id, text: q.text,
        ownerId: owner, originatingRequestId: request.id, status: 'pending' as const, createdAt: now,
        accountId: request.accountId, accountName: request.accountName, context: request.context })) };
      await this.db.update(tables.channelSupplementRequests).set({ result }).where(and(eq(tables.channelSupplementRequests.owner, owner), eq(tables.channelSupplementRequests.id, request.id)));
      return result;
    }
    let answer: Awaited<ReturnType<ChannelService['runOneTool']>>;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { answer = await Promise.race([this.runOneTool(owner, request, request.context), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('SINGLE_TOOL_TIMEOUT')), 30000); timeout.unref(); })]); }
    catch { answer = { templateId: 'channel.supplement.unverified', card: this.gapCard(request.id, '本次核查没有取得足够资料', ['本次工具查询失败；同一请求不会自动重试或换工具。']), facts: [] }; }
    finally { if (timeout) clearTimeout(timeout); }
    const now = new Date().toISOString();
    if (!answer.facts.length) answer.facts.push(this.processFact(owner, request.id, 'supplement.attempted', 1, now));
    if (answer.card.kind === 'gap') answer.card.supports = [{ factId: answer.facts[0].id, scope: '本次核查尝试及尚未核实的部分' }];
    const bubble = await this.publishTemplate(owner, { accountId: request.accountId, accountName: request.accountName, episodeId: `question:${request.id}`, entityId: request.id, title: '单事实补充核查', eventKind: 'user.question', semanticDeltaId: channelHash([request.id, 'answer']),
      facts: answer.facts.map(fact => ({ fact, card: answer.card })), templateId: answer.templateId, stance: answer.priorOwnBubbleId ? 'I_told_you' : answer.card.kind === 'gap' ? 'unsure_honest' : 'plain_fact', weight: 'nudge', layer: 3, posture: 'standalone', evidence: answer.card, deliveryCause: 'user_reply', speaker: answer.speaker, priorOwnBubbleId: answer.priorOwnBubbleId, relationshipMemoryIds: answer.relationshipMemoryIds, thesis: answer.thesis });
    const saved: SupplementRequest = { ...request, status: answer.card.kind === 'gap' ? 'not_verified' : 'answered', conclusion: bubble?.text, evidenceCardId: answer.card.id };
    const result = { request: saved, bubble, deferredQuestions: [] };
    await this.db.update(tables.channelSupplementRequests).set({ data: saved, result, leaseUntil: null }).where(and(eq(tables.channelSupplementRequests.owner, owner), eq(tables.channelSupplementRequests.id, request.id)));
    if (request.deferredQuestionIds.length >= 1) {
      const selectedIndex = request.originalQuestions.findIndex(q => q.text === request.factQuestion) + 1;
      const scope = this.scopeCard(request), facts = [this.processFact(owner, request.id, 'supplement.scope.selectedIndex', selectedIndex, now),
        this.processFact(owner, request.id, 'supplement.scope.deferredCount', request.deferredQuestionIds.length, now),
        this.processFact(owner, request.id, 'supplement.scope.originalQuestionCount', request.originalQuestions.length, now)];
      scope.supports = facts.map(fact => ({ factId: fact.id, scope: '本次核查选择与保留待办的范围' }));
      await this.publishTemplate(owner, { accountId: request.accountId, accountName: request.accountName, episodeId: `question:${request.id}`, entityId: request.id, title: '核查范围', eventKind: 'user.question', semanticDeltaId: channelHash([request.id, 'selected-scope']), facts: facts.map(fact => ({ fact, card: scope })), templateId: 'channel.supplement.scope', stance: 'plain_fact', weight: 'nudge', layer: 3, posture: 'standalone', evidence: scope, deliveryCause: 'user_reply' });
    }
    return result;
  }
  private async recoverInterruptedSupplements(owner?: string) {
    const expired = await this.db.select().from(tables.channelSupplementRequests).where(and(owner ? eq(tables.channelSupplementRequests.owner, owner) : undefined,
      sql`${tables.channelSupplementRequests.data}->>'status' = 'running'`, sql`(${tables.channelSupplementRequests.leaseUntil} IS NULL OR ${tables.channelSupplementRequests.leaseUntil} < now())`)).limit(100);
    for (const row of expired) {
      const saved: SupplementRequest = { ...row.data, status: 'not_verified', conclusion: '上次核查已中断，结果未确认；未重新调用工具。', evidenceCardId: `card:recovery:${row.id}` };
      const updated = await this.db.update(tables.channelSupplementRequests).set({ data: saved, leaseUntil: null, result: { request: saved } }).where(and(eq(tables.channelSupplementRequests.owner, row.owner), eq(tables.channelSupplementRequests.id, row.id), sql`${tables.channelSupplementRequests.data}->>'status'='running'`)).returning();
      if (!updated.length) continue;
      const fact = this.processFact(row.owner, row.id, 'supplement.interrupted', 1, new Date().toISOString()), card = this.gapCard(`recovery:${row.id}`, '上次核查中断，结果未确认', ['原调用没有被重发，也没有换工具；本次只恢复失败记录。']);
      card.supports = [{ factId: fact.id, scope: '已持久化的单次调用中断状态' }];
      await this.publishTemplate(row.owner, { accountId: row.data.accountId, accountName: row.data.accountName, episodeId: `question:${row.id}`, entityId: row.id, title: '上次核查未确认', eventKind: 'user.question', semanticDeltaId: channelHash([row.id, 'interrupted']), facts: [{ fact, card }], templateId: 'channel.supplement.unverified', stance: 'unsure_honest', weight: 'nudge', layer: 3, posture: 'standalone', evidence: card, deliveryCause: 'user_reply' });
    }
  }
  private selectTool(question: string) {
    if (/(上次|之前|以前|last time|previously).*(怎么说|说过|提醒|said|warn)/iu.test(question)) return 'history_one';
    if (/现金流/u.test(question)) return 'report_one';
    if (/现价|股价|价格|price|quote/iu.test(question) && !/昨天|昨日|上周|历史|收盘|yesterday|historical|last week/iu.test(question)) return 'quote_one';
    if (/现金|余额|cash/iu.test(question)) return 'cash_one';
    if (/数量|多少股|持股|shares|position/iu.test(question)) return 'position_one';
    return 'report_one';
  }
  private processFact(owner: string, requestId: string, key: string, value: string | number, at: string): ChannelFact {
    return { id: channelHash([owner, requestId, key]), revision: 1, ownerId: owner, key, value, observedAt: at, subject: 'research_process' };
  }
  private gapCard(id: string, summary: string, gaps: string[]): ChannelEvidenceCard {
    return { id: `card:${id}`, kind: 'gap', summary, sources: [], asOf: new Date().toISOString(), gaps, supports: [{ factId: id, scope: '本次单事实核查的范围与资料缺口' }] };
  }
  private scopeCard(request: SupplementRequest): ChannelEvidenceCard {
    return this.gapCard(`scope:${request.id}`, '本次仅核查一个事实，其余问题保留在待办', request.originalQuestions.map((q, i) => `${i + 1}. ${q.text}${q.text === request.factQuestion ? '（本次核查）' : '（未核查）'}`));
  }
  private async runOneTool(owner: string, request: SupplementRequest, context?: Record<string, unknown>): Promise<{ templateId: string; card: ChannelEvidenceCard; facts: ChannelFact[]; speaker?: ChannelSpeaker; priorOwnBubbleId?: string; relationshipMemoryIds?: string[]; thesis?: { id: string; revision: number } }> {
    const now = new Date().toISOString(), question = request.factQuestion;
    const explicitTicker = typeof context?.ticker === 'string' ? context.ticker : question.match(/\b[A-Z][A-Z0-9.\-]{0,14}\b/u)?.[0];
    const ticker = explicitTicker?.toUpperCase().trim();
    const [account] = request.accountId ? await this.db.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, request.accountId))) : [];
    if (request.accountId && !account) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    if (request.selectedToolId === 'history_one') {
      const [match] = await this.db.select({prior:tables.channelBubbles}).from(tables.channelBubbles)
        .innerJoin(tables.channelEpisodes,and(eq(tables.channelEpisodes.owner,owner),eq(tables.channelEpisodes.id,tables.channelBubbles.episodeId)))
        .where(and(eq(tables.channelBubbles.owner, owner), sql`${tables.channelBubbles.data}->>'speaker' = 'laozhou'`, sql`${tables.channelBubbles.data}->>'stance' = 'watchful'`,
          request.accountId ? sql`${tables.channelBubbles.data}->>'accountId' = ${request.accountId}` : sql`${tables.channelBubbles.data}->>'accountId' IS NULL`,
          ticker?sql`(${tables.channelEpisodes.data}->>'entityId' = ${ticker} OR EXISTS(SELECT 1 FROM channel_facts cf WHERE cf.owner=${owner} AND cf.id=(${tables.channelBubbles.data}->'anchors'->'primary'->>'factId') || ':symbol' AND cf.data->>'key'='monitor.symbol' AND upper(cf.data->>'value')=${ticker}))`:undefined))
        .orderBy(desc(tables.channelBubbles.createdAt)).limit(1);
      const prior=match?.prior;
      if (prior) {
        const fact = { ...this.processFact(owner, request.id, 'relationship.recall', prior.id, now), sourceId: `bubble:${prior.id}` };
        return { templateId: 'channel.history.watchful', facts: [fact], speaker: 'laozhou', priorOwnBubbleId: prior.id, relationshipMemoryIds: [`history:${prior.id}`], thesis: prior.data.anchors.thesis,
          card: { id: `card:${request.id}`, kind: 'evidence', summary: '已定位老周本人留下的保护线提醒', sources: [{ id: prior.id, kind: 'ledger', title: '本人历史频道发言', uri: `/council?bubbleId=${encodeURIComponent(prior.id)}`, publishedAt: prior.data.createdAt, observedAt: now, verification: 'checked', locator: prior.data.text }],
            asOf: prior.data.createdAt, gaps: ['此处只核实当时说过什么，不把旧提醒当作当前投资判断。'], supports: [{ factId: fact.id, scope: `${prior.data.createdAt}：${prior.data.text}` }] } };
      }
      return { templateId: 'channel.supplement.unverified', facts: [], card: this.gapCard(request.id, '没有查到对应的本人保护线提醒', ['本次只查可核验的本人历史提醒，没有合成旧账。']) };
    } else if (request.selectedToolId === 'quote_one' && ticker) {
      const quote = await this.quotes.getQuote(ticker);
      if (quote && quote.quoteAt && Number(quote.price) > 0) {
        const fact = { ...this.processFact(owner, request.id, 'supplement.price', quote.price, quote.quoteAt), subject: 'verified_fact' as const, sourceId: `${quote.source}:${quote.symbol}:${quote.quoteAt}` };
        return { templateId: 'channel.supplement.price', facts: [fact], card: { id: `card:${request.id}`, kind: 'evidence', summary: `${quote.symbol} 当前取得的价格为 ${quote.price} ${quote.currency}`,
          sources: [{ id: fact.sourceId, kind: 'market_data', title: `${quote.source ?? '行情来源'} · ${quote.symbol}`, uri: `/holdings?ticker=${encodeURIComponent(ticker)}`, publishedAt: quote.quoteAt, observedAt: now, verification: 'retrieved' }], asOf: quote.quoteAt, gaps: quote.delayed ? ['行情可能延迟，不能据此声称实时成交。'] : [], supports: [{ factId: fact.id, scope: '该行情时点的价格' }] } };
      }
    } else if (request.selectedToolId === 'position_one' && ticker) {
      if (account) {
        const [position] = await this.db.select().from(paperPositions).where(and(eq(paperPositions.owner, owner),
          eq(paperPositions.accountId, account.id), eq(paperPositions.ticker, ticker)));
        const quantity = position?.shares ?? '0';
        const observedAt = position?.updatedAt.toISOString() ?? now;
        const fact = this.processFact(owner, request.id, 'supplement.quantity', quantity, observedAt);
        return { templateId: 'channel.supplement.position', facts: [fact], card: { id: `card:${request.id}`, kind: 'evidence',
          summary: `${account.name} 模拟账户记录：${ticker} ${quantity} 股 / Simulation account recorded shares`,
          sources: [{ id: position?.id ?? `${account.id}:${ticker}`, kind: 'ledger', title: `${account.name} · ${ticker} 模拟持仓 / Simulation position`,
            uri: `/paper/${account.id}`, publishedAt: null, observedAt, verification: 'checked' }], asOf: observedAt,
          gaps: ['仅为所选模拟账户账本，不代表真实券商持仓。 / This is the selected simulation ledger, not a live broker position.'],
          supports: [{ factId: fact.id, scope: `${account.name} 模拟账户持仓账本记录数量 / Recorded simulation shares` }] } };
      }
      const rows = await this.db.select().from(holdings).where(and(eq(holdings.owner, owner), eq(holdings.ticker, ticker))).limit(1);
      if (rows[0]) {
        const row = rows[0], fact = this.processFact(owner, request.id, 'supplement.quantity', String(row.shares), now);
        return { templateId: 'channel.supplement.position', facts: [fact], card: { id: `card:${request.id}`, kind: 'evidence', summary: `真实账户记录：${ticker} ${row.shares} 股`,
          sources: [{ id: row.id, kind: 'ledger', title: `真实持仓记录 · ${ticker}`, uri: '/holdings', publishedAt: null, observedAt: row.updatedAt.toISOString(), verification: 'checked' }], asOf: row.updatedAt.toISOString(), gaps: ['此处为已记录真实持仓，不代表券商实时同步。'], supports: [{ factId: fact.id, scope: '持仓账本记录数量' }] } };
      }
    } else if (request.selectedToolId === 'cash_one') {
      const currency = question.match(/\b(?:USD|HKD|CNY)\b/iu)?.[0]?.toUpperCase();
      if (account) {
        const rows = account.ledgerMode === 'native_currency'
          ? await this.db.select().from(simulationCash).where(and(eq(simulationCash.owner, owner), eq(simulationCash.accountId, account.id),
            currency ? eq(simulationCash.currency, currency) : undefined)).limit(4)
          : !currency || currency === 'USD' ? [{ id: account.id, currency: 'USD', available: account.cashBalance,
            frozen: '0', unsettled: '0', availabilityKnown: true }] : [];
        if (rows.length !== 1 || !rows[0].availabilityKnown) return { templateId: 'channel.supplement.unverified', facts: [],
          card: this.gapCard(request.id, `${account.name} 模拟现金未能确认单一可用余额 / Simulation cash balance unavailable`,
            [rows.length > 1 ? '请明确核查币种，不跨币种加总。 / Specify one currency; currencies are not added together.'
              : '该模拟账户的币种可用现金尚未确认。 / Available cash for this account and currency is not confirmed.']) };
        const row = rows[0], fact = this.processFact(owner, request.id, 'supplement.amount', row.available, now);
        return { templateId: 'channel.supplement.cash', facts: [fact], card: { id: `card:${request.id}`, kind: 'evidence',
          summary: `${account.name} 模拟账户可用现金：${row.available} ${row.currency} / Simulation available cash`,
          sources: [{ id: row.id, kind: 'ledger', title: `${account.name} · ${row.currency} 模拟现金 / Simulation cash`,
            uri: `/paper/${account.id}`, publishedAt: null, observedAt: now, verification: 'checked' }], asOf: now,
          gaps: [`冻结 ${row.frozen}、未结算 ${row.unsettled} ${row.currency} 未计入可用余额。 / Frozen and unsettled amounts are excluded.`],
          supports: [{ factId: fact.id, scope: `${account.name} 所选币种的已确认可用模拟现金 / Confirmed available simulation cash` }] } };
      }
      const rows = await this.db.select().from(cashAccounts).where(and(eq(cashAccounts.owner, owner), currency ? eq(cashAccounts.currency, currency) : undefined)).limit(4);
      if (rows.length === 1 && rows[0].reconciliationStatus === 'confirmed') {
        const row = rows[0], fact = this.processFact(owner, request.id, 'supplement.amount', String(row.balance), now);
        return { templateId: 'channel.supplement.cash', facts: [fact], card: { id: `card:${request.id}`, kind: 'evidence', summary: `真实账户记录现金：${row.balance} ${row.currency}`,
          sources: [{ id: row.id, kind: 'ledger', title: `${row.currency} 已确认现金记录`, uri: '/holdings', publishedAt: null, observedAt: row.updatedAt.toISOString(), verification: 'checked' }], asOf: row.updatedAt.toISOString(), gaps: [], supports: [{ factId: fact.id, scope: '所选币种的已确认现金余额' }] } };
      }
      return { templateId: 'channel.supplement.unverified', card: this.gapCard(request.id, '现金记录尚不能用于单一余额结论', [rows.length > 1 ? '存在多个币种，需明确核查的币种；不跨币种直接加总。' : '该币种现金尚未明确确认。']), facts: [] };
    } else if (request.selectedToolId === 'report_one') {
      const [report] = await this.db.select().from(tables.channelReports).where(eq(tables.channelReports.owner, owner)).orderBy(desc(tables.channelReports.createdAt)).limit(1);
      const focus = question.match(/毛利率|净利润|营业收入|营收|经营现金流|自由现金流|现金流|资产负债率|净资产|总资产|EPS|持仓比例|目标仓位|止损/iu)?.[0];
      if (report && focus) {
        const parsedSections = z.array(z.object({ id: z.string(), title: z.string().optional(), content: z.string().optional() })).safeParse(report.source.publicSections);
        const sections = parsedSections.success && parsedSections.data.length ? parsedSections.data : [{ id: report.sectionIds[0] ?? 'summary', content: report.content }];
        const matches = sections.filter(section => !ticker || `${section.title ?? ''} ${section.content ?? ''}`.toUpperCase().includes(ticker))
          .flatMap(section => (section.content ?? '').split(/[。！？\n]/u).map(sentence => sentence.trim()).filter(sentence => sentence.includes(focus) && /\d/u.test(sentence)).map(sentence => ({ sectionId: section.id, sentence })));
        const unique = [...new Map(matches.map(match => [match.sentence, match])).values()];
        if (unique.length === 1) {
          const located = unique[0], fact = this.processFact(owner, request.id, 'supplement.reportLocator', 1, now);
          return { templateId: 'channel.supplement.report_fact', facts: [fact], card: { id: `card:${request.id}`, kind: 'evidence', summary: `已定位报告中的“${focus}”记载`,
            sources: [{ id: `${report.id}:${report.revision}:${located.sectionId}`, kind: 'tool_result', title: report.title, uri: `/analysis/reports/${encodeURIComponent(report.id)}`, publishedAt: report.createdAt.toISOString(), observedAt: now, verification: 'retrieved', locator: `段落 ${located.sectionId}：${located.sentence}` }],
            asOf: report.createdAt.toISOString(), gaps: ['本次核实报告如何记载该事实，未重新核实底层外部数据。'], supports: [{ factId: fact.id, scope: located.sentence }] } };
        }
      }
      const card = this.gapCard(request.id, report ? '找到当前报告，但本次不能唯一定位所问事实' : '当前没有可核验的报告来源', ['可单次核查：证券现价、持股数量、指定币种现金、报告内某只证券的一项财务指标。请明确证券、期间或指标；本次未展开多轮研究。']);
      if (report) card.sources.push({ id: report.id, kind: 'tool_result', title: report.title, uri: `/analysis/reports/${encodeURIComponent(report.id)}`, publishedAt: report.createdAt.toISOString(), observedAt: now, verification: 'retrieved' });
      return { templateId: 'channel.supplement.unverified', card, facts: [] };
    }
    return { templateId: 'channel.supplement.unverified', card: this.gapCard(request.id, '本次没有取得足够依据', [ticker ? '指定证券或所需数据尚未取得；本次不自动换工具。' : '缺少明确的证券或币种；原问题保留在本次范围中。']), facts: [] };
  }

  async action(owner: string, body: unknown) {
    const parsed = z.object({ actionId: z.string().min(1), bubbleId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), requestKey: z.string().min(1).max(150) }).strict().safeParse(body);
    if (!parsed.success) throw new BadRequestException('INVALID_CHANNEL_ACTION');
    const input = parsed.data, hash = channelHash(input);
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [prior] = await tx.select().from(tables.channelUserActions).where(and(eq(tables.channelUserActions.owner, owner), eq(tables.channelUserActions.requestKey, input.requestKey)));
      if (prior) { if (prior.inputHash !== hash) throw new ConflictException('REQUEST_KEY_CONFLICT'); return prior.result; }
      const [row] = await tx.select().from(tables.channelBubbles).where(and(eq(tables.channelBubbles.owner, owner), eq(tables.channelBubbles.id, input.bubbleId)));
      const action = row?.data.action?.find(a => a.id === input.actionId);
      if (!row || !action || action.expectedRevision !== input.expectedRevision || action.expiresAt && Date.parse(action.expiresAt) <= Date.now()) throw new ConflictException('ACTION_STALE_OR_UNAVAILABLE');
      const [episode] = await tx.select().from(tables.channelEpisodes).where(and(eq(tables.channelEpisodes.owner, owner), eq(tables.channelEpisodes.id, row.episodeId)));
      if (['review_proposal', 'apply_proposal', 'dismiss_proposal'].includes(action.kind)) {
        const [target] = await tx.select().from(userInvestmentStrategies).where(and(eq(userInvestmentStrategies.owner, owner), eq(userInvestmentStrategies.id, action.targetId), isNull(userInvestmentStrategies.deletedAt)));
        if (!target || target.revision !== input.expectedRevision || target.status !== 'draft' || row.resolvedAt) throw new ConflictException('ACTION_TARGET_CHANGED');
      }
      if (action.kind === 'snooze_episode' && (action.targetId !== episode.id || action.expectedRevision !== episode.data.revision || episode.data.phase === 'closed' || row.resolvedAt)) throw new ConflictException('ACTION_TARGET_CHANGED');
      if (action.kind === 'ask_one_fact') {
        const [target] = await tx.select().from(tables.channelDeferredQuestions).where(and(eq(tables.channelDeferredQuestions.owner, owner), eq(tables.channelDeferredQuestions.id, action.targetId)));
        if (!target || target.data.status !== 'pending') throw new ConflictException('ACTION_TARGET_CHANGED');
      }
      const decisionId = randomUUID();
      // Navigation never applies a strategy; the existing explicit review/apply path remains authoritative.
      const result: Record<string, unknown> = action.kind === 'review_proposal' || action.kind === 'apply_proposal' ? { navigation: `/paper?investmentStrategyId=${encodeURIComponent(action.targetId)}#investment-strategy` }
        : action.kind === 'view_evidence' ? { evidence: row.data.evidence } : { recorded: true };
      if (action.kind === 'ask_one_fact') result.questionId = action.targetId;
      await tx.insert(tables.channelUserActions).values({ id: decisionId, owner, requestKey: input.requestKey, inputHash: hash, data: { action, bubbleId: row.id }, result });
      if (!['view_evidence', 'review_proposal', 'apply_proposal', 'ask_one_fact'].includes(action.kind)) {
        await tx.update(tables.channelEpisodes).set({ data: { ...episode.data, revision: episode.data.revision + 1, userDecisionIds: [...episode.data.userDecisionIds, decisionId] }, updatedAt: new Date() }).where(and(eq(tables.channelEpisodes.owner, owner), eq(tables.channelEpisodes.id, episode.id)));
        await tx.update(tables.channelBubbles).set({ resolvedAt: new Date() }).where(and(eq(tables.channelBubbles.owner, owner), eq(tables.channelBubbles.id, row.id)));
      }
      return result;
    });
  }
}
