const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/import?accountId=real' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');

function csvPage() {
  let cursor = 0, refCursor = 0;
  const states = [], refs = [], calls = [];
  const jsx = (type, props) => ({ type, props: props ?? {} });
  function ImportSavedNextSteps() {}
  const imports = {
    react: {
      useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
      useRef(initial) { return refs[refCursor++] ??= { current: initial }; },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-router-dom': { useNavigate: () => path => calls.push(['navigate', path]) },
    'react-i18next': { useTranslation: () => ({ t: key => key, i18n: { language: 'zh-CN' } }) },
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries: async () => {} }) },
    '@/api/import-batches': {
      IMPORT_QUERY_KEYS: [['holdings']],
      confirmMappedImport: async value => { calls.push(['commit', value]); return { created: 1, skipped: 0, failed: [], receiptId: 'saved-receipt' }; },
    },
    './ImportSavedNextSteps': { ImportSavedNextSteps },
    papaparse: require('papaparse'),
    sonner: { toast: { warning() {}, info() {}, success() {}, error() {} } },
  };
  for (const module of ['button', 'card', 'input', 'label', 'badge']) imports[`@/components/ui/${module}`] = new Proxy({}, { get: (_, key) => String(key) });
  imports['lucide-react'] = new Proxy({}, { get: (_, key) => String(key) });
  const mod = { exports: {} };
  const source = fs.readFileSync(path.resolve(__dirname, '../pages/Import/ImportPage.tsx'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText + '\nexports.CsvImport = CsvImport;', {
    module: mod, exports: mod.exports, require: name => imports[name] ?? {},
    crypto: { randomUUID: () => 'stable-save-request' },
    FileReader: class { readAsText(file) { this.result = file.content; this.onload(); } },
  });
  return { calls, render() { cursor = 0; refCursor = 0; return mod.exports.CsvImport(); } };
}
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : []; }
function content(tree) { return Array.isArray(tree) ? tree.map(content).join('') : tree && typeof tree === 'object' ? content(tree.props?.children) : tree == null ? '' : String(tree); }
function loadedCsv() {
  const page = csvPage();
  nodes(page.render()).find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [{ name: 'fictional.csv', content: 'ticker,shares,avgcost\nFICT,2,20' }] } });
  return page;
}

test('CSV primary save persists reviewed holdings with zero research scheduling and offers a separate next step', async () => {
  const page = loadedCsv();
  const button = nodes(page.render()).find(node => node.type === 'Button' && content(node) === '保存持仓');
  assert.ok(button, 'saving must be the primary action');
  await button.props.onClick();
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0][0], 'commit');
  assert.equal(page.calls[0][1].analyze, false);
  assert.equal(page.calls[0][1].rows[0].ticker, 'FICT');
  assert.ok(nodes(page.render()).some(node => node.type?.name === 'ImportSavedNextSteps'));
});

test('CSV research is an explicit action using the durable import handoff and its existing report route', async () => {
  const page = loadedCsv();
  const button = nodes(page.render()).find(node => node.type === 'Button' && content(node) === '保存并开始研究');
  assert.ok(button);
  await button.props.onClick();
  assert.equal(page.calls[0][1].analyze, true);
  assert.deepEqual(page.calls[1], ['navigate', '/research/portfolio']);
});

test('saved import continuation preserves an editor return target while direct import offers friends first', () => {
  const f = fixture();
  const { ImportSavedNextSteps } = f.load('pages/Import/ImportSavedNextSteps.tsx');
  const render = entry => renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [entry] }, React.createElement(ImportSavedNextSteps)));
  const direct = render('/import?accountId=real');
  assert.match(direct, /href="\/friends"/);
  assert.match(direct, /Next: meet your agents/);
  const contextual = render({ pathname: '/import', search: '?accountId=real', state: { returnTo: '/holdings?accountId=real&q=FICT#cash' } });
  assert.match(contextual, /href="\/holdings\?accountId=real&amp;q=FICT#cash"/);
  assert.match(contextual, /Return to previous page/);
  assert.match(contextual, /href="\/friends"/);
  assert.match(render('/import?accountId=real&returnTo=%2Fholdings%3FaccountId%3Dreal%26q%3DFICT%23cash'), /href="\/holdings\?accountId=real&amp;q=FICT#cash"/);
  const unsafe = render('/import?returnTo=%2F%2Fevil.test');
  assert.doesNotMatch(unsafe, /evil\.test/);
  f.state.language = 'zh-CN';
  assert.match(render('/import?accountId=real'), /下一步：认识股友/);
});

async function importDom(kind, { failure = new Error('Lost response'), settleOnRead = false } = {}, run) {
  const records = new Map(['one', 'two'].map(id => [id, {
    id, revision: 3, status: 'completed', createdAt: '2026-11-06T00:00:00Z',
    executor: { executor: 'local', agentId: 'fixture' }, receipts: [],
    images: [{ id: 'image', filename: `${id}.png`, status: 'completed', fileAvailable: true }],
    rows: [{ id: 'row', ticker: 'FICT', shares: 2, avgCost: 20, sourceImageIds: ['image'], revision: 0, confirmed: true }],
  }]));
  const calls = [], messages = []; let sequence = 0, attempted = false, pending;
  const clone = value => JSON.parse(JSON.stringify(value));
  const http = {
    async get(url) {
      calls.push({ method: 'GET', url });
      if (url === '/api/import/batches') return { data: clone([...records.values()]) };
      const id = url.split('/')[4];
      if (url.endsWith('/preview')) return { data: { holdingsRevision: 'holdings-original', changes: [] } };
      if (settleOnRead && pending?.id === id) {
        const batch = records.get(id);
        batch.receipts.push({ id: 'saved', requestKey: pending.input.requestKey, rowIds: pending.input.rowIds, created: 1, updated: 0 });
        batch.rows[0].committedRevision = batch.rows[0].revision;
        pending = null;
      }
      return { data: clone(records.get(id)) };
    },
    async post(url, input) {
      calls.push({ method: 'POST', url, input: clone(input) });
      const id = url.split('/')[4];
      if (url.endsWith('/commit')) {
        if (!attempted) { attempted = true; pending = { id, input: clone(input) }; throw failure; }
        return { data: { id: 'saved', receiptId: 'saved', requestKey: input.requestKey, created: 1, updated: 0, skipped: 0, failed: [] } };
      }
      if (url.includes('/rows/')) {
        const batch = records.get(id); Object.assign(batch.rows[0], input.patch); batch.revision++;
        return { data: clone(batch) };
      }
      throw Error(`Unexpected fixture POST ${url}`);
    },
  };
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const ui = tag => ({ children, ...props }) => React.createElement(tag, props, children);
  const imports = {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'),
    '@tanstack/react-query': require('@tanstack/react-query'),
    'react-router-dom': { ...require('react-router-dom'), useNavigate: () => destination => calls.push({ method: 'NAVIGATE', destination }) },
    'react-i18next': { useTranslation: () => ({ t: key => key, i18n: { language: 'zh-CN' } }) },
    '@/api/local-agents': { fetchLocalAgents: async () => [] },
    '@/utils/local-agent-settings': { cleanAgentSettings: value => value, agentSettingsProblem: () => null },
    './screenshot-import': { loadScreenshotProvider: () => ({ model: '', baseUrl: '', apiKey: '' }), preferredScreenshotAgent: () => null },
    './ImportSavedNextSteps': { ImportSavedNextSteps: () => React.createElement('p', null, 'Saved next steps') },
    './ScreenshotImport': { __esModule: true, default: () => null }, './TransactionImport': { __esModule: true, default: () => null },
    '@/features/assets/AccountAssetsPage': { ImportAccountBoundary: ({ children }) => children },
    '@/api': { fetchImportHistory: async () => [] }, papaparse: require('papaparse'),
    sonner: { toast: Object.fromEntries(['warning', 'info', 'success', 'error'].map(method => [method, text => messages.push(text)])) },
  };
  for (const [name, values] of Object.entries({ button: { Button: ui('button') }, input: { Input: ui('input') }, label: { Label: ui('label') }, badge: { Badge: ui('span') }, card: Object.fromEntries(['Card', 'CardContent', 'CardHeader', 'CardTitle'].map(key => [key, ui('div')])) })) imports[`@/components/ui/${name}`] = values;
  imports['lucide-react'] = new Proxy({}, { get: () => () => null });
  const compile = (relative, extra = '', dependencies = imports) => {
    const mod = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText + extra, {
      module: mod, exports: mod.exports, require: name => dependencies[name] ?? {}, Date, Map, Set,
      crypto: { randomUUID: () => `fixture-${++sequence}` },
      localStorage: window.localStorage,
      FileReader: class { readAsText(file) { this.result = file.content; this.onload(); } },
    }); return mod.exports;
  };
  imports['@/api/import-batches'] = compile('api/import-batches.ts', '', { './http': { __esModule: true, default: http } });
  imports['./ScreenshotImport'] = compile('pages/Import/ScreenshotImport.tsx');
  const Component = kind === 'csv' ? compile('pages/Import/ImportPage.tsx', '\nexports.CsvImport = CsvImport;').CsvImport
    : kind === 'hub' ? compile('pages/Import/ImportPage.tsx', '\nexports.RealImportPage = RealImportPage;').RealImportPage : imports['./ScreenshotImport'].default;
  const root = createRoot(document.getElementById('root'));
  const flush = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text);
  const click = async text => { const node = button(text); assert.ok(node, `Missing ${text}`); assert.equal(node.disabled, false, `${text} should be enabled`); await React.act(async () => node.click()); await flush(); };
  const change = async (node, value) => React.act(async () => { Object.getOwnPropertyDescriptor(node.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client: query }, React.createElement(MemoryRouter, { initialEntries: ['/import?accountId=real'] }, React.createElement(Component)))));
    await flush();
    if (kind === 'hub') await click('import.csvFile');
    if (kind === 'csv' || kind === 'hub') await React.act(async () => { const input = document.querySelector('input[type=file]'); Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'fictional.csv', content: 'ticker,shares,avgcost\nFICT,2,20' }] }); input.dispatchEvent(new window.Event('change', { bubbles: true })); });
    for (let attempt = 0; kind === 'screenshot' && attempt < 15 && (!button('保存持仓') || button('保存持仓').disabled); attempt++) await flush();
    await run({ calls, messages, button, click, change, query });
  } finally { await React.act(async () => root.unmount()); query.clear(); }
}

for (const kind of ['csv', 'screenshot']) for (const status of [undefined, 408, 429, 503]) test(`${kind} unknown save (${status ?? 'network'}) fixes the original payload and blocks research and edits until recovery`, async () => {
  const failure = status ? { response: { status, data: { message: 'TEMPORARY' } } } : new Error('Lost response');
  await importDom(kind, { failure }, async ({ calls, button, click, change }) => {
    await click('保存持仓');
    assert.equal(button('保存并开始研究').disabled, true);
    assert.match(document.body.textContent, /先核对本次保存结果/);
    if (kind === 'csv') {
      assert.equal(document.querySelector('input[type=date]').disabled, true);
      assert.ok([...document.querySelectorAll('select')].every(node => node.disabled));
      assert.equal(document.querySelector('input[type=file]').disabled, true);
      await change(document.querySelector('input[type=date]'), '2026-11-12');
    } else {
      assert.equal(button('新的一组截图').disabled, true);
      assert.equal(document.querySelector('[aria-label="选择截图批次"]').disabled, true);
      assert.equal(document.getElementById('import-row-shares').disabled, true);
      assert.equal(button('重新确认').disabled, true);
      await change(document.getElementById('import-row-shares'), '99');
      await React.act(async () => { button('重新确认').click(); button('新的一组截图').click(); });
      await change(document.querySelector('[aria-label="选择截图批次"]'), 'two');
    }
    await click('核对本次保存结果');
    const commits = calls.filter(call => call.method === 'POST' && call.url.endsWith('/commit'));
    assert.equal(commits.length, 2);
    assert.equal(commits[0].url, commits[1].url);
    assert.deepEqual(commits[0].input, commits[1].input);
    assert.equal(commits[1].input.analyze, false);
    assert.equal(calls.some(call => call.method === 'NAVIGATE'), false);
    assert.equal(button('保存并开始研究').disabled, false);
  });
});

for (const kind of ['csv', 'screenshot']) test(`${kind} a definite 422 rejection allows correcting the data and a fresh explicit research request`, async () => {
  await importDom(kind, { failure: { response: { status: 422, data: { message: 'INVALID_ROWS' } } } }, async ({ calls, button, click, change }) => {
    await click('保存持仓');
    assert.equal(button('保存并开始研究').disabled, false);
    if (kind === 'csv') await change(document.querySelector('input[type=date]'), '2026-11-12');
    else { await change(document.getElementById('import-row-shares'), '3'); await click('保存核对修改'); }
    await click('保存并开始研究');
    const commits = calls.filter(call => call.method === 'POST' && call.url.endsWith('/commit'));
    assert.notEqual(commits[0].input.requestKey, commits[1].input.requestKey);
    assert.equal(commits[1].input.analyze, true);
    assert.ok(calls.some(call => call.method === 'NAVIGATE' && call.destination === '/research/portfolio'));
  });
});

test('screenshot recovery reads the original batch receipt before considering an identical retry', async () => {
  await importDom('screenshot', { settleOnRead: true }, async ({ calls, button, click }) => {
    await click('保存持仓');
    await click('核对本次保存结果');
    assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/commit')).length, 1);
    assert.equal(button('新的一组截图').disabled, false);
    assert.match(document.body.textContent, /Saved next steps/);
  });
});

for (const kind of ['csv', 'screenshot']) test(`${kind} recovering an explicit research save keeps its original choice and report route`, async () => {
  await importDom(kind, {}, async ({ calls, button, click }) => {
    await click('保存并开始研究');
    assert.equal(button('保存持仓').disabled, true);
    await click('核对本次保存结果');
    const commits = calls.filter(call => call.method === 'POST' && call.url.endsWith('/commit'));
    assert.deepEqual(commits[0].input, commits[1].input);
    assert.equal(commits[1].input.analyze, true);
    assert.ok(calls.some(call => call.method === 'NAVIGATE' && call.destination === '/research/portfolio'));
  });
});

test('an unresolved CSV save keeps the import hub from unmounting its original intent', async () => {
  await importDom('hub', {}, async ({ button, click }) => {
    await click('保存持仓');
    assert.equal(button('import.screenshot').disabled, true);
    assert.equal(button('import.csvFile').disabled, true);
    await click('核对本次保存结果');
    assert.equal(button('import.screenshot').disabled, false);
  });
});
