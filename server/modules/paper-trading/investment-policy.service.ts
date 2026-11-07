import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { builderProfiles, cashAccounts, holdings, paperAccounts, paperEvents, paperOrders, paperPositions, paperSnapshots, paperTrades } from '../../database/schema';
import { investmentConstraintProposals, investmentCycles, investmentPolicies, investmentPreviews, investmentRequests } from '../../database/investment-policy.schema';
import { experiencePreferences } from '../../database/simple-experience.schema';
import { simulationCash, simulationPreviews, simulationSeeds } from '../../database/simulation-experiments.schema';
import { strategyMandates, strategyReservations, strategyMonitorState, strategyRouteReviews } from '../../database/strategy-mandates.schema';
import { strategySignals, strategyRuntime } from '../../database/strategy.schema';
import { councilSessions } from '../../database/council.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { SimpleCouncilService } from '../council/simple-council.service';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { channelDecisionReflections,channelEpisodes,channelUserActions } from '../../database/channel.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { installInvestorMandate } from './user-strategy-runtime';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { DEFAULT_INVESTMENT_CONFIG, effectiveInvestmentConfig, investmentConstraintSchema, normalizeInvestmentRequest } from './investment-policy.rules';
import { seedRevision } from './simulation-experiments.rules';
import { paperRiskDay } from './paper-risk-day';
import type { InvestmentConfig, InvestmentConstraint, InvestmentPolicy } from '../../../shared/investment-policy.interface';
import type { SimulationSeed } from '../../../shared/simulation-experiment.interface';

export type InvestmentTx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
export type PolicyRow = typeof investmentPolicies.$inferSelect;
export const policyView = (p: PolicyRow): InvestmentPolicy => ({ ...p, effectiveConfig: effectiveInvestmentConfig(p.baseConfig, p.constraintRecords), status: p.status as InvestmentPolicy['status'], confirmedAt: p.confirmedAt.toISOString(), updatedAt: p.updatedAt.toISOString() });
export function investmentHash(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export async function cancelInvestmentCandidates(tx: InvestmentTx, owner: string, accountId: string, reason: string, cancelCycles = true) {
  const signals = await tx.select().from(strategySignals).where(and(eq(strategySignals.owner, owner), inArray(strategySignals.state, ['claimed', 'pending', 'reviewing', 'approved', 'wait'])));
  const ids = signals.filter(s => s.candidate.accountId === accountId).map(s => s.id);
  if (ids.length) await tx.update(strategySignals).set({ state: 'cancelled', reason, updatedAt: new Date() }).where(inArray(strategySignals.id, ids));
  if (ids.length) {
    const openReviews = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.scene, 'trade_pre_review'), inArray(councilSessions.status, ['running', 'idle'])));
    for (const review of openReviews.filter(session => ids.some(id => session.subject.includes(`signal:${id};`)))) await tx.update(councilSessions).set({ status: 'paused', revision: review.revision + 1, error: reason, updatedAt: new Date() }).where(eq(councilSessions.id, review.id));
  }
  await tx.update(strategyReservations).set({ status: 'released', reason, updatedAt: new Date() }).where(and(eq(strategyReservations.owner, owner), eq(strategyReservations.accountId, accountId), eq(strategyReservations.status, 'active')));
  await tx.update(paperOrders).set({ status: 'cancelled', reason }).where(and(eq(paperOrders.owner, owner), eq(paperOrders.accountId, accountId), eq(paperOrders.status, 'pending_approval')));
  if (cancelCycles) await tx.update(investmentCycles).set({ state: 'cancelled', updatedAt: new Date(), result: { reason } }).where(and(eq(investmentCycles.owner, owner), eq(investmentCycles.accountId, accountId), inArray(investmentCycles.state, ['queued', 'researching', 'waiting'])));
}
/** Caller has owner and account locks; expiry and confirmation share this exact revision fence. */
export async function expireInvestmentConstraints(tx: InvestmentTx, policy: PolicyRow, now = new Date()): Promise<PolicyRow> {
  const expired = policy.constraintRecords.some(c => c.status === 'active' && c.constraint.expiresAt && Date.parse(c.constraint.expiresAt) <= now.getTime());
  if (!expired) return policy;
  const records = policy.constraintRecords.map(c => c.status === 'active' && c.constraint.expiresAt && Date.parse(c.constraint.expiresAt) <= now.getTime() ? { ...c, status: 'expired' as const } : c);
  await cancelInvestmentCandidates(tx, policy.owner, policy.accountId, 'Investment constraint expired; old orders cannot resume');
  await tx.update(strategyMandates).set({ status: 'paused', updatedAt: now }).where(and(eq(strategyMandates.owner, policy.owner), eq(strategyMandates.accountId, policy.accountId), eq(strategyMandates.status, 'published')));
  const [saved] = await tx.update(investmentPolicies).set({ revision: policy.revision + 1, constraintRecords: records,
    effectiveConfig: effectiveInvestmentConfig(policy.baseConfig, records, now), updatedAt: now }).where(eq(investmentPolicies.id, policy.id)).returning();
  if (saved.status === 'running' && saved.baseConfig.userStrategy) await installInvestorMandate(tx, saved.owner, saved, saved.baseConfig.userStrategy);
  return saved;
}

@Injectable()
export class InvestmentPolicyService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase, private readonly simulations: SimulationExperimentsService, @Optional() private readonly userStrategies?: UserInvestmentStrategyService, @Optional() private readonly reviewTeam?: SimpleCouncilService) {}
  async assertFeatureEnabled(owner: string) {
    const [preferences] = await this.db.select().from(experiencePreferences).where(eq(experiencePreferences.owner, owner));
    if (process.env.SQUABBLE_SIMPLE_EXPERIENCE !== 'true' || preferences?.enabled === false) throw new NotFoundException('SIMPLE_EXPERIENCE_DISABLED');
  }
  private parse<K extends Parameters<typeof normalizeInvestmentRequest>[0]>(kind: K, value: unknown) {
    try { return normalizeInvestmentRequest(kind, value); } catch { throw new BadRequestException({ code: 'INVALID_INVESTMENT_REQUEST', message: 'Please check the supplied investment details.' }); }
  }
  async overview(owner: string) {
    const accounts = await this.db.select().from(paperAccounts).where(eq(paperAccounts.owner, owner)).orderBy(desc(paperAccounts.createdAt));
    const policies = await this.db.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), ne(investmentPolicies.status, 'archived')));
    const policy = policies.find(p => accounts.some(a => a.id === p.accountId && a.isActive)) ?? policies[0] ?? null;
    const account = accounts.find(a => a.id === policy?.accountId) ?? accounts.find(a => a.isActive) ?? null;
    const [positions, actions, mandates, heartbeats] = account ? await Promise.all([
      this.db.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, account.id))),
      this.db.select().from(paperOrders).where(and(eq(paperOrders.owner, owner), eq(paperOrders.accountId, account.id))).orderBy(desc(paperOrders.createdAt)).limit(20),
      this.db.select().from(strategyMandates).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, account.id))).orderBy(desc(strategyMandates.createdAt)).limit(1),
      this.db.select().from(strategyMonitorState).where(and(eq(strategyMonitorState.owner, owner), eq(strategyMonitorState.accountId, account.id))),
    ]) : [[], [], [], []];
    const cycles = policy ? await this.db.selectDistinctOn([investmentCycles.market]).from(investmentCycles).where(and(eq(investmentCycles.owner, owner), eq(investmentCycles.policyId, policy.id), eq(investmentCycles.policyRevision, policy.revision), ne(investmentCycles.state, 'cancelled'), ne(investmentCycles.state, 'superseded')))
      .orderBy(investmentCycles.market, desc(investmentCycles.createdAt), desc(investmentCycles.updatedAt)) : [];
    const waiting = cycles.find(c => ['waiting', 'uncertain', 'failed'].includes(c.state));
    if (account) await this.simulations.establishBaseline(owner, account.id).catch(() => false);
    const performance = account ? await this.simulations.review(owner, account.id).catch(() => null) : null;
    const [runtime, snapshots, signals, trades] = account ? await Promise.all([
      this.db.select().from(strategyRuntime).where(and(eq(strategyRuntime.owner, owner), eq(strategyRuntime.profileId, mandates[0]?.profileId ?? '00000000-0000-0000-0000-000000000000'))),
      this.db.select().from(paperSnapshots).where(and(eq(paperSnapshots.owner, owner), eq(paperSnapshots.accountId, account.id))).orderBy(desc(paperSnapshots.valuedAt)).limit(1),
      this.db.select().from(strategySignals).where(eq(strategySignals.owner, owner)).orderBy(desc(strategySignals.createdAt)).limit(200),
      this.db.select().from(paperTrades).where(and(eq(paperTrades.owner, owner), eq(paperTrades.accountId, account.id))).orderBy(desc(paperTrades.createdAt)).limit(20),
    ]) : [[], [], [], []];
    const [openingSeed] = account ? await this.db.select().from(simulationSeeds).where(and(eq(simulationSeeds.owner, owner), eq(simulationSeeds.accountId, account.id))) : [];
    const decisions = account ? await this.db.select().from(strategyRouteReviews).where(and(eq(strategyRouteReviews.owner, owner), eq(strategyRouteReviews.accountId, account.id))) : [];
    return { currentStrategy: policy?.baseConfig.userStrategy ?? null, netAssetUsd: snapshots[0]?.equity ?? performance?.endingEquityUsd ?? null, todayChangeUsd: snapshots[0]?.dailyPl ?? null, waitingReasons: [...new Set([...runtime.map(item => item.data.reason), ...(performance?.gaps ?? [])])], lastCheckAt: runtime.map(item => item.data.lastCheckAt).filter(Boolean).sort().at(-1) ?? null, status: policy ? policy.status === 'paused' ? 'paused' : waiting ? 'attention_required' : 'running' : account ? 'needs_confirmation' : 'not_started',
      account, policy: policy ? policyView(policy) : null, needsInput: !policy && account ? ['CONFIRM_LEGACY_ADOPTION'] : [],
      limits: policy?.effectiveConfig.limits ?? DEFAULT_INVESTMENT_CONFIG.limits, constraints: policy?.constraintRecords ?? [],
      currentThinking: policy && !policy.baseConfig.userStrategy ? null : mandates[0]?.config.objective ?? (waiting ? String(waiting.result.reason ?? 'Waiting for verified independent research') : null),
      actions: actions.map(action => ({ ...action, strategyId: signals.find(signal => signal.orderId === action.id)?.candidate.userStrategyId ?? null, strategyEntryId: signals.find(signal => signal.orderId === action.id)?.ruleId ?? null, fee: trades.find(trade => trade.orderId === action.id)?.fee ?? null, discussionId: decisions.find(d => d.signalId && d.councilSessionId && action.sessionId === d.councilSessionId)?.councilSessionId ?? action.sessionId })), holdings: positions.map(position => ({ ...position, originalCost: openingSeed?.seed.positions.find(item => item.ticker === position.ticker)?.historicalCost })), performance, lastHeartbeatAt: heartbeats[0]?.lastHeartbeat.toISOString() ?? null,
      legacyAccounts: accounts.filter(a => !policies.some(p => p.accountId === a.id)).map(a => ({ id: a.id, name: a.name, active: a.isActive, botEnabled: a.botEnabled })),
      cycles: cycles.map(c => ({ id: c.id, state: c.state, market: c.market, reason: c.result.reason ?? null })),
    };
  }
  async preview(owner: string, input: unknown) {
    const request = this.parse('preview', input); const hash = investmentHash(request);
    const [prior] = await this.db.select().from(investmentPreviews).where(and(eq(investmentPreviews.owner, owner), eq(investmentPreviews.requestKey, request.requestKey)));
    if (prior) { if (prior.requestHash !== hash) throw new ConflictException('REQUEST_KEY_CONFLICT'); return this.previewView(prior); }
    let seed: SimulationSeed; let sourcePreviewId: string | null = null;
    if (request.origin === 'holdings') { const source = await this.simulations.preview(owner); seed = source.seed; sourcePreviewId = source.id; }
    else {
      const cash = request.cash!;
      seed = await this.simulations.previewCash(owner, cash.currency, cash.amount);
    }
    const row = await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [existing] = await tx.select().from(investmentPreviews).where(and(eq(investmentPreviews.owner, owner), eq(investmentPreviews.requestKey, request.requestKey)));
      if (existing) { if (existing.requestHash !== hash) throw new ConflictException('REQUEST_KEY_CONFLICT'); return existing; }
      const [saved] = await tx.insert(investmentPreviews).values({ owner, requestKey: request.requestKey, requestHash: hash, origin: request.origin, seed, sourcePreviewId, expiresAt: new Date(Date.now() + 5 * 60000) }).returning(); return saved;
    });
    return this.previewView(row);
  }
  private previewView(row: typeof investmentPreviews.$inferSelect) {
    const needsInput = row.seed.gaps.filter(g => /^(CASH_UNKNOWN|CASH_AVAILABILITY_UNKNOWN|SELLABILITY_UNKNOWN|QUOTE_MISSING|FX_MISSING|INSTRUMENT_UNKNOWN|NEGATIVE_OR_INVALID)/u.test(g));
    if (row.origin === 'holdings' && !row.seed.positions.length) needsInput.push('IMPORT_HOLDINGS_OR_CHOOSE_CASH');
    return { id: row.id, previewId: row.id, seed: row.seed, sourceRevision: row.seed.sourceRevision, expiresAt: row.expiresAt.toISOString(), needsInput,
      markets: [...new Set(row.seed.positions.map(p => p.market))], limits: DEFAULT_INVESTMENT_CONFIG.limits, budget: DEFAULT_INVESTMENT_CONFIG.budget,
      inheritedConcentration: row.seed.positions.filter(p => Number(p.shares) * Number(p.initialPrice) * Number(row.seed.fx.find(f => f.currency === p.currency)?.rate ?? 0) > Number(row.seed.initialEquityUsd) * 0.1).map(p => p.ticker) };
  }
  private async idempotent<T>(tx: InvestmentTx, owner: string, operation: string, request: { requestKey: string }, action: () => Promise<T>): Promise<T> {
    const hash = investmentHash({ operation, request });
    const [prior] = await tx.select().from(investmentRequests).where(and(eq(investmentRequests.owner, owner), eq(investmentRequests.requestKey, request.requestKey)));
    if (prior) { if (prior.requestHash !== hash) throw new ConflictException('REQUEST_KEY_CONFLICT'); return prior.result as T; }
    const result = await action();
    await tx.insert(investmentRequests).values({ owner, operation, requestKey: request.requestKey, requestHash: hash, result: result as Record<string, unknown> }); return result;
  }
  private async sourceRevision(tx: InvestmentTx, owner: string) {
    const positions = await tx.select().from(holdings).where(eq(holdings.owner, owner));
    const cash = await tx.select().from(cashAccounts).where(eq(cashAccounts.owner, owner));
    return seedRevision({ holdings: positions.map(h => ({ id: h.id, ticker: h.ticker, market: h.market, currency: h.currency, company: h.company, shares: String(h.shares), buyPrice: h.buyPrice, currentPrice: h.currentPrice, updatedAt: h.updatedAt })), cash: cash.map(c => ({ currency: c.currency, balance: String(c.balance), updatedAt: c.updatedAt, reconciliationStatus: c.reconciliationStatus })) });
  }
  async start(owner: string, input: unknown) { return this.startInternal(owner, this.parse('start', input)); }
  async restart(owner: string, input: unknown) { return this.startInternal(owner, this.parse('restart', input)); }
  private async startInternal(owner: string, request: ReturnType<typeof normalizeInvestmentRequest<'start'>> & { expectedAccountId?: string }) {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      return this.idempotent(tx, owner, request.expectedAccountId ? 'restart' : 'start', request, async () => {
        const accounts = await tx.select().from(paperAccounts).where(eq(paperAccounts.owner, owner)).for('update');
        const active = accounts.find(a => a.isActive);
        if (request.expectedAccountId && active?.id !== request.expectedAccountId) throw new ConflictException('ACCOUNT_CHANGED');
        const [existingPolicy] = active ? await tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, active.id))).for('update') : [];
        if (existingPolicy && !request.expectedAccountId) throw new ConflictException('INVESTMENT_ALREADY_STARTED');
        const [preview] = await tx.select().from(investmentPreviews).where(and(eq(investmentPreviews.owner, owner), eq(investmentPreviews.id, request.previewId))).for('update');
        if (!preview) throw new NotFoundException('Preview not found');
        if (preview.expiresAt.getTime() <= Date.now()) throw new ConflictException('PREVIEW_EXPIRED');
        if (preview.origin === 'holdings' && await this.sourceRevision(tx, owner) !== preview.seed.sourceRevision) throw new ConflictException('SOURCE_CHANGED_REPREVIEW');
        const seed = structuredClone(preview.seed);
        if (seed.gaps.some(g => /^(INSTRUMENT_UNKNOWN|NEGATIVE_OR_INVALID)/u.test(g))) throw new BadRequestException('SOURCE_LEDGER_INVALID');
        for (const position of seed.positions) { position.sellableShares = position.shares; position.restriction = 'Opening simulated inventory'; }
        seed.gaps = seed.gaps.filter(g => !g.startsWith('SELLABILITY_UNKNOWN:'));
        for (const cash of seed.cash) if (request.confirmOpeningCash || cash.availabilityKnown) { cash.available = cash.total; cash.frozen = '0'; cash.availabilityKnown = true; }
        seed.copiedCash = seed.cash.map(cash => ({ currency: cash.currency, total: cash.total }));
        for (const [currency, amount] of Object.entries(request.additionalVirtualCash ?? {})) {
          if (!amount) continue;
          const cash = seed.cash.find(item => item.currency === currency);
          if (cash) { cash.total = String(Number(cash.total) + amount); cash.available = String(Number(cash.available) + amount); }
          else seed.cash.push({ currency, total: String(amount), available: String(amount), frozen: '0', unsettled: '0', availabilityKnown: true });
          if (!seed.fx.some(rate => rate.currency === currency)) {
            if (currency === 'USD') seed.fx.push({ currency, rate: '1', at: seed.capturedAt });
            else seed.gaps.push(`FX_MISSING:${currency}`);
          }
        }
        if (request.confirmNoCash) seed.gaps = seed.gaps.filter(g => g !== 'CASH_UNKNOWN');
        seed.gaps = seed.gaps.filter(g => !g.startsWith('CASH_AVAILABILITY_UNKNOWN:') || !seed.cash.find(c => g.endsWith(c.currency))?.availabilityKnown);
        const missingBaseline = seed.gaps.some(g => /^(CASH_UNKNOWN|CASH_AVAILABILITY_UNKNOWN|QUOTE_MISSING|FX_MISSING)/u.test(g));
        const rate = (currency: string) => Number(seed.fx.find(item => item.currency === currency)?.rate ?? 0);
        seed.initialEquityUsd = missingBaseline ? null : String(seed.positions.reduce((sum, position) => sum + Number(position.shares) * Number(position.initialPrice) * rate(position.currency), 0) + seed.cash.reduce((sum, cash) => sum + Number(cash.total) * rate(cash.currency), 0));
        const base = structuredClone(DEFAULT_INVESTMENT_CONFIG);
        const [preferences] = await tx.select().from(experiencePreferences).where(eq(experiencePreferences.owner, owner));
        base.timezone = preferences?.timezone ?? base.timezone;
        base.markets = request.markets ?? (seed.positions.length ? [...new Set(seed.positions.map(p => p.market))] : [seed.cash[0]?.currency === 'HKD' ? 'HK' : seed.cash[0]?.currency === 'CNY' ? 'CN' : 'US']);
        base.limits = { ...base.limits, ...request.limits };
        if (base.limits.maxGrossExposurePct + base.limits.minCashPct > 100) throw new BadRequestException('CONTRADICTORY_LIMITS');
        let account = request.adoptAccountId ? accounts.find(a => a.id === request.adoptAccountId) : undefined;
        if (request.adoptAccountId && !account) throw new NotFoundException('Adoption account not found');
        if (account && (await tx.select({ id: investmentPolicies.id }).from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, account.id)))).length) throw new ConflictException('PREVIOUSLY_MANAGED_ACCOUNT_IS_READ_ONLY');
        base.initialTickers = account ? (await tx.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, account.id)))).filter(p => Number(p.shares) > 0).map(p => p.ticker)
          : seed.positions.map(p => p.ticker);
        for (const target of [...new Map([active, account].filter(Boolean).map(a => [a!.id, a!])).values()]) {
          await cancelInvestmentCandidates(tx, owner, target.id, 'User confirmed investment takeover/restart');
          await tx.update(strategyMandates).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, target.id), eq(strategyMandates.status, 'published')));
        }
        await tx.update(builderProfiles).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.status, 'active')));
        await tx.update(paperAccounts).set({ isActive: false, botEnabled: false, updatedAt: new Date() }).where(eq(paperAccounts.owner, owner));
        if (existingPolicy) await tx.update(investmentPolicies).set({ status: 'archived', revision: existingPolicy.revision + 1, updatedAt: new Date() }).where(eq(investmentPolicies.id, existingPolicy.id));
        if (!account) {
          const cashUsd = seed.cash.reduce((sum, c) => sum + Number(c.total) * Number(seed.fx.find(f => f.currency === c.currency)?.rate ?? 0), 0);
          [account] = await tx.insert(paperAccounts).values({ owner, name: 'AI investment', isActive: true, botEnabled: false, ledgerMode: 'native_currency', initialCash: seed.initialEquityUsd ?? '0', cashBalance: String(cashUsd), executionModel: seed.model,
            guardrails: { maxOrderPct: base.limits.maxOrderPct, dailyLossLimitPct: base.limits.dailyLossLimitPct, maxOrdersPerDay: 20 } }).returning();
          let sourcePreviewId = preview.sourcePreviewId;
          if (!sourcePreviewId) { const [saved] = await tx.insert(simulationPreviews).values({ owner, seed, expiresAt: preview.expiresAt }).returning(); sourcePreviewId = saved.id; }
          await tx.insert(simulationSeeds).values({ owner, accountId: account.id, previewId: sourcePreviewId, idempotencyKey: request.requestKey, requestHash: investmentHash(request), seed });
          if (seed.cash.length) await tx.insert(simulationCash).values(seed.cash.map(c => ({ owner, accountId: account!.id, currency: c.currency, available: c.available, frozen: c.frozen, unsettled: c.unsettled, availabilityKnown: c.availabilityKnown })));
          if (seed.positions.length) await tx.insert(paperPositions).values(seed.positions.map(p => ({ owner, accountId: account!.id, ticker: p.ticker, company: p.company, market: p.market, currency: p.currency, shares: p.shares, avgCost: p.initialPrice ?? '0', restrictedShares: '0' })));
          if (seed.initialEquityUsd !== null) await tx.insert(paperSnapshots).values({ owner, accountId: account.id, snapshotDate: paperRiskDay(new Date(seed.capturedAt), base.timezone), valuedAt: new Date(seed.capturedAt), equity: seed.initialEquityUsd, benchmarkEquity: seed.initialEquityUsd, cash: String(cashUsd), positionsValue: String(Number(seed.initialEquityUsd) - cashUsd), dailyPl: '0' });
          await tx.insert(paperEvents).values({ owner, accountId: account.id, eventType: 'opening_balance', detail: { previewId: preview.id, sourceRevision: seed.sourceRevision, model: seed.model } });
        } else await tx.update(paperAccounts).set({ isActive: true, botEnabled: false, updatedAt: new Date() }).where(eq(paperAccounts.id, account.id));
        const [policy] = await tx.insert(investmentPolicies).values({ owner, accountId: account.id, status: 'paused', baseConfig: base, effectiveConfig: base }).returning();
        await tx.insert(experiencePreferences).values({ owner, defaultAccountId: account.id, migrationState: request.adoptAccountId ? 'adopted' : 'new' }).onConflictDoUpdate({ target: experiencePreferences.owner, set: { defaultAccountId: account.id, migrationState: request.adoptAccountId ? 'adopted' : 'new', updatedAt: new Date() } });
        return { status: 'paused', policy: policyView(policy), accountId: account.id, evaluationState: seed.initialEquityUsd === null ? 'waiting_valuation' : 'observing' };
      });
    });
  }
  private async current(tx: InvestmentTx, owner: string) {
    const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.isActive, true))).for('update');
    if (!account) throw new NotFoundException('INVESTMENT_NOT_STARTED');
    const [policy] = await tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, account.id))).for('update');
    if (!policy) throw new NotFoundException('INVESTMENT_NOT_STARTED');
    return { account, policy };
  }
  async applyStrategy(owner: string, input: unknown) {
    const request = this.parse('apply', input);
    if (!this.userStrategies) throw new BadRequestException('USER_STRATEGY_SERVICE_UNAVAILABLE');
    const availableReviewers = await this.reviewTeam?.resolveMembers(owner).catch(() => null);
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      return this.idempotent(tx, owner, 'apply-strategy', request, async () => {
        const { account, policy } = await this.current(tx, owner);
        let saved = policy;
        const activate = async (snapshot: import('../../../shared/user-investment-strategy.interface').ConfirmedInvestmentStrategy) => {
          await cancelInvestmentCandidates(tx, owner, account.id, 'User applied a confirmed strategy; old results cannot execute');
          const baseConfig = { ...policy.baseConfig, userStrategy: snapshot, timezone: snapshot.content.timezone, limits: { ...policy.baseConfig.limits, ...snapshot.content.limits }, ...(availableReviewers?.members.length ? { reviewMembers: availableReviewers.members } : {}) };
          const effectiveConfig = effectiveInvestmentConfig(baseConfig, policy.constraintRecords);
          [saved] = await tx.update(investmentPolicies).set({ revision: policy.revision + 1, status: 'running', baseConfig, effectiveConfig, updatedAt: new Date() }).where(eq(investmentPolicies.id, policy.id)).returning();
          await tx.update(paperAccounts).set({ botEnabled: true, updatedAt: new Date() }).where(eq(paperAccounts.id, account.id));
          await installInvestorMandate(tx, owner, saved, snapshot);
        };
        const strategy = await this.userStrategies!.confirmInTransaction(tx, owner, request.strategyId, request.expectedRevision, request.previewHash, request.expectedCurrentId, async (_tx, snapshot) => activate(snapshot));
        if (saved === policy && policy.baseConfig.userStrategy?.id !== strategy.id) await activate(strategy);
        if(saved!==policy){
          const at=new Date().toISOString(),decisionId=randomUUID();
          await tx.insert(channelUserActions).values({id:decisionId,owner,requestKey:`strategy-apply:${request.requestKey}`,inputHash:request.previewHash,
            data:{kind:'strategy_applied',strategyId:strategy.id,strategyRevision:strategy.revision,policyRevision:saved.revision},result:{active:true}}).onConflictDoNothing();
          const base={decisionId:strategy.id,recordedAt:at,kind:'reason_at_adoption' as const};
          const pinnedReports=(await Promise.all(strategy.sources.filter(s=>s.versionId).map(s=>tx.select({id:researchDocumentVersions.id,revision:researchDocumentVersions.version}).from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner,owner),eq(researchDocumentVersions.id,s.versionId!)))))).flat();
          await tx.insert(channelDecisionReflections).values([
            {id:`strategy:${strategy.id}:${strategy.revision}:snapshot`,owner,decisionId:strategy.id,data:{...base,id:`strategy:${strategy.id}:${strategy.revision}:snapshot`,author:'system_snapshot',snapshot:{strategyId:strategy.id,strategyRevision:strategy.revision,runtimeRevision:saved.revision,reportRefs:pinnedReports,evidenceIds:strategy.sources.map(s=>s.key),knownGapIds:strategy.preview.issues.map(i=>i.code)}}},
            {id:`strategy:${strategy.id}:${strategy.revision}:unrecorded`,owner,decisionId:strategy.id,data:{...base,id:`strategy:${strategy.id}:${strategy.revision}:unrecorded`,author:'unrecorded'}},
          ]).onConflictDoNothing();
          const episodes=await tx.select().from(channelEpisodes).where(eq(channelEpisodes.owner,owner));
          for(const episode of episodes.filter(e=>e.data.phase!=='closed'))await tx.update(channelEpisodes).set({data:{...episode.data,revision:episode.data.revision+1,userDecisionIds:[...episode.data.userDecisionIds,decisionId]},updatedAt:new Date()}).where(and(eq(channelEpisodes.owner,owner),eq(channelEpisodes.id,episode.id)));
        }
        return { status: saved.status, policy: policyView(saved), strategy, evaluationState: 'monitoring' };
      });
    });
  }
  async enqueue(tx: InvestmentTx, policy: PolicyRow, trigger: string) {
    if (policy.baseConfig.userStrategy) return;
    for (const market of policy.effectiveConfig.markets) await tx.insert(investmentCycles).values({ owner: policy.owner, accountId: policy.accountId, policyId: policy.id, policyRevision: policy.revision, market,
      marketDate: paperRiskDay(new Date(), market === 'US' ? 'America/New_York' : market === 'HK' ? 'Asia/Hong_Kong' : 'Asia/Shanghai'), trigger, eventKey: `${trigger}:${policy.revision}` }).onConflictDoNothing();
  }
  async pause(owner: string, input: unknown) { return this.switchStatus(owner, this.parse('pause', input), false); }
  async removeStrategy(owner: string, input: unknown) {
    const request = this.parse('removeStrategy', input);
    if (!this.userStrategies) throw new BadRequestException('USER_STRATEGY_SERVICE_UNAVAILABLE');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      return this.idempotent(tx, owner, 'remove-strategy', request, async () => {
        const { account, policy } = await this.current(tx, owner);
        if (policy.revision !== request.expectedPolicyRevision) throw new ConflictException('POLICY_REVISION_CHANGED');
        if (policy.baseConfig.userStrategy?.id !== request.strategyId || policy.baseConfig.userStrategy.revision !== request.expectedRevision) throw new ConflictException('Current strategy changed; reload before removing');
        await this.userStrategies!.removeCurrentInTransaction(tx, owner, request.strategyId, request.expectedRevision, async () => {
          await cancelInvestmentCandidates(tx, owner, account.id, 'User stopped and removed the current strategy');
          await tx.update(strategyMandates).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, account.id), eq(strategyMandates.status, 'published')));
          await tx.update(builderProfiles).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.status, 'active')));
          await tx.update(paperAccounts).set({ botEnabled: false, updatedAt: new Date() }).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, account.id)));
          const baseConfig = { ...policy.baseConfig }; delete baseConfig.userStrategy;
          await tx.update(investmentPolicies).set({ status: 'paused', revision: policy.revision + 1, baseConfig,
            effectiveConfig: effectiveInvestmentConfig(baseConfig, policy.constraintRecords), updatedAt: new Date() }).where(eq(investmentPolicies.id, policy.id));
        });
        return { removed: true, strategyId: request.strategyId, status: 'paused' as const };
      });
    });
  }
  async resume(owner: string, input: unknown) { return this.switchStatus(owner, this.parse('resume', input), true); }
  private async switchStatus(owner: string, request: { expectedRevision: number; requestKey: string }, running: boolean) {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      return this.idempotent(tx, owner, running ? 'resume' : 'pause', request, async () => {
        const { account, policy } = await this.current(tx, owner);
        if (running && !policy.baseConfig.userStrategy) throw new ConflictException('CONFIRMED_USER_STRATEGY_REQUIRED');
        if (policy.revision !== request.expectedRevision) throw new ConflictException('POLICY_REVISION_CHANGED');
        await cancelInvestmentCandidates(tx, owner, account.id, running ? 'Resume requires fresh evaluation' : 'All automatic trading paused, including protective exits');
        await tx.update(strategyMandates).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, account.id), eq(strategyMandates.status, 'published')));
        await tx.update(paperAccounts).set({ botEnabled: running, updatedAt: new Date() }).where(eq(paperAccounts.id, account.id));
        const [saved] = await tx.update(investmentPolicies).set({ status: running ? 'running' : 'paused', revision: policy.revision + 1, updatedAt: new Date() }).where(eq(investmentPolicies.id, policy.id)).returning();
        if (running && saved.baseConfig.userStrategy) await installInvestorMandate(tx, owner, saved, saved.baseConfig.userStrategy);
        return { status: saved.status, policy: policyView(saved), evaluationState: running ? 'queued' : 'cancelled' };
      });
    });
  }
  async propose(owner: string, input: unknown) {
    const request = this.parse('propose', input);
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      return this.idempotent(tx, owner, 'propose', request, async () => {
        const { account, policy } = await this.current(tx, owner);
        if (request.sessionId) {
          const [session] = await tx.select({ id: councilSessions.id }).from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, request.sessionId)));
          if (!session) throw new NotFoundException('Conversation not found');
        }
        // Explicit language only. General opinions remain research and never change permissions.
        const symbol = request.text.match(/\b([A-Z][A-Z0-9.-]{0,19}|\d{1,6}\.(?:HK|SH|SZ|BJ))\b/u)?.[1];
        let constraint: InvestmentConstraint | null = request.constraint as InvestmentConstraint ?? null;
        if (!constraint && symbol && /(?:不要|禁止|别再|do not|don't|never)\s*(?:再)?\s*(?:卖|sell)/iu.test(request.text)) constraint = { kind: 'no_sell', ticker: symbol, expiresAt: null };
        if (!constraint && symbol && /(?:不要|禁止|别再|do not|don't|never)\s*(?:再)?\s*(?:买|buy)/iu.test(request.text)) constraint = { kind: 'no_buy', ticker: symbol, expiresAt: null };
        if (!constraint && /(?:暂停加仓|停止加仓|stop increasing)/iu.test(request.text)) constraint = { kind: 'no_increase', expiresAt: null };
        if (!constraint && /(?:现金|cash)/iu.test(request.text)) { const percent = request.text.match(/(\d+(?:\.\d+)?)\s*%/u); if (percent && Number(percent[1]) <= 100) constraint = { kind: 'cash_floor', percent: Number(percent[1]), expiresAt: null }; }
        if (constraint) { const checked = investmentConstraintSchema.safeParse(constraint); constraint = checked.success ? checked.data as InvestmentConstraint : null; }
        const needsInput = constraint ? [] : ['CLARIFY_CONSTRAINT_TICKER_AMOUNT_OR_EXPIRY'];
        if (!request.constraint && /(?:明天|后天|今天|本周|下周|月底|\d{4}-\d{2}-\d{2}|until|tomorrow|this week)/iu.test(request.text)) needsInput.push('CLARIFY_EXACT_EXPIRY');
        if (constraint?.expiresAt && Date.parse(constraint.expiresAt) <= Date.now()) throw new BadRequestException('CONSTRAINT_EXPIRY_IN_PAST');
        const impact = constraint?.kind === 'no_sell' ? `禁止自动卖出 ${constraint.ticker}，包括自动止损和保护性退出。This also disables protective stop sales.` : constraint ? `Confirm ${constraint.kind}; previous candidates will be cancelled. ${constraint.expiresAt ? `At ${constraint.expiresAt} the remaining confirmed settings resume.` : 'Effective until revoked.'}` : 'Clarify the exact restriction before confirming.';
        const [proposal] = await tx.insert(investmentConstraintProposals).values({ owner, accountId: account.id, expectedPolicyRevision: policy.revision, constraint, text: request.text, impact, needsInput, requestKey: request.requestKey, requestHash: investmentHash(request), expiresAt: new Date(Date.now() + 15 * 60000) }).returning();
        return { ...proposal, expiresAt: proposal.expiresAt.toISOString(), createdAt: proposal.createdAt.toISOString() };
      });
    });
  }
  async confirm(owner: string, id: string, input: unknown) { return this.changeConstraint(owner, id, this.parse('confirm', input), false); }
  async revoke(owner: string, id: string, input: unknown) { return this.changeConstraint(owner, id, this.parse('revoke', input), true); }
  private async changeConstraint(owner: string, id: string, request: { expectedPolicyRevision: number; requestKey: string }, revoke: boolean) {
    if (!/^[a-f\d-]{36}$/iu.test(id)) throw new BadRequestException('INVALID_PROPOSAL');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      return this.idempotent(tx, owner, (revoke ? 'revoke:' : 'confirm:') + id, request, async () => {
        const { account, policy: unexpired } = await this.current(tx, owner);
        const policy = await expireInvestmentConstraints(tx, unexpired);
        if (policy.revision !== request.expectedPolicyRevision) throw new ConflictException('POLICY_REVISION_CHANGED');
        const [proposal] = await tx.select().from(investmentConstraintProposals).where(and(eq(investmentConstraintProposals.owner, owner), eq(investmentConstraintProposals.id, id), eq(investmentConstraintProposals.accountId, account.id))).for('update');
        if (!proposal) throw new NotFoundException('Proposal not found');
        if (!revoke && (proposal.state !== 'proposed' || proposal.expectedPolicyRevision !== policy.revision || proposal.expiresAt.getTime() <= Date.now() || !proposal.constraint || proposal.needsInput.length)) throw new ConflictException('PROPOSAL_EXPIRED_CHANGED_OR_AMBIGUOUS');
        let records = structuredClone(policy.constraintRecords);
        if (revoke) {
          const record = records.find(r => r.proposalId === id);
          if (!record || record.status !== 'active') throw new ConflictException('CONSTRAINT_ALREADY_REVOKED_OR_EXPIRED');
          records = records.map(r => r.proposalId === id ? { ...r, status: 'revoked' as const, revokedAt: new Date().toISOString() } : r);
        } else records.push({ id: randomUUID(), proposalId: id, constraint: proposal.constraint!, createdAt: new Date().toISOString(), expiresAt: undefined, revokedAt: null, status: 'active' } as typeof records[number]);
        let effectiveConfig: InvestmentConfig;
        try { effectiveConfig = effectiveInvestmentConfig(policy.baseConfig, records); } catch { throw new ConflictException('CONTRADICTORY_CONSTRAINTS'); }
        await cancelInvestmentCandidates(tx, owner, account.id, 'Confirmed investment constraint changed');
        await tx.update(strategyMandates).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, account.id), eq(strategyMandates.status, 'published')));
        const [saved] = await tx.update(investmentPolicies).set({ revision: policy.revision + 1, constraintRecords: records, effectiveConfig, updatedAt: new Date() }).where(eq(investmentPolicies.id, policy.id)).returning();
        await tx.update(investmentConstraintProposals).set({ state: revoke ? 'revoked' : 'confirmed' }).where(eq(investmentConstraintProposals.id, id));
        if (saved.status === 'running') {
          if (saved.baseConfig.userStrategy) await installInvestorMandate(tx, owner, saved, saved.baseConfig.userStrategy);
          else await this.enqueue(tx, saved, 'constraint');
        }
        return { status: 'applied', policy: policyView(saved), impact: proposal.impact };
      });
    });
  }
  async history(owner: string) { return (await this.simulations.list(owner)).filter(a => !a.active); }
  async pauseLegacy(owner: string, accountId: string, input: unknown) {
    const request = input as { requestKey?: string };
    if (!request || Object.keys(request).some(k => k !== 'requestKey') || !/^[\w-]{8,128}$/u.test(request.requestKey ?? '') || !/^[a-f\d-]{36}$/iu.test(accountId)) throw new BadRequestException('INVALID_INVESTMENT_REQUEST');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      return this.idempotent(tx, owner, 'legacy-pause:' + accountId, request as { requestKey: string }, async () => {
        const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId))).for('update');
        if (!account) throw new NotFoundException('Account not found');
        await cancelInvestmentCandidates(tx, owner, accountId, 'User paused all legacy automatic trading');
        await tx.update(paperAccounts).set({ botEnabled: false, updatedAt: new Date() }).where(eq(paperAccounts.id, accountId));
        const [policy] = await tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId))).for('update');
        if (policy && policy.status !== 'archived') await tx.update(investmentPolicies).set({ status: 'paused', revision: policy.revision + 1, updatedAt: new Date() }).where(eq(investmentPolicies.id, policy.id));
        await tx.update(builderProfiles).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.status, 'active')));
        await tx.update(strategyMandates).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, accountId), eq(strategyMandates.status, 'published')));
        return { status: 'paused', accountId };
      });
    });
  }
  async decision(owner: string, id: string) {
    const [order] = await this.db.select().from(paperOrders).where(and(eq(paperOrders.owner, owner), eq(paperOrders.id, id)));
    if (!order) throw new NotFoundException('Decision not found');
    const [signal] = await this.db.select().from(strategySignals).where(and(eq(strategySignals.owner, owner), eq(strategySignals.orderId, id)));
    const [mandate] = signal?.candidate.mandateId ? await this.db.select().from(strategyMandates).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.id, signal.candidate.mandateId))) : [];
    const rule = mandate?.config.rules.find(r => r.id === signal?.ruleId) as (import('../../../shared/strategy-mandate.interface').MandateRule & { sourceCycleId?: string }) | undefined;
    const [cycle] = rule?.sourceCycleId ? await this.db.select().from(investmentCycles).where(and(eq(investmentCycles.owner, owner), eq(investmentCycles.id, rule.sourceCycleId))) : [];
    const [review] = signal ? await this.db.select().from(strategyRouteReviews).where(and(eq(strategyRouteReviews.owner, owner), eq(strategyRouteReviews.signalId, signal.id))) : [];
    return { strategy: mandate?.config.userStrategyId && rule ? { id: mandate.config.userStrategyId, revision: mandate.config.userStrategyRevision, title: mandate.config.title, entryId: rule.id, text: rule.userDirective?.reviewedText ?? rule.rationale, route: review?.decision.route ?? null } : null, order, candidate: signal?.candidate ?? null, evidence: mandate?.config.references ?? [], authorization: mandate?.config ?? null,
      actualResearch: Array.isArray(cycle?.result.completedResearch) ? cycle.result.completedResearch.filter(item => item && typeof item === 'object' && item.ticker === order.ticker) : [], actualExecutors: cycle?.input.actualExecutors ?? [], discussionId: review?.councilSessionId ?? order.sessionId };
  }
}
