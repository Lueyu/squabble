const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

function setup() {
  const f = fixture({ realQuery: true });
  const dialog = f.load('components/ui/dialog.tsx');
  dialog.Dialog = ({ open, children }) => open ? React.createElement('div', null, children) : null;
  for (const name of ['DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']) dialog[name] = ({ children }) => React.createElement('div', null, children);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const root = createRoot(document.getElementById('root'));
  const render = async (Page, props = {}) => React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(Page, props)))));
  const flush = async () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const close = async () => { await React.act(async () => root.unmount()); client.clear(); };
  return { f, render, flush, close };
}
const button = text => [...document.querySelectorAll('button')].find(item => item.textContent === text);
async function change(input, value) {
  await React.act(async () => {
    const prototype = input.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

test('website creation sends explicit format and authorization once; error rendering never exposes request secrets', async () => {
  const { f, render, flush, close } = setup();
  const attempts = [];
  let fail = true, closed = false;
  f.load('api/data-library.ts').dataLibraryApi.create = async body => {
    attempts.push(body);
    if (fail) throw { response: { status: 400 }, message: 'private-fixture-secret', config: { data: body } };
    return { id: 'saved-source' };
  };
  const Page = f.load('features/data-library/SourceForm.tsx').default;
  try {
    await render(Page, { subscription: true, onClose() { closed = true; } });
    await change(document.querySelector('input[maxlength]'), 'Fictional subscribed research');
    await change(document.querySelector('input[type="url"]'), 'https://example.com/research');
    await change([...document.querySelectorAll('select')].at(-1), 'cookie');
    await change(document.querySelector('input[type="password"]'), 'private-fixture-secret');
    await React.act(async () => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].kind, 'website');
    assert.equal(attempts[0].authKind, 'cookie');
    assert.equal(attempts[0].credential, 'private-fixture-secret');
    assert.equal(attempts[0].syncIntervalMinutes, 1440);
    assert.equal(closed, false);
    assert.match(document.querySelector('[role="alert"]').textContent, /did not complete/);
    assert.doesNotMatch(document.body.textContent, /private-fixture-secret/);
    fail = false;
    await React.act(async () => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    assert.equal(closed, true);
    assert.equal(attempts.length, 2);
  } finally { await close(); }
});

test('source preview keeps exact historical version in research links and requires explicit deletion', async () => {
  const { f, render, flush, close } = setup();
  const calls = [];
  let removed = false;
  const source = { id: 'source-owned', title: 'Fictional research note', kind: 'page', format: 'text', description: '', enabled: true, state: 'ready', versionCount: 2, latestVersionId: 'v2', updatedAt: '2026-11-10T00:00:00Z' };
  const api = f.load('api/data-library.ts').dataLibraryApi;
  api.detail = async () => ({ source, versions: [{ id: 'v2', version: 2 }, { id: 'v1', version: 1 }] });
  api.version = async (id, versionId) => { calls.push([id, versionId]); return { id: versionId, version: versionId === 'v2' ? 2 : 1, extractedText: versionId === 'v2' ? 'Current evidence' : 'Earlier evidence', rawContent: '<script>fixture</script>' }; };
  api.remove = async id => { calls.push(['delete', id]); return { deleted: true }; };
  const Page = f.load('features/data-library/MaterialPreview.tsx').default;
  try {
    await render(Page, { sourceId: source.id, onRemoved() { removed = true; } });
    await flush(); await flush();
    assert.match(document.querySelector('a[href^="/research?"]').getAttribute('href'), /versionId=v2/);
    await change(document.querySelector('select'), 'v1');
    await flush();
    assert.match(document.body.textContent, /Earlier evidence/);
    assert.match(document.querySelector('a[href^="/research?"]').getAttribute('href'), /versionId=v1/);
    assert.equal(button('Edit').disabled, true, 'editing an old snapshot cannot silently overwrite the current page');
    await React.act(async () => button('Original text').click());
    assert.equal(document.querySelector('script'), null);
    assert.match(document.body.textContent, /<script>fixture<\/script>/);
    await React.act(async () => button('Delete').click());
    assert.equal(calls.some(call => call[0] === 'delete'), false);
    await React.act(async () => button('Confirm deletion').click());
    await flush();
    assert.equal(removed, true);
    assert.equal(calls.filter(call => call[0] === 'delete').length, 1);
  } finally { await close(); }
});

test('companion list uses stable animal fallbacks and offers only account operations', () => {
  const f = fixture();
  f.state.queries.set('portfolio-accounts', { data: [{ id: 'legacy', name: 'Legacy companion account', status: 'paused', companionId: null, equityUsd: '12000', cashBalance: '5000', strategyCount: 0, policyRevision: 1 }] });
  const Page = f.load('pages/Paper/SimulationAccountsPage.tsx').default;
  const html = f.render(Page);
  assert.match(html, /data-persona="moderator"/);
  assert.match(html, /Delete Legacy companion account/);
  assert.match(html, /View account/);
  assert.doesNotMatch(html, /href="\/strategies|Clarify a strategy|Compare account histories|Join comparison/);
});

test('editing an uploaded text attachment changes metadata without overwriting its original content', async () => {
  const { f, render, flush, close } = setup();
  const source = { id: 'uploaded-note', title: 'Uploaded note', kind: 'file', format: 'text', description: '', fileName: 'note.txt', enabled: true, state: 'ready', versionCount: 1, latestVersionId: 'v1' };
  const api = f.load('api/data-library.ts').dataLibraryApi;
  const updates = [];
  api.detail = async () => ({ source, versions: [{ id: 'v1', version: 1 }] });
  api.version = async () => ({ id: 'v1', version: 1, extractedText: 'Original attachment', rawContent: 'Original attachment' });
  api.update = async (id, body) => { updates.push({ id, body }); return { ...source, ...body }; };
  const Page = f.load('features/data-library/MaterialPreview.tsx').default;
  try {
    await render(Page, { sourceId: source.id, onRemoved() {} });
    await flush(); await flush();
    await React.act(async () => button('Edit').click());
    assert.equal(document.querySelectorAll('textarea').length, 1, 'only the description is editable for an attachment');
    await change(document.querySelector('input'), 'Renamed attachment');
    await change(document.querySelector('textarea'), 'User description');
    await React.act(async () => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ id: source.id, body: { title: 'Renamed attachment', description: 'User description' } }]);
  } finally { await close(); }
});
