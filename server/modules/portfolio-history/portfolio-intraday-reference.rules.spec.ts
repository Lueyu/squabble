import test from 'node:test';
import assert from 'node:assert/strict';
import { intradayReferencePoints } from './portfolio-intraday-reference.rules';

const positions = [
  { ticker: 'FICT', market: 'US', currency: 'USD', shares: '2' },
  { ticker: 'UNAVAILABLE', market: 'US', currency: 'USD', shares: '1' },
];
const quote = (price: string, quoteAt: string, source = 'fictional:quote') => ({ ticker: 'FICT', market: 'US', currency: 'USD', price, quoteAt, source });
const from = '2026-11-10T00:00:00Z', to = '2026-11-10T20:00:00Z';

test('reference keeps genuine five-minute quote times and consistent known holdings without inventing complete NAV', () => {
  const rows = [quote('10', '2026-11-10T15:00:00Z'), quote('11', '2026-11-10T15:05:00Z')];
  const points = intradayReferencePoints(positions, [...rows, rows[1]], [], from, to, 'observations');
  assert.equal(points.length, 2, 'duplicate captures of the same market quote are not new observations');
  assert.deepEqual(points.map(point => point.knownValueUsd), [20, 22]);
  assert.ok(points.every(point => point.valueUsd === null && point.coveredPositions === 1 && point.totalPositions === 2));
  assert.equal(points[1].timestamp, '2026-11-10T15:05:00.000Z');
  assert.equal(points[1].priceAsOf[0].timestamp, '2026-11-10T15:05:00.000Z');
  assert.ok(points[1].gaps.includes('PRICE_MISSING:UNAVAILABLE'));
});

test('hourly reference chooses a real representative rather than synthesizing a midpoint', () => {
  const rows = [quote('10', '2026-11-10T15:01:00Z'), quote('11', '2026-11-10T15:04:00Z'),
    quote('13', '2026-11-10T15:06:00Z'), quote('14', '2026-11-10T16:00:00Z')];
  const points = intradayReferencePoints(positions.slice(0, 1), rows, [], from, to, 'hourly');
  assert.deepEqual(points.map(point => point.valueUsd), [26, 28]);
  assert.equal(points[0].timestamp, '2026-11-10T15:06:00.000Z');
});

test('future quotes, mismatched currencies and future FX never create a historical value', () => {
  const bad = [quote('10', '2026-11-11T15:00:00Z'), { ...quote('10', '2026-11-10T15:00:00Z'), currency: 'HKD' }];
  assert.equal(intradayReferencePoints(positions, bad, [], from, to, 'observations').length, 0);
  const hk = [{ ticker: '0700', market: 'HK', currency: 'HKD', shares: '1' }];
  const hkQuote = [{ ticker: '0700', market: 'HK', currency: 'HKD', price: '100', quoteAt: '2026-11-10T02:00:00Z', source: 'fictional:quote' }];
  const points = intradayReferencePoints(hk, hkQuote,
    [{ currency: 'HKD', rateDate: '2026-11-11', usdRate: '0.125', source: 'future' }], from, to, 'observations');
  assert.equal(points[0].valueUsd, null);
  assert.equal(points[0].coveredPositions, 0);
});

test('stale open-session quotes and changed provider conventions remain visible gaps', () => {
  const rows = [quote('10', '2026-11-10T15:00:00Z'), { ticker: 'UNAVAILABLE', market: 'US', currency: 'USD', price: '20', quoteAt: '2026-11-10T16:00:00Z', source: 'fictional:quote' }];
  const points = intradayReferencePoints(positions, rows, [], from, to, 'observations');
  assert.equal(points.at(-1)!.coveredPositions, 1, 'one-hour-old quote is not a current market observation');
  assert.ok(points.at(-1)!.gaps.includes('PRICE_MISSING:FICT'));
  const changed = intradayReferencePoints(positions.slice(0, 1),
    [quote('10', '2026-11-10T15:00:00Z'), quote('11', '2026-11-10T15:05:00Z', 'different:basis')], [], from, to, 'hourly');
  assert.ok(changed.some(point => point.gaps.includes('PRICE_BASIS_CHANGED:FICT')), 'aggregation preserves a convention boundary');
  assert.ok(changed.some(point => point.valueUsd === null));
});

test('an expired intraday quote cannot become complete again when another holding closes', () => {
  const other = { ticker: 'UNAVAILABLE', market: 'US', currency: 'USD', price: '20',
    quoteAt: '2026-11-10T16:00:00Z', source: 'fictional:quote' };
  const points = intradayReferencePoints(positions, [
    quote('10', '2026-11-10T15:00:00Z'), other,
    { ...other, price: '21', quoteAt: '2026-11-10T21:00:00Z' },
  ], [], from, '2026-11-10T22:00:00Z', 'observations');
  const close = points.at(-1)!;
  assert.equal(close.valueUsd, null);
  assert.ok(close.gaps.includes('PRICE_MISSING:FICT'));
  assert.ok(!close.priceAsOf.some(row => row.ticker === 'FICT'));
});

test('repeated captures of an identical quote cannot hide its price discontinuity', () => {
  const changed = quote('20', '2026-11-10T15:00:00Z');
  const points = intradayReferencePoints(positions.slice(0, 1), [
    quote('10', '2026-11-10T14:55:00Z'), changed, { ...changed },
  ], [], from, to, 'observations');
  assert.equal(points.at(-1)!.valueUsd, null);
  assert.ok(points.at(-1)!.gaps.includes('PRICE_DISCONTINUITY_UNVERIFIED:FICT'));
});

test('five-minute and hourly reduction retain both provider changes inside one slot', () => {
  const rows = [quote('10', '2026-11-10T14:55:00Z'),
    quote('10.5', '2026-11-10T15:01:00Z', 'different:basis'),
    quote('11', '2026-11-10T15:04:00Z')];
  for (const granularity of ['observations', 'hourly'] as const) {
    const points = intradayReferencePoints(positions.slice(0, 1), rows, [], from, to, granularity);
    assert.deepEqual(points.map(point => point.timestamp), [
      '2026-11-10T14:55:00.000Z', '2026-11-10T15:01:00.000Z', '2026-11-10T15:04:00.000Z',
    ]);
    assert.ok(points.slice(1).every(point => point.valueUsd === null
      && point.gaps.includes('PRICE_BASIS_CHANGED:FICT')));
  }
});

test('conflicting quotes at one timestamp remain unknown regardless of input order', () => {
  for (const conflicting of [quote('11', '2026-11-10T15:00:00Z'),
    quote('10', '2026-11-10T15:00:00Z', 'different:basis')]) {
    const rows = [quote('10', '2026-11-10T15:00:00Z'), conflicting];
    const forward = intradayReferencePoints(positions.slice(0, 1), rows, [], from, to, 'observations');
    const reverse = intradayReferencePoints(positions.slice(0, 1), [...rows].reverse(), [], from, to, 'observations');
    assert.deepEqual(forward, reverse);
    assert.equal(forward[0].valueUsd, null);
    assert.equal(forward[0].knownValueUsd, 0);
    assert.equal(forward[0].coveredPositions, 0);
    assert.ok(forward[0].gaps.some(gap => gap.startsWith('PRICE_BASIS_CHANGED:')
      || gap.startsWith('PRICE_DISCONTINUITY_UNVERIFIED:')));
  }
});

test('a verified last closing quote can support another market on the next day', () => {
  const points = intradayReferencePoints([
    positions[0], { ticker: '0700', market: 'HK', currency: 'HKD', shares: '1' },
  ], [quote('10', '2026-11-10T21:00:00Z'),
    { ticker: '0700', market: 'HK', currency: 'HKD', price: '100',
      quoteAt: '2026-11-11T02:00:00Z', source: 'fictional:quote' }],
  [{ currency: 'HKD', rateDate: '2026-11-10', usdRate: '0.125', source: 'fictional:fx' }],
  from, '2026-11-11T03:00:00Z', 'observations');
  const latest = points.at(-1)!;
  assert.equal(latest.valueUsd, 32.5);
  assert.ok(latest.gaps.includes('PRIOR_CLOSE:FICT'));
  assert.equal(latest.priceAsOf.find(row => row.ticker === 'FICT')!.timestamp, '2026-11-10T21:00:00.000Z');
});

test('a transient coverage loss inside one slot survives both reductions', () => {
  const other = { ticker: 'UNAVAILABLE', market: 'US', currency: 'USD', price: '20',
    quoteAt: '2026-11-10T14:30:00Z', source: 'fictional:quote' };
  const rows = [quote('10', '2026-11-10T14:30:00Z'), other,
    { ...other, quoteAt: '2026-11-10T15:16:00Z' }, quote('10', '2026-11-10T15:17:00Z')];
  for (const granularity of ['observations', 'hourly'] as const) {
    const points = intradayReferencePoints(positions, rows, [], from, to, granularity);
    const gap = points.find(point => point.timestamp === '2026-11-10T15:16:00.000Z');
    assert.ok(gap);
    assert.equal(gap.valueUsd, null);
    assert.ok(gap.gaps.includes('PRICE_MISSING:FICT'));
    assert.equal(points.at(-1)!.valueUsd, 40);
  }
});

test('intraday reference ignores same-day FX without a publication time and uses a prior dated rate', () => {
  const hkPositions = [{ ticker: '0700', market: 'HK', currency: 'HKD', shares: '1' }];
  const rows = [{ ticker: '0700', market: 'HK', currency: 'HKD', price: '100',
    quoteAt: '2026-11-10T02:00:00Z', source: 'fictional:quote' }];
  const today = { currency: 'HKD', rateDate: '2026-11-10', usdRate: '0.5', source: 'same-day-time-unknown' };
  const previous = { currency: 'HKD', rateDate: '2026-11-09', usdRate: '0.125', source: 'prior-dated-fx' };
  const known = intradayReferencePoints(hkPositions, rows, [today, previous], from, to, 'observations')[0];
  assert.equal(known.valueUsd, 12.5);
  assert.deepEqual(known.fxAsOf, [{ currency: 'HKD', date: '2026-11-09', source: 'prior-dated-fx' }]);
  assert.ok(known.gaps.includes('PRIOR_FX:HKD'));
  const unknown = intradayReferencePoints(hkPositions, rows, [today], from, to, 'observations')[0];
  assert.equal(unknown.valueUsd, null);
  assert.equal(unknown.coveredPositions, 0);
  assert.ok(unknown.gaps.includes('FX_MISSING:HKD'));
});

for (const quoteAt of ['2026-11-10T21:00:00Z', '2026-11-10T21:00:01Z']) {
  test(`a genuine US-only closing quote remains visible at its actual time ${quoteAt}`, () => {
    const points = intradayReferencePoints(positions.slice(0, 1), [quote('10', quoteAt)],
      [], from, '2026-11-10T22:00:00Z', 'observations');
    assert.equal(points[0].valueUsd, 20);
    assert.equal(points[0].timestamp, new Date(quoteAt).toISOString());
    assert.equal(points[0].priceAsOf[0].timestamp, new Date(quoteAt).toISOString());
  });
}
