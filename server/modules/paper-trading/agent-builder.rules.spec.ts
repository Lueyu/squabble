import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BuilderConfig } from '../../../shared/api.interface';
import { normalizeCouncil, decideBuilderSignal, normalizeBuilderConfig, validateManualFill } from './agent-builder.rules';

const config: BuilderConfig = {
  name: 'My agent',
  template: 'balanced',
  tickers: [],
  minimumRating: 'Buy',
  customPrompt: '',
  maxOrderPct: 5,
  dailyLossLimitPct: 3,
  maxOrdersPerDay: 4,
  notifyOnProposal: true,
};

const signalContext = {
  ticker: 'AAPL',
  source: 'watchlist' as const,
  rating: 'Buy',
  heldShares: 0,
  price: 100,
  fxToUsd: 1,
  equityUsd: 1_000,
  cashUsd: 500,
  targetBuy: null,
  targetPrice: null,
  marketOpen: true,
  quoteFresh: true,
  tradedToday: false,
};

test('normalizes ticker allowlist and rejects unsafe order limits', () => {
  const normalized = normalizeBuilderConfig({
    ...config,
    tickers: [' aapl ', 'AAPL', 'nvda'],
  });
  assert.deepEqual(normalized.tickers, ['AAPL', 'NVDA']);
  assert.throws(() => normalizeBuilderConfig({ ...config, maxOrderPct: 101 }));
});

test('guard template never opens a new position', () => {
  assert.equal(decideBuilderSignal(configWith('guard'), signalContext), null);
});

test('buy size respects the configured order cap', () => {
  const signal = decideBuilderSignal(config, {
    ...signalContext,
    equityUsd: 10_000,
    cashUsd: 5_000,
  });
  assert.equal(signal?.side, 'buy');
  assert.equal(signal?.quantity, 5);
});

test('missing quote, closed market and outside allowlist never trade', () => {
  assert.equal(decideBuilderSignal(config, { ...signalContext, quoteFresh: false }), null);
  assert.equal(decideBuilderSignal(config, { ...signalContext, marketOpen: false }), null);
  assert.equal(decideBuilderSignal({ ...config, tickers: ['NVDA'] }, signalContext), null);
});

test('bearish rating can close an existing paper position', () => {
  const signal = decideBuilderSignal(configWith('guard'), {
    ...signalContext,
    source: 'holding',
    rating: 'Sell',
    heldShares: 7,
  });
  assert.equal(signal?.side, 'sell');
  assert.equal(signal?.quantity, 7);
});

test('manual fill rejects impossible prices, sizes and future timestamps', () => {
  const valid = {
    executedAt: '2026-10-30T09:00:00.000Z',
    quantity: 2,
    price: 101.5,
    fees: 1,
    notes: 'My broker fill',
  };
  assert.equal(validateManualFill(valid, new Date('2026-10-30T10:00:00.000Z')).price, 101.5);
  assert.throws(() => validateManualFill({ ...valid, price: 0 }, new Date('2026-10-30T10:00:00.000Z')));
  assert.throws(() => validateManualFill({ ...valid, quantity: -1 }, new Date('2026-10-30T10:00:00.000Z')));
  assert.throws(() => validateManualFill({ ...valid, executedAt: '2026-10-31T10:00:00.000Z' }, new Date('2026-10-30T10:00:00.000Z')));
});

test('investor price trigger works without AI rating but never above the buy price', () => {
  const rules = { ...config, priceRules: [{ ticker: 'AAPL', buyAtOrBelow: 95 }] };
  assert.equal(decideBuilderSignal(rules, { ...signalContext, rating: null, price: 100 }), null);
  const signal = decideBuilderSignal(rules, { ...signalContext, rating: null, price: 94, equityUsd: 10_000 });
  assert.equal(signal?.side, 'buy');
  assert.match(signal?.reason ?? '', /investor price rule/i);
});

test('configured buy price blocks a bullish AI rating above investor limit', () => {
  const rules = { ...config, priceRules: [{ ticker: 'AAPL', buyAtOrBelow: 95 }] };
  assert.equal(decideBuilderSignal(rules, { ...signalContext, rating: 'Strong Buy', price: 100 }), null);
});

test('explicit buy trigger does not fight a current bearish research rating', () => {
  const rules = { ...config, priceRules: [{ ticker: 'AAPL', buyAtOrBelow: 95 }] };
  assert.equal(decideBuilderSignal(rules, {
    ...signalContext,
    rating: 'Sell',
    price: 94,
    equityUsd: 10_000,
  }), null);
});

test('investor buy threshold takes precedence over an old watchlist target', () => {
  const rules = { ...config, priceRules: [{ ticker: 'AAPL', buyAtOrBelow: 95 }] };
  assert.equal(decideBuilderSignal(rules, {
    ...signalContext,
    rating: null,
    price: 94,
    equityUsd: 10_000,
    targetBuy: 80,
  })?.side, 'buy');
});

test('normalizes price rule ticker and rejects invalid thresholds', () => {
  const normalized = normalizeBuilderConfig({
    ...config,
    tickers: ['MSFT'],
    priceRules: [{ ticker: ' aapl ', buyAtOrBelow: 95 }],
  });
  assert.deepEqual(normalized.tickers, ['MSFT', 'AAPL']);
  assert.equal(normalized.priceRules?.[0].ticker, 'AAPL');
  assert.throws(() => normalizeBuilderConfig({
    ...config,
    priceRules: [{ ticker: 'AAPL', buyAtOrBelow: -1 }],
  }));
});

function configWith(template: BuilderConfig['template']): BuilderConfig {
  return { ...config, template };
}

test('an investor runtime can retain one real research source without fabricating another member', () => {
  const config = normalizeCouncil({ enabled: true, members: [{ id: 'only-real-source', name: 'Actual connected source', role: 'researcher', model: 'fast', instructions: '' }] });
  assert.equal(config.members.length, 1);
  assert.equal(config.members[0].id, 'only-real-source');
  assert.equal(config.members[0].role, 'manager');
});
