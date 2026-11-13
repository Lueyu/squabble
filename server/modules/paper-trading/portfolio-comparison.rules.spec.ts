import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonObservations, comparisonPeriodStart } from './portfolio-comparison.rules';

const observation = (date: string, value: number | null, continuity = 'unchanged') => ({
  timestamp: `${date}T16:00:00.000Z`, date, equityUsd: value, continuity, gaps: value === null ? ['INCOMPLETE_VALUATION'] : [],
});

test('a late inception never receives fabricated earlier observations or a zero initial return', () => {
  const points = comparisonObservations([observation('2026-11-03', 100)], 'daily');
  assert.equal(points.length, 1);
  assert.equal(points[0].date, '2026-11-03');
  assert.equal(points[0].returnPct, null);
});

test('missing calendar observations break the line without changing the valid ending balance', () => {
  const points = comparisonObservations([observation('2026-11-03', 100), observation('2026-11-06', 110)], 'daily');
  assert.equal(points[1].equityUsd, null);
  assert.ok(points[1].gaps.includes('MISSING_OBSERVATION'));
  assert.equal(points.at(-1)?.equityUsd, 110);
});

test('cash-flow or baseline discontinuity invalidates return values, not equity', () => {
  const points = comparisonObservations([observation('2026-11-03', 100), observation('2026-11-04', 150, 'deposit'), observation('2026-11-05', 151, 'deposit')], 'daily');
  assert.equal(points[1].returnPct, null);
  assert.equal(points[2].returnPct, null);
  assert.equal(points[2].equityUsd, 151);
  assert.ok(points[2].gaps.includes('CASH_FLOW_OR_BASELINE_CHANGED'));
});

test('daily samples use the latest observation, including an incomplete latest observation', () => {
  const earlier = observation('2026-11-03', 100);
  const later = { ...observation('2026-11-03', null), timestamp: '2026-11-03T18:00:00.000Z' };
  assert.equal(comparisonObservations([later, earlier], 'daily').at(-1)?.equityUsd, null);
});

test('daily sampling preserves the first trusted observation and first-day return', () => {
  const opening = observation('2026-11-03', 100);
  const close = { ...observation('2026-11-03', 110), timestamp: '2026-11-03T18:00:00.000Z' };
  const points = comparisonObservations([opening, close, observation('2026-11-04', 121)], 'daily');
  assert.equal(points[0].timestamp, opening.timestamp);
  assert.ok(Math.abs(points.at(-1)!.returnPct! - 21) < 1e-8);
});

test('a hidden intraday cash-flow discontinuity is not erased by daily sampling', () => {
  const changed = { ...observation('2026-11-04', 105, 'changed'), timestamp: '2026-11-04T12:00:00.000Z' };
  const points = comparisonObservations([observation('2026-11-03', 100), changed, observation('2026-11-04', 110)], 'daily');
  assert.equal(points.at(-1)?.returnPct, null);
});

test('unchanged external-flow and baseline identity permits observed period return', () => {
  const points = comparisonObservations([observation('2026-11-03', 100), observation('2026-11-04', 110)], 'daily');
  assert.equal(points[0].returnPct, 0);
  assert.ok(Math.abs(points[1].returnPct! - 10) < 1e-8);
});

test('an estimated observation followed by the first trusted observation cannot establish a return', () => {
  const estimated = { ...observation('2026-11-03', 100), continuity: null };
  const points = comparisonObservations([estimated, observation('2026-11-04', 110)], 'daily');
  assert.equal(points[1].returnPct, null);
});

test('period boundaries use UTC and do not overflow short months', () => {
  assert.equal(comparisonPeriodStart('1M', new Date('2026-03-31T12:00:00Z')).toISOString(), '2026-03-01T12:00:00.000Z');
  assert.equal(comparisonPeriodStart('YTD', new Date('2026-11-09T12:00:00Z')).toISOString(), '2026-01-01T00:00:00.000Z');
});

test('hourly projection keeps origin, unknown facts and the exact discontinuity instead of hiding them', () => {
  const start=observation('2026-11-03',100);
  const bad={...start,timestamp:'2026-11-03T16:10:00Z',equityUsd:null,gaps:['INCOMPLETE_VALUATION']};
  const changed={...start,timestamp:'2026-11-03T16:20:00Z',equityUsd:130,continuity:'changed'};
  const close={...start,timestamp:'2026-11-03T16:55:00Z',equityUsd:140};
  const middle={...start,timestamp:'2026-11-03T16:05:00Z',equityUsd:101};
  const points=comparisonObservations([start,middle,bad,changed,close],'hourly');
  assert.ok(!points.some(p=>p.timestamp===middle.timestamp),'an ordinary intermediate same-hour observation is reduced');
  assert.ok(points.some(p=>p.timestamp===start.timestamp));
  assert.ok(points.some(p=>p.timestamp===bad.timestamp&&p.equityUsd===null));
  assert.ok(points.some(p=>p.timestamp===changed.timestamp&&p.gaps.includes('CASH_FLOW_OR_BASELINE_CHANGED')));
  assert.equal(points.at(-1)?.returnPct,null);
});
