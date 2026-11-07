import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { channelBriefs, channelBubbles, channelReports, channelTemplateRegistry } from '../../database/channel.schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { experiencePreferences } from '../../database/simple-experience.schema';
import { holdings } from '../../database/schema';
import type { ChannelBrief, ChannelEvidenceCard, ChannelFact } from '../../../shared/channel.interface';
import type { MonitorCondition } from '../../../shared/research-monitor.interface';
import { monitorConditionSchema, sameMonitorSymbol } from '../research-memory/research-memory.monitor.rules';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';
import { businessDate } from '../experience/simple-experience.rules';
import { QuoteService } from '../quote/quote.service';
import { ChannelService } from './channel.service';
import { readChannelRuntime } from './channel-runtime';
import { TemplateRegistry } from './template-registry';
import { channelHash } from './channel-hash';

interface CompiledBrief extends ChannelBrief {
  compilation: {
    sourceCouncilReportId: string; sessionId: string; strategyId: string | null; strategyRevision: number | null;
    startedAt: string; finishedAt: string; timezone: string; ticker?: string; condition?: MonitorCondition;
    observation?: { matched: boolean; episode: number; quoteAt: string };
  };
}

/** Compiles sourced report artifacts once, then dispatches deterministic templates without a model. */
@Injectable()
export class ChannelBriefsService {
  private busy = false;
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly channel: ChannelService, private readonly quotes: QuoteService) {}

  async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      await this.compilePublished();
      const rows = await this.db.select().from(channelBriefs).orderBy(desc(channelBriefs.createdAt));
      for (const row of rows) {
        const brief = row.data as CompiledBrief;
        if (brief.status !== 'ready' || !brief.compilation) continue;
        if (!await this.stillCurrent(row.owner, brief)) {
          await this.setStatus(row.owner, brief, Date.parse(brief.expiresAt) <= Date.now() ? 'expired' : 'invalidated');
          continue;
        }
        if (Date.parse(brief.validFrom) > Date.now()) continue;
        if (brief.when.kind === 'cross') await this.dispatchCross(row.owner, brief);
        else await this.dispatchCompleted(row.owner, brief);
      }
    } finally { this.busy = false; }
  }

  private async setStatus(owner: string, brief: CompiledBrief, status: ChannelBrief['status']) {
    await this.db.update(channelBriefs).set({ data: { ...brief, status } }).where(and(eq(channelBriefs.owner, owner), eq(channelBriefs.id, brief.id)));
  }

  private async compilePublished(): Promise<void> {
    const reports = await this.db.select().from(channelReports).orderBy(desc(channelReports.createdAt));
    const latest = new Set<string>();
    const templates = await this.db.select().from(channelTemplateRegistry);
    const registry = new TemplateRegistry(templates.map(row => row.data));
    for (const report of reports) {
      if (latest.has(report.owner)) continue; latest.add(report.owner);
      const [preference] = await this.db.select().from(experiencePreferences).where(eq(experiencePreferences.owner, report.owner));
      const timezone = preference?.timezone ?? 'Asia/Shanghai';
      if (businessDate(report.createdAt, timezone) !== businessDate(new Date(), timezone)) continue;
      const sourceId = typeof report.source.id === 'string' ? report.source.id : '';
      if (report.source.type !== 'council' || !/^[\da-f-]{36}$/iu.test(sourceId)) continue;
      const [source] = await this.db.select({ report: councilReports, session: councilSessions, version: researchDocumentVersions })
        .from(councilReports).innerJoin(councilSessions, and(eq(councilSessions.owner, report.owner), eq(councilSessions.id, councilReports.sessionId)))
        .innerJoin(researchDocumentVersions, and(eq(researchDocumentVersions.owner, report.owner), eq(researchDocumentVersions.id, report.id)))
        .where(and(eq(councilReports.owner, report.owner), eq(councilReports.id, sourceId)));
      if (!source || source.version.revokedAt || source.report.publicationOutcome !== 'succeeded' || source.session.status !== 'completed') continue;
      if(source.session.checkpoint?.simple?.contextDate&&source.session.checkpoint.simple.contextDate!==businessDate(new Date(),timezone))continue;
      const runtime = await readChannelRuntime(this.db, report.owner);
      const validUntil = new Date(report.createdAt.getTime() + 24 * 3600000).toISOString();
      const publicationFactId = channelHash([report.owner, report.id, report.revision, 'publication']);
      const publicationCard: ChannelEvidenceCard = { id: `card:${publicationFactId}`, kind: 'evidence', summary: '原报告已完成并归档，原始判断与核查结果可追溯。',
        sources: [{ id: source.report.id, kind: 'ledger', title: report.title, uri: `/?reportId=${encodeURIComponent(report.id)}`, publishedAt: source.report.createdAt.toISOString(),
          observedAt: source.report.createdAt.toISOString(), verification: 'checked' }], asOf: source.report.createdAt.toISOString(), gaps: [],
        supports: [{ factId: publicationFactId, scope: '报告已发布及其不可变来源版本' }] };
      await this.channel.ingestFact(report.owner, { id: publicationFactId, revision: 1, ownerId: report.owner, key: 'research.report_published',
        value: 1, observedAt: source.report.createdAt.toISOString(), expiresAt: validUntil, subject: 'research_process' }, publicationCard);
      const base = { revision: 1, reportId: report.id, reportRevision: report.revision,
        card: { templateId: 'channel.card.report', templateRevision: 1, sourceEvidenceCardIds: [publicationCard.id], includeTriggerFacts: true as const },
        anchor: { reportSectionId: report.sectionIds[0] ?? 'summary' }, requiredChecks: ['fresh_data', 'no_unresolved_source_correction'],
        validFrom: report.createdAt.toISOString(), expiresAt: validUntil, status: 'ready' as const,
        compilation: { sourceCouncilReportId: sourceId, sessionId: source.session.id, strategyId: runtime.current.strategyId,
          strategyRevision: runtime.current.strategyRevision, timezone, startedAt: source.session.createdAt.toISOString(), finishedAt: source.report.createdAt.toISOString() } };
      const save = async (brief: CompiledBrief) => {
        try { registry.resolveTemplate(brief.text, 'bubble', 'publish'); registry.resolveTemplate(brief.card, 'evidence_card', 'publish'); }
        catch { return; }
        await this.db.insert(channelBriefs).values({ id: brief.id, owner: report.owner, data: brief }).onConflictDoNothing();
      };
      if (source.session.checkpoint?.simple?.researchOnly) {
        await save({ ...base, id: `closed:${report.id}`, when: { kind: 'event', eventKind: 'research.day_closed', entityId: source.session.id },
          agent: 'laozhou', text: { templateId: 'channel.research.closed', templateRevision: 1, slots: [] },
          stance: 'quiet_win', weight: 'tap', layer: 2, posture: 'standalone' });
        const duration = Math.floor((source.report.createdAt.getTime() - source.session.createdAt.getTime()) / 60000);
        if (duration >= 1) await save({ ...base, id: `arrived:${report.id}`, when: { kind: 'event', eventKind: 'research.day_closed', entityId: source.session.id },
          agent: 'xiaoqi', text: { templateId: 'channel.process.research_arrived', templateRevision: 1,
            slots: [{ name: 'minutes', source: { kind: 'fact', factKey: 'process.elapsedMinutes' }, format: 'decimal' }] },
          stance: 'mood', weight: 'tap', layer: 2, posture: 'standalone' });
      }
      const ownedSymbols = await this.db.select({ ticker: holdings.ticker }).from(holdings).where(eq(holdings.owner, report.owner));
      const priorBriefs = await this.db.select().from(channelBriefs).where(and(eq(channelBriefs.owner, report.owner), sql`${channelBriefs.data}->>'reportId'=${report.id}`));
      for (const [thesisIndex, thesis] of (source.report.thesisCandidates ?? []).entries()) {
        for (const rawCondition of thesis.monitorConditions ?? []) {
          const parsed = monitorConditionSchema.safeParse(rawCondition);
          if (!parsed.success || parsed.data.metric !== 'price') continue;
          const condition = parsed.data;
          if (condition.evidenceIds.some(id => !source.report.evidence.some(evidence => evidence.id === id))) continue;
          const direct = source.session.ticker !== 'PORTFOLIO' && resolveTradingTicker(source.session.ticker) ? source.session.ticker : null;
          const entities = source.report.evidence.filter(evidence => condition.evidenceIds.includes(evidence.id))
            .flatMap(evidence => evidence.metadata?.sources.flatMap(component => component.facts.map(fact => fact.entity).filter((entity): entity is string => Boolean(entity))) ?? []);
          const matches = [...new Set(ownedSymbols.filter(symbol => entities.some(entity => sameMonitorSymbol(entity, symbol.ticker))).map(symbol => symbol.ticker))];
          const ticker = direct ?? (matches.length === 1 ? matches[0] : null);
          if (!ticker) continue; // No ticker inference from prose, and no forced default threshold.
          const expiresAt = new Date(Math.min(Date.parse(condition.validUntil), Date.parse(validUntil))).toISOString();
          if (Date.parse(expiresAt) <= Date.now()) continue;
          const conditionId = `cross:${report.id}:${thesisIndex}:${condition.conditionIndex}`;
          // Keep retired contexts immutable. A new context carries the same report condition's
          // latest observation so merely changing strategy never repeats an unchanged alert.
          const conditionBriefs = priorBriefs.filter(row => row.id === conditionId || row.id.startsWith(`${conditionId}:strategy:`)).map(row => row.data as CompiledBrief);
          const observation = conditionBriefs.map(brief => brief.compilation?.observation).filter((item): item is NonNullable<CompiledBrief['compilation']['observation']> => Boolean(item))
            .sort((left, right) => Date.parse(right.quoteAt) - Date.parse(left.quoteAt))[0];
          const contextId = channelHash([runtime.current.strategyId, runtime.current.strategyRevision]);
          const sameContext = conditionBriefs.filter(brief => brief.compilation?.strategyId === runtime.current.strategyId && brief.compilation?.strategyRevision === runtime.current.strategyRevision);
          const currentBrief = sameContext.find(brief => brief.status === 'ready');
          await save({ ...base, id: currentBrief?.id ?? `${conditionId}:strategy:${contextId}:${sameContext.length + 1}`, expiresAt,
            validFrom: new Date(Math.max(Date.parse(condition.validFrom), report.createdAt.getTime())).toISOString(),
            when: { kind: 'cross', factKey: `quote:${ticker}:price`, operator: condition.operator.startsWith('g') ? 'above' : 'below',
              threshold: { kind: 'report_value', assertionId: `thesis:${thesisIndex}:condition:${condition.conditionIndex}`, value: String(condition.threshold) }, hysteresis: '0' },
            agent: 'xiaoqi', text: { templateId: 'channel.report.condition', templateRevision: 1, slots: [] },
            stance: 'plain_fact', weight: 'nudge', layer: 3, posture: 'standalone',
            compilation: { ...base.compilation, ticker, condition, ...(observation ? { observation } : {}) } });
        }
      }
    }
  }

  private async stillCurrent(owner: string, brief: CompiledBrief): Promise<boolean> {
    if (Date.parse(brief.expiresAt) <= Date.now()) return false;
    const [latest] = await this.db.select().from(channelReports).where(eq(channelReports.owner, owner)).orderBy(desc(channelReports.createdAt)).limit(1);
    if (!latest || latest.id !== brief.reportId || latest.revision !== brief.reportRevision) return false;
    const [version] = await this.db.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, brief.reportId)));
    if (!version || version.revokedAt) return false;
    const runtime = await readChannelRuntime(this.db, owner);
    return runtime.current.strategyId === brief.compilation.strategyId && runtime.current.strategyRevision === brief.compilation.strategyRevision;
  }

  private async dispatchCompleted(owner: string, brief: CompiledBrief) {
    const arrival = brief.text.templateId === 'channel.process.research_arrived';
    const date = businessDate(new Date(brief.compilation.finishedAt), brief.compilation.timezone);
    const episodeId = arrival ? `research-process:${brief.compilation.sessionId}` : `research-close:${owner}:${date}`;
    const delta = channelHash([episodeId, arrival ? 'duration' : 'closed']);
    const factId = channelHash([brief.id, 'completed']);
    const minutes = Math.floor((Date.parse(brief.compilation.finishedAt) - Date.parse(brief.compilation.startedAt)) / 60000);
    const fact: ChannelFact = { id: factId, revision: 1, ownerId: owner, key: arrival ? 'process.elapsedMinutes' : 'research.completed',
      value: arrival ? minutes : 1, observedAt: brief.compilation.finishedAt, expiresAt: brief.expiresAt, subject: 'research_process' };
    const card: ChannelEvidenceCard = { id: `card:${factId}`, kind: 'evidence', summary: arrival ? `本轮研究实际耗时 ${minutes} 分钟，结果已归档。` : '当日研究已生成可查阅的报告。',
      sources: [{ id: brief.compilation.sourceCouncilReportId, kind: 'ledger', title: '已完成的研究记录', uri: `/?reportId=${encodeURIComponent(brief.reportId)}`,
        publishedAt: brief.compilation.finishedAt, observedAt: brief.compilation.finishedAt, verification: 'checked' }], asOf: brief.compilation.finishedAt,
      gaps: ['完成研究不代表研究判断已被市场或反证核查证明正确。'], supports: [{ factId, scope: '研究开始、完成及归档时点' }] };
    await this.channel.publishTemplate(owner, { briefId: brief.id, templateRevision: brief.text.templateRevision, episodeId, entityId: brief.compilation.sessionId, title: '今日研究',
      eventKind: 'research.day_closed', semanticDeltaId: delta, facts: [{ fact, card }], templateId: brief.text.templateId,
      stance: brief.stance, weight: brief.weight, layer: brief.layer, posture: 'standalone', evidence: card,
      deliveryCause: arrival ? 'process' : 'closing_ritual' });
  }

  private async dispatchCross(owner: string, brief: CompiledBrief) {
    const { ticker, condition } = brief.compilation;
    if (!ticker || !condition) return;
    let quote: Awaited<ReturnType<QuoteService['getQuote']>>;
    try { quote = await this.quotes.getQuote(ticker); } catch { return; }
    const quoteTime = quote?.quoteAt ? Date.parse(quote.quoteAt) : NaN;
    if (!quote || !Number.isFinite(quoteTime) || Date.now() - quoteTime > 180000 || quoteTime > Date.now() + 5000
      || quote.currency !== condition.unit || !(Number(quote.price) > 0) || !sameMonitorSymbol(quote.symbol, ticker)) return;
    const old = brief.compilation.observation;
    if (old && quoteTime <= Date.parse(old.quoteAt)) return;
    const value = Number(quote.price), threshold = condition.threshold;
    const matched = condition.operator === 'lt' ? value < threshold : condition.operator === 'lte' ? value <= threshold : condition.operator === 'gt' ? value > threshold : value >= threshold;
    const episode = old?.episode ?? 0;
    if (!matched) {
      await this.db.update(channelBriefs).set({ data: { ...brief, compilation: { ...brief.compilation, observation: { matched: false, episode, quoteAt: quote.quoteAt! } } } as CompiledBrief })
        .where(and(eq(channelBriefs.owner, owner), eq(channelBriefs.id, brief.id), sql`${channelBriefs.data}->>'status'='ready'`));
      return;
    }
    if (old?.matched) return;
    const number = episode + 1, episodeId = `brief:${brief.id}:${number}`, delta = channelHash([brief.id, 'condition_met', number]);
    const factId = channelHash([brief.id, quote.quoteAt, number]);
    const fact: ChannelFact = { id: factId, revision: 1, ownerId: owner, key: brief.when.kind === 'cross' ? brief.when.factKey : 'research.condition',
      value: String(quote.price), observedAt: quote.quoteAt!, expiresAt: new Date(quoteTime + 180000).toISOString(), sourceId: `${quote.source}:${quote.symbol}:${quote.quoteAt}`, subject: 'verified_fact' };
    const card: ChannelEvidenceCard = { id: `card:${factId}`, kind: 'evidence', summary: `${ticker} 价格 ${quote.price} ${quote.currency}，报告条件 ${condition.operator} ${threshold} ${condition.unit} 已满足。`,
      sources: [{ id: fact.sourceId!, kind: 'market_data', title: `${ticker} · ${quote.source ?? '行情'}`, uri: `/holdings?ticker=${encodeURIComponent(ticker)}`,
        publishedAt: quote.quoteAt!, observedAt: new Date().toISOString(), verification: 'retrieved' },
      { id: brief.reportId, kind: 'tool_result', title: '原报告中的结构化观察条件', uri: `/?reportId=${encodeURIComponent(brief.reportId)}`,
        publishedAt: brief.compilation.finishedAt, observedAt: brief.compilation.finishedAt, verification: 'checked' }], asOf: quote.quoteAt!,
      gaps: ['这是研究观察条件，不是交易指令；本次未修改策略或提交模拟订单。'], supports: [{ factId, scope: condition.rationale }] };
    await this.channel.publishTemplate(owner, { briefId: brief.id, templateRevision: brief.text.templateRevision, episodeId, entityId: ticker, title: `${ticker} · 报告观察条件`,
      eventKind: 'thesis.changed', semanticDeltaId: delta, facts: [{ fact, card }], templateId: brief.text.templateId,
      stance: brief.stance, weight: brief.weight, layer: brief.layer, posture: 'standalone', evidence: card });
    const [published] = await this.db.select().from(channelBubbles).where(and(eq(channelBubbles.owner, owner), eq(channelBubbles.episodeId, episodeId), eq(channelBubbles.semanticDeltaId, delta)));
    if (published) await this.db.update(channelBriefs).set({ data: { ...brief, compilation: { ...brief.compilation, observation: { matched: true, episode: number, quoteAt: quote.quoteAt! } } } as CompiledBrief })
      .where(and(eq(channelBriefs.owner, owner), eq(channelBriefs.id, brief.id), sql`${channelBriefs.data}->>'status'='ready'`));
  }
}
