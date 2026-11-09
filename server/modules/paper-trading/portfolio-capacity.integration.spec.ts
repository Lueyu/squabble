import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
import { simulationMarketFixture } from './simulation-market.fixture';
import { tradingMarketSchedule } from './trading-market.calendar';
import { cashAccounts, holdings, paperOrders } from '../../database/schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import type { StrategyDraftInput } from '../../../shared/user-investment-strategy.interface';

const symbols = (count: number) => Array.from({ length: count }, (_, index) =>
  `QA${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`);

function content(tickers: string[], executableTicker?: string): StrategyDraftInput {
  return {
    title: 'Fictional capacity strategy', body: 'Explicit independent entries', timezone: 'Asia/Shanghai',
    startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(),
    limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20,
      minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 5 },
    entries: tickers.map(ticker => {
      const price = ticker === executableTicker ? 100 : 80;
      const text = `Buy 1 ${ticker} below ${price}`;
      return { id: ticker, ticker, text, sourceKeys: [], directive: {
        ticker, side: 'buy', quantity: 1, trigger: { kind: 'price_lte', price }, reviewedText: text,
        numericEvidence: [{ field: 'quantity', value: 1, quote: text }, { field: 'trigger.price', value: price, quote: text }],
      } };
    }),
  };
}

test('a fixed combination evaluates entries beyond the old twenty-security discussion limit', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-09T15:00:00Z') });
  await investmentFixture(async (db, _client, owner) => {
    const tickers = symbols(21);
    const lastTicker = tickers.at(-1)!;
    await db.insert(holdings).values(tickers.map(ticker => ({ owner, ticker, shares: '1', buyPrice: '80', market: 'US', currency: 'USD' })));
    await db.insert(cashAccounts).values({ owner, currency: 'USD', balance: '20000', reconciliationStatus: 'confirmed' });
    const market = {
      getSnapshot: async (ticker: string) => ({ ...simulationMarketFixture({ price: '99', market: 'US', currency: 'USD', timestamp: Date.now() }),
        ticker, providerSymbol: ticker, lotSize: 1, candles: Array.from({ length: 20 }, () => ({ volume: 1000000 })) }),
      getSchedule: async () => tradingMarketSchedule('US', new Date()),
    };
    const fx = { convert: async (amount: number) => amount };
    const model = { json: async () => { throw new Error('Fixed reviewed entries must not dispatch AI'); } };
    const documents = new ResearchDocumentsService(db);
    const drafts = new UserInvestmentStrategyService(db, documents, model as never);
    const simulations = new SimulationExperimentsService(db, {} as never, fx as never, documents, market as never);
    const policies = new InvestmentPolicyService(db, simulations, drafts);
    const workspace = new PortfolioWorkspaceService(db, policies, drafts);
    const seed = await policies.preview(owner, { origin: 'holdings', requestKey: randomUUID() });
    const account = await workspace.create(owner, { name: 'Twenty-one securities', previewId: seed.id,
      requestKey: randomUUID(), confirmOpeningCash: true });
    const allocations = [];
    for (const group of [tickers.slice(0, 20), tickers.slice(20)]) {
      const draft = await drafts.create(owner, content(group, lastTicker));
      const reviewed = await drafts.preview(owner, draft.id, draft.revision);
      assert.equal(reviewed.preview?.canConfirm, true);
      allocations.push({ strategyId: draft.id, strategyRevision: draft.revision, allocationPct: 50, enabled: true });
    }
    const preview = await workspace.preview(owner, account.accountId, { allocations, expectedPolicyRevision: 1, requestKey: randomUUID() });
    assert.equal(preview.canApply, true);
    await workspace.apply(owner, account.accountId, { allocations, expectedPolicyRevision: 1,
      previewHash: preview.previewHash, requestKey: randomUUID() });
    const builder = new AgentBuilderService(db, {} as never);
    const paper = new PaperTradingService(db, { getQuote: async (ticker: string) => ({ price: '99', market: 'US', currency: 'USD', timestamp: Date.now(), symbol: ticker }) } as never,
      fx as never, {} as never, builder, new BuilderCadenceService(db), {} as never, market as never);
    const mandates = new StrategyMandateService(db, documents, builder, model as never, market as never);
    const discovery = { verify: async ({ ticker }: { ticker: string }) => ({ ticker, market: 'US', currency: 'USD', assetType: 'stock',
      identitySourceUrl: 'https://example.invalid/security', sourceUrl: 'https://example.invalid/quote', observedAt: new Date().toISOString(),
      summary: 'Fictional verified security', providerSymbol: ticker, lotSize: 1, leveraged: false, inverse: false }) };
    const strategy = new StrategyService(db, builder, paper, {} as never, market as never, model as never,
      new StrategyStore(db), fx as never, mandates, undefined, undefined, discovery as never);
    const runtime = await strategy.tick(owner, account.accountId);
    const orders = await db.select().from(paperOrders).where(eq(paperOrders.accountId, account.accountId));
    assert.equal(orders.length, 1, JSON.stringify(runtime));
    assert.equal(orders[0].ticker, lastTicker, 'The twenty-first entry is retained and evaluated');
    assert.equal(orders[0].status, 'filled');
  });
});

test('preview rejects more than one hundred enabled securities and apply preserves the accepted boundary', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-09T15:00:00Z') });
  await investmentFixture(async (db, _client, owner) => {
    const documents = new ResearchDocumentsService(db);
    const drafts = new UserInvestmentStrategyService(db, documents, {} as never);
    const simulations = new SimulationExperimentsService(db, {} as never, {} as never);
    const policies = new InvestmentPolicyService(db, simulations, drafts);
    const workspace = new PortfolioWorkspaceService(db, policies, drafts);
    const seed = await policies.preview(owner, { origin: 'cash', cash: { currency: 'USD', amount: 100000 }, requestKey: randomUUID() });
    const account = await workspace.create(owner, { name: 'Capacity boundary', previewId: seed.id, requestKey: randomUUID() });
    const tickers = symbols(101);
    const allocations = [];
    for (let offset = 0; offset < tickers.length; offset += 20) {
      const draft = await drafts.create(owner, content(tickers.slice(offset, offset + 20)));
      await drafts.preview(owner, draft.id, draft.revision);
      allocations.push({ strategyId: draft.id, strategyRevision: draft.revision, allocationPct: 10, enabled: true });
    }
    const oversized = await workspace.preview(owner, account.accountId, { allocations, expectedPolicyRevision: 1, requestKey: randomUUID() });
    assert.equal(oversized.canApply, false, 'Preview must reject the same capacity that the execution profile cannot compile');
    assert.equal(oversized.issues[0]?.code, 'COMBINATION_SECURITY_CAPACITY_EXCEEDED');
    await assert.rejects(workspace.apply(owner, account.accountId, { allocations, expectedPolicyRevision: 1,
      previewHash: oversized.previewHash, requestKey: randomUUID() }), /COMBINATION_CONFLICT/);
    assert.equal((await workspace.detail(owner, account.accountId)).policyRevision, 1);
    const supported = allocations.map((allocation, index) => ({ ...allocation, enabled: index < 5 }));
    const accepted = await workspace.preview(owner, account.accountId, { allocations: supported, expectedPolicyRevision: 1, requestKey: randomUUID() });
    assert.equal(accepted.canApply, true, 'A disabled strategy does not consume executable security capacity');
    await workspace.apply(owner, account.accountId, { allocations: supported, expectedPolicyRevision: 1,
      previewHash: accepted.previewHash, requestKey: randomUUID() });
    const [mandate] = await db.select().from(strategyMandates).where(eq(strategyMandates.accountId, account.accountId));
    assert.equal(mandate.config.rules.length, 100, 'No enabled strategy entries are silently truncated');
    assert.deepEqual(new Set(mandate.config.rules.map(rule => rule.ticker)), new Set(tickers.slice(0, 100)));
  });
});
