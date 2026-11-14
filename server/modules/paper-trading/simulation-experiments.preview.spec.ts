import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { cashAccounts, fxRates, holdings } from '../../database/schema';
import { simulationPreviews } from '../../database/simulation-experiments.schema';
import type { SimulationSeed } from '../../../shared/simulation-experiment.interface';
import { seedRevision, type SeedSource } from './simulation-experiments.rules';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { simulationMarketFixture } from './simulation-market.fixture';

const NOW = new Date('2026-11-03T16:00:00Z');

test('real-holdings preview bounds parallel quotes, starts FX alongside them, and opens missing observations from recorded prices', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const source: SeedSource = {
    holdings: Array.from({ length: 13 }, (_, i) => ({ id: `holding-${i}`, ticker: `ASSET${i}`,
      market: i === 4 ? 'HK' : 'US', currency: 'USD', company: `Fixture ${i}`, shares: String(i + 1),
      buyPrice: String(50 + i), currentPrice: '9999', updatedAt: NOW })),
    cash: ['USD', 'HKD', 'CNY'].map((currency) => ({ currency, balance: '100', updatedAt: NOW,
      reconciliationStatus: 'confirmed' })),
  };
  let inserted: { owner: string; seed: SimulationSeed; expiresAt: Date } | undefined;
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: () => {
      if (table === holdings) return source.holdings;
      if (table === cashAccounts) return source.cash;
      assert.equal(table, fxRates);
      return { orderBy: () => ({ limit: async () => [{ rateDate: '2026-11-03' }] }) };
    } }) }),
    insert: (table: unknown) => {
      assert.equal(table, simulationPreviews);
      return { values: (value: typeof inserted) => {
        inserted = value;
        return { returning: async () => [{ id: 'offline-preview' }] };
      } };
    },
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let releaseFirst!: () => void;
  const firstQuote = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const quoteCalls: string[] = [];
  const fxCalls: string[] = [];
  let activeQuotes = 0;
  let peakQuotes = 0;
  const tradingMarket = { getSnapshot: async (ticker: string) => {
    quoteCalls.push(ticker);
    activeQuotes += 1;
    peakQuotes = Math.max(peakQuotes, activeQuotes);
    try {
      await gate;
      // Complete the first holding last, so order assertions also cover out-of-order providers.
      if (ticker === 'ASSET0') await firstQuote;
      if (ticker === 'QQQ') releaseFirst();
      if (ticker === 'ASSET1' || ticker === 'QQQ') return undefined;
      if (ticker === 'ASSET2') throw new Error('Fixture provider unavailable');
      const index = Number(ticker.slice(5));
      const quote = simulationMarketFixture({ price: ticker === 'SPY' ? '701' : String(100 + index),
        market: 'US', currency: ticker === 'ASSET3' ? 'HKD' : 'USD',
        timestamp: NOW.getTime() - (ticker === 'ASSET5' ? 360_000 : 60_000) });
      return { ...quote, ticker };
    } finally { activeQuotes -= 1; }
  } };
  const fx = { convert: async (amount: number, from: string, to: string) => {
    assert.equal(amount, 1);
    assert.equal(to, 'USD');
    fxCalls.push(from);
    await gate;
    if (from === 'CNY') throw new Error('Fixture FX unavailable');
    return 0.128;
  } };
  const service = new SimulationExperimentsService(db as never, {} as never, fx as never,
    undefined, tradingMarket as never);
  const pending = service.preview('fixture-owner');
  try {
    // Drain immediately ready work only; provider promises remain blocked on the same gate.
    await setImmediate();
    assert.equal(quoteCalls.length, 8, 'start a bounded batch while its provider calls are pending');
    assert.equal(activeQuotes, 8);
    assert.ok(fxCalls.includes('HKD'), 'FX starts before the blocked quote batch finishes');
    assert.equal(inserted, undefined, 'an incomplete snapshot cannot be persisted');
  } catch (error) {
    releaseFirst();
    throw error;
  } finally { release(); }
  const preview = await pending;

  assert.equal(peakQuotes, 8);
  assert.deepEqual(quoteCalls, [...source.holdings.map((holding) => holding.ticker), 'SPY', 'QQQ']);
  assert.deepEqual(fxCalls, ['HKD', 'CNY']);
  assert.equal(preview.id, 'offline-preview');
  assert.equal(inserted?.owner, 'fixture-owner');
  assert.deepEqual(inserted?.seed, preview.seed);
  assert.equal(preview.seed.sourceRevision, seedRevision(source));
  assert.deepEqual(preview.seed.positions.map((position) => position.sourceHoldingId), source.holdings.map((holding) => holding.id));
  assert.deepEqual(preview.seed.positions.map((position) => position.shares), source.holdings.map((holding) => holding.shares));
  for (let i = 0; i < source.holdings.length; i += 1) {
    const missing = i >= 1 && i <= 5;
    assert.equal(preview.seed.positions[i].initialPrice, missing ? '9999' : String(100 + i));
    assert.equal(preview.seed.positions[i].quoteAt, missing ? NOW.toISOString() : new Date(NOW.getTime() - 60_000).toISOString());
    assert.equal(preview.seed.gaps.includes(`QUOTE_STALE:ASSET${i}`), missing);
    assert.equal(preview.seed.gaps.includes(`QUOTE_MISSING:ASSET${i}`), false);
  }
  assert.equal(preview.seed.initialEquityUsd, null, 'missing CNY FX keeps the opening equity unknown even with recorded price fallback');
  assert.ok(preview.seed.gaps.includes('FX_MISSING:CNY'));
  assert.deepEqual(preview.seed.fx, [
    { currency: 'USD', rate: '1', at: NOW.toISOString() },
    { currency: 'HKD', rate: '0.128', at: '2026-11-03' },
  ]);
  assert.deepEqual(preview.seed.benchmarkOptions, [
    { ticker: 'SPY', currency: 'USD', initialPrice: '701', quoteAt: '2026-11-03T15:59:00.000Z' },
    { ticker: 'QQQ', currency: 'USD', initialPrice: null, quoteAt: null },
  ]);
});
