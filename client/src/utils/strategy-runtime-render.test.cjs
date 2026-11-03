const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');
const ts = require('typescript');
const translations = require('../i18n/strategy.en.json');
let query = {};
const cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} }; cache.set(filename, module);
  const requireModule = id => {
    if (id === '@/api/builder') return { fetchStrategyRuntime: async () => query.data };
    if (id === '@tanstack/react-query') return { useQuery: () => query };
    if (id === 'react-i18next') return { useTranslation: () => ({ i18n: { language: 'en' }, t: (key, values = {}) => {
      const text = key.replace(/^strategy\./, '').split('.').reduce((item, part) => item?.[part], translations) ?? key;
      return String(text).replace(/\{\{(\w+)\}\}/gu, (_, name) => String(values[name] ?? ''));
    } }) };
    if (id.startsWith('@/') || id.startsWith('.')) {
      const target = id.startsWith('@/') ? path.resolve(__dirname, '..', id.slice(2)) : path.resolve(path.dirname(filename), id);
      const resolved = [target, `${target}.tsx`, `${target}.ts`].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
      if (resolved) return load(resolved);
    }
    return require(id);
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText, { exports: module.exports, module, require: requireModule });
  return module.exports;
}
const Component = load(path.resolve(__dirname, '../pages/AgentBuilder/StrategyRuntimeCard.tsx')).default;
const profile = { id: 'p1', version: 3, status: 'active', config: { automation: { enabled: true, monitorSeconds: 60 } } };
const market = { market: 'US', marketDate: '2026-11-03', state: 'blocked', lastCheckAt: null,
  nextDiscussionAt: null, lastQuoteAt: null, reason: 'Market data unavailable.', currentPlan: null };
const runtime = { profileVersion: 3, markets: [market], notification: { pending: 1, failed: 2, lastDeliveredAt: null } };
const render = p => renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Component, { profile: p ?? profile })));

test('runtime errors hide cached monitoring data and show an actionable failure', () => {
  query = { isError: true, data: { ...runtime, markets: [{ ...market, state: 'monitoring', lastCheckAt: new Date().toISOString() }] } };
  const html = render();
  assert.match(html, /Could not load runtime status/);
  assert.doesNotMatch(html, />Monitoring</);
});
test('runtime shows blocked reason and independent delivery failures', () => {
  query = { data: runtime };
  const html = render();
  assert.match(html, /Execution blocked/);
  assert.match(html, /Market data unavailable/);
  assert.match(html, /Delivery failed: 2/);
});
test('plans expose expiry, collapsed trigger detail and matching research links', () => {
  query = { data: { ...runtime, markets: [{ ...market, currentPlan: { version: 2,
    expiresAt: '2026-11-03T21:00:00Z', summary: 'Wait for a supported entry.', sessionIds: ['room-123'],
    rules: [{ id: 'r1', ticker: 'EXAMPLE', side: 'buy', trigger: { kind: 'price_below', value: 10 },
      minPrice: 9, maxPrice: 10, stopLossPrice: 8, maxPositionPct: 4, rationale: 'A fixture, not a live recommendation.' }] } }] } };
  const html = render();
  assert.match(html, /Valid until/);
  assert.match(html, /href="\/council\?session=room-123"/);
  assert.match(html, /Protective stop price/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:[= >])/);
});
