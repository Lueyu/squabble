import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { investmentFixture, startPreUserStrategyInvestmentFixture, restorePreUserStrategyRunningPolicyFixture } from './investment-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { AutonomousResearchService } from './autonomous-research.service';
import { AutomaticResearchBudgetService } from './automatic-research-budget.service';
import { automaticResearchTasks, investmentCycles } from '../../database/investment-policy.schema';
import { tradingMarketSchedule } from './trading-market.calendar';

test('verified team changes create a new independent-review cycle and never replay paid or uncertain work', async t => {
  await investmentFixture(async (db, _client, owner) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T15:00:00Z') });
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'recover-preview' });
    const start = await startPreUserStrategyInvestmentFixture(policies, db, owner, { previewId: preview.id, requestKey: 'recover-start' });
    const [original] = await db.select().from(investmentCycles);
    await db.update(investmentCycles).set({ state: 'waiting', input: { actualExecutors: [{ memberId: 'one', identity: 'source-one', identityVerified: true }] }, result: { reason: 'WAITING_INDEPENDENT_REVIEW', completedResearch: [{ ticker: 'ABC', summary: 'Original paid research remains' }] } }).where(eq(investmentCycles.id, original.id));
    await db.insert(investmentCycles).values({ owner, accountId: start.accountId, policyId: start.policy.id, policyRevision: 1, market: 'US', marketDate: original.marketDate, trigger: 'market_open', eventKey: 'earlier-success', state: 'completed', createdAt: new Date(original.createdAt.getTime()-3600000) });
    const budget = new AutomaticResearchBudgetService(db);
    const paid = await budget.claimAutomaticResearch(owner, start.accountId, `discovery:${original.id}`, 'autonomous-discovery');
    await budget.reserveCall(owner, paid.taskId!); await budget.finish(owner, paid.taskId!, 'completed');
    let sources = ['source-one'];
    const team = { resolveMembers: async () => ({ members: sources.map((id, index) => ({ id, name: id, role: index ? 'manager' : 'researcher', model: 'fast', instructions: '' })), executors: sources.map(id => ({ memberId: id, identity: id, identityVerified: true })) }) };
    const research = new AutonomousResearchService(db, policies, budget, {} as never, team as never, {} as never, {} as never,
      { getSchedule: async () => tradingMarketSchedule('US', new Date()) } as never, {} as never, {} as never);
    await research.queueCurrentMarkets();
    assert.equal((await db.select().from(investmentCycles)).length, 2);
    sources = ['source-one', 'source-two'];
    await Promise.all([research.queueCurrentMarkets(), research.queueCurrentMarkets()]);
    const cycles = await db.select().from(investmentCycles);
    assert.equal(cycles.length, 3, 'a later paid wait recovers despite an earlier successful cycle');
    assert.equal(cycles.find(c => c.id === original.id)!.state, 'superseded');
    assert.deepEqual(cycles.find(c => c.id === original.id)!.result.completedResearch, [{ ticker: 'ABC', summary: 'Original paid research remains' }]);
    const recovered = cycles.find(c => c.state === 'queued')!;
    assert.equal(recovered.state, 'queued');
    assert.notEqual(recovered.eventKey, original.eventKey);
    assert.equal((await db.select().from(automaticResearchTasks))[0].calls, 1, 'old paid task is untouched');
    await db.update(investmentCycles).set({ state: 'uncertain', result: { reason: 'DISPATCH_UNCERTAIN' } }).where(eq(investmentCycles.id, recovered.id));
    sources = ['source-one', 'source-three']; await research.queueCurrentMarkets();
    assert.equal((await db.select().from(investmentCycles)).length, 3, 'uncertain dispatch is never automatically replayed');
  });
});

test('overview and recovery ignore resolved older waits and waits belonging to a superseded policy revision', async t => {
  await investmentFixture(async (db, _client, owner) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T15:00:00Z') });
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'overview-preview' });
    const start = await startPreUserStrategyInvestmentFixture(policies, db, owner, { previewId: preview.id, requestKey: 'overview-start' });
    const [original] = await db.select().from(investmentCycles);
    await db.update(investmentCycles).set({ state: 'waiting', result: { reason: 'CONNECT_AVAILABLE_AI' } }).where(eq(investmentCycles.id, original.id));
    await db.insert(investmentCycles).values({ owner, accountId: start.accountId, policyId: start.policy.id, policyRevision: 1, market: 'US', marketDate: original.marketDate, trigger: 'important_event', eventKey: 'recovered-current', state: 'completed', createdAt: new Date(original.createdAt.getTime()+1000) });
    assert.equal((await policies.overview(owner)).status, 'running', 'a newer successful cycle resolves the old market wait');
    const research = new AutonomousResearchService(db, policies, new AutomaticResearchBudgetService(db), {} as never,
      { resolveMembers: async () => ({ members: [{ id: 'available' }], executors: [{ memberId: 'available', identity: 'actual-source', identityVerified: true }] }) } as never,
      {} as never, {} as never, { getSchedule: async () => tradingMarketSchedule('US', new Date()) } as never, {} as never, {} as never);
    await research.queueCurrentMarkets();
    assert.equal((await db.select().from(investmentCycles)).length, 2);
    assert.equal((await db.select().from(investmentCycles)).find(c => c.id === original.id)!.state, 'waiting', 'the resolved older wait is retained as history, never requeued');
    await policies.pause(owner, { expectedRevision: 1, requestKey: 'overview-pause' });
    await restorePreUserStrategyRunningPolicyFixture(policies, db, owner, true);
    await db.update(investmentCycles).set({ state: 'waiting', result: { reason: 'OLD_REVISION_WAIT' }, createdAt: new Date(Date.now()+10000) }).where(eq(investmentCycles.id, original.id));
    const current = (await db.select().from(investmentCycles)).find(c => c.policyRevision === 3)!;
    await db.update(investmentCycles).set({ state: 'completed' }).where(eq(investmentCycles.id, current.id));
    assert.equal((await policies.overview(owner)).status, 'running');
  });
});

test('a later unpaid connection wait recovers after an earlier completed cycle', async t => {
  await investmentFixture(async (db, _client, owner) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T15:00:00Z') });
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'later-wait-preview' });
    const start = await startPreUserStrategyInvestmentFixture(policies, db, owner, { previewId: preview.id, requestKey: 'later-wait-start' });
    const [waiting] = await db.select().from(investmentCycles);
    await db.update(investmentCycles).set({ state: 'waiting', result: { reason: 'CONNECT_AVAILABLE_AI' } }).where(eq(investmentCycles.id, waiting.id));
    await db.insert(investmentCycles).values({ owner, accountId: start.accountId, policyId: start.policy.id, policyRevision: 1, market: 'US', marketDate: waiting.marketDate, trigger: 'market_open', eventKey: 'earlier-completed', state: 'completed', createdAt: new Date(waiting.createdAt.getTime()-3600000) });
    const research = new AutonomousResearchService(db, policies, new AutomaticResearchBudgetService(db), {} as never,
      { resolveMembers: async () => ({ members: [{ id: 'available' }], executors: [{ memberId: 'available', identity: 'actual-source', identityVerified: true }] }) } as never,
      {} as never, {} as never, { getSchedule: async () => tradingMarketSchedule('US', new Date()) } as never, {} as never, {} as never);
    await research.queueCurrentMarkets();
    const cycles = await db.select().from(investmentCycles);
    assert.equal(cycles.length, 2);
    assert.equal(cycles.find(c => c.id === waiting.id)!.state, 'queued');
    assert.equal((await db.select().from(automaticResearchTasks)).length, 0);
  });
});

test('a connection wait with a claimed provider task cannot reuse its cycle identity', async t => {
  await investmentFixture(async (db, _client, owner) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T15:00:00Z') });
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'claimed-preview' });
    const start = await startPreUserStrategyInvestmentFixture(policies, db, owner, { previewId: preview.id, requestKey: 'claimed-start' });
    const [cycle] = await db.select().from(investmentCycles);
    await db.update(investmentCycles).set({ state: 'waiting', result: { reason: 'CONNECT_AVAILABLE_AI' } }).where(eq(investmentCycles.id, cycle.id));
    const budget = new AutomaticResearchBudgetService(db);
    await budget.claimAutomaticResearch(owner, start.accountId, `discovery:${cycle.id}`, 'autonomous-discovery');
    const research = new AutonomousResearchService(db, policies, budget, {} as never,
      { resolveMembers: async () => ({ members: [{ id: 'available' }], executors: [{ memberId: 'available', identity: 'actual-source', identityVerified: true }] }) } as never,
      {} as never, {} as never, { getSchedule: async () => tradingMarketSchedule('US', new Date()) } as never, {} as never, {} as never);
    await research.queueCurrentMarkets();
    const cycles = await db.select().from(investmentCycles);
    assert.equal(cycles.length, 1); assert.equal(cycles[0].state, 'waiting');
    assert.equal((await db.select().from(automaticResearchTasks)).length, 1);
  });
});
