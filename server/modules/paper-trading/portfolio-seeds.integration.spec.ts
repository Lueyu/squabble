import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fxRates, paperAccounts, paperPositions, paperTrades } from '../../database/schema';
import { simulationCash, simulationSeeds } from '../../database/simulation-experiments.schema';
import { InvestmentPolicyService } from './investment-policy.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { investmentFixture } from './investment-test.fixture';
import { simulationMarketFixture } from './simulation-market.fixture';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';

test('copy and custom seeds freeze current mixed-currency balances without changing the source or fabricating trades', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-03T16:00:00Z') });
  await investmentFixture(async (db, _sql, owner) => {
    await db.insert(fxRates).values({ base: 'HKD', quote: 'USD', rate: '0.125', rateDate: new Date().toISOString().slice(0, 10) });
    const market = { getSnapshot: async (ticker: string) => {
      const resolved = resolveTradingTicker(ticker)!;
      const quote = simulationMarketFixture({ price: resolved.market === 'US' ? '100' : '200', market: resolved.market,
        currency: resolved.currency, timestamp: resolved.market === 'HK' ? Date.parse('2026-11-03T08:00:00Z') : Date.now() });
      return { ...quote, ticker, quoteReason: resolved.market === 'HK' ? 'market_closed' : quote.quoteReason };
    } };
    const simulations = new SimulationExperimentsService(db, {} as never, { convert: async () => 0.125 } as never, undefined, market as never);
    const policies = new InvestmentPolicyService(db, simulations);
    const [source] = await db.insert(paperAccounts).values({ owner, name: 'Source fixture', ledgerMode: 'native_currency' }).returning();
    await db.insert(paperPositions).values([
      { owner, accountId: source.id, ticker: 'AAPL', shares: '10', avgCost: '80', market: 'US', currency: 'USD' },
      { owner, accountId: source.id, ticker: '0700.HK', shares: '100', avgCost: '150', market: 'HK', currency: 'HKD' },
    ]);
    await db.insert(simulationCash).values([
      { owner, accountId: source.id, currency: 'USD', available: '1000', frozen: '100', unsettled: '0', availabilityKnown: true },
      { owner, accountId: source.id, currency: 'HKD', available: '8000', frozen: '0', unsettled: '0', availabilityKnown: true },
    ]);
    await assert.rejects(policies.preview(randomUUID(), { origin: 'account', sourceAccountId: source.id, requestKey: randomUUID() }), /ACCOUNT_NOT_FOUND/);
    const copyRequest = { origin: 'account', sourceAccountId: source.id, requestKey: randomUUID() };
    const preview = await policies.preview(owner, copyRequest);
    assert.deepEqual(await policies.preview(owner, copyRequest), preview);
    await assert.rejects(policies.preview(owner, { ...copyRequest, sourceAccountId: randomUUID() }), /REQUEST_KEY_CONFLICT/);
    assert.equal(Number(preview.seed.initialEquityUsd), 5600);
    await db.update(paperPositions).set({ shares: '999' }).where(eq(paperPositions.accountId, source.id));
    const create = { name: 'Frozen copy fixture', previewId: preview.id, requestKey: randomUUID() };
    const created = await policies.createAccount(owner, create);
    assert.equal((await policies.createAccount(owner, create)).accountId, created.accountId);
    await assert.rejects(policies.createAccount(owner, { ...create, name: 'Different name' }), /REQUEST_KEY_CONFLICT/);
    assert.deepEqual(Object.fromEntries((await db.select().from(paperPositions).where(eq(paperPositions.accountId, created.accountId)))
      .map(item => [item.ticker, item.shares])), { AAPL: '10', '0700.HK': '100' });
    assert.equal((await db.select().from(paperAccounts).where(eq(paperAccounts.id, source.id)))[0].botEnabled, source.botEnabled);
    assert.equal((await db.select().from(paperTrades)).length, 0, 'opening positions are not fabricated historical fills');
    const custom = await policies.preview(owner, { origin: 'custom', requestKey: randomUUID(),
      holdings: [{ ticker: '700.HK', shares: 10, historicalCost: 99 }], cash: [{ currency: 'USD', amount: 1000 }] });
    assert.equal(custom.seed.positions[0].ticker, '0700.HK');
    assert.equal(custom.seed.positions[0].historicalCost, '99');
    assert.equal(custom.seed.positions[0].initialPrice, '200', 'current market price, not original cost, sets the new baseline');
    assert.equal(Number(custom.seed.initialEquityUsd), 1250);
    const own = await policies.createAccount(owner, { name: 'Custom fixture', previewId: custom.id, requestKey: randomUUID() });
    assert.equal((await simulations.get(owner, own.accountId)).sourceChanged, null, 'custom holdings are not compared to the real portfolio');
    const [saved] = await db.select().from(simulationSeeds).where(eq(simulationSeeds.accountId, created.accountId));
    assert.equal(saved.seed.positions.find(position => position.ticker === 'AAPL')?.shares, '10');
    await assert.rejects(policies.createAccount(randomUUID(), { name: 'Forbidden', previewId: custom.id, requestKey: randomUUID() }), /Preview not found/);
  });
});

test('copied unknown cash and custom missing prices remain unknown, with no cost-price fallback or invented FX', async () => {
  await investmentFixture(async (db, _sql, owner) => {
    const simulations = new SimulationExperimentsService(db, {} as never, { convert: async () => { throw new Error('offline'); } } as never);
    const policies = new InvestmentPolicyService(db, simulations);
    const [source] = await db.insert(paperAccounts).values({ owner, name: 'Unconfirmed cash fixture', ledgerMode: 'native_currency' }).returning();
    await db.insert(simulationCash).values({ owner, accountId: source.id, currency: 'USD', available: '0', frozen: '1000', unsettled: '0', availabilityKnown: false });
    const copy = await policies.preview(owner, { origin: 'account', sourceAccountId: source.id, requestKey: randomUUID() });
    assert.equal(copy.seed.cash[0].total, '1000');
    assert.equal(copy.seed.cash[0].availabilityKnown, false);
    const copied = await policies.createAccount(owner, { name: 'Unconfirmed copy', previewId: copy.id, requestKey: randomUUID() });
    const [copySeed] = await db.select().from(simulationSeeds).where(eq(simulationSeeds.accountId, copied.accountId));
    assert.equal(copySeed.seed.initialEquityUsd, null);
    assert.equal(copySeed.seed.cash[0].available, '0');
    const custom = await policies.preview(owner, { origin: 'custom', requestKey: randomUUID(), holdings: [{ ticker: '0700.HK', shares: 10, historicalCost: 42 }], cash: [{ currency: 'USD', amount: 0 }] });
    assert.equal(custom.seed.positions[0].initialPrice, null);
    assert.equal(custom.seed.initialEquityUsd, null);
    assert.ok(custom.seed.gaps.includes('QUOTE_MISSING:0700.HK'));
    assert.ok(custom.seed.gaps.includes('FX_MISSING:HKD'));
    const pending = await policies.createAccount(owner, { name: 'Awaiting quotes', previewId: custom.id, requestKey: randomUUID() });
    const [pendingSeed] = await db.select().from(simulationSeeds).where(eq(simulationSeeds.accountId, pending.accountId));
    assert.equal(pendingSeed.seed.initialEquityUsd, null);
    assert.equal(pendingSeed.seed.positions[0].historicalCost, '42');
    assert.equal(pendingSeed.seed.positions[0].initialPrice, null);
    assert.equal((await db.select().from(paperTrades)).length, 0);
  });
});
