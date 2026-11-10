import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frankfurterDailyFx, yahooDailyCloses, tencentDailyCloses, tencentResponseSymbol } from './portfolio-history.provider';

test('historical provider parsers require dated correct-currency observations and never use dividend-adjusted or intraday values', () => {
  const at = new Date('2026-11-10T08:00:00Z');
  const data = { chart: { result: [{ meta: { currency: 'HKD', symbol: '0700.HK' }, timestamp: [Date.parse('2026-11-09T01:30:00Z') / 1000, Date.parse('2026-11-10T01:30:00Z') / 1000],
    indicators: { quote: [{ close: [100, 999] }], adjclose: [{ adjclose: [88, 999] }] } }] } };
  const rows = yahooDailyCloses(data, '0700', 'HK', '2026-11-01', '2026-11-30', at);
  assert.equal(rows.length, 1); assert.equal(rows[0].close, '100'); assert.equal(rows[0].priceDate, '2026-11-09');
  assert.throws(() => yahooDailyCloses(data, 'FICT', 'US', '2026-11-01', '2026-11-30', at), /INVALID/);
  assert.throws(() => yahooDailyCloses(data, '0005', 'HK', '2026-11-01', '2026-11-30', at), /INVALID/);
  const fx = frankfurterDailyFx({ base: 'USD', rates: { '2026-11-06': { HKD: 8, CNY: 7 }, '2026-11-11': { HKD: 1 }, 'bad': { HKD: 2 } } }, '2026-11-01', '2026-11-30', at);
  assert.equal(fx.length, 2); assert.equal(fx[0].usdRate, '0.125'); assert.equal(fx[0].rateDate, '2026-11-06');
  assert.throws(() => frankfurterDailyFx({ base: 'HKD', rates: {} }, '2026-11-01', '2026-11-30', at), /INVALID/);
});

test('Tencent day validates the exact quote identity and close column, ignores qfq and unfinished bars', () => {
  const at = new Date('2026-11-10T08:00:00Z');
  const data = { code: 0, data: { usFICT: { qt: { usFICT: ['200', 'Fictional', 'FICT.OQ'] }, day: [['2026-11-09', '19', '20', '22', '18']] } } };
  assert.equal(tencentResponseSymbol(data, 'usFICT', 'FICT', 'US'), 'usFICT.OQ');
  const exact = { code: 0, data: { 'usFICT.OQ': { qt: { 'usFICT.OQ': ['200', 'Fictional', 'FICT.OQ'] },
    day: [['2026-11-09', '19', '20', '22', '18'], ['2026-11-10', '999', '999', '999', '999']],
    qfqday: [['2026-11-09', '10', '10', '10', '10']] } } };
  const values = tencentDailyCloses(exact, 'usFICT.OQ', 'FICT', 'US', '2026-11-01', '2026-11-30', at);
  assert.equal(values.length, 1); assert.equal(values[0].close, '20'); assert.equal(values[0].source, 'tencent:unadjusted-close');
  assert.throws(() => tencentDailyCloses(exact, 'usFICT.OQ', 'OTHER', 'US', '2026-11-01', '2026-11-30', at), /SYMBOL_MISMATCH/);
  const adjustedOnly = { code: 0, data: { 'usFICT.OQ': { qt: exact.data['usFICT.OQ'].qt, qfqday: exact.data['usFICT.OQ'].qfqday } } };
  assert.throws(() => tencentDailyCloses(adjustedOnly, 'usFICT.OQ', 'FICT', 'US', '2026-11-01', '2026-11-30', at), /UNADJUSTED/);
});
