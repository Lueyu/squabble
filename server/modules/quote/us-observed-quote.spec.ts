import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { of } from 'rxjs';
import { tencentObservedUsQuote } from './us-observed-quote';
import { QuoteService } from './quote.service';
import type { HttpService } from '@nestjs/axios';
import type { PostgresJsDatabase } from '../../common/platform';

function payload(wall = '2026-11-12 16:00:01', season = 'EST') {
  const quote = Array<string>(73).fill('');
  quote[2] = 'MSFT.OQ'; quote[3] = '100'; quote[4] = '99'; quote[30] = wall;
  return { code: 0, data: { usMSFT: { qt: { usMSFT: quote },
    data: { date: wall.slice(0, 10).replaceAll('-', ''), data: ['0930 99 1', '1600 100 2'] }, pandata: { season } } } };
}
const at = new Date('2026-11-13T05:00:00Z');

test('Tencent US observations use explicit provider timezone and native minute evidence', () => {
  const result = tencentObservedUsQuote(payload(), 'MSFT', at);
  assert.equal(result?.quoteAt, '2026-11-12T21:00:01.000Z');
  assert.equal(result?.tradingDate, '2026-11-12');
  assert.equal(result?.price, '100');
  assert.equal(result?.timestamp, at.getTime(), 'retrieval time remains separate from the provider observation');
  const summer = tencentObservedUsQuote(payload('2026-07-10 16:00:01', 'EDT'), 'MSFT', new Date('2026-07-10T21:00:00Z'));
  assert.equal(summer?.quoteAt, '2026-07-10T20:00:01.000Z');
});

test('unverified season, mismatched minute date/identity, invalid date and future quotes fail closed', () => {
  for (const season of ['UTC', '', 'EDT']) assert.equal(tencentObservedUsQuote(payload(undefined, season), 'MSFT', at), null);
  assert.equal(tencentObservedUsQuote(payload('2026-07-10 16:00:01', 'EST'), 'MSFT', new Date('2026-07-11T00:00:00Z')), null);
  assert.equal(tencentObservedUsQuote(payload('2026-02-30 16:00:01', 'EST'), 'MSFT', at), null);
  assert.equal(tencentObservedUsQuote(payload(), 'OTHER', at), null);
  assert.equal(tencentObservedUsQuote(payload(), 'MSFT', new Date('2026-11-12T20:00:00Z')), null);
  const changed = payload(); changed.data.usMSFT.data.date = '20261111';
  assert.equal(tencentObservedUsQuote(changed, 'MSFT', at), null);
  const wrong = payload(); wrong.data.usMSFT.qt.usMSFT[2] = 'FOREIGN.OQ';
  assert.equal(tencentObservedUsQuote(wrong, 'MSFT', at), null);
  const stale = payload(); stale.data.usMSFT.data.data[1] = '1530 100 2';
  assert.equal(tencentObservedUsQuote(stale, 'MSFT', at), null);
});

test('dated US capture uses the bounded public minute endpoint without writing holdings or changing getQuote', async () => {
  let calls = 0;
  const http = { get: (url: string, config: { params: { code: string }; timeout: number; maxContentLength: number }) => {
    calls++; assert.equal(url, 'https://web.ifzq.gtimg.cn/appstock/app/usMinute/query');
    assert.equal(config.params.code, 'usMSFT'); assert.ok(config.timeout <= 8000); assert.ok(config.maxContentLength <= 1_000_000);
    return of({ data: payload() });
  } } as unknown as HttpService;
  const service = new QuoteService({} as PostgresJsDatabase, http);
  const result = await service.fetchUsObservedQuote('MSFT', at);
  assert.equal(result?.quoteAt, '2026-11-12T21:00:01.000Z'); assert.equal(calls, 1);
});
