import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { automaticResearchTasks, investmentCycles, investmentPolicies } from '../../database/investment-policy.schema';
import { builderProfiles, paperAccounts, paperPositions, paperTrades } from '../../database/schema';
import { simulationSeeds } from '../../database/simulation-experiments.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { SimpleCouncilService } from '../council/simple-council.service';
import { ResearchDiscoveryService } from '../research-tools/research-discovery.service';
import { EvidenceService } from '../research-core/evidence.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { InvestmentPolicyService, cancelInvestmentCandidates, expireInvestmentConstraints, investmentHash, type PolicyRow } from './investment-policy.service';
import { AutomaticResearchBudgetService } from './automatic-research-budget.service';
import { AutonomousPlanCompiler, compileAutonomousRules } from './autonomous-plan.compiler';
import { StrategyModelService } from './strategy-model.service';
import { TradingMarketService } from './trading-market.service';
import { normalizeBuilderConfig } from './agent-builder.rules';
import type { CouncilMember } from '../../../shared/council.interface';
import type { AutonomousMandateRule, InvestmentResearchReview, VerifiedInvestmentSecurity } from '../../../shared/investment-policy.interface';
import type { BuilderConfig, Market } from '../../../shared/api.interface';
import { paperRiskDay } from './paper-risk-day';
import { investmentSecurityKey } from './investment-policy.rules';

const draftSchema = z.object({ conclusion: z.enum(['approve', 'observe', 'research_more']), summary: z.string().min(1).max(4000),
  unresolvedDisagreements: z.array(z.string().max(1000)).max(20), rules: z.array(z.unknown()).max(20) }).strict();
const reviewSchema = z.object({ conclusion: z.enum(['approve', 'observe', 'research_more']), summary: z.string().min(1).max(4000),
  unresolvedDisagreements: z.array(z.string().max(1000)).max(20), agreesWithProposedRules: z.boolean() }).strict();
type Cycle = typeof investmentCycles.$inferSelect;

/** Durable work is claimed before any provider dispatch. Uncertain work is retained for review, never replayed. */
@Injectable()
export class AutonomousResearchService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly policies: InvestmentPolicyService, private readonly budget: AutomaticResearchBudgetService,
    private readonly discovery: ResearchDiscoveryService, private readonly team: SimpleCouncilService,
    private readonly model: StrategyModelService, private readonly evidence: EvidenceService,
    private readonly market: TradingMarketService, private readonly documents: ResearchDocumentsService,
    private readonly compiler: AutonomousPlanCompiler) {}

  async queueCurrentMarkets(): Promise<void> {
    const policies = await this.db.select().from(investmentPolicies).where(eq(investmentPolicies.status, 'running'));
    for (const policy of policies.filter(p => !p.baseConfig.userStrategy)) for (const market of policy.effectiveConfig.markets) {
      const schedule = await this.market.getSchedule(market);
      if (!schedule.calendarVerified || !schedule.isTradingDay || !schedule.closesAt || !schedule.opensAt
        || Date.now() < Date.parse(schedule.opensAt) - 60 * 60000 || Date.now() >= Date.parse(schedule.closesAt)) continue;
      // Connection discovery stays outside the transaction and never dispatches research.
      const available = await this.team.resolveMembers(policy.owner).catch(() => ({ members: [], executors: [] }));
      const verifiedSources = [...new Set(available.executors.filter(e => e.identityVerified === true).map(e => e.identity))].sort();
      await this.db.transaction(async tx => {
        await lockMemoryOwner(tx, policy.owner);
        const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, policy.owner), eq(paperAccounts.id, policy.accountId))).for('update');
        const [unexpired] = await tx.select().from(investmentPolicies).where(eq(investmentPolicies.id, policy.id)).for('update');
        const current = await expireInvestmentConstraints(tx, unexpired);
        if (!account?.isActive || !account.botEnabled || current.status !== 'running') return;
        const existing = await tx.select().from(investmentCycles).where(and(eq(investmentCycles.policyId, current.id), eq(investmentCycles.policyRevision, current.revision), eq(investmentCycles.market, market), eq(investmentCycles.marketDate, schedule.tradingDate))).orderBy(desc(investmentCycles.createdAt));
        const phase = Date.now() < Date.parse(schedule.opensAt!) ? 'preopen' : 'open';
        if (existing.some(c => ['researching', 'queued', 'uncertain'].includes(c.state))) return;
        const latest = existing.find(c => !['cancelled', 'superseded'].includes(c.state));
        const waiting = latest?.state === 'waiting' ? latest : undefined;
        if (waiting?.result.reason === 'CONNECT_AVAILABLE_AI') {
          if (!available.members.length) return;
          const dispatched = await tx.select({ id: automaticResearchTasks.id }).from(automaticResearchTasks).where(and(eq(automaticResearchTasks.owner, policy.owner), sql`${automaticResearchTasks.key} LIKE ${'%' + waiting.id + '%'}`)).limit(1);
          if (dispatched.length) return; // A claimed task can include paid web work even when model calls are zero.
          await tx.update(investmentCycles).set({ state: 'queued', leaseToken: null, leaseUntil: null, result: { ...waiting.result, reason: 'AI_CONNECTED_REEVALUATION' }, updatedAt: new Date() }).where(eq(investmentCycles.id, waiting.id));
          return;
        }
        if (waiting?.result.reason === 'WAITING_INDEPENDENT_REVIEW') {
          const previousSources = Array.isArray(waiting.input.actualExecutors) ? [...new Set(waiting.input.actualExecutors.flatMap(e => e && typeof e === 'object' && e.identityVerified === true && typeof e.identity === 'string' ? [e.identity] : []))].sort() : [];
          if (verifiedSources.length < 2 || investmentHash(verifiedSources) === investmentHash(previousSources)) return;
          const [recovery] = await tx.insert(investmentCycles).values({ owner: policy.owner, accountId: account.id, policyId: current.id, policyRevision: current.revision, market,
            marketDate: schedule.tradingDate, trigger: 'team_available', eventKey: `team:${waiting.id}:${investmentHash(verifiedSources)}`, priority: waiting.priority, input: { recoveredFromCycleId: waiting.id } }).onConflictDoNothing().returning();
          if (recovery) await tx.update(investmentCycles).set({ state: 'superseded', result: { ...waiting.result, recoveredByCycleId: recovery.id }, updatedAt: new Date() }).where(eq(investmentCycles.id, waiting.id));
          return;
        }
        if (existing.some(c => c.state === 'completed' || c.eventKey === `market:${schedule.tradingDate}:${phase}`
          || c.state === 'waiting' && /BUDGET|INDEPENDENT_REVIEW/u.test(String(c.result.reason)))) return;
        await tx.insert(investmentCycles).values({ owner: policy.owner, accountId: account.id, policyId: current.id, policyRevision: current.revision, market,
          marketDate: schedule.tradingDate, trigger: 'market_open', eventKey: `market:${schedule.tradingDate}:${phase}`, priority: 1 }).onConflictDoNothing();
      });
    }
  }
  async trigger(owner: string, policyId: string, market: Market, eventKey: string, trigger: 'evidence_invalidated' | 'important_event') {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [policy] = await tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.id, policyId)));
      if (!policy || policy.baseConfig.userStrategy || policy.status !== 'running' || !policy.effectiveConfig.markets.includes(market)) return null;
      const [cycle] = await tx.insert(investmentCycles).values({ owner, policyId, accountId: policy.accountId, policyRevision: policy.revision,
        market, marketDate: paperRiskDay(new Date(), market === 'US' ? 'America/New_York' : market === 'HK' ? 'Asia/Hong_Kong' : 'Asia/Shanghai'), eventKey, trigger, priority: trigger === 'evidence_invalidated' ? 0 : 1 }).onConflictDoNothing().returning();
      return cycle ?? null;
    });
  }
  async queued(): Promise<Cycle[]> {
    return this.db.select().from(investmentCycles).where(inArray(investmentCycles.state, ['queued', 'researching'])).orderBy(asc(investmentCycles.priority), asc(investmentCycles.createdAt)).limit(12);
  }
  private async claim(owner: string, id: string): Promise<{ cycle: Cycle; policy: PolicyRow; token: string } | null> {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [found] = await tx.select().from(investmentCycles).where(and(eq(investmentCycles.owner, owner), eq(investmentCycles.id, id)));
      if (!found) return null;
      const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, found.accountId))).for('update');
      const [unexpired] = await tx.select().from(investmentPolicies).where(eq(investmentPolicies.id, found.policyId)).for('update');
      const policy = await expireInvestmentConstraints(tx, unexpired);
      const [cycle] = await tx.select().from(investmentCycles).where(eq(investmentCycles.id, id)).for('update');
      if (cycle.state === 'researching' && cycle.leaseUntil && cycle.leaseUntil.getTime() <= Date.now()) {
        await tx.update(investmentCycles).set({ state: 'uncertain', result: { reason: 'LEASE_EXPIRED_DISPATCH_NOT_REPLAYED' }, updatedAt: new Date() }).where(eq(investmentCycles.id, id)); return null;
      }
      if (cycle.state !== 'queued') return null;
      if (policy.baseConfig.userStrategy || !account?.isActive || !account.botEnabled || policy.status !== 'running' || policy.revision !== cycle.policyRevision) {
        await tx.update(investmentCycles).set({ state: 'cancelled', result: { reason: 'POLICY_CHANGED' }, updatedAt: new Date() }).where(eq(investmentCycles.id, id)); return null;
      }
      const token = randomUUID();
      const [claimed] = await tx.update(investmentCycles).set({ state: 'researching', leaseToken: token, leaseUntil: new Date(Date.now() + 5 * 60000), updatedAt: new Date() }).where(eq(investmentCycles.id, id)).returning();
      return { cycle: claimed, policy, token };
    });
  }
  private async valid(cycle: Cycle, token: string) {
    const [current] = await this.db.select().from(investmentCycles).where(and(eq(investmentCycles.id, cycle.id), eq(investmentCycles.leaseToken, token)));
    const [policy] = await this.db.select().from(investmentPolicies).where(eq(investmentPolicies.id, cycle.policyId));
    const [account] = await this.db.select().from(paperAccounts).where(eq(paperAccounts.id, cycle.accountId));
    return Boolean(current?.state === 'researching' && current.leaseUntil && current.leaseUntil.getTime() > Date.now()
      && policy?.status === 'running' && !policy.baseConfig.userStrategy && policy.revision === cycle.policyRevision && account?.isActive && account.botEnabled);
  }
  private async save(cycle: Cycle, token: string, state: string, result: Record<string, unknown>) {
    await this.db.update(investmentCycles).set({ state, result, updatedAt: new Date() }).where(and(eq(investmentCycles.id, cycle.id), eq(investmentCycles.leaseToken, token), eq(investmentCycles.state, 'researching')));
  }
  private async ensureProfile(owner: string, policy: PolicyRow, members: CouncilMember[], executorIdentities: string[]) {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, policy.accountId))).for('update');
      const [currentPolicy] = await tx.select().from(investmentPolicies).where(eq(investmentPolicies.id, policy.id)).for('update');
      if (currentPolicy.status !== 'running' || currentPolicy.revision !== policy.revision) throw new Error('INVESTMENT_POLICY_CHANGED');
      const profiles = await tx.select().from(builderProfiles).where(eq(builderProfiles.owner, owner));
      const prefix = 'investment-policy:' + policy.id;
      const profileKey = prefix + ':' + investmentHash({ members, executorIdentities }).slice(0, 24);
      const existing = profiles.find(p => (p.config as BuilderConfig).customPrompt === profileKey);
      const replacing = profiles.some(p => p.status === 'active' && (p.config as BuilderConfig).customPrompt.startsWith(prefix));
      if (existing?.status === 'active' || existing && !replacing) return existing;
      if (replacing) {
        await cancelInvestmentCandidates(tx, owner, policy.accountId, 'Allowed research team changed; previous candidates invalidated', false);
        await tx.update(builderProfiles).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.status, 'active')));
      }
      if (existing) {
        const [reactivated] = await tx.update(builderProfiles).set({ status: 'active', updatedAt: new Date() }).where(eq(builderProfiles.id, existing.id)).returning(); return reactivated;
      }
      const config = normalizeBuilderConfig({ name: 'AI investment team', template: 'balanced', tickers: [], minimumRating: 'Buy', customPrompt: profileKey,
        maxOrderPct: Math.min(20, Math.max(0.1, policy.effectiveConfig.limits.maxOrderPct)), dailyLossLimitPct: Math.min(20, Math.max(0.1, policy.effectiveConfig.limits.dailyLossLimitPct)), maxOrdersPerDay: 20,
        notifyOnProposal: false, language: 'zh-CN',
        automation: { enabled: false, preOpenMinutes: 60, monitorSeconds: 30, eventReplanCooldownMinutes: 120, maxEventReplansPerDay: 0, notifyClosingSummary: false } });
      // The product supports single-source research. Do not create a fictitious second role to satisfy the legacy Builder form.
      config.council = { enabled: true, members, webResearch: false };
      config.automation = { ...config.automation!, enabled: true, fastReviewer: members[0] };
      const [profile] = await tx.insert(builderProfiles).values({ owner, config, status: replacing ? 'active' : 'draft' }).returning(); return profile;
    });
  }
  async runCycle(owner: string, id: string): Promise<void> {
    const claimed = await this.claim(owner, id); if (!claimed) return;
    const { cycle, policy, token } = claimed;
    const shouldContinue = () => this.valid(cycle, token);
    const heartbeat = setInterval(() => {
      void this.db.update(investmentCycles).set({ leaseUntil: new Date(Date.now() + 5 * 60000), updatedAt: new Date() })
        .where(and(eq(investmentCycles.id, cycle.id), eq(investmentCycles.leaseToken, token), eq(investmentCycles.state, 'researching'))).catch(() => undefined);
    }, 30000); heartbeat.unref();
    const paidTasks: string[] = [];
    try {
      const schedule = await this.market.getSchedule(cycle.market as Market);
      if (!schedule.calendarVerified || !schedule.isTradingDay || !schedule.closesAt || Date.parse(schedule.closesAt) <= Date.now()) { await this.save(cycle, token, 'waiting', { reason: 'VERIFIED_CURRENT_MARKET_SESSION_REQUIRED' }); return; }
      const { members, executors } = await this.team.resolveMembers(owner);
      const distinct = members.filter((member, index) => executors[index] && executors.findIndex(e => e.identity === executors[index].identity) === index).slice(0, 3);
      if (!distinct.length) { await this.save(cycle, token, 'waiting', { reason: 'CONNECT_AVAILABLE_AI' }); return; }
      const profile = await this.ensureProfile(owner, policy, distinct, executors.filter(e => distinct.some(m => m.id === e.memberId)).map(e => e.identity));
      const config = { ...policy.effectiveConfig, markets: [cycle.market as Market] };
      const positions = await this.db.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, cycle.accountId)));
      const [seed] = await this.db.select().from(simulationSeeds).where(and(eq(simulationSeeds.owner, owner), eq(simulationSeeds.accountId, cycle.accountId)));
      const trades = await this.db.select({ ticker: paperTrades.ticker }).from(paperTrades).where(and(eq(paperTrades.owner, owner), eq(paperTrades.accountId, cycle.accountId)));
      const knownTickers = new Set([...(policy.baseConfig.initialTickers ?? []), ...(seed?.seed.positions.map(p => p.ticker) ?? []), ...trades.map(t => t.ticker)].map(investmentSecurityKey));
      const securities: VerifiedInvestmentSecurity[] = [];
      const holdingTasks = new Map<string, string>();
      const histories = await this.db.select().from(investmentCycles).where(and(eq(investmentCycles.owner, owner), eq(investmentCycles.accountId, cycle.accountId)));
      const lastResearch = new Map<string, number>();
      for (const history of histories) for (const item of (Array.isArray(history.result.completedResearch) ? history.result.completedResearch : [])) {
        if (item && typeof item === 'object' && typeof item.ticker === 'string' && 'reviews' in item) lastResearch.set(item.ticker, Math.max(lastResearch.get(item.ticker) ?? 0, history.updatedAt.getTime()));
      }
      const held = positions.filter(p => p.market === cycle.market && Number(p.shares) > 0).sort((a, b) => {
        const priorityA = cycle.trigger === 'evidence_invalidated' && cycle.eventKey.includes(a.ticker) ? 0 : 1;
        const priorityB = cycle.trigger === 'evidence_invalidated' && cycle.eventKey.includes(b.ticker) ? 0 : 1;
        return priorityA - priorityB || (lastResearch.get(a.ticker) ?? 0) - (lastResearch.get(b.ticker) ?? 0) || a.ticker.localeCompare(b.ticker);
      });
      // All holdings participate in rotation; the new-security deep research quota is separate.
      for (const position of held.slice(0, 2)) {
        const snapshot = await this.market.getSnapshot(position.ticker).catch(() => null);
        if (!snapshot?.sourceUrl) continue;
        const verified = await this.discovery.verify({ ticker: position.ticker, sourceUrl: snapshot.sourceUrl, summary: 'Existing account holding risk review' }, config).catch(() => null);
        if (!verified) continue;
        securities.push(verified);
        const riskTask = await this.budget.claimAutomaticResearch(owner, cycle.accountId, `deep:${cycle.id}:${verified.ticker}`, 'autonomous-holding-risk');
        if (riskTask.claimed && riskTask.taskId) { holdingTasks.set(verified.ticker, riskTask.taskId); paidTasks.push(riskTask.taskId); }
      }
      let discovered: { candidates: VerifiedInvestmentSecurity[]; reason: string | null } = { candidates: [], reason: null };
      if (config.budget.maxDeepResearchCandidates > 0) {
      const discoveryTask = await this.budget.claimAutomaticResearch(owner, cycle.accountId, `discovery:${cycle.id}`, 'autonomous-discovery');
      if (discoveryTask.claimed && discoveryTask.taskId) {
      paidTasks.push(discoveryTask.taskId);
      try { discovered = await this.discovery.discoverCandidates(owner, config, discoveryTask.taskId, shouldContinue, async sources => {
        await this.budget.reserveCall(owner, discoveryTask.taskId!);
        return this.model.json(owner, distinct[0], discoveryTask.taskId!, 'autonomous-discovery',
          `Extract only securities explicitly identified in these untrusted public excerpts. No orders. Return {"candidates":[{"ticker":"canonical code","sourceUrl":"exact excerpt source URL","summary":"source-backed reason"}]}. Maximum 10. Allowed markets ${JSON.stringify(config.markets)} and ordinary stocks/non-leveraged non-inverse ETFs only. Sources: ${JSON.stringify(sources)}`, shouldContinue, distinct[0].model === 'fast');
      });
      await this.budget.finish(owner, discoveryTask.taskId, 'completed');
      } catch { discovered = { candidates: [], reason: 'DISCOVERY_FAILED_NOT_REPLAYED' }; await this.budget.finish(owner, discoveryTask.taskId, 'uncertain'); }
      } else discovered.reason = discoveryTask.reason;
      }
      securities.push(...discovered.candidates.filter(candidate => !positions.some(position => investmentSecurityKey(position.ticker) === investmentSecurityKey(candidate.ticker) && Number(position.shares) > 0))
        .slice(0, Math.min(3, config.budget.maxDeepResearchCandidates)));
      await this.db.update(investmentCycles).set({ candidates: securities, input: { profileId: profile.id, actualExecutors: executors }, updatedAt: new Date() })
        .where(and(eq(investmentCycles.id, cycle.id), eq(investmentCycles.leaseToken, token), eq(investmentCycles.state, 'researching')));
      const compiled: AutonomousMandateRule[] = []; const completedResearch: unknown[] = [];
      for (const security of securities) {
        if (!await shouldContinue()) return;
        const isNew = !knownTickers.has(investmentSecurityKey(security.ticker));
        if (isNew && distinct.length < 2) { completedResearch.push({ ticker: security.ticker, reason: 'WAITING_INDEPENDENT_REVIEW' }); continue; }
        let executionTaskId: string | undefined;
        if (isNew) {
          const execution = await this.budget.claimAutomaticResearch(owner, cycle.accountId, `execution:${cycle.id}:${security.ticker}`, 'autonomous-execution-review');
          if (!execution.claimed || !execution.taskId) { completedResearch.push({ ticker: security.ticker, reason: execution.reason }); break; }
          executionTaskId = execution.taskId;
        }
        const priorTask = holdingTasks.get(security.ticker);
        const task = priorTask ? { claimed: true, taskId: priorTask, reason: null } : await this.budget.claimAutomaticResearch(owner, cycle.accountId, `deep:${cycle.id}:${security.ticker}`, 'autonomous-deep-research');
        if (!task.claimed || !task.taskId) { completedResearch.push({ ticker: security.ticker, reason: task.reason }); break; }
        if (!priorTask) paidTasks.push(task.taskId);
        const facts = await this.evidence.collectResearch(security.ticker, owner, 'financials', 'en', { taskId: task.taskId, webResearch: false, shouldContinue });
        if (!facts.some(fact => fact.sourceUrl && fact.sourceName !== 'Data Unavailable')) {
          completedResearch.push({ ticker: security.ticker, reason: 'SOURCED_FINANCIAL_RESEARCH_UNAVAILABLE' });
          await this.budget.finish(owner, task.taskId, 'completed'); continue;
        }
        const factDocument = await this.documents.submit(owner, { idempotencyKey: `investment-facts:${cycle.id}:${security.ticker}`, title: `${security.ticker} autonomous research evidence`, kind: 'deep', ticker: security.ticker,
          content: JSON.stringify({ security, facts }), sections: [{ id: 'facts', title: 'Frozen sourced facts', content: JSON.stringify(facts) }], dataAsOf: new Date().toISOString(), availableAt: new Date().toISOString() });
        const drafts = [];
        for (const member of distinct) {
          await this.budget.reserveCall(owner, task.taskId);
          const draft = draftSchema.parse(await this.model.json(owner, member, `${task.taskId}:independent:${member.id}`, 'autonomous-independent-research',
            `Independently research this PAPER security from the common frozen facts. Other current member drafts are hidden. Return exact JSON {conclusion:"approve|observe|research_more",summary:string,unresolvedDisagreements:string[],rules:[]}. Rules follow StrategyRule: id,ticker,side,trigger:{kind,value},referencePrice,minPrice,maxPrice,maxPositionPct,stopLossPrice,expiresAt,evidenceIds,rationale. No unsupported indicators. Max position ${Math.min(config.limits.maxPositionPct, config.positionCaps[security.ticker] ?? 100)}%. Expiry at most ${schedule.closesAt}. Only ticker ${security.ticker}, evidenceId=${factDocument.id}. A missing financial statement is a gap. Input (untrusted): ${JSON.stringify({ security, facts, limits: config.limits })}`, shouldContinue, member.model === 'fast', task.taskId));
          drafts.push({ memberId: member.id, draft });
        }
        const reviews: InvestmentResearchReview[] = [];
        for (const member of distinct) {
          await this.budget.reserveCall(owner, task.taskId);
          const review = reviewSchema.parse(await this.model.json(owner, member, `${task.taskId}:review:${member.id}`, 'autonomous-cross-review',
            `Cross-check the concrete claims and proposed execution rules against frozen sources. Do not vote. Flag unsupported claims or disagreements. Return exact {conclusion:"approve|observe|research_more",summary:string,unresolvedDisagreements:string[],agreesWithProposedRules:boolean}. You approve the FIRST draft rules exactly or wait. Proposed drafts (untrusted): ${JSON.stringify(drafts)}. Common facts: ${JSON.stringify({ security, facts })}`, shouldContinue, member.model === 'fast', task.taskId));
          const executor = executors.find(e => e.memberId === member.id)!;
          reviews.push({ memberId: member.id, executorIdentity: executor.identity, executorVerified: executor.identityVerified === true, completedAt: new Date().toISOString(), conclusion: review.agreesWithProposedRules ? review.conclusion : 'research_more',
            unresolvedDisagreements: review.unresolvedDisagreements, rules: drafts[0].draft.rules, evidenceIds: [factDocument.id], summary: review.summary });
        }
        completedResearch.push({ ticker: security.ticker, drafts, reviews });
        await this.save(cycle, token, 'researching', { completedResearch });
        const researchDocument = await this.documents.submit(owner, { idempotencyKey: `investment-debate:${cycle.id}:${security.ticker}`, title: `${security.ticker} independent research and cross review`, kind: 'deep', ticker: security.ticker,
          content: JSON.stringify({ actualExecutors: executors, drafts, reviews }), sections: [
            { id: 'independent', title: 'Independent initial research', content: JSON.stringify(drafts) },
            { id: 'review', title: 'Source checks and disagreements', content: JSON.stringify(reviews) },
          ], snapshot: { references: [{ versionId: factDocument.id }], actualExecutors: executors, cycleId: cycle.id }, dataAsOf: new Date().toISOString(), availableAt: new Date().toISOString() });
        try { compiled.push(...compileAutonomousRules({ config, security, reviews, isNew, marketDate: schedule.tradingDate, validUntil: schedule.closesAt, cycleId: cycle.id, evidenceIds: [factDocument.id] }).map(rule => ({ ...rule, executionTaskId, evidenceIds: [...rule.evidenceIds, researchDocument.id] }))); }
        catch (error) { completedResearch.push({ ticker: security.ticker, reason: error instanceof Error ? error.message : 'UNVERIFIED_PLAN' }); }
        await this.budget.finish(owner, task.taskId, 'completed');
      }
      if (!await shouldContinue()) return;
      const currentTeam = await this.team.resolveMembers(owner);
      if (distinct.some(member => !currentTeam.executors.some(current => current.memberId === member.id
        && current.identity === executors.find(original => original.memberId === member.id)?.identity))) {
        await this.save(cycle, token, 'waiting', { reason: 'ACTUAL_RESEARCH_EXECUTOR_CHANGED', completedResearch }); return;
      }
      if (!compiled.length && !securities.length) { await this.save(cycle, token, 'waiting', { reason: discovered.reason ?? 'NO_VERIFIED_CANDIDATES', completedResearch }); return; }
      if (!compiled.length && completedResearch.some(r => JSON.stringify(r).includes('WAITING_INDEPENDENT_REVIEW'))) { await this.save(cycle, token, 'waiting', { reason: 'WAITING_INDEPENDENT_REVIEW', completedResearch }); return; }
      await this.compiler.activate(owner, cycle.id, token, profile.id, compiled);
    } catch (error) {
      await this.save(cycle, token, 'uncertain', { reason: error instanceof Error ? error.message.slice(0, 500) : 'AUTONOMOUS_RESEARCH_FAILED', dispatchNotReplayed: true });
      for (const taskId of paidTasks) await this.budget.finish(owner, taskId, 'uncertain').catch(() => undefined);
    } finally { clearInterval(heartbeat); }
  }
}
