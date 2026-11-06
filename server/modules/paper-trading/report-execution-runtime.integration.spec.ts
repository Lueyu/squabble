import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { investmentFixture } from './investment-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { holdings, cashAccounts, paperPositions, paperTrades } from '../../database/schema';
import { StrategyService } from './strategy.service';
import { StrategyStore } from './strategy.store';
import { StrategyMandateService } from './strategy-mandate.service';
import { AgentBuilderService } from './agent-builder.service';
import { PaperTradingService } from './paper-trading.service';
import { BuilderCadenceService } from './builder-cadence.service';
import { tradingMarketSchedule } from './trading-market.calendar';
import { simulationMarketFixture } from './simulation-market.fixture';
import { strategyProtections } from '../../database/strategy.schema';

test('an immutable report plan reaches one paper fill after explicit strategy application without another model call', async t => {
  await investmentFixture(async (db, client, owner) => {
    await client.unsafe(readFileSync('scripts/db/39_user_investment_strategies.sql', 'utf8'));
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T15:00:00Z') });
    await db.insert(holdings).values({ owner, ticker: 'AAPL', shares: '1', buyPrice: '80', market: 'US', currency: 'USD' });
    await db.insert(cashAccounts).values({ owner, currency: 'USD', balance: '10000', reconciliationStatus: 'confirmed' });
    const quote = { price: '99', market: 'US', currency: 'USD', timestamp: Date.now() };
    const snapshot = () => ({ ...simulationMarketFixture({ ...quote, timestamp: Date.now() }), ticker: 'AAPL', providerSymbol: 'AAPL', lotSize: 1,
      usable: false, reason: 'No indicator history', candles: Array.from({ length: 20 }, () => ({ volume: 1000000 })), indicators: null });
    const market = { getSnapshot: async () => snapshot(), getSchedule: async () => tradingMarketSchedule('US', new Date()) };
    const fx = { convert: async (amount: number) => amount }; let modelCalls = 0;
    const model = { json: async () => { modelCalls++; throw new Error('No model is needed'); } };
    const documents = new ResearchDocumentsService(db), drafts = new UserInvestmentStrategyService(db, documents, model as never);
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, fx as never, documents, market as never), drafts);
    const opening = await policies.preview(owner, { origin: 'holdings', requestKey: 'report-runtime-preview' });
    await policies.start(owner, { previewId: opening.id, requestKey: 'report-runtime-create', confirmOpeningCash: true });
    const now = new Date(), text = 'AI proposal: Buy 2 AAPL at or below 100';
    const report = await documents.submit(owner, { idempotencyKey: 'report-runtime-source', title: 'Fictional report strategy', kind: 'portfolio',
      content: text, sections: [{ id: 'execution-strategy', title: 'AI proposed strategy', content: text }], availableAt: now.toISOString(), dataAsOf: now.toISOString(),
      snapshot: { evidence: [{ id: 'e1' }], executionPlan: { schemaVersion: 1, parameterOrigin: 'ai_proposed', evidenceIds: ['e1'], gaps: [], strategy: {
        title: 'Measured proposed order', body: text, timezone: 'Asia/Shanghai', startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 86400000).toISOString(),
        limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20, minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 5 },
        entries: [{ id: 'aapl-buy', text, sourceKeys: [], directive: { ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_lte', price: 100 }, quantity: 2,
          reviewedText: text, numericEvidence: [{ field: 'quantity', value: 2, quote: text }, { field: 'trigger.price', value: 100, quote: text }] } }],
      } } } });
    const draft = await drafts.importSource(owner, { kind: 'report', versionId: report.id, sectionId: 'execution-strategy' });
    assert.equal(draft.sources[0].executionPlan?.readiness, 'ready'); assert.equal(draft.preview?.directives[0].quantity, 2);
    assert.equal((await db.select().from(paperTrades)).length, 0, 'report import does not activate or execute the proposal');
    await policies.applyStrategy(owner, { strategyId: draft.id, expectedRevision: draft.revision, previewHash: draft.preview!.contentHash, expectedCurrentId: null, requestKey: 'report-runtime-apply' });
    const builder = new AgentBuilderService(db, {} as never);
    const paper = new PaperTradingService(db, { getQuote: async () => ({ ...quote, timestamp: Date.now(), symbol: 'AAPL' }) } as never, fx as never, {} as never,
      builder, new BuilderCadenceService(db), {} as never, market as never);
    const mandates = new StrategyMandateService(db, documents, builder, model as never, market as never);
    const discovery = { verify: async () => ({ ticker: 'AAPL', market: 'US', currency: 'USD', assetType: 'stock', identitySourceUrl: 'https://example.invalid/identity',
      sourceUrl: 'https://example.invalid/quote', observedAt: new Date().toISOString(), summary: 'Verified fixture', providerSymbol: 'AAPL', lotSize: 1, leveraged: false, inverse: false }) };
    const strategy = new StrategyService(db, builder, paper, {} as never, market as never, model as never, new StrategyStore(db), fx as never, mandates, undefined, undefined, discovery as never);
    await strategy.tick(owner); await strategy.tick(owner);
    const trades = await db.select().from(paperTrades), actions = (await policies.overview(owner)).actions;
    assert.equal(trades.length, 1); assert.equal(trades[0].quantity, '2');
    assert.equal(actions.length, 1); assert.equal(actions[0].status, 'filled'); assert.equal(actions[0].quantity, '2');
    assert.equal((await db.select().from(paperPositions))[0].shares, '3');
    assert.equal((await db.select().from(strategyProtections)).length, 0, 'no invented stop target');
    assert.equal(modelCalls, 0, 'report import, explicit application and concrete execution require no extraction or new-stock review');
  });
});
