import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historySymbol, referencePoints, currentMark } from './portfolio-history.rules';

test('reference uses fixed quantities and only dated prior observations, never future FX or current saved prices', () => {
  const positions = [{ ticker: '0700', market: 'HK', currency: 'HKD', shares: '2', currentPrice: '999' }];
  const prices = [{ symbol: '0700.HK', market: 'HK', currency: 'HKD', priceDate: '2026-11-06', close: '78', source: 'fixture' }];
  const future = [{ currency: 'HKD', rateDate: '2026-11-10', usdRate: '0.1', source: 'fixture' }];
  const missing = referencePoints(positions, prices, future, '2026-11-06', '2026-11-08');
  assert.equal(missing[0].valueUsd, null);
  assert.ok(missing[0].gaps.includes('FX_MISSING:HKD'));
  const points = referencePoints(positions, prices, [{ ...future[0], rateDate: '2026-11-06', usdRate: String(1 / 7.8) }], '2026-11-06', '2026-11-08');
  assert.equal(points[0].valueUsd, 20);
  assert.equal(points[2].valueUsd, 20);
  assert.equal(points[2].priceAsOf[0].date, '2026-11-06');
  assert.ok(points[2].gaps.includes('PRIOR_CLOSE:0700'));
  assert.equal(referencePoints(positions, prices, future, '2026-11-20', '2026-11-20')[0].valueUsd, null);
});

test('current mark shows holdings when cash is unknown, without changing NAV or claiming current quote time', () => {
  const positions = [{ ticker: 'FICT', market: 'US', currency: 'USD', shares: '2', currentPrice: '30' }];
  const result = currentMark(positions, [{ currency: 'USD', balance: '999', known: false }], [], [], new Date('2026-11-10T08:00:00Z'));
  assert.equal(result.valueUsd, 60); assert.equal(result.basis, 'holdings_market_value');
  assert.equal(result.cashValueUsd, null); assert.equal(result.complete, false); assert.equal(result.asOf, null);
  const partial = currentMark([...positions, { ...positions[0], ticker: 'MISSING', currentPrice: null }], [{ currency: 'USD', balance: '10', known: true }], [], [], new Date('2026-11-10T08:00:00Z'));
  assert.equal(partial.valueUsd, 70); assert.equal(partial.basis, 'known_assets'); assert.equal(partial.coveredPositions, 1);
  const legacy = currentMark([{ ticker: '0700', market: 'HK', currency: 'HKD', shares: '2', currentPrice: '80' }],
    [{ currency: 'USD', balance: '100', known: true }], [], [{ currency: 'HKD', rateDate: '2026-11-09', usdRate: '0.125', source: 'fixture' }], new Date('2026-11-10T08:00:00Z'), true);
  assert.equal(legacy.valueUsd, 120); assert.equal(legacy.basis, 'total_assets');
  const refreshed = currentMark(positions, [{ currency: 'USD', balance: '999', known: false }],
    [{ symbol: 'FICT', market: 'US', currency: 'USD', priceDate: '2026-11-09', close: '25', source: 'fixture' }], [], new Date('2026-11-10T08:00:00Z'));
  assert.equal(refreshed.valueUsd, 50); assert.equal(refreshed.asOf, '2026-11-09'); assert.equal(refreshed.pricing, 'cached_close');
});

test('large unverified price changes and provider adjustment changes break the reference line without altering prices', () => {
  const positions = [{ ticker: 'FICT', market: 'US', currency: 'USD', shares: '2' }];
  const prices = [
    { symbol: 'FICT', market: 'US', currency: 'USD', priceDate: '2026-11-06', close: '100', source: 'tencent:unadjusted-close' },
    { symbol: 'FICT', market: 'US', currency: 'USD', priceDate: '2026-11-09', close: '50', source: 'tencent:unadjusted-close' },
    { symbol: 'FICT', market: 'US', currency: 'USD', priceDate: '2026-11-10', close: '51', source: 'yahoo:split-adjusted-close' },
  ];
  const points = referencePoints(positions, prices, [], '2026-11-06', '2026-11-10');
  assert.equal(points[3].valueUsd, null); assert.equal(points[3].knownValueUsd, 100);
  assert.ok(points[3].gaps.includes('PRICE_DISCONTINUITY_UNVERIFIED:FICT'));
  assert.equal(points[4].valueUsd, null); assert.ok(points[4].gaps.includes('PRICE_BASIS_CHANGED:FICT'));
  assert.equal(prices[1].close, '50');
});

test('US/HK/CN identities are canonical, and cash-only accounts do not get a fictional holdings curve', () => {
  assert.equal(historySymbol('BRK.B', 'US')?.symbol, 'BRK-B');
  assert.equal(historySymbol('700', 'HK')?.symbol, '0700.HK');
  assert.equal(historySymbol('00700.HK', 'HK')?.symbol, '0700.HK');
  assert.equal(historySymbol('600519.SH', 'CN')?.symbol, '600519.SS');
  assert.equal(historySymbol('000001', 'CN')?.symbol, '000001.SZ');
  assert.equal(historySymbol('../secret', 'US'), null);
  assert.equal(referencePoints([], [], [], '2026-11-09', '2026-11-10')[0].valueUsd, null);
});
