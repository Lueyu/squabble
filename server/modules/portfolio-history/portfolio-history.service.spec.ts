import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioHistoryService } from './portfolio-history.service';
import type { PortfolioHistoryHoldings } from './portfolio-history.holdings';
import type { PortfolioHistoryCache } from './portfolio-history.cache';
import type { PortfolioIntradayReferenceService } from './portfolio-intraday-reference.service';
import type { HistoryObservedQuote } from './portfolio-intraday-reference.rules';

const positions = Array.from({ length: 13 }, (_, i) => ({ ticker: `FICT${i}`, market: 'US', currency: 'USD', shares: String(i + 1) }));
const prices = positions.slice(0, 12).map((position, i) => ({ symbol: position.ticker, market: 'US', currency: 'USD',
  priceDate: '2026-11-10', close: String(10 + i), source: 'fixture' }));
const quote = (i: number, quoteAt: string, price = 20 + i, source = 'fixture'): HistoryObservedQuote => ({
  ticker: positions[i].ticker, market: 'US', currency: 'USD', price, quoteAt, source,
});

function service(quotes: HistoryObservedQuote[], ownPositions = positions, ownPrices = prices) {
  return new PortfolioHistoryService(
    { read: async () => [{ accountId: 'real', name: 'Fixture', kind: 'real', positions: ownPositions, cash: [] }] } as unknown as PortfolioHistoryHoldings,
    { read: async () => ({ prices: ownPrices, fx: [], gaps: [], refreshing: false }), prefetch: async () => {} } as unknown as PortfolioHistoryCache,
    { read: async () => quotes } as unknown as PortfolioIntradayReferenceService,
  );
}

test('month daily 12 and earlier observed full 13 are revalued from facts for the latest fixed 11 cohort', async () => {
  const quotes = [...positions.map((_, i) => quote(i, '2026-11-12T14:30:00Z')),
    ...positions.slice(0, 11).map((_, i) => quote(i, '2026-11-12T15:30:00Z'))];
  const before = JSON.stringify({ positions, prices, quotes });
  const view = await service(quotes).read('fictional-owner', '1M', undefined, new Date('2026-11-12T15:31:00Z'));
  const reference = view.series[0], daily = reference.points.find(point => point.date === '2026-11-10')!;
  assert.equal(daily.knownValueUsd, positions.slice(0, 11).reduce((sum, row, i) => sum + Number(row.shares) * (10 + i), 0));
  assert.deepEqual(daily.priceAsOf.map(row => row.ticker), positions.slice(0, 11).map(row => row.ticker));
  assert.equal(reference.coverage.completePoints, 0);
  for (const point of reference.points.filter(row => row.coveredPositions)) {
    assert.equal(point.totalPositions, 13); assert.equal(point.coveredPositions, 11); assert.equal(point.valueUsd, null);
    assert.ok(point.gaps.includes('COHORT_EXCLUDED:FICT11')); assert.ok(point.gaps.includes('COHORT_EXCLUDED:FICT12'));
  }
  assert.equal(reference.points.find(row => row.timestamp === '2026-11-12T14:30:00.000Z')?.knownValueUsd,
    positions.slice(0, 11).reduce((sum, row, i) => sum + Number(row.shares) * (20 + i), 0));
  assert.equal(JSON.stringify({ positions, prices, quotes }), before, 'facts and current quantities remain immutable');
});

test('excluded daily-to-quote basis evidence keeps its original boundary even when cohort hourly sampling would omit it', async () => {
  const ownPositions = positions.slice(0, 2), ownPrices = prices.slice(0, 2).map((row, i) => ({ ...row, source: i ? 'fixture' : 'older-basis' }));
  const facts = [quote(0, '2026-11-12T15:00:00Z'), quote(1, '2026-11-12T15:00:00Z'),
    quote(1, '2026-11-12T15:10:00Z'), quote(1, '2026-11-12T15:46:00Z')];
  const view = await service(facts, ownPositions, ownPrices).read('fictional-owner', '1M', undefined, new Date('2026-11-12T15:47:00Z'));
  const boundary = view.series[0].points.find(point => point.timestamp === '2026-11-12T15:10:00.000Z');
  assert.ok(boundary?.gaps.includes('PRICE_BASIS_CHANGED:FICT0'));
  assert.equal(boundary?.knownValueUsd, 42); assert.equal(boundary?.valueUsd, null);
  assert.equal(boundary?.coveredPositions, 1); assert.equal(boundary?.totalPositions, 2);
  assert.deepEqual(boundary?.priceAsOf.map(row => row.ticker), ['FICT1']);
  assert.ok(boundary?.gaps.includes('COHORT_EXCLUDED:FICT0'));
});

test('a later zero-coverage observation remains unknown without removing the last trustworthy cohort or its risk boundary', async () => {
  const quotes = [...positions.slice(0, 11).map((_, i) => quote(i, '2026-11-12T14:30:00Z')),
    quote(0, '2026-11-12T14:35:00Z', 21, 'other-fixture'), quote(12, '2026-11-12T23:00:00Z')];
  const view = await service(quotes).read('fictional-owner', '1M', undefined, new Date('2026-11-12T23:01:00Z'));
  const reference = view.series[0], last = reference.points.at(-1)!;
  assert.equal(reference.points.find(row => row.date === '2026-11-10')?.coveredPositions, 11);
  assert.equal(last.timestamp, '2026-11-12T23:00:00.000Z'); assert.equal(last.coveredPositions, 0);
  assert.equal(last.knownValueUsd, 0); assert.equal(last.valueUsd, null);
  assert.ok(last.gaps.includes('PRICE_MISSING:FICT0'));
  assert.ok(reference.points.some(row => row.timestamp === '2026-11-12T14:35:00.000Z' && row.gaps.includes('PRICE_BASIS_CHANGED:FICT0')));
  assert.equal(reference.coverage.completePoints, 0);
});
