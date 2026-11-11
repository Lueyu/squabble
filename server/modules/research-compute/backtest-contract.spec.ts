import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parseBacktestParameters } from './backtest-contract';

const input = () => ({ templateId: 'fixed-shares-v1', instrumentId: 'DEMO', quantity: 10, initialCash: 1000,
  baseCurrency: 'USD', from: '2020-01-02', to: '2020-01-08', signalDate: '2020-01-02',
  signalAvailableAt: '2020-01-02T21:00:00Z', universeVersionId: randomUUID(),
  priceDatasetVersionId: randomUUID(), calendarVersionId: randomUUID(), marketRulesVersionId: randomUUID(),
  corporateActionsVersionId: randomUUID(), fxVersionId: randomUUID(),
  benchmark: { datasetVersionId: randomUUID(), returnColumn: 'return' },
  cashFlowDatasetVersionId: null,
  outOfSampleFrom: '2020-01-08', frequency: 'daily', annualizationFactor: 252, riskFreeRate: 0 });

test('validated request references complete frozen datasets instead of model-provided market arrays', () => {
  const value = input();
  assert.equal(parseBacktestParameters(value).templateId, 'fixed-shares-v1');
  assert.throws(() => parseBacktestParameters({ ...value, calendar: { sessions: ['2026-01-01'] } }));
  assert.throws(() => parseBacktestParameters({ ...value, marketRules: { settlementSessions: 0 } }));
  assert.throws(() => parseBacktestParameters({ ...value, code: 'buy(future_price)' }));
});

test('missing calendar/corporate action/benchmark/FX versions fail before sandbox creation', () => {
  for (const key of ['calendarVersionId', 'corporateActionsVersionId', 'fxVersionId', 'benchmark']) {
    const value = { ...input() }; delete value[key];
    assert.throws(() => parseBacktestParameters(value));
  }
});

test('free code, invalid chronology and unstated annualization cannot be labeled validated', () => {
  assert.throws(() => parseBacktestParameters({ ...input(), templateId: 'python' }));
  assert.throws(() => parseBacktestParameters({ ...input(), from: '2025-01-01' }));
  assert.throws(() => parseBacktestParameters({ ...input(), annualizationFactor: undefined }));
});
