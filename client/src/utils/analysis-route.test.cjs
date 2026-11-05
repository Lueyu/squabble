const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../..');
function load(file, imports = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => imports[name] });
  return exports;
}
const agent = (patch = {}) => ({ id: 'codex', name: 'Codex', connected: true, available: true, busy: false, ...patch });
const routeHelpers = () => load('client/src/pages/Analysis/analysis-route.ts', {
  '@/utils/local-agent-settings': load('client/src/utils/local-agent-settings.ts'),
});

test('following the default sends no override but checks the configured route', () => {
  const { analysisRouteOverride, analysisRouteProblem } = routeHelpers();
  const defaultRoute = { mode: 'local', agentId: 'codex' };
  assert.equal(analysisRouteOverride('default', '', undefined), undefined);
  assert.equal(analysisRouteProblem(defaultRoute, [agent({ busy: true })], true), 'agentBusy');
});

test('explicit Basic, API, and local routes preserve the user choice', () => {
  const { analysisRouteOverride } = routeHelpers();
  assert.deepEqual(JSON.parse(JSON.stringify(analysisRouteOverride('basic', '', undefined))), { mode: 'basic' });
  assert.deepEqual(JSON.parse(JSON.stringify(analysisRouteOverride('api', '', undefined))), { mode: 'api' });
  assert.deepEqual(JSON.parse(JSON.stringify(analysisRouteOverride('local', 'codex', { model: 'model-a', reasoningEffort: 'high' }))),
    { mode: 'local', agentId: 'codex', agentSettings: { model: 'model-a', reasoningEffort: 'high' } });
});

test('route validation blocks missing, unavailable, busy, and invalid local choices', () => {
  const { analysisRouteProblem } = routeHelpers();
  const selected = { mode: 'local', agentId: 'codex' };
  assert.equal(analysisRouteProblem({ mode: 'local', agentId: '' }, [agent()], true), 'agentMissing');
  assert.equal(analysisRouteProblem(selected, [], true), 'agentUnavailable');
  assert.equal(analysisRouteProblem(selected, [agent({ connected: false })], true), 'agentUnavailable');
  assert.equal(analysisRouteProblem(selected, [agent({ available: false })], true), 'agentUnavailable');
  assert.equal(analysisRouteProblem(selected, [agent({ busy: true })], true), 'agentBusy');
  assert.equal(analysisRouteProblem({ ...selected, agentSettings: { model: 'x'.repeat(161) } }, [agent()], true), 'modelInvalid');
  assert.equal(analysisRouteProblem({ ...selected, agentSettings: { model: 'model-a' } }, [agent()], true), 'modelUnsupported');
  assert.equal(analysisRouteProblem({ ...selected, agentSettings: { reasoningEffort: 'high' } }, [agent({ reasoningEfforts: ['low'] })], true), 'reasoningInvalid');
  assert.equal(analysisRouteProblem({ mode: 'api' }, [], false), 'apiUnavailable');
  assert.equal(analysisRouteProblem({ mode: 'basic' }, [], false), null);
});

test('portfolio API sends the optional route to one portfolio report run', async () => {
  const calls = [];
  const { createPortfolioReportRun } = load('client/src/api/portfolio-report.ts', {
    './http': { default: async request => { calls.push(request); return { data: { id: 'portfolio-1' } }; } },
  });
  await createPortfolioReportRun('en', { mode: 'basic' });
  await createPortfolioReportRun('zh-CN');
  assert.equal(calls[0].url, '/api/multi-agent/portfolio-runs');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].data)), { language: 'en', route: { mode: 'basic' } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].data)), { language: 'zh-CN' });
});

test('single-stock API preserves a per-run route in the batch body', async () => {
  const calls = [];
  const { runStockAnalysis } = load('client/src/api/analysis-runner.ts', {
    './http': { default: async request => { calls.push(request); return { data: { created: 1, errors: [] } }; } },
  });
  await runStockAnalysis({ scope: 'custom', tiered: false, tickers: ['AAPL'], language: 'en',
    route: { mode: 'local', agentId: 'codex' } });
  assert.equal(calls[0].url, '/api/multi-agent/runs/batch');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].data.route)), { mode: 'local', agentId: 'codex' });
});

test('Daily Analysis route labels and errors exist in both languages', () => {
  const english = require('../i18n/analysis-flow.en.json');
  const chinese = require('../i18n/analysis-flow.zh-CN.json');
  for (const key of ['route', 'followDefault', 'apiRoute', 'localAgent', 'agent', 'chooseAgent', 'agentModel',
    'reasoningEffort', 'agentDefault', 'loadingAgents', 'noAgents', 'manageAgents', 'agentsLoadError', 'unavailable', 'agentBusy']) {
    assert.equal(typeof english[key], 'string');
    assert.equal(typeof chinese[key], 'string');
  }
  assert.deepEqual(Object.keys(english.routeProblems).sort(), Object.keys(chinese.routeProblems).sort());
});
