import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { of } from 'rxjs';
import { QuoteService } from '../quote/quote.service';

test('Yahoo quote retains actual exchange timestamp and previous close independently from fetch time', async () => {
  const time = Date.parse('2026-11-05T21:00:00Z') / 1000;
  const service = new QuoteService({} as never,{get:()=>of({data:{chart:{result:[{meta:{symbol:'ACME',regularMarketPrice:110,chartPreviousClose:100,regularMarketTime:time}}]}}})} as never);
  const quote = await service.fetchUsQuoteYahoo('ACME');
  assert.equal(quote?.previousClose,'100');
  assert.equal(quote?.quoteAt,'2026-11-05T21:00:00.000Z');
  assert.equal(quote?.tradingDate,'2026-11-05');
  assert.equal(quote?.source,'yahoo');
});

test('Yahoo missing previous close and exchange time stays missing, not derived from request timestamp', async () => {
  const service = new QuoteService({} as never,{get:()=>of({data:{chart:{result:[{meta:{symbol:'ACME',regularMarketPrice:110}}]}}})} as never);
  const quote = await service.fetchUsQuoteYahoo('ACME');
  assert.equal(quote?.previousClose,undefined);
  assert.equal(quote?.quoteAt,undefined);
  assert.equal(quote?.tradingDate,undefined);
});
