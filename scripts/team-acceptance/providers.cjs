const assert = require('node:assert/strict');
const axios = require('axios');
const dns = require('node:dns/promises');
const { resolve } = require('node:path');

const endpoint = 'https://squabble-model.acceptance.example.com';
const apiKey = 'fictional-acceptance-token';
const ticker = 'DEMO';
const price = 80;
const minute = 60_000;
const marketTimezone = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  timeZoneName: 'short',
});


function ruleContent(at, endsAt) {
  const text = 'Buy 2 ' + ticker + ' shares at or below 85 USD.';
  return {
    title: 'Acceptance fixed price rule', body: text, timezone: 'America/New_York',
    startsAt: new Date(at.getTime() - minute).toISOString(), endsAt: endsAt.toISOString(),
    limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20,
      minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 5 },
    entries: [{ id: 'fixture-buy', text, sourceKeys: [], directive: { ticker, side: 'buy', quantity: 2,
      trigger: { kind: 'price_lte', price: 85 }, reviewedText: text, numericEvidence: [
        { field: 'quantity', value: 2, quote: text }, { field: 'trigger.price', value: 85, quote: text },
      ] } }],
  };
}

function researchReply(system, input, proposeExecution = false) {
  assert.ok(input.task && Array.isArray(input.skills), 'Received a real Council work prompt');
  if (input.submitted) {
    const feedback = 'The fictional conclusions match the supplied account evidence.';
    return Array.isArray(input.submitted)
      ? { reviews: input.submitted.map(({ taskId, submittedAttemptId }) => ({ taskId, submittedAttemptId, accepted: true, feedback })) }
      : { accepted: true, feedback };
  }
  assert.match(system, /evidenceIds/u);
  const evidenceId = input.evidence.find(item => item.id.startsWith('team-account:'))?.id;
  assert.ok(evidenceId, 'Council must provide exact frozen team-account evidence');
  const summary = 'Acceptance research read the frozen portfolio.';
  const now = new Date();
  const executionPlan = proposeExecution && input.task.key === 'summary'
    ? { schemaVersion: 1, parameterOrigin: 'ai_proposed',
      strategy: ruleContent(now, new Date(now.getTime() + 4 * 86_400_000)),
      evidenceIds: [evidenceId], gaps: [] }
    : undefined;
  return {
    conclusion: summary, evidenceIds: [evidenceId], asOf: input.dataCutoffAt,
    currency: 'USD', units: 'shares', assumptions: [], gaps: [],
    skillVersions: input.skills.map(({ id, version, hash }) => ({ id, version, hash })),
    response: { thesis: summary, evidencePoints: ['The account holds fictional positions.'],
      risks: ['The controlled quote dataset is limited.'], nextChecks: ['Review the next priced observation.'] },
    researchStance: 'cautious',
    ...(executionPlan ? { executionPlan } : {}),
  };
}

function companionReply(prompt) {
  const lines = prompt.trim().split('\n');
  const input = JSON.parse(lines.pop());
  return JSON.stringify(researchReply(lines.join('\n'), input));
}

function yahooQuote(at) {
  const { tradingMarketSchedule, lastCompletedTradingDate } =
    require(resolve(__dirname, '../../dist/server/modules/paper-trading/trading-market.calendar.js'));
  const schedule = tradingMarketSchedule('US', at);
  const lastDay = lastCompletedTradingDate('US', at);
  assert.ok(lastDay, 'Use a year covered by the bundled market calendar');
  const lastClose = tradingMarketSchedule('US', new Date(lastDay + 'T17:00:00Z')).closesAt;
  const quoteAt = schedule.isOpen ? Math.max(at.getTime() - minute, Date.parse(schedule.opensAt)) : Date.parse(lastClose);
  const candles = [];
  const dayMs = 86_400_000;
  for (let yesterday = 0; yesterday < 120 && candles.length < 60; yesterday++) {
    const day = new Date(Date.parse(lastDay + 'T17:00:00Z') - yesterday * dayMs);
    const session = tradingMarketSchedule('US', day);
    if (session.isTradingDay) candles.unshift(Math.floor(Date.parse(session.opensAt) / 1000));
  }
  const previous = 79;
  return { chart: { result: [{
    meta: { symbol: ticker, currency: 'USD', exchangeName: 'NMS', instrumentType: 'EQUITY',
      exchangeTimezoneName: 'America/New_York', regularMarketTime: Math.floor(quoteAt / 1000),
      regularMarketPrice: price, chartPreviousClose: previous },
    timestamp: candles, indicators: { quote: [{ open: candles.map(() => 78), high: candles.map(() => 82),
      low: candles.map(() => 77), close: candles.map(() => previous), volume: candles.map(() => 20_000) }] },
  }], error: null } };
}

function tencentQuote(at) {
  const format = Object.fromEntries(marketTimezone.formatToParts(new Date(at.getTime() - minute))
    .map(({ type, value }) => [type, value]));
  const code = 'us' + ticker;
  const quote = Array(73).fill('');
  quote[1] = 'Acceptance sample';
  quote[2] = ticker;
  quote[3] = String(price);
  quote[4] = '79';
  quote[30] = [format.year, format.month, format.day].join('-') + ' ' + [format.hour, format.minute, format.second].join(':');
  return { code: 0, data: { [code]: { qt: { [code]: quote },
    data: { date: format.year + format.month + format.day, data: [format.hour + format.minute + ' ' + price + ' 1'] },
    pandata: { season: format.timeZoneName } } } };
}

function installProviders() {
  const originalAdapter = axios.defaults.adapter;
  const lookup = dns.lookup;
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === 'https://query1.finance.yahoo.com' && url.pathname === '/v1/finance/search' && url.searchParams.get('q') === ticker) {
      return Response.json({ quotes: [{ symbol: ticker, quoteType: 'EQUITY', exchange: 'NMS' }] });
    }
    assert.equal(url.hostname, '127.0.0.1', 'Acceptance blocked an unexpected fetch');
    return fetch(input, init);
  };
  const calls = [];
  const fixture = { marketAt: null, missingQuotes: false, rejectModel: false, proposeExecution: false, calls };
  dns.lookup = (host, ...options) => host === new URL(endpoint).hostname
    ? Promise.resolve([{ address: '93.184.215.14', family: 4 }])
    : lookup(host, ...options);
  axios.defaults.adapter = async config => {
    const url = new URL(config.url);
    const at = fixture.marketAt ?? new Date();
    let data;
    if (url.origin === endpoint && /^\/v1\/chat\/completions$/u.test(url.pathname)) {
      assert.equal(config.headers.get('Authorization'), 'Bearer ' + apiKey);
      const { messages, model } = JSON.parse(config.data);
      assert.equal(model, 'acceptance-model');
      const user = messages.findLast(message => message.role === 'user').content;
      const test = user === 'Reply with OK only.';
      const input = test ? null : JSON.parse(user);
      calls.push({ provider: 'model', task: input?.task?.key ?? 'connection-test', rejected: fixture.rejectModel });
      if (fixture.rejectModel) {
        if (config.validateStatus?.(401)) return { status: 401, headers: {}, data: { error: { message: 'Fixture rejected API key' } }, config };
        throw new axios.AxiosError('Fixture rejected API key', 'ERR_BAD_REQUEST', config, undefined, { status: 401 });
      }
      const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
      const result = test ? 'OK' : researchReply(system, input, fixture.proposeExecution);
      if (result.executionPlan) calls.at(-1).executionPlan = 'price_lte';
      const content = test ? result : JSON.stringify(result);
      data = { id: 'acceptance-' + calls.length, model, created: Math.floor(Date.now() / 1000),
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } };
    } else if (url.origin === 'https://api.frankfurter.dev' && url.pathname === '/v1/latest') {
      data = { date: new Date(at.getTime() - 86_400_000).toISOString().slice(0, 10), rates: { HKD: 8, CNY: 1 / 0.14 } };
    } else if (!fixture.missingQuotes && url.origin === 'https://query1.finance.yahoo.com' &&
      url.pathname === '/v8/finance/chart/' + ticker) {
      data = yahooQuote(at);
    } else if (!fixture.missingQuotes && url.origin === 'https://web.ifzq.gtimg.cn' &&
      url.pathname === '/appstock/app/usMinute/query' && config.params?.code === 'us' + ticker) {
      data = tencentQuote(at);
    } else {
      throw new Error('No offline provider fixture for ' + url.hostname);
    }
    return {
      config, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' },
      data: config.responseType === 'arraybuffer' ? Buffer.from(JSON.stringify(data)) : data,
    };
  };
  return Object.assign(fixture, {
    restore: () => { axios.defaults.adapter = originalAdapter; dns.lookup = lookup; globalThis.fetch = fetch; },
  });
}

module.exports = { apiKey, companionReply, endpoint, installProviders, price, ruleContent, ticker };
