import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioMetricsService } from './portfolio-metrics.service';

test('an undated Tencent US reading falls back to the existing dated Yahoo source for sampling only',async()=>{
  let fallback=0;
  const primary={symbol:'ACME',market:'US',currency:'USD',price:'110',source:'tencent'};
  const quotes={getQuote:async()=>primary,fetchUsQuoteYahoo:async()=>{fallback++;return {...primary,source:'yahoo',quoteAt:'2026-11-05T15:59:00Z',tradingDate:'2026-11-05'};}};
  const service=new PortfolioMetricsService({} as never,quotes as never);
  const positions=[{ticker:'ACME',market:'US',currency:'USD'}],at=new Date('2026-11-05T16:00:00Z');
  const facts=await service.captureQuotes(positions,at);
  assert.equal(fallback,1);assert.equal(facts.length,1);
  assert.equal(facts[0].quoteAt,'2026-11-05T15:59:00.000Z');
  assert.equal(facts[0].source,'yahoo');
  await service.captureQuotes(positions,at);assert.equal(fallback,1,'dated fallback shares a bounded success cache');
});

test('when both public sources lack provider time, sampling records no valid quote and negatively caches fallback',async()=>{
  let fallback=0;
  const undated={symbol:'ACME',market:'US',currency:'USD',price:'110',timestamp:Date.now(),source:'tencent'};
  const service=new PortfolioMetricsService({} as never,{getQuote:async()=>undated,fetchUsQuoteYahoo:async()=>{fallback++;return null;}} as never);
  for(let i=0;i<2;i++)assert.deepEqual(await service.captureQuotes([{ticker:'ACME',market:'US',currency:'USD'}],new Date('2026-11-05T16:00:00Z')),[]);
  assert.equal(fallback,1,'provider failure must not cause a request per position or consumer');
});

test('a verified observed Tencent timestamp is preferred to a redundant Yahoo request',async()=>{
  let yahoo=0,observed=0;
  const primary={symbol:'ACME',market:'US',currency:'USD',price:'110',source:'tencent'};
  const source={getQuote:async()=>primary,fetchUsObservedQuote:async()=>{observed++;return {...primary,quoteAt:'2026-11-05T15:59:00Z',tradingDate:'2026-11-05'};},fetchUsQuoteYahoo:async()=>{yahoo++;return null;}};
  const facts=await new PortfolioMetricsService({} as never,source as never).captureQuotes([{ticker:'ACME',market:'US',currency:'USD'}],new Date('2026-11-05T16:00:00Z'));
  assert.equal(facts.length,1);assert.equal(observed,1);assert.equal(yahoo,0);
});

test('parallel consumers share pending quotes and never exceed four public requests',async()=>{
  let active=0,peak=0,calls=0;
  const quotes={getQuote:async(symbol:string)=>{
    calls++;active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,2));active--;
    return {symbol,market:'US',currency:'USD',price:'110',source:'fixture',quoteAt:'2026-11-05T15:59:00Z',tradingDate:'2026-11-05'};
  }};
  const service=new PortfolioMetricsService({} as never,quotes as never);
  const positions='ABCDEFGHIJKL'.split('').map(ticker=>({ticker,market:'US',currency:'USD'}));
  const results=await Promise.all([service.captureQuotes(positions,new Date('2026-11-05T16:00:00Z')),service.captureQuotes(positions,new Date('2026-11-05T16:00:00Z'))]);
  assert.equal(calls,12);assert.ok(peak<=4);assert.ok(results.every(facts=>facts.length===12));
});
