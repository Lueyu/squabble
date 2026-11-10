const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, useLocation } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

function location() { const v = useLocation(); return React.createElement('output', null, v.pathname + v.search); }
async function settle() { await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
async function click(text) { const node = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text || b.getAttribute('aria-label') === text); assert.ok(node, text); await React.act(async () => node.click()); await settle(); }

test('deleting one report needs confirmation, keeps the exact retry receipt, and preserves another version on the list', async () => {
  const f = fixture({ realQuery: true }), calls = [];
  let nextKey = 0; f.state.randomUUID = () => `report-delete-${++nextKey}`;
  const dialog = f.load('components/ui/dialog.tsx');
  dialog.Dialog = ({ open, children }) => open ? React.createElement('section', { role: 'dialog' }, children) : null;
  for (const key of ['DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']) dialog[key] = ({ children }) => React.createElement('div', null, children);
  let rows = [1, 2].map(n => ({ id: 'version-' + n, title: 'Saved version ' + n, version: n, kind: 'daily', createdAt: '2026-11-10T00:00:00Z' }));
  const api = f.load('api/research-documents.ts');
  api.fetchResearchDocuments = async () => ({ items: rows, total: rows.length });
  api.deleteResearchDocumentVersion = async (id, body) => { calls.push({ id, body: structuredClone(body) }); if (calls.length === 1) throw Error('Lost response'); rows = rows.filter(r => r.id !== id); return { id, deleted: true }; };
  const Page = f.load('pages/Analysis/ReportHistoryPage.tsx').default;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, { initialEntries: ['/analysis?date=2026-11-10&offset=30'] }, React.createElement(Page), React.createElement(location)))));
    await settle();
    await click('Delete report Saved version 1'); assert.equal(calls.length, 0);
    assert.match(document.querySelector('[role="dialog"]').textContent, /Other versions, existing trades/);
    await click('Cancel'); assert.equal(calls.length, 0);
    await click('Delete report Saved version 1'); await click('Confirm deletion');
    assert.match(document.querySelector('[role="alert"]').textContent, /unconfirmed/);
    assert.equal(document.querySelectorAll('#report-history ul > li').length, 2);
    await click('Confirm deletion');
    assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0].id, 'version-1'); assert.equal(calls[0].body.expectedVersion, 1);
    assert.equal(document.querySelectorAll('#report-history ul > li').length, 1);
    assert.match(document.querySelector('#report-history ul').textContent, /Saved version 2/);
    assert.equal(document.querySelector('output').textContent, '/analysis?date=2026-11-10&offset=30');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await click('Delete report Saved version 2'); await click('Confirm deletion');
    assert.equal(calls[2].id, 'version-2'); assert.equal(calls[2].body.expectedVersion, 2);
    assert.notDeepEqual(calls[2], calls[0], 'the next deletion keeps its own version identity');
    assert.notEqual(calls[2].body.requestKey, calls[0].body.requestKey);
    assert.equal(document.querySelector('output').textContent, '/analysis?date=2026-11-10', 'deleting the last item returns to the previous page without losing its date');
  } finally { await React.act(async () => root.unmount()); client.clear(); }
});
