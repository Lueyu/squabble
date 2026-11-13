import test from 'node:test';
import assert from 'node:assert/strict';
import type { PortfolioHistoryPoint } from '../../../shared/portfolio-history.interface';
import { combineReferencePoints } from './portfolio-history-merge';

const point = (date: string, valueUsd: number | null, source?: string): PortfolioHistoryPoint => ({ date, valueUsd,
  knownValueUsd: valueUsd ?? 0, coveredPositions: source ? 1 : 0, totalPositions: 1,
  priceAsOf: source ? [{ ticker: 'FICT', date, source }] : [], fxAsOf: [], gaps: source ? [] : ['PRICE_MISSING:FICT'] });

test('daily fallback keeps an explicit unknown interval between real source dates', () => {
  const daily = [point('2026-11-07', null), point('2026-11-08', 20, 'tencent:unadjusted-close'), point('2026-11-09', null)];
  const quote = { ...point('2026-11-10', 24, 'tencent'), timestamp: '2026-11-10T15:00:00Z' };
  const combined = combineReferencePoints(daily, [quote]);
  assert.deepEqual(combined.map(row => row.valueUsd), [20, null, 24]);
  assert.ok(combined[1].gaps.includes('PRICE_MISSING:FICT'));
});

test('unverified close/quote conventions keep a boundary without changing original facts', () => {
  const daily = [point('2026-11-09', 20, 'yahoo:split-adjusted-close')];
  const quote = { ...point('2026-11-10', 24, 'yahoo'), timestamp: '2026-11-10T15:00:00Z' };
  const combined = combineReferencePoints(daily, [quote]);
  assert.equal(combined[1].valueUsd, null);
  assert.ok(combined[1].gaps.includes('PRICE_BASIS_CHANGED:FICT'));
  assert.equal(combined[1].knownValueUsd, 24);
  assert.equal(quote.valueUsd, 24, 'retained observation is not rewritten');
});
