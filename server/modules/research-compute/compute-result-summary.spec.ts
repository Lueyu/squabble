import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeComputeResult } from './compute-result-summary';

test('saved statistics yield actual finite metrics and retain explicit coverage', () => {
  const result = summarizeComputeResult('statistics', 'returns-v1', { templateId: 'returns-v1', templateVersion: '1',
    frequency: 'daily', annualizationFactor: 252, annualRiskFreeRate: 0, observations: 4, missingPeriods: 1,
    coverage: 'partial', totalReturn: 0.12, sharpe: null, positivePeriodRatio: 0.5, maxDrawdown: -0.1 });
  assert.equal(result.metrics.totalReturn, 0.12); assert.equal(result.metrics.positivePeriodRatio, 0.5);
  assert.equal(result.coverage.status, 'partial'); assert.equal(result.coverage.missingPeriods, 1);
  assert.throws(() => summarizeComputeResult('statistics', 'returns-v1', { templateId: 'prices-to-returns-v1' }));
});

test('large hypothetical NAV and trades stay in the artifact while bounded metrics and full counts reach the model', () => {
  const result = summarizeComputeResult('backtest', 'fixed-shares-v1', {
    classification: 'hypothetical-validated-template-backtest', templateId: 'fixed-shares-v1', templateVersion: '1',
    engine: { name: 'Backtrader', version: '1.9.78.123', preload: false, runonce: false, cheatOnClose: false, cheatOnOpen: false },
    nav: Array.from({ length: 10000 }, () => ({ date: '2020-01-01', value: 1000, return: 0 })),
    trades: Array.from({ length: 10000 }, () => ({ date: '2020-01-01', quantity: 1, basePrice: 1, commission: 0 })),
    finalCash: 900, finalQuantity: 100, universeLabel: 'current-universe', outOfSampleFrom: '2020-01-01',
    coverage: { status: 'partial', missing: ['SURVIVORSHIP_COVERAGE_UNKNOWN'] },
    statistics: { templateId: 'returns-v1', templateVersion: '1', frequency: 'daily', annualizationFactor: 252,
      annualRiskFreeRate: 0, observations: 10000, missingPeriods: 0, coverage: 'complete', totalReturn: 0 },
  });
  assert.equal(result.rowCounts.navPoints, 10000); assert.equal(result.rowCounts.trades, 10000);
  assert.ok(JSON.stringify(result).length < 16000);
  assert.equal('nav' in result, false); assert.equal('trades' in result, false);
});

test('price evidence gaps force partial coverage after all limitations are merged', () => {
  const result = summarizeComputeResult('statistics', 'prices-to-returns-v1', {
    templateId: 'prices-to-returns-v1', templateVersion: '1', frequency: 'daily', annualizationFactor: 252,
    annualRiskFreeRate: 0, observations: 2, missingPeriods: 0, coverage: 'complete', totalReturn: 0.21,
    priceEvidence: { currency: null, unit: null, returnBasis: 'unadjusted-price-only', calendarVerified: true,
      endpointPriceChange: 0.21, limitations: ['PRICE_CURRENCY_UNKNOWN', 'PRICE_UNIT_UNKNOWN'] },
  });
  assert.equal(result.coverage.status, 'partial');
  assert.deepEqual(result.coverage.missing, ['PRICE_CURRENCY_UNKNOWN', 'PRICE_UNIT_UNKNOWN']);
  assert.equal(result.metrics.endpointPriceChange, 0.21);
});
