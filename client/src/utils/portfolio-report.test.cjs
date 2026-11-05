const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function load(file, imports = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => imports[name] });
  return exports;
}

test('portfolio run API starts one report and reads its lifecycle separately from stock batches', async () => {
  const calls = [];
  const run = { id: 'portfolio-1', status: 'pending' };
  const api = load('api/portfolio-report.ts', { './http': { default: async request => {
    calls.push(request);
    return { data: request.method === 'GET' && request.params ? { items: [run] } : run };
  } } });
  assert.equal((await api.createPortfolioReportRun('en', { mode: 'basic' })).id, run.id);
  assert.equal((await api.listPortfolioReportRuns(5)).items[0].id, run.id);
  assert.equal((await api.getPortfolioReportRun(run.id)).id, run.id);
  await api.cancelPortfolioReportRun(run.id);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { url: '/api/multi-agent/portfolio-runs', method: 'POST', data: { language: 'en', route: { mode: 'basic' } } },
    { url: '/api/multi-agent/portfolio-runs', method: 'GET', params: { limit: 5 } },
    { url: '/api/multi-agent/portfolio-runs/portfolio-1', method: 'GET' },
    { url: '/api/multi-agent/portfolio-runs/portfolio-1/cancel', method: 'POST' },
  ]);
});

test('portfolio run API omits the route when following the saved default', async () => {
  const calls = [];
  const api = load('api/portfolio-report.ts', { './http': { default: async request => {
    calls.push(request);
    return { data: { id: 'portfolio-2' } };
  } } });
  await api.createPortfolioReportRun('zh-CN');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].data)), { language: 'zh-CN' });
});

test('portfolio report helpers identify active runs and preserve server supplied gaps', () => {
  const { isPortfolioReportActive, portfolioReportSections } = load('utils/portfolio-report.ts');
  assert.equal(isPortfolioReportActive('pending'), true);
  assert.equal(isPortfolioReportActive('running'), true);
  assert.equal(isPortfolioReportActive('cancelling'), true);
  for (const status of ['completed', 'failed', 'cancelled']) assert.equal(isPortfolioReportActive(status), false);
  const sections = portfolioReportSections({
    summary: 'Portfolio summary', allocationRisks: ['Concentration'], actions: ['Review'],
    uncertainties: ['Earnings'], dataGaps: ['Missing quote'],
    holdings: [{ ticker: 'AAPL', stance: 'hold', rationale: 'Evidence', evidenceRefs: ['Source'], triggers: ['Event'] }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(sections)), [
    { key: 'allocationRisks', values: ['Concentration'] },
    { key: 'actions', values: ['Review'] },
    { key: 'uncertainties', values: ['Earnings'] },
    { key: 'dataGaps', values: ['Missing quote'] },
  ]);
});

test('holding data gaps come from its frozen snapshot fields and named snapshot gaps', () => {
  const { holdingDataGaps } = load('utils/portfolio-report.ts');
  const snapshot = { holdings: [{ ticker: 'AAPL', currentPrice: null, costPrice: 20, marketValueUsd: null, weightPct: null }],
    gaps: ['AAPL quote stale', 'portfolio cash unavailable', 'MSFT price missing'] };
  assert.deepEqual(JSON.parse(JSON.stringify(holdingDataGaps(snapshot, 'AAPL'))),
    ['currentPrice', 'marketValueUsd', 'weightPct', 'AAPL quote stale']);
});

test('an active portfolio run stays visible ahead of a newer finished report', () => {
  const { visiblePortfolioRun } = load('utils/portfolio-report.ts');
  const runs = [{ id: 'newer', status: 'completed' }, { id: 'older', status: 'running' }];
  assert.equal(visiblePortfolioRun(runs).id, 'older');
  assert.equal(visiblePortfolioRun([runs[0]]).id, 'newer');
  assert.equal(visiblePortfolioRun([]), undefined);
});

test('recent portfolio reports stay reachable below the visible run', () => {
  const { recentPortfolioReports } = load('utils/portfolio-report.ts');
  const runs = [
    { id: 'active', status: 'running', report: null },
    { id: 'new', status: 'completed', report: { summary: 'new' } },
    { id: 'failed', status: 'failed', report: null },
    { id: 'old', status: 'completed', report: { summary: 'old' } },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(recentPortfolioReports(runs, 'active'))).map(run => run.id), ['new', 'old']);
  assert.deepEqual(JSON.parse(JSON.stringify(recentPortfolioReports(runs, 'new'))).map(run => run.id), ['old']);
});

test('evidence facts resolve citations to values from the frozen snapshot', () => {
  const { portfolioEvidenceFact } = load('utils/portfolio-report.ts');
  const snapshot = {
    holdings: [{ ticker: 'AAPL', shares: 10, currentPrice: 150, costPrice: 100,
      marketValueUsd: 1500, weightPct: 25 }],
    cashUsd: 500, totalValueUsd: 2000,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(portfolioEvidenceFact('holding:AAPL:weightPct', snapshot))),
    { subject: 'AAPL', field: 'weightPct', value: 25 });
  assert.deepEqual(JSON.parse(JSON.stringify(portfolioEvidenceFact('portfolio:cashUsd', snapshot))),
    { subject: 'portfolio', field: 'cashUsd', value: 500 });
  assert.equal(portfolioEvidenceFact('holding:MSFT:weightPct', snapshot), null);
});

test('portfolio report labels are present in English and Chinese', () => {
  const english = require('../i18n/analysis-flow.en.json').portfolio;
  const chinese = require('../i18n/analysis-flow.zh-CN.json').portfolio;
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
  for (const key of ['title', 'summary', 'allocationRisks', 'actions', 'uncertainties', 'dataGaps',
    'holdings', 'rationale', 'evidence', 'triggers', 'status', 'empty', 'openReport', 'recentReports']) {
    assert.equal(typeof english[key], 'string');
    assert.equal(typeof chinese[key], 'string');
  }
  for (const field of ['shares', 'currentPrice', 'costPrice', 'marketValueUsd', 'weightPct', 'cashUsd', 'totalValueUsd']) {
    assert.equal(typeof english.fact[field], 'string');
    assert.equal(typeof chinese.fact[field], 'string');
  }
});

test('portfolio report content renders every required conclusion and holding detail', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const helper = load('utils/portfolio-report.ts');
  const { default: Content } = load('components/MultiAgent/PortfolioReportContent.tsx', {
    'react/jsx-runtime': require('react/jsx-runtime'),
    '@/utils/portfolio-report': helper,
  });
  const report = {
    summary: 'Summary conclusion', allocationRisks: ['Concentration risk'], actions: ['Trim position'],
    uncertainties: ['Uncertain earnings'], dataGaps: ['Price missing'],
    holdings: [{ ticker: 'AAPL', stance: 'hold', rationale: 'Strong cash flow',
      evidenceRefs: ['holding:AAPL:weightPct'], triggers: ['Next earnings'] }],
  };
  const snapshot = { holdings: [{ ticker: 'AAPL', currentPrice: null, costPrice: 20, marketValueUsd: 100, weightPct: 25 }], gaps: [] };
  const html = renderToStaticMarkup(React.createElement(Content, { report, snapshot, t: key => key }));
  for (const phrase of ['Summary conclusion', 'Concentration risk', 'Trim position', 'Uncertain earnings',
    'Price missing', 'AAPL', 'Strong cash flow', 'Next earnings', 'analysisFlow.portfolio.field.currentPrice',
    'analysisFlow.portfolio.fact.weightPct', '25%', 'holding:AAPL:weightPct']) {
    assert.ok(html.includes(phrase), `${phrase} missing`);
  }
});

test('portfolio report has a dedicated browser route', () => {
  const routes = fs.readFileSync(path.resolve(__dirname, '..', 'app.tsx'), 'utf8');
  assert.match(routes, /path="analysis\/portfolio-report\/:runId"/);
  assert.match(routes, /element=\{<PortfolioReportPage \/>\}/);
});

test('Daily Analysis links to recent completed portfolio reports', () => {
  const runner = fs.readFileSync(path.resolve(__dirname, '..', 'pages', 'Analysis', 'AnalysisRunner.tsx'), 'utf8');
  assert.match(runner, /recentPortfolioReports\(portfolioRuns\.data\?\.items/);
  assert.match(runner, /analysisFlow\.portfolio\.recentReports/);
  assert.match(runner, /analysis\/portfolio-report\/\$\{encodeURIComponent\(run\.id\)\}/);
});
