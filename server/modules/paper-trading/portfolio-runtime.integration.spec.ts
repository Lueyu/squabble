import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { investmentFixture } from './investment-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { PortfolioWorkspaceService } from './portfolio-workspace.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { AgentBuilderService } from './agent-builder.service';
import { PaperTradingService } from './paper-trading.service';
import { BuilderCadenceService } from './builder-cadence.service';
import { StrategyService } from './strategy.service';
import { StrategyStore } from './strategy.store';
import { StrategyMandateService } from './strategy-mandate.service';
import { StrategyScheduler } from './strategy.scheduler';
import { simulationMarketFixture } from './simulation-market.fixture';
import { tradingMarketSchedule } from './trading-market.calendar';
import { investmentExecutionFence } from './investment-policy.fence';
import { requireActivePaperAccount } from './simulation-account';
import { reserveStrategyCandidate } from './strategy-reservation';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { cashAccounts, holdings, builderProfiles, paperAccounts, paperOrders, paperPositions } from '../../database/schema';
import { strategySignals } from '../../database/strategy.schema';
import { strategyMandates, strategyReservations } from '../../database/strategy-mandates.schema';
import { investmentCycles } from '../../database/investment-policy.schema';
import { AutonomousResearchService } from './autonomous-research.service';
import { AutonomousPlanCompiler } from './autonomous-plan.compiler';
import type { PortfolioAllocationInput } from '../../../shared/portfolio-workspace.interface';

test('two accounts execute independent combinations; pausing A stops its protections and keeps B running', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-09T15:00:00Z') });
  await investmentFixture(async (db, _client, owner) => {
    await db.insert(holdings).values(['AAPL', 'MSFT'].map(ticker => ({ owner, ticker, shares: '1', buyPrice: '80', market: 'US', currency: 'USD' })));
    await db.insert(cashAccounts).values({ owner, currency: 'USD', balance: '20000', reconciliationStatus: 'confirmed' });
    let quotePrice = '99';
    const snapshot = (ticker: string) => ({ ...simulationMarketFixture({ price: quotePrice, market: 'US', currency: 'USD', timestamp: Date.now() }),
      ticker, providerSymbol: ticker, lotSize: 1, candles: Array.from({ length: 20 }, () => ({ volume: 1000000 })) });
    const market = { getSnapshot: async (ticker: string) => snapshot(ticker), getSchedule: async () => tradingMarketSchedule('US', new Date()) };
    const fx = { convert: async (amount: number) => amount };
    const model = { json: async () => { throw new Error('These explicit test directives must not call AI'); } };
    const documents = new ResearchDocumentsService(db);
    const drafts = new UserInvestmentStrategyService(db, documents, model as never);
    const simulations = new SimulationExperimentsService(db, {} as never, fx as never, documents, market as never);
    const policies = new InvestmentPolicyService(db, simulations, drafts);
    const workspace = new PortfolioWorkspaceService(db, policies, drafts);
    const makeAccount = async (name: string) => {
      const preview = await policies.preview(owner, { origin: 'holdings', requestKey: `preview-${name}` });
      return workspace.create(owner, { name, previewId: preview.id, requestKey: `create-${name}`, confirmOpeningCash: true });
    };
    const first = await makeAccount('account-a');
    const second = await makeAccount('account-b');
    const makeStrategy = async (ticker: string) => {
      const text = `Buy 2 ${ticker} below 100 with stop 95`;
      const draft = await drafts.create(owner, { title: ticker, body: text, timezone: 'Asia/Shanghai',
        startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(),
        limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20, minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 5 },
        entries: [{ id: 'shared-entry-name', text, sourceKeys: [], directive: { ticker, side: 'buy', quantity: 2,
          trigger: { kind: 'price_lte', price: 100 }, stopLossPrice: 95, reviewedText: text,
          numericEvidence: [{ field: 'quantity', value: 2, quote: text }, { field: 'trigger.price', value: 100, quote: text }, { field: 'stopLossPrice', value: 95, quote: text }] } }] });
      const ready = await drafts.preview(owner, draft.id, draft.revision);
      assert.equal(ready.preview?.canConfirm, true, JSON.stringify(ready.preview));
      return ready;
    };
    const aapl = await makeStrategy('AAPL'); const msft = await makeStrategy('MSFT');
    const allocations = [aapl, msft].map(strategy => ({ strategyId: strategy.id, strategyRevision: strategy.revision, allocationPct: 50, enabled: true }));
    const apply = async (accountId: string, expectedPolicyRevision: number, values: PortfolioAllocationInput[], key: string) => {
      const preview = await workspace.preview(owner, accountId, { expectedPolicyRevision, allocations: values, requestKey: `preview-${key}` });
      return workspace.apply(owner, accountId, { expectedPolicyRevision, allocations: values, previewHash: preview.previewHash, requestKey: `apply-${key}` });
    };
    const appliedA = await apply(first.accountId, first.policy.revision, allocations, 'combination-a');
    const appliedB = await apply(second.accountId, second.policy.revision, [{ ...allocations[0], allocationPct: 100 }], 'combination-b');
    const research = new AutonomousResearchService(db, policies, {} as never, {} as never, {} as never, model as never,
      {} as never, {} as never, documents, new AutonomousPlanCompiler(db, documents));
    await research.queueCurrentMarkets();
    assert.equal((await db.select().from(investmentCycles)).length, 0, 'combination policies never start autonomous discovery');
    assert.equal(await research.trigger(owner, appliedA.policy.id, 'US', 'combination-evidence', 'evidence_invalidated'), null);
    const [obsoleteCycle] = await db.insert(investmentCycles).values({ owner, accountId: first.accountId,
      policyId: appliedA.policy.id, policyRevision: appliedA.policy.revision, market: 'US', marketDate: '2026-11-09',
      trigger: 'fixture-late-result', eventKey: 'cannot-replace-combination' }).returning();
    await assert.rejects(new AutonomousPlanCompiler(db, documents).activate(owner, obsoleteCycle.id, randomUUID(), randomUUID(), []),
      /USER_STRATEGY_CANNOT_BE_REPLACED/);
    const builder = new AgentBuilderService(db, {} as never);
    const paper = new PaperTradingService(db, { getQuote: async (ticker: string) => ({ price: quotePrice, market: 'US', currency: 'USD', timestamp: Date.now(), symbol: ticker }) } as never,
      fx as never, {} as never, builder, new BuilderCadenceService(db), {} as never, market as never);
    const mandates = new StrategyMandateService(db, documents, builder, model as never, market as never);
    const discovery = { verify: async ({ ticker }: { ticker: string }) => ({ ticker, market: 'US', currency: 'USD', assetType: 'stock',
      identitySourceUrl: 'https://example.invalid/security', sourceUrl: 'https://example.invalid/quote', observedAt: new Date().toISOString(),
      summary: 'Fictional verified security', providerSymbol: ticker, lotSize: 1, leveraged: false, inverse: false }) };
    const strategy = new StrategyService(db, builder, paper, {} as never, market as never, model as never,
      new StrategyStore(db), fx as never, mandates, undefined, undefined, discovery as never);
    await assert.rejects(requireActivePaperAccount(db, owner), /ACCOUNT_SELECTION_REQUIRED/);
    await assert.rejects(paper.getOverview(owner), /ACCOUNT_SELECTION_REQUIRED/);
    await Promise.all([strategy.tick(owner, first.accountId), strategy.tick(owner, second.accountId)]);
    const orders = await db.select().from(paperOrders);
    assert.equal(orders.filter(order => order.accountId === first.accountId && order.status === 'filled').length, 2,
      JSON.stringify({ orders, signals: await db.select().from(strategySignals) }));
    assert.equal(orders.filter(order => order.accountId === second.accountId && order.status === 'filled').length, 1);
    assert.equal((await db.select().from(builderProfiles)).filter(profile => profile.status === 'active').length, 2);
    const [oldSignal] = (await db.select().from(strategySignals)).filter(signal => signal.candidate.accountId === first.accountId);
    const paused = await workspace.switchStatus(owner, first.accountId, { expectedPolicyRevision: appliedA.policy.revision, requestKey: 'pause-account-a' }, false);
    const fence = await db.transaction(tx => investmentExecutionFence(tx, owner, first.accountId, oldSignal.candidate, 'agent', oldSignal.candidate));
    assert.equal(fence.block, 'INVESTMENT_PAUSED');
    assert.equal((await workspace.detail(owner, second.accountId)).policyRevision, appliedB.policy.revision);
    t.mock.timers.tick(61_000); quotePrice = '90';
    await Promise.all([strategy.tick(owner, first.accountId), strategy.tick(owner, second.accountId)]);
    const positions = await db.select().from(paperPositions);
    assert.equal(positions.find(position => position.accountId === first.accountId && position.ticker === 'AAPL')?.shares, '3');
    assert.equal(positions.find(position => position.accountId === second.accountId && position.ticker === 'AAPL')?.shares ?? '0', '0', 'B protection still executes');
    quotePrice = '99';
    const resumed = await workspace.switchStatus(owner, first.accountId, { expectedPolicyRevision: paused.policy.revision, requestKey: 'resume-account-a' }, true);
    const replaced = await apply(first.accountId, resumed.policy.revision, [{ ...allocations[0], allocationPct: 40 }, { ...allocations[1], allocationPct: 60 }], 'rebuild-a');
    assert.ok(replaced.policy.revision > appliedA.policy.revision);
    const stale = await db.transaction(tx => investmentExecutionFence(tx, owner, first.accountId, oldSignal.candidate, 'agent', oldSignal.candidate));
    assert.equal(stale.block, 'INVESTMENT_AUTHORIZATION_CHANGED');
    await strategy.tick(owner, first.accountId);
    assert.equal((await db.select().from(paperOrders).where(eq(paperOrders.accountId, first.accountId))).length, 2, 'rebuild and resume cannot repeat consumed entries');
    assert.ok((await db.select().from(strategyReservations)).every(reservation => reservation.status !== 'active'));
    const current = await db.select().from(strategyMandates).where(and(eq(strategyMandates.accountId, first.accountId), eq(strategyMandates.status, 'published')));
    assert.equal(new Set(current[0].config.rules.map(rule => rule.id)).size, 2, 'same original entry name has separate strategy identity');

    const capped = await makeStrategy('AAPL');
    const capApplied = await apply(first.accountId, replaced.policy.revision, [
      { ...allocations[0], allocationPct: 40 }, { ...allocations[1], allocationPct: 59.9 },
      { strategyId: capped.id, strategyRevision: capped.revision, allocationPct: 0.1, enabled: true },
    ], 'enforce-budget-a');
    await strategy.tick(owner, first.accountId);
    const [budgetSignal] = (await db.select().from(strategySignals)).filter(signal => signal.candidate.userStrategyId === capped.id);
    assert.equal(budgetSignal.state, 'blocked');
    assert.equal(budgetSignal.reason, 'PORTFOLIO_STRATEGY_BUDGET_EXCEEDED');
    // Bypass only the early routing gate in this fixture to prove the transaction itself rechecks the cap.
    await db.update(strategySignals).set({ state: 'approved' }).where(eq(strategySignals.id, budgetSignal.id));
    await db.update(strategyReservations).set({ status: 'active', expiresAt: new Date(Date.now() + 60000) })
      .where(eq(strategyReservations.signalId, budgetSignal.id));
    await assert.rejects(paper.placeOrder(owner, { ticker: 'AAPL', side: 'buy', quantity: 2, orderType: 'market' }, 'agent',
      undefined, true, true, await builder.getProfile(owner, budgetSignal.profileId), undefined, budgetSignal.id, first.accountId),
    /PORTFOLIO_STRATEGY_BUDGET_EXCEEDED/);
    assert.equal((await db.select().from(paperOrders).where(eq(paperOrders.accountId, first.accountId))).length, 2);

    const scheduled: string[] = []; const valued: string[] = [];
    await workspace.switchStatus(owner, first.accountId, { expectedPolicyRevision: capApplied.policy.revision, requestKey: 'pause-for-scheduler' }, false);
    const scheduler = new StrategyScheduler(db, { tick: async (_owner: string, accountId: string) => { scheduled.push(accountId); } } as never,
      { tick: async () => undefined } as never, { ensureDailySnapshot: async (_owner: string, accountId: string) => { valued.push(accountId); } } as never);
    await scheduler.tick();
    assert.deepEqual(scheduled, [second.accountId], 'one exact account dispatch; no profile/account cross product');
    assert.deepEqual(valued.sort(), [first.accountId, second.accountId].sort(), 'paused accounts still get valuation observations');

    const reserve = (index: number) => db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [account] = await tx.select().from(paperAccounts).where(eq(paperAccounts.id, first.accountId)).for('update');
      const candidate = { ...oldSignal.candidate, signalId: randomUUID(), userStrategyId: allocations[index].strategyId,
        quantity: 150, notionalUsd: 14850, quoteAt: new Date().toISOString() };
      await tx.insert(strategySignals).values({ owner, id: candidate.signalId, profileId: oldSignal.profileId,
        planId: oldSignal.planId, ruleId: candidate.ruleId, kind: `reservation-contention-${index}`, candidate, state: 'reviewing', reason: 'Cash contention fixture' });
      return reserveStrategyCandidate(tx, owner, account, candidate);
    });
    const reservations = await Promise.all([reserve(0), reserve(1)]);
    assert.equal(reservations.filter(Boolean).length, 1, 'two independent strategies cannot reserve the same account cash');
  });
});
