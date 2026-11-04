import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { researchMonitorEvents, researchMonitorRules, researchThesisReplacements } from '../../database/research-monitor.schema';
import { researchTheses, researchMemories } from '../../database/research-memory.schema';
import { builderProfiles, paperAccounts } from '../../database/schema';
import { strategyOutbox } from '../../database/strategy.schema';
import type { BuilderConfig } from '@shared/api.interface';
import type { ResearchMonitorView, StrategyMemoryInventory } from '@shared/research-monitor.interface';
import { resolveTradingTicker, type TradingMarketSnapshot } from '@shared/trading-market.interface';
import { evaluateMonitor, monitorWriteSchema, sameMonitorSymbol } from './research-memory.monitor.rules';
import { lockMemoryOwner, type MemoryFenceTransaction } from './research-memory.fence';
import { lockedThesis, resolvedThesisDependency } from './research-memory.dependencies';
import { isUnverifiedCitation } from './research-memory.theses';
import { thesisFreshness } from './research-memory.temporal';

export async function createThesisMonitors(tx: MemoryFenceTransaction, owner: string,
  thesis: typeof researchTheses.$inferSelect, memory: typeof researchMemories.$inferSelect): Promise<void> {
  if (!['accepted', 'confirmed'].includes(thesis.status)) return;
  for (const condition of thesis.content.monitorConditions ?? []) {
    if (['price', 'sma20'].includes(condition.metric) && resolveTradingTicker(memory.ticker)?.currency !== condition.unit) {
      throw new BadRequestException('MEMORY_MONITOR_UNIT_MISMATCH');
    }
    await tx.insert(researchMonitorRules).values({ owner, rootId: randomUUID(), thesisId: thesis.id, thesisVersion: thesis.version,
      version: 1, ticker: memory.ticker, market: memory.market, origin: thesis.status === 'accepted' ? 'agent-reviewed' : 'user',
      reportId: memory.reportId, reportVersion: memory.reportVersion, condition });
  }
}

/** DB-only. Snapshot fetching is outside the owner fence, including in the final ledger transaction. */
export async function observeThesisMonitors(tx: MemoryFenceTransaction, owner: string, inventory: StrategyMemoryInventory,
  snapshot: TradingMarketSnapshot, profileId: string, now = new Date()): Promise<boolean> {
  const [profile] = await tx.select().from(builderProfiles).where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.id, profileId)));
  const [account] = await tx.select().from(paperAccounts).where(eq(paperAccounts.owner, owner));
  const config = profile?.config as BuilderConfig | undefined;
  if (profile?.status !== 'active' || !config?.automation?.enabled || !account?.botEnabled) return false;
  let breached = false;
  for (const ref of inventory.dependencies.filter(ref => sameMonitorSymbol(ref.ticker, snapshot.ticker))) {
    if (await resolvedThesisDependency(tx, owner, inventory, ref, now)) continue;
    const current = await lockedThesis(tx, owner, ref.thesisId);
    if (!current || current.thesis.version !== ref.version) continue;
    const rules = await tx.select().from(researchMonitorRules).where(and(eq(researchMonitorRules.owner, owner),
      eq(researchMonitorRules.thesisId, ref.thesisId), eq(researchMonitorRules.thesisVersion, ref.version), eq(researchMonitorRules.enabled, true)));
    for (const rule of rules) {
      const observation = evaluateMonitor(rule.condition, rule.ticker, snapshot, now);
      const [event] = await tx.insert(researchMonitorEvents).values({ owner, ruleId: rule.id, ruleVersion: rule.version,
        thesisId: ref.thesisId, thesisVersion: ref.version, observationKey: observation.observationKey, state: observation.state, observation })
        .onConflictDoNothing().returning({ id: researchMonitorEvents.id });
      breached ||= observation.state === 'breached';
      if (event && observation.state === 'breached' && config.notifyOnProposal) await tx.insert(strategyOutbox).values({ owner, profileId,
        eventKey: `memory-breach:${profileId}:${ref.thesisId}:${ref.version}`, payload: { event: 'strategy_memory_breached',
          title: config.language === 'en' ? 'PAPER thesis condition breached' : '模拟策略论点条件已触发',
          body: config.language === 'en' ? `${ref.ticker}: new risk is blocked until a reviewed thesis revision. Protective exits remain active.`
            : `${ref.ticker}：新增风险已阻断，等待论点复核修订；保护性退出继续有效。` } }).onConflictDoNothing();
    }
  }
  return breached;
}

@Injectable()
export class ResearchMonitorService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}
  async observe(owner: string, inventory: StrategyMemoryInventory, snapshot: TradingMarketSnapshot, profileId: string): Promise<boolean> {
    return this.db.transaction(async tx => { await lockMemoryOwner(tx, owner);
      return observeThesisMonitors(tx, owner, inventory, snapshot, profileId); });
  }
  async write(owner: string, thesisId: string, input: unknown): Promise<ResearchMonitorView> {
    const parsed = monitorWriteSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('MEMORY_INVALID_MONITOR');
    const data = parsed.data;
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const current = await lockedThesis(tx, owner, thesisId);
      if (!current) throw new NotFoundException('MEMORY_THESIS_NOT_FOUND');
      if (current.thesis.version !== data.expectedVersion) throw new ConflictException('MEMORY_VERSION_CONFLICT');
      if (data.condition.conditionIndex >= current.thesis.content.invalidationConditions.length
        || data.condition.evidenceIds.some(id => !current.report.evidence.some(item => item.id === id && !isUnverifiedCitation(item)))) throw new BadRequestException('MEMORY_INVALID_MONITOR_SOURCE');
      if (['price', 'sma20'].includes(data.condition.metric) && resolveTradingTicker(current.memory.ticker)?.currency !== data.condition.unit) {
        throw new BadRequestException('MEMORY_MONITOR_UNIT_MISMATCH');
      }
      const [old] = data.ruleId ? await tx.select().from(researchMonitorRules).where(and(eq(researchMonitorRules.owner, owner),
        eq(researchMonitorRules.id, data.ruleId), eq(researchMonitorRules.thesisId, thesisId), eq(researchMonitorRules.thesisVersion, data.expectedVersion))) : [];
      const [latest] = old ? await tx.select().from(researchMonitorRules).where(and(eq(researchMonitorRules.owner, owner),
        eq(researchMonitorRules.rootId, old.rootId))).orderBy(desc(researchMonitorRules.version)).limit(1) : [];
      if (data.ruleId && (!old || old.version !== data.ruleVersion || latest?.id !== old.id)) throw new ConflictException('MEMORY_MONITOR_VERSION_CONFLICT');
      const active = await tx.select({ id: researchMonitorRules.id }).from(researchMonitorRules).where(and(eq(researchMonitorRules.owner, owner),
        eq(researchMonitorRules.thesisId, thesisId), eq(researchMonitorRules.thesisVersion, data.expectedVersion), eq(researchMonitorRules.enabled, true)));
      if (!old?.enabled && data.enabled !== false && active.length >= 20) throw new BadRequestException('MEMORY_MONITOR_LIMIT');
      if (old) await tx.update(researchMonitorRules).set({ enabled: false }).where(eq(researchMonitorRules.id, old.id));
      await tx.insert(researchMonitorRules).values({ owner, rootId: old?.rootId ?? randomUUID(), thesisId, thesisVersion: data.expectedVersion,
        version: (old?.version ?? 0) + 1, ticker: current.memory.ticker, market: current.memory.market, origin: 'user',
        reportId: current.report.id, reportVersion: current.report.version, condition: data.condition, enabled: data.enabled ?? true });
    });
    return this.view(owner, thesisId);
  }
  async view(owner: string, thesisId: string): Promise<ResearchMonitorView> {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const current = await lockedThesis(tx, owner, thesisId, false);
      if (!current) throw new NotFoundException('MEMORY_THESIS_NOT_FOUND');
      const rules = await tx.select().from(researchMonitorRules).where(and(eq(researchMonitorRules.owner, owner),
        eq(researchMonitorRules.thesisId, thesisId))).orderBy(desc(researchMonitorRules.createdAt));
      const events = rules.length ? await tx.select().from(researchMonitorEvents).where(and(eq(researchMonitorEvents.owner, owner),
        inArray(researchMonitorEvents.ruleId, rules.map(rule => rule.id)))).orderBy(desc(researchMonitorEvents.createdAt)).limit(100) : [];
      const configured = rules.filter(rule => rule.thesisVersion === current.thesis.version && rule.enabled);
      const latest = rules.length ? await tx.selectDistinctOn([researchMonitorEvents.ruleId]).from(researchMonitorEvents).where(and(
        eq(researchMonitorEvents.owner, owner), inArray(researchMonitorEvents.ruleId, rules.map(rule => rule.id))))
        .orderBy(researchMonitorEvents.ruleId, desc(researchMonitorEvents.createdAt)) : [];
      const valid = rules.length ? await tx.selectDistinctOn([researchMonitorEvents.ruleId]).from(researchMonitorEvents).where(and(
        eq(researchMonitorEvents.owner, owner), inArray(researchMonitorEvents.ruleId, rules.map(rule => rule.id)), ne(researchMonitorEvents.state, 'unknown')))
        .orderBy(researchMonitorEvents.ruleId, desc(researchMonitorEvents.createdAt)) : [];
      const [breach] = await tx.select({ id: researchMonitorEvents.id }).from(researchMonitorEvents).where(and(eq(researchMonitorEvents.owner, owner),
        eq(researchMonitorEvents.thesisId, thesisId), eq(researchMonitorEvents.thesisVersion, current.thesis.version), eq(researchMonitorEvents.state, 'breached'))).limit(1);
      const [proof] = await tx.select().from(researchThesisReplacements).where(and(eq(researchThesisReplacements.owner, owner),
        eq(researchThesisReplacements.thesisId, thesisId), eq(researchThesisReplacements.thesisVersion, current.thesis.version)));
      const previous = proof ? await lockedThesis(tx, owner, proof.previousId) : null;
      const fresh = !['expired', 'not_yet_valid', 'needs_review'].includes(thesisFreshness(current.thesis.content,
        current.thesis.expiresAt?.toISOString() ?? null, new Date().toISOString(), current.conflicted));
      return { rules: rules.map(rule => ({ ...rule, lastObservation: latest.find(event => event.ruleId === rule.id)?.observation ?? null,
        lastValidObservation: valid.find(event => event.ruleId === rule.id)?.observation ?? null })), executionEligible: current.executionEligible && fresh && !breach,
        events: events.map(event => ({ ...event.observation, id: event.id, ruleId: event.ruleId, ruleVersion: event.ruleVersion,
        thesisVersion: event.thesisVersion, createdAt: event.createdAt.toISOString() })), breached: Boolean(breach),
        configuration: configured.length ? 'configured' : 'unconfigured', scope: 'enabled-paper-strategies',
        unsupportedConditions: current.thesis.content.invalidationConditions.flatMap((_text, index) => configured.some(rule => rule.condition.conditionIndex === index) ? [] : [index]),
        replacement: current.thesis.content.supersedes ?? null,
        replacementState: proof ? previous?.thesis.version === proof.previousVersion ? 'reviewed' : 'stale' : current.thesis.content.supersedes ? 'proposed' : 'none' };
    });
  }
}
