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

const browserSourceFixture = overrides => ({
  id: 'fictional-browser-source', title: 'Fictional browser research', kind: 'website', format: 'html',
  description: '', url: 'https://example.com/research', enabled: true, authKind: 'none',
  hasCredential: false, needsReentry: false, captureMode: 'browser', hasBrowserSession: false,
  browserConnectedAt: null, syncIntervalMinutes: null, nextSyncAt: null, latestVersionId: null,
  versionCount: 0, state: 'pending', lastSuccessAt: null, lastErrorCode: null,
  createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', ...overrides,
});

test('browser subscriptions require saving settings, manual connection confirmation, then separate capture', async () => {
  const { f, render, flush, close } = setup();
  const calls = [];
  let source = browserSourceFixture({ captureMode: 'http' });
  let status = { available: true, canOpenInteractive: true, state: 'not-connected', connectedAt: null, loginWindowOpen: false };
  const api = f.load('api/data-library.ts').dataLibraryApi;
  api.list = async () => ({ items: [source], total: 1 });
  api.detail = async () => ({ source, versions: [] });
  api.update = async (id, body) => { calls.push(['save', body]); source = { ...source, ...body }; return source; };
  api.browserStatus = async () => status;
  api.openBrowser = async () => { calls.push(['open']); status = { ...status, state: 'login-open', loginWindowOpen: true }; return status; };
  api.confirmBrowser = async () => { calls.push(['confirm']); source = { ...source, hasBrowserSession: true }; status = { ...status, state: 'connected', connectedAt: '2026-11-10T01:00:00Z', loginWindowOpen: false }; return status; };
  api.sync = async () => { calls.push(['capture']); return { source, job: { state: 'succeeded', outcome: 'updated' } }; };
  const Page = f.load('features/data-library/SubscriptionWorkspace.tsx').default;
  try {
    await render(Page); await flush(); await flush();
    assert.ok(button('Browser dynamic capture'), 'collection method is separate from authentication');
    await React.act(async () => button('Browser dynamic capture').click());
    assert.equal(button('Open browser and sign in').disabled, true);
    assert.equal(button('Capture now').disabled, true);
    assert.match(document.body.textContent, /Save settings before opening the browser or capturing/);
    await React.act(async () => button('Save settings').click()); await flush(); await flush();
    assert.equal(calls[0][1].captureMode, 'browser');
    await React.act(async () => button('Open browser and sign in').click()); await flush();
    assert.deepEqual(calls.map(call => call[0]), ['save', 'open']);
    assert.equal(button('Capture now').disabled, true, 'opening a window does not confirm authentication');
    await React.act(async () => button('I signed in; save connection').click()); await flush();
    assert.deepEqual(calls.map(call => call[0]), ['save', 'open', 'confirm']);
    assert.equal(button('Capture now').disabled, false);
    await React.act(async () => button('Capture now').click()); await flush();
    assert.deepEqual(calls.map(call => call[0]), ['save', 'open', 'confirm', 'capture']);
    assert.match(document.body.textContent, /new version saved/i);
  } finally { await close(); }
});

test('browser failures use safe guidance, do not invent saved versions, and require explicit disconnection', async () => {
  const { f, render, flush, close } = setup();
  let source = browserSourceFixture({ state: 'needs-auth', lastErrorCode: 'TIMEOUT', hasBrowserSession: true });
  const status = { available: false, state: 'unavailable', reason: 'BROWSER_NOT_INSTALLED', connectedAt: null, loginWindowOpen: false };
  const api = f.load('api/data-library.ts').dataLibraryApi;
  let disconnects = 0;
  api.list = async () => ({ items: [source], total: 1 });
  api.detail = async () => ({ source, versions: [] });
  api.browserStatus = async () => status;
  api.disconnectBrowser = async () => { disconnects += 1; source = { ...source, hasBrowserSession: false }; return { ...status, state: 'not-connected' }; };
  const Page = f.load('features/data-library/SubscriptionWorkspace.tsx').default;
  try {
    await render(Page); await flush(); await flush();
    assert.match(document.body.textContent, /browser is not installed/i);
    assert.match(document.body.textContent, /No content has been saved yet/);
    assert.doesNotMatch(document.body.textContent, /Saved versions remain available|TIMEOUT|BROWSER_NOT_INSTALLED/);
    await React.act(async () => button('Disconnect browser').click());
    assert.equal(disconnects, 0);
    await React.act(async () => button('Confirm disconnect').click()); await flush();
    assert.equal(disconnects, 1);
    assert.doesNotMatch(document.body.textContent, /cookie=/i);
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

test('browser version preview keeps the selected version acquisition details and page URL', async () => {
  const { f, render, flush, close } = setup();
  const source = browserSourceFixture({ state: 'ready', latestVersionId: 'browser-v2', versionCount: 2 });
  const api = f.load('api/data-library.ts').dataLibraryApi;
  api.detail = async () => ({ source, versions: [{ id: 'browser-v2', version: 2 }, { id: 'http-v1', version: 1 }] });
  api.version = async (id, versionId) => versionId === 'browser-v2'
    ? { id: versionId, version: 2, acquisition: 'browser-rendered', pageTitle: 'Rendered fictional page', finalUrl: 'https://example.com/research/after-login', observedAt: '2026-11-10T02:00:00Z', extractedText: 'Rendered evidence' }
    : { id: versionId, version: 1, acquisition: 'http', pageTitle: 'Earlier static page', finalUrl: 'https://example.com/research/original', observedAt: '2026-11-09T01:00:00Z', extractedText: 'Earlier static evidence' };
  const Page = f.load('features/data-library/MaterialPreview.tsx').default;
  try {
    await render(Page, { sourceId: source.id, onRemoved() {} }); await flush(); await flush();
    assert.match(document.body.textContent, /Browser-rendered content/);
    assert.match(document.body.textContent, /Rendered fictional page/);
    assert.ok(document.querySelector('a[href="https://example.com/research/after-login"]'));
    await change(document.querySelector('select'), 'http-v1'); await flush();
    assert.match(document.body.textContent, /HTTP static capture/);
    assert.match(document.body.textContent, /Earlier static page/);
    assert.doesNotMatch(document.body.textContent, /Browser-rendered content|Rendered fictional page/);
    assert.ok(document.querySelector('a[href="https://example.com/research/original"]'));
  } finally { await close(); }
});

test('headless connected browsers can capture while interactive sign-in is unavailable and mobile returns to its list', async () => {
  const { f, render, flush, close } = setup();
  const scroller = document.getElementById('root');
  scroller.className = 'app-content';
  scroller.scrollTop = 240;
  window.matchMedia = () => ({ matches: true });
  window.requestAnimationFrame = callback => window.setTimeout(() => callback(0), 0);
  window.cancelAnimationFrame = frame => window.clearTimeout(frame);
  const source = browserSourceFixture({ hasBrowserSession: true });
  const api = f.load('api/data-library.ts').dataLibraryApi;
  api.list = async () => ({ items: [source], total: 1 });
  api.detail = async () => ({ source, versions: [] });
  api.browserStatus = async () => ({ available: true, canOpenInteractive: false, state: 'connected', reason: 'INTERACTIVE_DISPLAY_UNAVAILABLE', connectedAt: '2026-11-10T01:00:00Z', loginWindowOpen: false });
  const Page = f.load('features/data-library/SubscriptionWorkspace.tsx').default;
  try {
    await render(Page); await flush(); await flush();
    assert.equal(button('Capture now').disabled, false);
    assert.equal(button('Reopen browser').disabled, true);
    assert.match(document.body.textContent, /no interactive desktop/);
    await React.act(async () => document.querySelector('.data-subscription-list .data-item').click());
    await flush();
    assert.ok(document.querySelector('.data-subscriptions.has-selection'));
    assert.equal(scroller.scrollTop, 0);
    scroller.scrollTop = 500;
    await React.act(async () => button('Back to subscriptions').click());
    await flush();
    assert.equal(document.querySelector('.data-subscriptions.has-selection'), null);
    assert.ok(document.querySelector('.data-subscription-list .data-item'));
    assert.equal(scroller.scrollTop, 240);
    assert.equal(document.activeElement, document.querySelector('.data-subscription-list .data-item'));
  } finally {
    await close();
    scroller.className = '';
    delete window.matchMedia;
    delete window.requestAnimationFrame;
    delete window.cancelAnimationFrame;
  }
});

test('companion list uses stable animal fallbacks and offers only account operations', () => {
  const f = fixture();
  f.state.queries.set('portfolio-accounts', { data: [{ id: 'legacy', name: 'Legacy companion account', status: 'paused', companionId: null, equityUsd: '12000', cashBalance: '5000', strategyCount: 0, policyRevision: 1 }] });
  const Page = f.load('pages/Paper/SimulationAccountsPage.tsx').default;
  const html = f.render(Page);
  assert.match(html, /<h1[^>]*>Simulation accounts<\/h1>/);
  assert.match(html, /New simulation account/);
  assert.doesNotMatch(html, /My companions|Add companion/);
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
