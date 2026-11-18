import test from 'node:test';
import assert from 'node:assert/strict';
import { isLegacyValuationMinute, minuteValuationSlot, valuationMarketPhase, valuationSlot, verifiedMarketQuote } from './portfolio-sampling.rules';
import { tradingMarketSchedule } from '../paper-trading/trading-market.calendar';

const at = new Date('2026-11-05T16:00:00Z');
const quote = {symbol:'ACME', market:'US', currency:'USD', price:'110', source:'fixture', quoteAt:'2026-11-05T15:55:00Z', tradingDate:'2026-11-05'};
test('sampling trusts provider time, never retrieval time or stale/wrong identity', () => {
  assert.equal(verifiedMarketQuote({ticker:'ACME',market:'US',currency:'USD'},quote,at)?.quoteAt,new Date(quote.quoteAt).toISOString());
  for(const invalid of [{...quote,symbol:'OTHER'},{...quote,quoteAt:undefined,timestamp:at.getTime()},{...quote,quoteAt:'2026-11-05T15:00:00Z'},{...quote,market:'HK'},{...quote,currency:'CNY'},{...quote,quoteAt:'2026-11-05T16:10:00Z'}]) {
    assert.equal(verifiedMarketQuote({ticker:'ACME',market:'US',currency:'USD'},invalid,at),null);
  }
});
test('verified closing facts remain dated facts outside the session; unverified calendar fails closed', () => {
  const close={...quote,quoteAt:'2026-11-06T21:00:00Z',tradingDate:'2026-11-06'};
  assert.ok(verifiedMarketQuote({ticker:'ACME',market:'US',currency:'USD'},close,new Date('2026-11-07T16:00:00Z')));
  assert.equal(verifiedMarketQuote({ticker:'ACME',market:'US',currency:'USD'},close,new Date('2027-01-05T16:00:00Z')),null);
});

test('legacy boundaries retain their previous epoch keys while other minutes have distinct keys', () => {
  const aligned = new Date('2026-11-05T16:05:30Z'), extra = new Date('2026-11-05T16:06:00Z');
  assert.equal(valuationSlot(aligned), 'sample:' + Math.floor(aligned.getTime() / 300_000));
  assert.equal(valuationSlot(extra), valuationSlot(aligned));
  assert.ok(isLegacyValuationMinute(aligned));
  assert.ok(!isLegacyValuationMinute(extra));
  assert.notEqual(minuteValuationSlot(aligned), minuteValuationSlot(extra));
});

test('cadence follows continuous local trading, early closes, holidays and US daylight saving time', () => {
  for (const [market, instant, phase] of [
    ['CN', '2026-11-05T03:29:59Z', 'open'],
    ['CN', '2026-11-05T03:30:00Z', 'closed'],
    ['CN', '2026-11-05T05:00:00Z', 'open'],
    ['CN', '2026-11-05T06:57:00Z', 'closed'],
    ['CN', '2026-11-05T07:00:00Z', 'closing'],
    ['CN', '2026-10-05T02:00:00Z', 'closed'],
    ['HK', '2026-11-05T04:59:59Z', 'closed'],
    ['HK', '2026-11-05T05:00:00Z', 'open'],
    ['HK', '2026-12-24T04:00:00Z', 'closing'],
    ['HK', '2026-12-24T05:00:00Z', 'closed'],
    ['US', '2026-03-06T13:45:00Z', 'closed'],
    ['US', '2026-03-09T13:45:00Z', 'open'],
    ['US', '2026-11-26T15:00:00Z', 'closed'],
    ['US', '2026-11-27T17:59:59Z', 'open'],
    ['US', '2026-11-27T18:00:00Z', 'closing'],
    ['US', '2027-01-05T15:00:00Z', 'closed'],
  ] as const) {
    const at = new Date(instant);
    assert.equal(valuationMarketPhase(tradingMarketSchedule(market, at), at), phase, market + ' ' + instant);
  }
});

test('a lunch carry uses the genuine end-of-segment quote and expires on reopening', () => {
  const position = { ticker: '600519.SH', market: 'CN', currency: 'CNY' };
  const mark = { ...quote, ...position, symbol: position.ticker, quoteAt: '2026-11-05T03:29:45Z' };
  const lunch = new Date('2026-11-05T04:59:00Z');
  assert.equal(verifiedMarketQuote(position, mark, lunch)?.quoteAt, '2026-11-05T03:29:45.000Z');
  assert.equal(verifiedMarketQuote(position, { ...mark, quoteAt: '2026-11-05T04:25:00Z' }, lunch), null);
  assert.equal(verifiedMarketQuote(position, { ...mark, quoteAt: '2026-11-05T03:14:00Z' }, lunch), null);
  assert.equal(verifiedMarketQuote(position, mark, new Date('2026-11-05T05:00:00Z')), null);
});
