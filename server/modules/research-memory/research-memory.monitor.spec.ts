import assert from 'node:assert/strict';
import { test } from 'node:test';
import { thesisCandidateSchema } from './research-memory.requests';
import { evaluateMonitor } from './research-memory.monitor.rules';
import type { MonitorCondition } from '@shared/research-monitor.interface';
import type { TradingMarketSnapshot } from '@shared/trading-market.interface';

export const condition = { conditionIndex: 0, metric: 'price', unit: 'USD', operator: 'lt', threshold: 90,
  validFrom: '2026-11-03T00:00:00Z', validUntil: '2026-11-04T00:00:00Z', evidenceIds: ['quote'], rationale: 'Price support breaks' };
test('reviewed candidates accept explicit machine conditions and reject unsupported authority, metrics, units and times', () => {
  const base = { claim: 'Support should hold', supportingEvidence: [{ evidenceId: 'quote' }], opposingEvidence: [], assumptions: [],
    indicators: [], invalidationConditions: ['Below USD 90'], monitorConditions: [condition] };
  assert.equal(thesisCandidateSchema.safeParse(base).success, true);
  for (const override of [{ metric: 'revenue' }, { unit: 'HKD', metric: 'rsi14' }, { threshold: -1 },
    { validUntil: '2026-01-01T00:00:00Z' }, { code: 'return price < 90' }, { origin: 'user' }, { conditionIndex: 1 }]) {
    assert.equal(thesisCandidateSchema.safeParse({ ...base, monitorConditions: [{ ...condition, ...override }] }).success, false);
  }
  assert.equal(thesisCandidateSchema.safeParse({ ...base, monitorConditions: undefined }).success, true);
});

test('same provider observation becoming stale is unknown with a distinct stable event key; HK aliases and units are exact', () => {
  const now = new Date('2026-11-03T02:00:00Z');
  const rule: MonitorCondition = { ...condition, metric: 'price', operator: 'lt', unit: 'HKD' };
  const snapshot: TradingMarketSnapshot = { ticker: '0700.HK', providerSymbol: '0700.HK', market: 'HK', currency: 'HKD',
    quoteUsable: true, quoteReason: null, usable: true, reason: null, price: 100, quoteTimestamp: now.toISOString(),
    fetchedAt: now.toISOString(), source: 'yahoo-chart', sourceUrl: 'https://example.test/price', maxQuoteAgeSeconds: 1200,
    delay: 'possibly-delayed', timeframe: '1d', candles: [], indicators: null, schedule: null };
  const fresh = evaluateMonitor(rule, '00700.HK', snapshot, now);
  const stale = evaluateMonitor(rule, '00700.HK', snapshot, new Date(now.getTime() + 1201000));
  assert.equal(fresh.state, 'clear'); assert.equal(stale.state, 'unknown');
  assert.notEqual(stale.observationKey, fresh.observationKey);
  assert.equal(stale.observationKey, evaluateMonitor(rule, '00700.HK', snapshot, new Date(now.getTime() + 1202000)).observationKey);
  assert.equal(evaluateMonitor(rule, '00700.HK', { ...snapshot, currency: 'USD' }, now).state, 'unknown');
  assert.equal(evaluateMonitor(rule, 'AAPL', snapshot, now).state, 'unknown');
  assert.equal(evaluateMonitor({ ...rule, validFrom: '2026-11-03T03:00:00Z' }, '00700.HK', snapshot, now).state, 'unknown');
  assert.equal(evaluateMonitor({ ...rule, metric: 'sma20' }, '00700.HK', snapshot, now).state, 'unknown');
});

test('indicator snapshots with stale completed history cannot claim clear even with usable=true', () => {
  const now = new Date('2026-11-03T15:00:00Z');
  const rule: MonitorCondition = { ...condition, metric: 'rsi14', unit: 'points', operator: 'lt', threshold: 20 };
  const snapshot = { ticker: 'AAPL', market: 'US', currency: 'USD', quoteUsable: true, usable: true,
    source: 'yahoo-chart', sourceUrl: 'https://example.test/price', quoteTimestamp: now.toISOString(), maxQuoteAgeSeconds: 1200,
    indicators: { rsi14: 40, asOf: '2026-10-01T20:00:00Z', timeframe: '1d', sampleSize: 60 } } as TradingMarketSnapshot;
  assert.equal(evaluateMonitor(rule, 'AAPL', snapshot, now).state, 'unknown');
});
