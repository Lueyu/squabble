import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedMarketQuote } from './portfolio-sampling.rules';

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
