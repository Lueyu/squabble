import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { of, throwError } from 'rxjs';
import { PortfolioMetricsService } from './portfolio-metrics.service';
import { QuoteService } from '../quote/quote.service';
import { ValuationSourceThrottled } from '../quote/valuation-rate-limit';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';

test('alternate dated US source is attempted once and an undated response remains unknown', async () => {
  const requests: string[] = [];
  let quoteAt: number | undefined = Date.parse('2026-11-05T15:59:00Z') / 1000;
  const http = { get: (url: string) => {
    requests.push(url);
    return url.includes('usMinute/query') ? of({ data: { code: 1 } }) : of({
      data: { chart: { result: [{ meta: { symbol: 'ACME', regularMarketPrice: 110, regularMarketTime: quoteAt } }] } },
    });
  } };
  const service = new PortfolioMetricsService({} as never, new QuoteService({} as never, http as never));
  const positions = [{ ticker: 'ACME', market: 'US', currency: 'USD' }];
  const at = new Date('2026-11-05T16:00:00Z');
  const facts = await service.captureQuotes(positions, at);
  assert.equal(facts[0]?.quoteAt, '2026-11-05T15:59:00.000Z');
  assert.equal(facts[0]?.source, 'yahoo');
  assert.deepEqual(await service.captureQuotes(positions, at), facts);
  assert.equal(requests.length, 2);

  quoteAt = undefined;
  const later = new Date('2026-11-05T16:05:00Z');
  for (let i = 0; i < 2; i++) assert.deepEqual(await service.captureQuotes(positions, later), []);
  assert.equal(requests.length, 4, 'an undated response is negatively cached for the slot');
});

test('dated CN and HK captures preserve exchange time and require matching upstream identities', async () => {
  let wrongIdentity = false;
  const requests: string[] = [];
  const http = { get: (url: string) => {
    requests.push(url);
    if (url.includes('finance.yahoo.com')) return of({ data: {} });
    const fields = Array<string>(32).fill('');
    fields[3] = '110';
    fields[4] = '100';
    fields[30] = '20261105100001';
    const native = wrongIdentity ? 'sh600000' : url.split('=').at(-1);
    return of({ data: Buffer.from('v_' + native + '="' + fields.join('~') + '";') });
  } };
  const service = new PortfolioMetricsService({} as never, new QuoteService({} as never, http as never));
  const positions = [{ ticker: '600519.SH', market: 'CN', currency: 'CNY' }, { ticker: '700', market: 'HK', currency: 'HKD' }];
  const at = new Date('2026-11-05T02:00:02Z');
  const facts = await service.captureQuotes(positions, at);
  assert.deepEqual(facts.map(row => [row.ticker, row.quoteAt, row.source]), [
    ['600519.SH', '2026-11-05T02:00:01.000Z', 'tencent'], ['700', '2026-11-05T02:00:01.000Z', 'tencent'],
  ]);
  assert.equal(requests.length, 2);
  wrongIdentity = true;
  assert.deepEqual(await service.captureQuotes(positions, new Date('2026-11-05T02:05:00Z')), []);
  assert.equal(requests.length, 5);
});

test('an explicit upstream throttle uses Retry-After and stops fallback requests', async () => {
  const identity = resolveTradingTicker('ACME');
  assert.ok(identity);
  const at = new Date('2026-11-05T16:00:00Z');
  let requests = 0;
  const http = { get: () => {
    requests++;
    return throwError(() => ({ isAxiosError: true,
      response: { status: 503, headers: { 'retry-after': 'Thu, 05 Nov 2026 16:07:00 GMT' } } }));
  } };
  const source = new QuoteService({} as never, http as never);
  await assert.rejects(source.getValuationQuote(identity, at, { legacy: true, accepts: () => true, mayRequest: () => true }),
    (error: unknown) => error instanceof ValuationSourceThrottled && error.retryAfterMs === 420_000);
  assert.equal(requests, 1);
});

test('parallel consumers share canonical pending quotes and never exceed four public requests', async () => {
  let active = 0, peak = 0, calls = 0;
  const quotes = { getValuationQuote: async ({ ticker: symbol }: { ticker: string }) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return { symbol, market: 'US', currency: 'USD', price: '110', source: 'fixture', quoteAt: '2026-11-05T15:59:00Z', tradingDate: '2026-11-05' };
  } };
  const service = new PortfolioMetricsService({} as never, quotes as never);
  const positions = 'ABCDEFGHIJKL'.split('').map(ticker => ({ ticker, market: 'US', currency: 'USD' }));
  const at = new Date('2026-11-05T16:00:00Z');
  const results = await Promise.all([service.captureQuotes(positions, at), service.captureQuotes(positions, at)]);
  assert.equal(calls, 12);
  assert.equal(peak, 4);
  assert.ok(results.every(facts => facts.length === 12));
});
