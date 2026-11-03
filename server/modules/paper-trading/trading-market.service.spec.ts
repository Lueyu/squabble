import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpService } from '@nestjs/axios';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import { TradingMarketService } from './trading-market.service';

const NOW = new Date('2026-11-03T16:00:00Z');

function fixture() {
  const dates: number[] = [];
  for (let date = Date.parse('2026-08-01T13:30:00Z'); date < Date.parse('2026-11-03T00:00:00Z'); date += 86_400_000) {
    const day = new Date(date);
    if (![0, 6].includes(day.getUTCDay()) && day.toISOString().slice(0, 10) !== '2026-09-07') dates.push(date / 1000);
  }
  return { chart: { error: null, result: [{
    meta: { symbol: 'AAPL', currency: 'USD', exchangeName: 'NMS', instrumentType: 'EQUITY',
      exchangeTimezoneName: 'America/New_York', regularMarketPrice: 170,
      regularMarketTime: NOW.getTime() / 1000 - 60 },
    timestamp: dates,
    indicators: { quote: [{ open: dates.map(() => 100), high: dates.map(() => 102),
      low: dates.map(() => 98), close: dates.map(() => 100), volume: dates.map(() => 1000) }] },
  }] } };
}

function createService(payload: unknown | (() => unknown)) {
  const requests: InternalAxiosRequestConfig[] = [];
  const client = axios.create({ adapter: async config => {
    requests.push(config);
    const data = typeof payload === 'function' ? payload() : payload;
    return { status: 200, statusText: 'OK', headers: {}, config, data };
  } });
  return { service: new TradingMarketService(new HttpService(client)), requests };
}

test('timestamped OHLCV and source quote yield usable data without confusing retrieval with exchange time', async () => {
  const { service, requests } = createService(fixture());
  const result = await service.getSnapshot('AAPL', NOW);
  assert.equal(result.usable, true);
  assert.equal(result.quoteUsable, true);
  assert.equal(result.quoteReason, null);
  assert.equal(result.price, 170);
  assert.equal(result.quoteTimestamp, '2026-11-03T15:59:00.000Z');
  assert.equal(result.fetchedAt, NOW.toISOString());
  assert.equal(result.delay, 'possibly-delayed');
  assert.equal(result.indicators?.sma50, 100);
  assert.equal(result.candles.at(-1)?.timestamp, '2026-11-02T13:30:00.000Z');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url ?? '', /^https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/AAPL/u);
  assert.equal(requests[0].timeout, 8000);
  assert.equal(requests[0].maxRedirects, 0);
  assert.ok(Number(requests[0].maxContentLength) <= 1_048_576);
});

test('cache preserves fetchedAt and re-evaluates source freshness on every read', async () => {
  const payload = fixture();
  payload.chart.result[0].meta.regularMarketTime = NOW.getTime() / 1000 - 1190;
  const { service, requests } = createService(payload);
  assert.equal((await service.getSnapshot('AAPL', NOW)).usable, true);
  const cached = await service.getSnapshot('AAPL', new Date(NOW.getTime() + 20_000));
  assert.equal(requests.length, 1);
  assert.equal(cached.fetchedAt, NOW.toISOString());
  assert.equal(cached.usable, false);
  assert.equal(cached.reason, 'quote_stale');
  assert.equal(cached.quoteUsable, false);
  assert.equal(cached.quoteReason, 'quote_stale');
});

test('incomplete current daily bar never affects indicators, and unordered bars are normalized', async () => {
  const payload = fixture();
  const result = payload.chart.result[0];
  result.timestamp.push(Date.parse('2026-11-03T14:30:00Z') / 1000);
  const quote = result.indicators.quote[0];
  for (const key of ['open', 'high', 'low', 'close', 'volume'] as const) quote[key].push(1_000_000);
  result.timestamp.reverse();
  for (const key of ['open', 'high', 'low', 'close', 'volume'] as const) quote[key].reverse();
  const snapshot = await createService(payload).service.getSnapshot('AAPL', NOW);
  assert.equal(snapshot.usable, true);
  assert.equal(snapshot.indicators?.sma20, 100);
  assert.equal(snapshot.candles.at(-1)?.timestamp, '2026-11-02T13:30:00.000Z');
});

test('malformed, empty, duplicate, stale or insufficient history is rejected without synthetic indicators', async () => {
  const cases: Array<{ payload: ReturnType<typeof fixture>; reason: string }> = [];
  const empty = fixture(); empty.chart.result[0].timestamp = []; cases.push({ payload: empty, reason: 'history_invalid' });
  const malformed = fixture(); malformed.chart.result[0].indicators.quote[0].low[0] = 999;
  cases.push({ payload: malformed, reason: 'history_invalid' });
  const duplicate = fixture(); duplicate.chart.result[0].timestamp[1] = duplicate.chart.result[0].timestamp[0];
  cases.push({ payload: duplicate, reason: 'history_invalid' });
  const stale = fixture(); stale.chart.result[0].timestamp.pop();
  for (const key of ['open', 'high', 'low', 'close', 'volume'] as const) stale.chart.result[0].indicators.quote[0][key].pop();
  cases.push({ payload: stale, reason: 'history_stale' });
  const short = fixture(); short.chart.result[0].timestamp = short.chart.result[0].timestamp.slice(-10);
  for (const key of ['open', 'high', 'low', 'close', 'volume'] as const) {
    short.chart.result[0].indicators.quote[0][key] = short.chart.result[0].indicators.quote[0][key].slice(-10);
  }
  cases.push({ payload: short, reason: 'history_insufficient' });
  for (const item of cases) {
    const result = await createService(item.payload).service.getSnapshot('AAPL', NOW);
    assert.equal(result.usable, false, item.reason);
    assert.equal(result.reason, item.reason);
    assert.equal(result.indicators, null);
    assert.equal(result.quoteUsable, true, 'missing indicators must not disable a valid protective-exit quote');
    assert.equal(result.quoteReason, null);
  }
});

test('quote mismatch, missing source time and future source time cannot execute', async () => {
  for (const change of [{ symbol: 'MSFT' }, { currency: 'HKD' }, { exchangeName: 'PNK' },
    { regularMarketTime: 0 }, { regularMarketTime: NOW.getTime() / 1000 + 300 }]) {
    const payload = fixture(); Object.assign(payload.chart.result[0].meta, change);
    const result = await createService(payload).service.getSnapshot('AAPL', NOW);
    assert.equal(result.usable, false);
    assert.equal(result.quoteUsable, false);
    assert.ok(['source_invalid', 'quote_future'].includes(result.reason ?? ''));
  }
});

test('closed market keeps dated research data while unsupported symbols/calendar never request upstream', async () => {
  const payload = fixture();
  payload.chart.result[0].meta.regularMarketTime = Date.parse('2026-11-02T21:00:00Z') / 1000;
  const { service } = createService(payload);
  const result = await service.getSnapshot('AAPL', new Date('2026-11-03T13:00:00Z'));
  assert.equal(result.usable, false);
  assert.equal(result.reason, 'market_closed');
  assert.equal(result.quoteUsable, false);
  assert.equal(result.quoteReason, 'market_closed');
  assert.ok(result.indicators);
  assert.equal(result.price, 170);
  const noFetch = createService(fixture());
  assert.equal((await noFetch.service.getSnapshot('https://localhost', NOW)).reason, 'unsupported_ticker');
  assert.equal((await noFetch.service.getSnapshot('AAPL', new Date('2029-11-03T16:00:00Z'))).reason, 'calendar_unavailable');
  assert.equal(noFetch.requests.length, 0);
});

test('final-fill refresh bypasses the cached quote and never falls back to it on source failure', async () => {
  let fail = false;
  const { service, requests } = createService(() => {
    if (fail) throw new Error('fixture unavailable');
    return fixture();
  });
  assert.equal((await service.getSnapshot('AAPL', NOW)).usable, true);
  fail = true;
  const refreshed = await service.getSnapshot('AAPL', NOW, true);
  assert.equal(requests.length, 2);
  assert.equal(refreshed.usable, false);
  assert.equal(refreshed.reason, 'source_unavailable');
  assert.equal(refreshed.price, null);
});

test('upstream failure is explicit and cached briefly instead of throwing or fabricating values', async () => {
  const { service, requests } = createService(() => { throw new Error('fixture upstream timeout'); });
  const result = await service.getSnapshot('AAPL', NOW);
  assert.equal(result.reason, 'source_unavailable');
  assert.equal(result.usable, false);
  assert.equal(result.price, null);
  assert.equal(result.quoteUsable, false);
  assert.equal(result.quoteReason, 'source_unavailable');
  assert.equal(result.indicators, null);
  await service.getSnapshot('AAPL', new Date(NOW.getTime() + 1000));
  assert.equal(requests.length, 1);
});

test('protective quote validity rejects stale quotes even when historical data is also invalid', async () => {
  const payload = fixture();
  payload.chart.result[0].timestamp = [];
  payload.chart.result[0].meta.regularMarketTime = NOW.getTime() / 1000 - 3600;
  const result = await createService(payload).service.getSnapshot('AAPL', NOW);
  assert.equal(result.usable, false);
  assert.equal(result.reason, 'history_invalid');
  assert.equal(result.quoteUsable, false);
  assert.equal(result.quoteReason, 'quote_stale');
});

test('concurrent reads share one bounded upstream request and returned candle mutations cannot poison the cache', async () => {
  const { service, requests } = createService(fixture());
  const snapshots = await Promise.all(Array.from({ length: 8 }, () => service.getSnapshot('AAPL', NOW)));
  assert.equal(requests.length, 1);
  assert.ok(snapshots.every(snapshot => snapshot.usable));
  snapshots[0].candles[0].close = 999;
  const freshRead = await service.getSnapshot('AAPL', NOW);
  assert.equal(freshRead.candles[0].close, 100);
  assert.equal(freshRead.indicators?.sma50, 100);
});

test('HTML, missing quote timestamp and null completed OHLCV are never silently converted to numbers', async () => {
  const payload = fixture();
  const data = payload as unknown as { chart: { result: Array<{ indicators: { quote: Array<{ close: unknown[] }> } }> } };
  data.chart.result[0].indicators.quote[0].close[20] = null;
  assert.equal((await createService(payload).service.getSnapshot('AAPL', NOW)).reason, 'history_invalid');
  assert.equal((await createService('<html>upstream blocked</html>').service.getSnapshot('AAPL', NOW)).reason, 'source_unavailable');
  const noTime = fixture();
  delete (noTime.chart.result[0].meta as Partial<typeof noTime.chart.result[0]['meta']>).regularMarketTime;
  const result = await createService(noTime).service.getSnapshot('AAPL', NOW);
  assert.equal(result.reason, 'source_invalid');
  assert.equal(result.quoteTimestamp, null);
});

test('HK and both CN exchanges enforce their own currency, timezone and mapped provider symbol', async () => {
  for (const spec of [
    { ticker: '00700', symbol: '0700.HK', exchange: 'HKG', currency: 'HKD', timezone: 'Asia/Hong_Kong' },
    { ticker: '600519.SH', symbol: '600519.SS', exchange: 'SHH', currency: 'CNY', timezone: 'Asia/Shanghai' },
    { ticker: '000001', symbol: '000001.SZ', exchange: 'SHZ', currency: 'CNY', timezone: 'Asia/Shanghai' },
  ]) {
    const payload = fixture();
    Object.assign(payload.chart.result[0].meta, { symbol: spec.symbol, exchangeName: spec.exchange,
      currency: spec.currency, exchangeTimezoneName: spec.timezone, regularMarketTime: Date.parse('2026-11-03T02:00:00Z') / 1000 });
    const result = await createService(payload).service.getSnapshot(spec.ticker, new Date('2026-11-03T02:01:00Z'));
    assert.equal(result.usable, true, spec.symbol);
    assert.equal(result.providerSymbol, spec.symbol);
    assert.equal(result.currency, spec.currency);
  }
});
