const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const ts = require('typescript');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'Element', 'Node', 'NodeFilter', 'CustomEvent',
  'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout engine; Radix only needs this browser observer to size its hidden checkbox input.
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { MemoryRouter } = require('react-router-dom');
const original = { id: 'live-thesis', memoryId: 'memory', ticker: 'TEST', market: 'US', topic: 'general', status: 'accepted', version: 3,
  claim: 'Fictional lifecycle thesis', supportingEvidence: [{ evidenceId: 'e1' }], opposingEvidence: [], assumptions: [], indicators: [],
  invalidationConditions: ['Price below 90'], sourceStatus: 'available', source: { sessionId: 'session', reportId: 'report', reportVersion: 1, reportRevision: 1, url: '/council' },
  citations: [{ evidenceId: 'e1', title: 'Fictional filing' }], flags: [], excluded: false, freshness: 'current' };
let current, failures, writes, rules;
const api = {
  fetchResearchMemory: async () => { if (failures.list) throw failures.list; return { theses: [current], memories: [] }; },
  fetchResearchThesis: async () => { if (failures.thesis) throw failures.thesis; return current; },
  fetchResearchMemoryById: async () => { if (failures.memory) throw failures.memory; return { sourceStatus: current.sourceStatus, citations: current.citations }; },
  fetchResearchMonitors: async () => { if (failures.monitors) throw failures.monitors; return { rules, events: [], unsupportedConditions: [0],
    replacementState: 'none', configuration: 'unconfigured', executionEligible: true, breached: false }; },
  fetchResearchMemoryPreferences: async () => ({ autoArchive: true, recallEnabled: true }),
  fetchResearchArchiveJobs: async () => ({ counts: { succeeded: 0, failed: 0, queued: 0, running: 0 }, jobs: [] }),
  fetchResearchEvidence: async () => ({ evidence: [], relations: [], comparisons: [] }),
  writeResearchMonitor: async (id, input) => { if (failures.write) throw failures.write; writes.push({ id, input }); return {}; },
};
const cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} }; cache.set(filename, module);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports, URL, Date, setTimeout, clearTimeout, window, document, require(id) {
    if (id === '@/api/research-memory') return api;
    if (id === 'react-i18next') return { useTranslation: () => ({ i18n: { resolvedLanguage: 'en' } }) };
    if (id.startsWith('@/') || id.startsWith('.')) {
      const target = id.startsWith('@/') ? path.resolve(__dirname, '..', id.slice(2)) : path.resolve(path.dirname(filename), id);
      const resolved = [target, `${target}.ts`, `${target}.tsx`].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
      if (resolved) return load(resolved);
    }
    return require(id);
  } }, { filename });
  return module.exports;
}
const Panel = load(path.resolve(__dirname, '../pages/Council/CouncilMemoryPanel.tsx')).CouncilMemoryPanel;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
const number = () => document.querySelector('input[type="number"]');
const rationale = () => document.querySelector('textarea');
const save = () => document.querySelector('form button[type="submit"]');
const outage = status => Object.assign(new Error(status ? `Request failed with status code ${status}` : 'Network Error'),
  { isAxiosError: true, ...(status ? { response: { status, data: { message: status === 404 ? 'MEMORY_SOURCE_NOT_FOUND' : 'Unavailable' } } } : {}) });
async function fixture(run) {
  current = structuredClone(original); failures = {}; writes = []; rules = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const root = createRoot(document.getElementById('root'));
  const refresh = async key => { await act(async () => { await client.refetchQueries({ queryKey: ['research-memory', key] }); }); await flush(); };
  try {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null,
      React.createElement(Panel, { ticker: 'TEST', market: 'US', language: 'en' })))));
    await flush();
    await run({ client, refresh });
  } finally { await act(async () => root.unmount()); client.clear(); await flush(); }
}
async function fill(node, value) {
  assert.ok(node, 'input exists');
  await act(async () => {
    const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function openWorkspace() {
  const opener = button('Condition monitoring');
  await act(async () => {
    if (opener) opener.click();
    else { const summary = [...document.querySelectorAll('summary')].find(node => node.textContent === 'Condition monitoring');
      assert.ok(summary); summary.parentElement.open = true; summary.parentElement.dispatchEvent(new window.Event('toggle')); }
  });
  await flush();
}
async function openDraft() {
  await openWorkspace();
  assert.ok(button('Configure condition'));
  await act(async () => button('Configure condition').click());
  await fill(number(), '88'); await fill(rationale(), 'Retain this draft across live refreshes');
  const dates = [...document.querySelectorAll('input[placeholder="2027-01-01T00:00:00Z"]')];
  await fill(dates[0], '2026-11-01T00:00:00Z'); await fill(dates[1], '2027-11-01T00:00:00Z');
  await act(async () => document.querySelector('form [role="checkbox"]').click());
  return { input: number(), text: rationale() };
}

test('mounted monitor draft survives transient monitor, listing and thesis refresh failures; requests wait for recovery', async () => {
  for (const key of ['monitors', 'list', 'thesis']) await fixture(async ({ refresh }) => {
    const originalNodes = await openDraft();
    failures[key] = outage(503); await refresh(key);
    assert.ok(number() === originalNodes.input, `${key}: React must keep the same mounted input`);
    assert.equal(number().value, '88'); assert.equal(rationale().value, 'Retain this draft across live refreshes');
    assert.equal(save().disabled, true);
    await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(writes.length, 0);
    delete failures[key]; await refresh(key);
    assert.ok(number() === originalNodes.input); assert.equal(number().value, '88'); assert.equal(save().disabled, false);
    await act(async () => save().click()); await flush();
    assert.equal(writes.length, 1, 'the retained valid draft saves after successful refresh');
    assert.equal(writes[0].input.expectedVersion, 3);
    assert.equal(writes[0].input.condition.threshold, 88); assert.equal(writes[0].input.condition.conditionIndex, 0);
  });
});

test('mounted monitor workspace survives active-to-candidate movement with its old draft and explicit version conflict', async () => fixture(async ({ refresh }) => {
  const originalNodes = await openDraft();
  current = { ...current, version: 4, status: 'candidate', invalidationConditions: ['Price below 80'] };
  await refresh('list'); await refresh('thesis');
  assert.ok(number() === originalNodes.input, 'moving cards must not unmount the monitor draft'); assert.equal(number().value, '88');
  assert.equal(rationale().value, 'Retain this draft across live refreshes');
  assert.equal(save().disabled, true);
  assert.ok(document.body.textContent.includes('Your draft keeps its original context'));
  assert.ok([...document.querySelectorAll('form option')].some(node => node.textContent === 'Price below 90'));
  assert.ok(button('Discard draft and review latest conditions'));
  await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(writes.length, 0, 'stale opening version cannot be submitted');
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('[role="dialog"]'), null, 'keyboard close still works after the opener moves');
  // Radix restores focus in an unmount timer, after the dialog has left the DOM.
  const focusDeadline = Date.now() + 1000;
  while (document.activeElement.getAttribute('data-ai-section-type') !== 'card-list' && Date.now() < focusDeadline) await flush();
  assert.equal(document.activeElement.getAttribute('data-ai-section-type'), 'card-list', 'focus returns to the stable panel when the opener moved');
}));

test('a newer immutable rule blocks its mounted editor while retaining typed values', async () => fixture(async ({ refresh }) => {
  const old = { id: 'rule-1', rootId: 'root', version: 1, thesisVersion: 3, origin: 'user', enabled: true,
    condition: { conditionIndex: 0, metric: 'price', unit: 'USD', operator: 'lt', threshold: 90, evidenceIds: ['e1'],
      rationale: 'Original condition', validFrom: '2026-11-01T00:00:00Z', validUntil: '2027-11-01T00:00:00Z' } };
  rules = [old]; await openWorkspace();
  await act(async () => button('Edit condition').click());
  await fill(number(), '88'); await fill(rationale(), 'Preserve rule draft');
  const input = number(); assert.equal(button('Disable').disabled, true);
  rules = [{ ...old, enabled: false }, { ...old, id: 'rule-2', version: 2 }]; await refresh('monitors');
  assert.ok(number() === input); assert.equal(number().value, '88'); assert.equal(rationale().value, 'Preserve rule draft');
  assert.equal(save().disabled, true);
  await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(writes.length, 0);
}));

test('thesis editor keeps its mounted draft across transient cached thesis and memory refresh errors', async () => {
  for (const key of ['thesis', 'memory', 'list']) await fixture(async ({ refresh }) => {
    await act(async () => button('Edit').click()); await flush();
    const claim = document.getElementById('memory-claim'); await fill(claim, 'Retained claim edit');
    failures[key] = outage(503); await refresh(key);
    assert.ok(document.getElementById('memory-claim') === claim); assert.equal(claim.value, 'Retained claim edit');
    assert.equal(save().disabled, true);
    delete failures[key]; await refresh(key);
    assert.ok(document.getElementById('memory-claim') === claim); assert.equal(claim.value, 'Retained claim edit');
  });
});

test('authoritative access errors clear cached monitor drafts and recovery cannot restore their old inputs', async () => {
  for (const key of ['monitors', 'list', 'thesis']) for (const status of [401, 403, 404]) await fixture(async ({ refresh }) => {
    await openDraft(); failures[key] = outage(status); await refresh(key);
    assert.ok(!number(), `${key}/${status}: inaccessible draft is removed`);
    assert.ok(!document.querySelector('[role="dialog"]')?.textContent.includes('Fictional filing'));
    delete failures[key]; await refresh(key);
    assert.ok(!number(), 'recovery must not resurrect discarded sensitive draft');
  });
});

test('authoritative thesis-editor access failures remove cached claim inputs', async () => {
  for (const key of ['thesis', 'memory', 'list']) for (const status of [401, 403, 404]) await fixture(async ({ refresh }) => {
    await act(async () => button('Edit').click()); await flush();
    await fill(document.getElementById('memory-claim'), 'Claim draft before access failure');
    failures[key] = outage(status); await refresh(key);
    assert.ok(!document.getElementById('memory-claim'), `${key}/${status}: inaccessible claim editor must be removed`);
  });
});

test('authoritative source deletion clears a mounted monitor editor', async () => fixture(async ({ refresh }) => {
  await openDraft(); current = { ...current, sourceStatus: 'source-deleted', source: null, citations: [] };
  await refresh('list'); await refresh('thesis');
  assert.equal(number(), null); assert.ok(!document.querySelector('[role="dialog"]')?.textContent.includes('Fictional filing'));
}));

test('an authoritative write rejection hides the inaccessible draft despite cached successful reads', async () => fixture(async ({ refresh }) => {
  await openDraft(); failures.write = outage(403);
  await act(async () => save().click()); await flush();
  assert.ok(!number()); assert.ok(!document.querySelector('[role="dialog"]')?.textContent.includes('Fictional filing'));
  await refresh('monitors'); assert.ok(!number()); assert.equal(writes.length, 0);
}));
