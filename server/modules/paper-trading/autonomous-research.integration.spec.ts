import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { investmentFixture, startPreUserStrategyInvestmentFixture, restorePreUserStrategyRunningPolicyFixture } from './investment-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { AutonomousResearchService } from './autonomous-research.service';
import { AutonomousPlanCompiler } from './autonomous-plan.compiler';
import { AutomaticResearchBudgetService } from './automatic-research-budget.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { investmentCycles, automaticResearchTasks } from '../../database/investment-policy.schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { tradingMarketSchedule } from './trading-market.calendar';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AgentBuilderService } from './agent-builder.service';
import { PaperTradingService } from './paper-trading.service';
import { BuilderCadenceService } from './builder-cadence.service';
import { StrategyStore } from './strategy.store';
import { StrategyService } from './strategy.service';
import { StrategyMandateService } from './strategy-mandate.service';
import { councilSessions, councilReports } from '../../database/council.schema';
import { paperAccounts, paperOrders, paperPositions } from '../../database/schema';
import { strategySignals } from '../../database/strategy.schema';
import { builderProfiles } from '../../database/schema';
import { normalizeBuilderConfig } from './agent-builder.rules';
import { DEFAULT_INVESTMENT_CONFIG } from './investment-policy.rules';
import { compileAutonomousRules } from './autonomous-plan.compiler';

test('real durable discovery and independent review activate a new-stock composite plan once', async t => {
  await investmentFixture(async (db, _client, owner) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T15:00:00Z') });
    const policyService = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const budget = new AutomaticResearchBudgetService(db);
    const daily = await budget.claimAutomaticResearch(owner, null, 'current-daily-report', 'portfolio');
    await budget.reserveCall(owner, daily.taskId!); await budget.finish(owner, daily.taskId!, 'completed');
    const [legacy] = await db.insert(paperAccounts).values({ owner, initialCash: '10000', cashBalance: '10000', botEnabled: true }).returning();
    await db.insert(paperPositions).values(['HLDA', 'HLDB'].map(ticker => ({ owner, accountId: legacy.id, ticker, market: 'US', currency: 'USD', shares: '1', avgCost: '100' })));
    const preview = await policyService.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'autonomous-preview' });
    await startPreUserStrategyInvestmentFixture(policyService, db, owner, { previewId: preview.id, requestKey: 'autonomous-start', markets: ['US'], adoptAccountId: legacy.id });
    const members = ['one', 'two'].map((id, i) => ({ id, name: id, role: i ? 'manager' : 'researcher', model: i ? 'slow' : 'fast', instructions: '', connectionId: randomUUID() }));
    let connected = false;
    const team = { resolveMembers: async () => ({ members: connected ? members : [], executors: connected ? members.map(m => ({ memberId: m.id, identity: m.id + ':provider:model', identityVerified: true, connection: m.id, provider: 'fixture', model: 'model' })) : [] }) };
    const security = { ticker: 'ABC', market: 'US', currency: 'USD', assetType: 'stock', sourceUrl: 'https://www.sec.gov/fixture', identitySourceUrl: 'https://www.nasdaq.com/fixture', summary: 'Fictional ordinary stock', observedAt: new Date().toISOString(), providerSymbol: 'ABC', lotSize: 1, leveraged: false, inverse: false };
    let calls = 0;
    const model = { json: async (_owner: string, _member: { model: string }, _task: string, purpose: string, prompt: string, _current: unknown, fast: boolean) => {
      calls++;
      assert.equal(fast, _member.model === 'fast', 'actual dispatched route must match the server-verified executor model');
      if (purpose === 'autonomous-independent-research') {
        assert.doesNotMatch(prompt, /otherDrafts/);
        if (!prompt.includes('Only ticker ABC,')) return { conclusion: 'observe', summary: 'Existing holding evidence reviewed; continue observing', unresolvedDisagreements: [], rules: [] };
        const evidenceId = prompt.match(/evidenceId=([\da-f-]{36})/u)![1];
        return { conclusion: 'approve', summary: 'Fictional sourced opportunity', unresolvedDisagreements: [], rules: [{ id: 'entry', ticker: 'ABC', side: 'buy', trigger: { kind: 'price_below', value: 100 }, referencePrice: 100, minPrice: 95, maxPrice: 105, stopLossPrice: 90, maxPositionPct: 10, expiresAt: tradingMarketSchedule('US', new Date()).closesAt!, evidenceIds: [evidenceId], rationale: 'Sourced fictional opportunity' }] };
      }
      return { conclusion: 'approve', summary: 'Verified the proposed price limits and source', unresolvedDisagreements: [], agreesWithProposedRules: true };
    } };
    const market = { getSchedule: async (m: 'US' | 'HK' | 'CN') => tradingMarketSchedule(m, new Date()), getSnapshot: async () => ({ sourceUrl: security.sourceUrl, quoteUsable: true, price: 100, quoteTimestamp: new Date().toISOString() }) };
    const docs = new ResearchDocumentsService(db);
    const service = new AutonomousResearchService(db, policyService, new AutomaticResearchBudgetService(db),
      { verify: async ({ ticker }: { ticker: string }) => ({ ...security, ticker, providerSymbol: ticker }), discoverCandidates: async () => ({ candidates: [security], excluded: [], reason: null }) } as never, team as never,
      model as never, { collectResearch: async () => [{ title: 'Fictional measured filing', content: 'Sourced fictional numbers', sourceUrl: security.sourceUrl }] } as never,
      market as never, docs, new AutonomousPlanCompiler(db, docs));
    const [cycle] = await db.select().from(investmentCycles);
    await service.runCycle(owner, cycle.id);
    assert.equal((await db.select().from(investmentCycles))[0].result.reason, 'CONNECT_AVAILABLE_AI');
    await service.queueCurrentMarkets();
    assert.equal((await db.select().from(investmentCycles)).length, 1, 'no connection does not create repeated empty cycles');
    connected = true;
    await Promise.all([service.queueCurrentMarkets(), service.queueCurrentMarkets()]);
    assert.equal((await db.select().from(investmentCycles))[0].state, 'queued', 'connecting AI in the same phase safely requeues the unpaid original cycle');
    assert.equal((await db.select().from(investmentCycles)).length, 1);
    await Promise.all([service.runCycle(owner, cycle.id), service.runCycle(owner, cycle.id)]);
    assert.equal(calls, 12, JSON.stringify(await db.select().from(investmentCycles)));
    const [mandate] = await db.select().from(strategyMandates);
    assert.equal(mandate.config.rules[0].ticker, 'ABC');
    assert.equal(mandate.config.parentPolicyRevision, 1);
    assert.equal((await db.select().from(investmentCycles).where(eq(investmentCycles.id, cycle.id)))[0].state, 'completed');
    const snapshot = () => ({ ticker: 'ABC', providerSymbol: 'ABC', market: 'US', currency: 'USD', usable: true, reason: null,
      quoteUsable: true, quoteReason: null, source: 'yahoo-chart', sourceUrl: security.sourceUrl, fetchedAt: new Date().toISOString(), quoteTimestamp: new Date().toISOString(),
      price: 100, lotSize: 1, delay: 'possibly-delayed', maxQuoteAgeSeconds: 1200, timeframe: '1d', candles: Array.from({ length: 30 }, () => ({ timestamp: '2026-11-05T21:00:00Z', open: 100, high: 105, low: 95, close: 100, volume: 1000000 })),
      indicators: { sma20: 100, sma50: 100, rsi14: 40, atr14: 2, volumeRatio: 1.2, asOf: '2026-11-05T21:00:00Z', sampleSize: 60, timeframe: '1d' }, schedule: tradingMarketSchedule('US', new Date()) });
    const executionMarket = { getSnapshot: async (ticker: string) => ({ ...snapshot(), ticker, providerSymbol: ticker }), getSchedule: market.getSchedule };
    const fx = { convert: async (amount: number) => amount };
    const builder = new AgentBuilderService(db, { isConfigured: async () => true, validateConnectionIds: async () => undefined } as never);
    let councilCalls = 0;
    const council = { reviewCandidate: async (_owner: string, profile: { id: string; version: number; config: never }, candidate: never, context: { automaticTaskId?: string }) => {
      councilCalls++; assert.ok(context.automaticTaskId);
      assert.deepEqual((profile.config as { council: { members: Array<{ id: string }> } }).council.members.map(m => m.id), members.map(m => m.id), 'actual execution review must use the currently allowed team');
      for (let i = 0; i < 4; i++) await budget.reserveCall(owner, context.automaticTaskId!);
      await budget.finish(owner, context.automaticTaskId!, 'completed');
      const [session] = await db.insert(councilSessions).values({ owner, ticker: 'ABC', profileId: profile.id, profileVersion: profile.version, profileSnapshot: profile.config, candidate, status: 'completed' }).returning();
      const [report] = await db.insert(councilReports).values({ owner, sessionId: session.id, version: 1, revision: 1, engine: 'llm', decision: 'approve', summary: 'Actual fixture pretrade Council', candidate, dissent: [], nextReviewCondition: 'new facts', evidence: [], createdAt: new Date() }).returning();
      return { approved: true, reason: 'Actual fixture pretrade Council', sessionId: session.id, reportId: report.id };
    } };
    const paper = new PaperTradingService(db, { getQuote: async () => ({ symbol: 'ABC', price: '100', market: 'US', currency: 'USD', timestamp: Date.now() }) } as never, fx as never, { notifyUser: async () => undefined } as never,
      builder, new BuilderCadenceService(db), council as never, executionMarket as never);
    let executionError = '';
    const place = paper.placeOrder.bind(paper);
    paper.placeOrder = async (...args) => { try { return await place(...args); } catch (error) { executionError = error instanceof Error ? error.message : String(error); throw error; } };
    const mandates = new StrategyMandateService(db, docs, builder, model as never, executionMarket as never);
    const strategy = new StrategyService(db, builder, paper, council as never, executionMarket as never, model as never, new StrategyStore(db), fx as never, mandates);
    await strategy.tick(owner);
    assert.equal(councilCalls, 1, 'first new-stock buy uses the existing Council execution route');
    const orders = await db.select().from(paperOrders);
    assert.equal(orders.filter(order => order.status === 'filled').length, 1, JSON.stringify({ executionError, orders, signals: await db.select().from(strategySignals) }));
    const decision = await policyService.decision(owner, orders.find(order => order.status === 'filled')!.id);
    assert.equal((decision.actualExecutors as unknown[]).length, 2);
    assert.equal((decision.actualResearch as unknown[]).length, 1);
    assert.equal((await db.select().from(automaticResearchTasks)).length, 6, 'daily report, two held risks, discovery, new deep research and reserved execution fit the shared daily six');
    const firstProfile = (await builder.getActiveProfile(owner))!;
    t.mock.timers.tick(72 * 3600000);
    members.splice(0, members.length, ...['three', 'four'].map((id, index) => ({ id, name: id, role: index ? 'manager' : 'researcher', model: index ? 'slow' : 'fast', instructions: '', connectionId: randomUUID() })));
    const next = await service.trigger(owner, mandate.config.parentPolicyId!, 'US', 'allowed-team-changed', 'important_event');
    await service.runCycle(owner, next!.id);
    const currentProfile = (await builder.getActiveProfile(owner))!;
    assert.notEqual(currentProfile.id, firstProfile.id);
    assert.deepEqual(currentProfile.config.council!.members.map(m => m.id), ['three', 'four']);
    assert.deepEqual((await builder.getProfile(owner, firstProfile.id)).config.council!.members.map(m => m.id), ['one', 'two'], 'historical execution config remains immutable');
    await strategy.tick(owner);
    assert.equal(councilCalls, 2, 'the second execution actually reviews with the replacement team');
  });
});

test('concurrent US/HK cycle completion merges both markets and a later market expiry preserves the other', async t => {
  await investmentFixture(async (db, _client, owner) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T07:00:00Z') });
    const service = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const preview = await service.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'merge-preview-one' });
    const started = await startPreUserStrategyInvestmentFixture(service, db, owner, { previewId: preview.id, requestKey: 'merge-start-one', markets: ['US', 'HK'] });
    const members = [{ id: 'one', role: 'researcher', name: 'One', model: 'slow', instructions: '' }, { id: 'two', role: 'manager', name: 'Two', model: 'slow', instructions: '' }];
    const config = normalizeBuilderConfig({ name: 'Fixture', template: 'balanced', tickers: [], minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 20, notifyOnProposal: false, council: { enabled: true, members } });
    const [profile] = await db.insert(builderProfiles).values({ owner, config, status: 'draft' }).returning();
    const docs = new ResearchDocumentsService(db); const compiler = new AutonomousPlanCompiler(db, docs);
    const cycles = await db.select().from(investmentCycles);
    const publish = async (cycle: typeof cycles[number]) => {
      const token = randomUUID(); const ticker = cycle.market === 'US' ? 'ABC' : '0700.HK'; const validUntil = cycle.market === 'US' ? '2026-11-06T21:00:00Z' : '2026-11-06T08:00:00Z';
      const doc = await docs.submit(owner, { idempotencyKey: 'merge-source-'+cycle.market, title: 'Fictional source', kind: 'deep', ticker, content: 'Verified bounded fictional evidence', sections: [{ id: 'facts', title: 'Facts', content: 'Fictional evidence' }], dataAsOf: new Date().toISOString(), availableAt: new Date().toISOString() });
      const security = { ticker, market: cycle.market as 'US' | 'HK', currency: cycle.market === 'US' ? 'USD' as const : 'HKD' as const, assetType: 'stock' as const, sourceUrl: 'https://www.sec.gov/fixture', identitySourceUrl: 'https://www.nasdaq.com/fixture', summary: 'Fictional equity', observedAt: new Date().toISOString(), providerSymbol: ticker, lotSize: 1, leveraged: false as const, inverse: false as const };
      const rule = { id: 'entry', ticker, side: 'buy', trigger: { kind: 'price_below', value: 100 }, referencePrice: 100, minPrice: 95, maxPrice: 105, stopLossPrice: 90, maxPositionPct: 10, expiresAt: validUntil, evidenceIds: [doc.id], rationale: 'Fictional source' };
      const reviews = ['actual-provider-one:model', 'actual-provider-two:model'].map(identity => ({ memberId: identity, executorIdentity: identity, executorVerified: true, completedAt: new Date().toISOString(), conclusion: 'approve' as const, unresolvedDisagreements: [], evidenceIds: [doc.id], rules: [rule], summary: 'Verified exact rule' }));
      const rules = compileAutonomousRules({ config: { ...DEFAULT_INVESTMENT_CONFIG, markets: ['US', 'HK'] }, security, reviews, isNew: true, marketDate: '2026-11-06', validUntil, cycleId: cycle.id, evidenceIds: [doc.id] });
      await db.update(investmentCycles).set({ state: 'researching', leaseToken: token, leaseUntil: new Date(Date.now()+5*60000) }).where(eq(investmentCycles.id, cycle.id));
      return compiler.activate(owner, cycle.id, token, profile.id, rules);
    };
    await Promise.all(cycles.map(publish));
    const [active] = (await db.select().from(strategyMandates)).filter(m => m.status === 'published');
    assert.deepEqual(active.config.rules.map(r => r.ticker).sort(), ['0700.HK', 'ABC']);
    assert.equal(active.config.endsAt, '2026-11-06T21:00:00.000Z');
    t.mock.timers.tick(2 * 3600000);
    const token = randomUUID();
    const [next] = await db.insert(investmentCycles).values({ owner, accountId: started.accountId, policyId: started.policy.id, policyRevision: 1, market: 'HK', marketDate: '2026-11-07', trigger: 'market_open', eventKey: 'next-hk-day', state: 'researching', leaseToken: token, leaseUntil: new Date(Date.now()+5*60000) }).returning();
    await compiler.activate(owner, next.id, token, profile.id, []);
    const [remaining] = (await db.select().from(strategyMandates)).filter(m => m.status === 'published');
    assert.deepEqual(remaining.config.rules.map(r => r.ticker), ['ABC']);
  });
});

test('four existing holdings rotate risk reviews and do not consume the new-candidate discovery quota', async t => {
  await investmentFixture(async (db, _client, owner) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T15:00:00Z') });
    const service = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const preview = await service.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'rotation-preview' });
    const [legacy] = await db.insert(paperAccounts).values({ owner, initialCash: '10000', cashBalance: '10000', botEnabled: true }).returning();
    await db.insert(paperPositions).values(['HLDA', 'HLDB', 'HLDC', 'HLDD'].map(ticker => ({ owner, accountId: legacy.id, ticker, market: 'US', currency: 'USD', shares: '1', avgCost: '100' })));
    const start = await startPreUserStrategyInvestmentFixture(service, db, owner, { previewId: preview.id, requestKey: 'rotation-start', adoptAccountId: legacy.id });
    const security = (ticker: string) => ({ ticker, market: 'US', currency: 'USD', assetType: 'stock', sourceUrl: 'https://www.sec.gov/fixture', identitySourceUrl: 'https://www.nasdaq.com/fixture', summary: 'Fictional equity', observedAt: new Date().toISOString(), providerSymbol: ticker, lotSize: 1, leveraged: false, inverse: false });
    let discoveries = 0;
    const discovery = { verify: async ({ ticker }: { ticker: string }) => security(ticker), discoverCandidates: async () => { discoveries++; return { candidates: [security('NEWONE')], reason: null }; } };
    const member = { id: 'one', role: 'researcher', name: 'One', model: 'fast', instructions: '', connectionId: randomUUID() };
    const team = { resolveMembers: async () => ({ members: [member], executors: [{ memberId: 'one', identity: 'fixture:actual-model', identityVerified: true }] }) };
    const model = { json: async (_owner: string, _member: unknown, _task: string, purpose: string) => purpose === 'autonomous-independent-research'
      ? { conclusion: 'observe', summary: 'Known holdings reviewed; missing evidence means observe', unresolvedDisagreements: [], rules: [] }
      : { conclusion: 'observe', summary: 'No new execution rule', unresolvedDisagreements: [], agreesWithProposedRules: false } };
    const market = { getSchedule: async () => tradingMarketSchedule('US', new Date()), getSnapshot: async () => ({ sourceUrl: 'https://www.sec.gov/fixture' }) };
    const docs = new ResearchDocumentsService(db);
    const research = new AutonomousResearchService(db, service, new AutomaticResearchBudgetService(db), discovery as never, team as never, model as never,
      { collectResearch: async () => [{ title: 'Fictional evidence', content: 'Measured fixture', sourceUrl: 'https://www.sec.gov/fixture' }] } as never, market as never, docs, new AutonomousPlanCompiler(db, docs));
    const [first] = await db.select().from(investmentCycles);
    await research.runCycle(owner, first.id);
    const next = await research.trigger(owner, start.policy.id, 'US', 'new-important-event', 'important_event');
    await research.runCycle(owner, next!.id);
    const cycles = await db.select().from(investmentCycles);
    assert.equal(discoveries, 2, JSON.stringify(cycles));
    const heldReviewed = cycles.flatMap(c => (c.result.completedResearch as Array<{ ticker: string; reviews?: unknown[] }>).filter(r => r.reviews).map(r => r.ticker));
    assert.equal(new Set(heldReviewed).size, 4, 'oldest unreviewed holdings receive the next risk slots');
    assert.ok(cycles.every(c => c.candidates.some(candidate => (candidate as { ticker: string }).ticker === 'NEWONE')), 'new stocks are still discovered with >=4 held securities');
  });
});
