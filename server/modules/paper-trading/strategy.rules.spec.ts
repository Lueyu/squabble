import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAutomation, validateStrategyRules, strategyTriggerMatches } from './strategy.rules';

const rule = { id: 'entry', ticker: 'AAPL', side: 'buy', trigger: { kind: 'rsi14_below', value: 35 },
  referencePrice: 100, minPrice: 95, maxPrice: 105, maxPositionPct: 5, stopLossPrice: 90,
  expiresAt: '2026-11-03T21:00:00.000Z', evidenceIds: ['e1'], rationale: 'Oversold with evidence' };
test('automation is opt-in with bounded cadence', () => {
  assert.equal(normalizeAutomation(undefined).enabled, false);
  assert.throws(() => normalizeAutomation({ enabled: true, monitorSeconds: 1 } as never));
});
test('plans reject invented evidence, symbols, invalid stops and oversized exposure', () => {
  const context = { tickers: ['AAPL'], evidenceIds: ['e1'], expiresAt: new Date(rule.expiresAt), now: new Date('2026-11-03T13:00:00Z'), maxPositionPct: 5 };
  assert.equal(validateStrategyRules([rule], context).length, 1);
  for (const change of [{ ticker: 'MSFT' }, { evidenceIds: ['fake'] }, { stopLossPrice: 102 },
    { maxPositionPct: 6 }, { maxPrice: 0 }, { expiresAt: '2027-01-01' }]) {
    assert.throws(() => validateStrategyRules([{ ...rule, ...change }], context));
  }
});
test('indicator triggers use measured values and price bounds', () => {
  const normalized = validateStrategyRules([rule], { tickers: ['AAPL'], evidenceIds: ['e1'],
    expiresAt: new Date(rule.expiresAt), now: new Date('2026-11-03T13:00:00Z'), maxPositionPct: 5 })[0];
  assert.equal(strategyTriggerMatches(normalized, 100, { rsi14: 30 }), true);
  assert.equal(strategyTriggerMatches(normalized, 100, { rsi14: 60 }), false);
  assert.equal(strategyTriggerMatches(normalized, 100, null), false);
  assert.equal(strategyTriggerMatches(normalized, 110, { rsi14: 30 }), false);
});
test('evidence must belong to the same researched ticker', () => {
  assert.throws(() => validateStrategyRules([rule], { tickers: ['AAPL', 'MSFT'], evidenceIds: ['e1', 'msft-evidence'],
    evidenceIdsByTicker: { AAPL: ['other-apple-evidence'], MSFT: ['e1', 'msft-evidence'] },
    expiresAt: new Date(rule.expiresAt), now: new Date('2026-11-03T13:00:00Z'), maxPositionPct: 5 }), /verified report evidence/u);
});
