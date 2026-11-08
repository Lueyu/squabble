const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const loaded = new Map();

function load(name) {
  if (loaded.has(name)) return loaded.get(name);
  const filename = path.join(__dirname, `${name}.ts`);
  if (!fs.existsSync(filename)) return {};
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((id) => {
    if (id === '@nestjs/common') return { Injectable: () => (target) => target };
    if (id.startsWith('./')) return load(id.slice(2));
    throw new Error(`Unexpected dependency: ${id}`);
  }, mod, mod.exports);
  loaded.set(name, mod.exports);
  return mod.exports;
}

const now = new Date('2026-10-30T12:00:00Z');
const accession = '0000320193-26-000020';
const end = '2026-06-27';
const start = '2025-09-28';
const filed = '2026-07-31';

function fixture() {
  const fact = (val, duration = true) => ({ val, ...(duration ? { start } : {}), end,
    accn: accession, fy: 2026, fp: 'Q3', form: '10-Q', filed });
  return {
    submissions: { cik: '0000320193', tickers: ['AAPL'], filings: { recent: {
      form: ['4', '10-Q', '10-K'],
      accessionNumber: ['0000320193-26-000099', accession, '0000320193-25-000079'],
      filingDate: ['2026-10-29', filed, '2025-10-31'],
      reportDate: ['2026-10-28', end, '2025-09-27'],
    } } },
    facts: { cik: 320193, entityName: 'Apple Inc.', facts: { 'us-gaap': {
      RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [fact(364357000000),
        { ...fact(100000000000), start: '2026-03-29' }, { ...fact(999), end: '2025-06-28' }] } },
      NetIncomeLoss: { units: { USD: [fact(101464000000), { ...fact(30000000000), start: '2026-03-29' }] } },
      NetCashProvidedByUsedInOperatingActivities: { units: { USD: [fact(116996000000)] } },
      Liabilities: { units: { USD: [fact(275746000000, false)] } },
    } } },
  };
}

test('SEC financials select one latest filing, matching monetary units and cumulative reporting period', () => {
  const { parseSecFinancials } = load('sec-financials');
  assert.equal(typeof parseSecFinancials, 'function', 'A verified SEC financial parser must exist');
  const raw = fixture();
  const result = parseSecFinancials(raw.facts, raw.submissions, 'AAPL', now);
  assert.equal(result.hasStatements, true);
  assert.deepEqual(result.missingFields, []);
  const item = result.items[0];
  assert.equal(item.sourceName, 'SEC EDGAR');
  assert.equal(item.metadata?.sources[0].verification, 'server-verified');
  assert.equal(item.metadata.sources[0].publishedAt, filed);
  assert.equal(item.metadata.sources[0].publicationPrecision, 'day');
  assert.equal(item.metadata.sources[0].observedAt, null, 'pure parsing is not system observation');
  assert.deepEqual(item.metadata.sources[0].facts[0], { entity: 'AAPL',
    metric: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', value: 364357000000,
    unit: 'currency', currency: 'USD', basis: 'us-gaap', actuality: 'actual',
    periodStart: start, periodEnd: end, instant: null });
  assert.match(item.sourceUrl, /www\.sec\.gov\/Archives\/edgar\/data\/320193\/000032019326000020\//);
  for (const expected of ['364357000000', '101464000000', '116996000000', '275746000000',
    start, end, filed, accession, 'USD']) assert.ok(item.content.includes(expected), expected);
  assert.match(item.content, /YTD|cumulative|period total/i);
  assert.doesNotMatch(item.content, /100000000000|30000000000|999/);
  const excerpt = Buffer.from(item.content).subarray(0, 250).toString('utf8');
  assert.match(excerpt, /116996000000.*period total/);
  assert.ok(excerpt.includes(end));
});

test('SEC data cannot fill a newer filing with older, mismatched-currency or conflicting facts', () => {
  const { parseSecFinancials } = load('sec-financials');
  assert.equal(typeof parseSecFinancials, 'function');
  const raw = fixture();
  const gaap = raw.facts.facts['us-gaap'];
  gaap.Liabilities.units.USD[0].accn = '0000320193-25-000079';
  let result = parseSecFinancials(raw.facts, raw.submissions, 'AAPL', now);
  assert.equal(result.hasStatements, false);
  assert.ok(result.missingFields.includes('Liabilities'));
  gaap.Liabilities.units = { EUR: [{ ...fixture().facts.facts['us-gaap'].Liabilities.units.USD[0] }] };
  result = parseSecFinancials(raw.facts, raw.submissions, 'AAPL', now);
  assert.equal(result.hasStatements, false);
  assert.ok(result.missingFields.includes('Liabilities'));
  gaap.Liabilities.units = { USD: [fixture().facts.facts['us-gaap'].Liabilities.units.USD[0],
    { ...fixture().facts.facts['us-gaap'].Liabilities.units.USD[0], val: 1 }] };
  result = parseSecFinancials(raw.facts, raw.submissions, 'AAPL', now);
  assert.equal(result.hasStatements, false);
  assert.ok(result.missingFields.includes('Liabilities'));
});

function withSupplementalFacts() {
  const raw = fixture();
  const gaap = raw.facts.facts['us-gaap'];
  const duration = gaap.NetCashProvidedByUsedInOperatingActivities.units.USD[0];
  const instant = gaap.Liabilities.units.USD[0];
  for (const [name, val, context] of [
    ['PaymentsToAcquirePropertyPlantAndEquipment', 6799000000, duration],
    ['CashAndCashEquivalentsAtCarryingValue', 39544000000, instant],
    ['StockholdersEquity', 107520000000, instant], ['Assets', 383266000000, instant],
    ['GrossProfit', 178782000000, duration], ['OperatingIncomeLoss', 122432000000, duration],
  ]) gaap[name] = { units: { USD: [{ ...context, val }] } };
  return raw;
}

test('SEC emits separate optional cash-flow and balance evidence with explicit period-based derived FCF', () => {
  const { parseSecFinancials } = load('sec-financials');
  for (const capex of [6799000000, 0]) {
    const raw = withSupplementalFacts();
    raw.facts.facts['us-gaap'].PaymentsToAcquirePropertyPlantAndEquipment.units.USD[0].val = capex;
    const result = parseSecFinancials(raw.facts, raw.submissions, 'AAPL', now);
    assert.equal(result.hasStatements, true);
    assert.deepEqual(result.missingFields, []);
    const compact = Buffer.from(result.items[0].content).subarray(0, 600).toString('utf8');
    for (const expected of ['364357000000', '101464000000', '116996000000', '275746000000',
      String(capex), String(116996000000 - capex), '39544000000', '107520000000', 'USD', start, end,
      'CFO-capex', 'non-GAAP', 'not annualized']) assert.ok(compact.includes(expected), expected);
    const cashFlow = result.items.find((item) => /supplemental cash flow/.test(item.title));
    assert.ok(cashFlow, 'Cash-flow details must be a separate prompt-visible evidence row');
    assert.match(cashFlow.content, new RegExp(`Capex.*USD ${capex}`));
    assert.match(cashFlow.content, new RegExp(`Derived FCF.*USD ${116996000000 - capex}`));
    for (const expected of [start, end, 'CFO - capex', 'non-GAAP', 'not TTM', 'not annualized']) {
      assert.ok(cashFlow.content.includes(expected), expected);
    }
    const balance = result.items.find((item) => /supplemental balance/.test(item.title));
    assert.ok(balance);
    for (const expected of ['39544000000', '107520000000', '383266000000', end]) assert.ok(balance.content.includes(expected));
    const income = result.items.find((item) => /supplemental profitability/.test(item.title));
    assert.match(income.content, /178782000000/);
    assert.match(income.content, /122432000000/);
    assert.ok(result.items.every((item) => item.sourceUrl === result.items[0].sourceUrl));
  }
  const absent = fixture();
  const result = parseSecFinancials(absent.facts, absent.submissions, 'AAPL', now);
  assert.equal(result.hasStatements, true, 'Optional omissions do not change critical coverage');
  assert.equal(result.items.length, 1);
});

test('SEC supplemental facts never mix period, accession, unit or conflicting contexts to calculate FCF', () => {
  const { parseSecFinancials } = load('sec-financials');
  for (const patch of [{ start: '2026-03-29' }, { accn: '0000320193-25-000079' },
    { end: '2025-06-28' }, { filed: '2026-08-01' }, { val: -1 }]) {
    const raw = withSupplementalFacts();
    Object.assign(raw.facts.facts['us-gaap'].PaymentsToAcquirePropertyPlantAndEquipment.units.USD[0], patch);
    const result = parseSecFinancials(raw.facts, raw.submissions, 'AAPL', now);
    assert.equal(result.hasStatements, true);
    assert.ok(!result.items.some((item) => /Derived FCF/.test(item.content)));
  }
  const raw = withSupplementalFacts();
  const gaap = raw.facts.facts['us-gaap'];
  gaap.PaymentsToAcquirePropertyPlantAndEquipment.units = { EUR: gaap.PaymentsToAcquirePropertyPlantAndEquipment.units.USD };
  gaap.CashAndCashEquivalentsAtCarryingValue.units.USD.push({ ...gaap.CashAndCashEquivalentsAtCarryingValue.units.USD[0], val: 1 });
  gaap.StockholdersEquity.units.USD[0].val = -10;
  gaap.OperatingIncomeLoss.units.USD[0].val = 0;
  const result = parseSecFinancials(raw.facts, raw.submissions, 'AAPL', now);
  const text = result.items.slice(1).map((item) => item.content).join(' ');
  assert.doesNotMatch(text, /Derived FCF|39544000000/);
  assert.match(text, /Stockholders equity \(parent\): USD -10/);
  assert.match(text, /Operating income: USD 0/);
});

test('SEC parser rejects issuer mismatch, future filing dates and stale statements', () => {
  const { parseSecFinancials } = load('sec-financials');
  assert.equal(typeof parseSecFinancials, 'function');
  const raw = fixture();
  assert.equal(parseSecFinancials(raw.facts, raw.submissions, 'MSFT', now).issue, 'invalid_response');
  raw.facts.cik = 789019;
  assert.equal(parseSecFinancials(raw.facts, raw.submissions, 'AAPL', now).issue, 'invalid_response');
  raw.facts.cik = 320193;
  assert.equal(parseSecFinancials(raw.facts, raw.submissions, 'AAPL', new Date('2028-01-01')).issue, 'stale_data');
  raw.submissions.filings.recent.filingDate[1] = '2099-07-31';
  assert.equal(parseSecFinancials(raw.facts, raw.submissions, 'AAPL', now).issue, 'invalid_response');
});

test('SEC cache deduplicates bounded fixed-host public requests and excludes unsupported markets', async () => {
  const { SecEvidenceService } = load('sec-evidence.service');
  assert.equal(typeof SecEvidenceService, 'function', 'The public SEC fallback service must exist');
  const originalFetch = globalThis.fetch;
  const requests = [];
  const raw = fixture();
  globalThis.fetch = async (url, options) => {
    const value = new URL(String(url));
    requests.push({ url: value, options });
    if (value.pathname.endsWith('/company_tickers.json')) return Response.json({ 0: { cik_str: 320193, ticker: 'AAPL' } });
    return Response.json(value.pathname.includes('/submissions/') ? raw.submissions : raw.facts);
  };
  try {
    const service = new SecEvidenceService();
    const [first, second] = await Promise.all([service.getFinancials('AAPL'), service.getFinancials('AAPL')]);
    assert.equal(first.hasStatements, true);
    assert.deepEqual(first.items, second.items);
    assert.equal(requests.length, 3);
    const cached = await service.getFinancials('AAPL');
    assert.equal(cached.cacheHit, true);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(({ url, options }) => ['www.sec.gov', 'data.sec.gov'].includes(url.hostname)
      && options.redirect === 'error' && !url.search && options.headers['User-Agent'].includes('Squabble')));
    await assert.rejects(service.getFinancials('0700.HK'), { code: 'unsupported_market' });
    await assert.rejects(service.getFinancials('https://127.0.0.1/private'), { code: 'unsupported_market' });
    assert.equal(requests.length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test('SEC transport failures are sanitized and failed requests are briefly cached', async () => {
  const { SecEvidenceService } = load('sec-evidence.service');
  assert.equal(typeof SecEvidenceService, 'function');
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ privateProviderDetails: 'never echo this' }, { status: 429 });
  };
  try {
    const service = new SecEvidenceService();
    for (let index = 0; index < 2; index++) {
      await assert.rejects(service.getFinancials('AAPL'), (error) => {
        assert.equal(error.code, 'rate_limited');
        assert.doesNotMatch(error.message, /never echo|https?:/);
        return true;
      });
    }
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});
