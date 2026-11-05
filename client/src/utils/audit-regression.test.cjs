// Component regression checks with isolated hook and API doubles.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const results = [];

function harness(file, options = {}) {
  const states = [];
  let cursor = 0;
  const effects = [];
  const effectDeps = [];
  let effectCursor = 0;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = options.seed && i in options.seed ? options.seed[i] : typeof initial === 'function' ? initial() : initial;
      return [states[i], (next) => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
    },
    useEffect(fn, deps) {
      const i = effectCursor++;
      if (!deps || !effectDeps[i] || deps.some((value, index) => value !== effectDeps[i][index])) effects.push(fn);
      effectDeps[i] = deps;
    },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    useRef(value) { return { current: value }; },
  };
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const fallback = (name) => new Proxy({ __esModule: true, default: name.split('/').at(-1) }, { get(target, property) { return property in target ? target[property] : String(property); } });
  const imports = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-i18next': { useTranslation: () => ({ t: (key) => key, i18n: { language: 'en' } }) },
    'react-router-dom': { useNavigate: () => () => {}, Link: 'Link' },
    sonner: { toast: { success() {}, error() {}, info() {} } },
    '@/utils/format': {
      formatDate: (d) => String(d), formatPercent: String, formatPrice: String,
      formatCurrency: (v) => '$' + Number(v).toFixed(2),
      formatCurrencyWithCode: String, formatCurrencyWithCurrency: (v, c) => c + Number(v).toFixed(2),
      formatShares: String, plClass: () => '', cn: (...v) => v.join(' '),
      toDate: (v) => v ? new Date(v) : null,
    },
    '@/hooks/use-market-quotes': { useMarketQuotes: () => ({ quotes: {}, marketStatus: {}, marketErrors: {}, refresh() {} }) },
    '@/hooks/use-simple-experience': { useSimpleExperience: () => ({ enabled: false }) },
    './JournalSectionCard': {
      JournalSectionCard: 'JournalSectionCard',
      sections: ['marketSummary', 'portfolioSummary', 'actions', 'plan', 'lessons'].map((key) => ({ key })),
    },
    '@/api': options.api || {},
    ...options.imports,
  };
  let source = read(file);
  if (options.append) source += options.append;
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require: (name) => imports[name] || fallback(name), Date, Object, Array, String, Number, Set, Map, parseFloat, isNaN, isFinite, URLSearchParams, window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }, setTimeout: () => 0, clearTimeout() {} }, { filename: file });
  return {
    states,
    exports,
    render(props, component = exports.default) { cursor = 0; effectCursor = 0; effects.length = 0; return component(props); },
    async runEffects() { for (const effect of effects.splice(0)) await effect(); await Promise.resolve(); await Promise.resolve(); },
  };
}
function all(tree) {
  if (Array.isArray(tree)) return tree.flatMap(all);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...all(tree.props?.children)];
}
function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(''); if (tree == null) return ''; return typeof tree === 'object' ? text(tree.props?.children) : String(tree); }
function button(tree, label) { const found = all(tree).find((n) => n.type === 'Button' && text(n).includes(label)); assert.ok(found, 'Button missing: ' + label); return found; }
function node(tree, type) { const found = all(tree).find((n) => n.type === type); assert.ok(found, 'Node missing: ' + type); return found; }

async function main() {
  // 1. Actual Watchlist DetailDialog retains state when externally controlled props open a new item.
  const writes = [];
  const watch = harness('client/src/pages/Watchlist/DetailDialog.tsx', { api: { updateWatchItem: async (id, payload) => writes.push({ id, payload }) } });
  const common = { onOpenChange() {}, onUpdated() {}, onDeleted() {} };
  watch.render({ ...common, open: false, item: null });
  const itemA = { id: 'audit-a', ticker: 'AAA', company: 'Alpha Company', sector: 'Technology', targetBuy: '100', analysis: 'Alpha thesis' };
  let tree = watch.render({ ...common, open: true, item: itemA });
  await watch.runEffects();
  tree = watch.render({ ...common, open: true, item: itemA });
  button(tree, 'common.edit').props.onClick();
  tree = watch.render({ ...common, open: true, item: itemA });
  const empty = node(tree, 'WatchForm').props.data;
  assert.equal(empty.company, itemA.company);
  node(tree, 'WatchForm').props.onChange({ ...empty, company: 'Alpha edited', analysis: 'Draft for AAA' });
  tree = watch.render({ ...common, open: true, item: itemA });
  node(tree, 'Dialog').props.onOpenChange(false);
  watch.render({ ...common, open: false, item: itemA });
  const itemB = { ...itemA, id: 'audit-b', ticker: 'BBB', company: 'Beta Company', analysis: 'Beta thesis' };
  tree = watch.render({ ...common, open: true, item: itemB });
  await watch.runEffects();
  tree = watch.render({ ...common, open: true, item: itemB });
  button(tree, 'common.edit').props.onClick();
  tree = watch.render({ ...common, open: true, item: itemB });
  assert.equal(node(tree, 'WatchForm').props.data.analysis, 'Beta thesis');
  results.push({ finding: 'watchlist-form-state', initiallyDisplayedCompany: empty.company, selectedCompany: itemB.company, savedStaleDraft: writes.length });

  // 2. Actual Journal handlers send the old draft with the newly selected date.
  const journalWrites = [];
  const entries = [
    { id: 'j-a', journalDate: '2026-11-02', marketSummary: 'Monday summary' },
    { id: 'j-b', journalDate: '2026-11-01', marketSummary: 'Sunday original' },
  ];
  const journal = harness('client/src/pages/Journal/JournalPage.tsx', {
    seed: { 0: new Date(2026, 10, 2) },
    api: { fetchJournal: async () => entries, fetchSnapshots: async () => [], logger: { error() {} } },
    imports: { '@/api/http': { __esModule: true, default: async ({ data }) => { journalWrites.push(data); return { data }; } } },
  });
  journal.render();
  await journal.runEffects();
  tree = journal.render();
  button(tree, 'ui.journal.editJournal').props.onClick();
  tree = journal.render();
  node(tree, 'DateNavigator').props.onPrev();
  tree = journal.render();
  await button(tree, 'common.save').props.onClick();
  assert.equal(journalWrites[0].journalDate, '2026-11-02');
  assert.equal(journalWrites[0].marketSummary, 'Monday summary');
  results.push({ finding: 'journal-cross-date-write', savedDate: journalWrites[0].journalDate });

  // 3. Actual HoldingsPage comparator renders numeric strings in lexical descending order.
  const holdings = ['2', '10', '100'].map((shares, i) => ({ id: String(i), ticker: 'AUDIT' + i, company: 'Fixture', shares, buyPrice: shares, currentPrice: shares, market: 'US', marketValue: Number(shares) ** 2, cost: 1, pl: 0, returnPct: 0 }));
  const holding = harness('client/src/pages/Holdings/HoldingsPage.tsx', { seed: { 0: holdings, 2: false } });
  tree = holding.render();
  node(tree, 'HoldingsTable').props.onSort('shares');
  tree = holding.render();
  const sorted = node(tree, 'HoldingsTable').props.holdings.map((h) => h.shares);
  assert.equal(JSON.stringify(sorted), JSON.stringify(['100', '10', '2']));
  results.push({ finding: 'holdings-numeric-string-sort', column: 'shares', direction: 'desc', actual: sorted, expected: ['100', '10', '2'] });

  // 4. Actual RealizedPlContent sums unlike currencies and labels the result USD.
  const transaction = harness('client/src/pages/Transactions/TransactionsPage.tsx', { append: '\nexport { RealizedPlContent };' });
  tree = transaction.render({ summary: { totalByCurrency: { USD: '100', HKD: '780', CNY: '0' }, items: [], totalWinners: 2, totalLosers: 0 }, onAddClosed() {} }, transaction.exports.RealizedPlContent);
  assert.ok(text(tree).includes('USD100.00'));
  assert.ok(text(tree).includes('HKD780.00'));
  assert.ok(!text(tree).includes('USD880.00'));
  const single = transaction.render({ summary: { totalByCurrency: { USD: '0', HKD: '780', CNY: '0' }, items: [], totalWinners: 1, totalLosers: 0 }, onAddClosed() {} }, transaction.exports.RealizedPlContent);
  assert.ok(text(single).includes('HKD780.00'));
  assert.ok(!text(single).includes('ui.tx.byCurrency'));
  results.push({ finding: 'realized-pl-currency', displayed: 'USD100.00 and HKD780.00' });

  // 5. Verify the page sends no pagination/limit, and only sees the first 100 API rows.
  const txCalls = [];
  const txRows = Array.from({ length: 101 }, (_, i) => ({ id: String(i), ticker: 'AAA', txType: 'Buy', txDate: '2026-11-02', shares: '1', price: '10', fees: '0', currency: 'USD' }));
  const page = harness('client/src/pages/Transactions/TransactionsPage.tsx', { api: {
    fetchTransactions: async (params) => { txCalls.push(params); return txRows.slice(params?.offset ?? 0, (params?.offset ?? 0) + (params?.limit ?? 100)); },
    fetchClosed: async () => [], fetchRealizedPlSummary: async () => ({ items: [], totalByCurrency: {} }),
  } });
  page.render(); await page.runEffects(); tree = page.render();
  assert.equal(txCalls[0].offset, 0);
  assert.equal(page.states[0].length, 100);
  await button(tree, 'common.loadMore').props.onClick();
  tree = page.render();
  assert.equal(txCalls[1].offset, 100);
  assert.equal(page.states[0].length, 101);
  const controller = read('server/modules/transactions/transactions.controller.ts');
  assert.ok(controller.includes('const limitNum = limit ? Math.min(parseInt(limit, 10), 500) : 100;'));
  results.push({ finding: 'transactions-pagination', fixtureRows: 101, storedRows: page.states[0].length });

  const importSource = read('client/src/pages/Import/ImportPage.tsx');
  const importStart = importSource.indexOf('type MapField =');
  const importEnd = importSource.indexOf('/** localStorage helpers');
  const importJs = ts.transpileModule(importSource.slice(importStart, importEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const importCases = [];
  vm.runInNewContext(importJs + `
    const average = suggestForPreset(['Symbol', 'Quantity', 'Average Cost'], 'robinhood');
    const total = suggestForPreset(['Symbol', 'Quantity', 'Total Cost'], 'generic');
    importCases.push(rowsFromMatrix([['AAPL', '10', '150']], average)[0].avgCost);
    importCases.push(rowsFromMatrix([['AAPL', '10', '1500']], total)[0].avgCost);
  `, { importCases });
  assert.equal(importCases[0], 150);
  assert.equal(importCases[1], null);
  results.push({ finding: 'import-cost-mapping', averageCost: importCases[0], totalCost: importCases[1] });

  process.stdout.write(JSON.stringify(results, null, 2));
}
main().catch((e) => { process.stderr.write(e.stack + '\n'); process.exitCode = 1; });
