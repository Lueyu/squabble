const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { JSDOM } = require('jsdom');
const { MemoryRouter } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');

test('adding a report first shows its immutable addition and only saves after the investor confirms', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, Element: global.Element, HTMLElement: global.HTMLElement,
    MutationObserver: global.MutationObserver, getComputedStyle: global.getComputedStyle, act: global.IS_REACT_ACT_ENVIRONMENT };
  const native = Object.fromEntries(['Event', 'CustomEvent', 'Node', 'NodeFilter', 'HTMLInputElement'].map(key => [key, global[key]]));
  for (const key of Object.keys(native)) global[key] = dom.window[key];
  Object.assign(global, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  const { state, load } = fixture();
  state.queries.set('investment-strategy-source-report', { data: { version: { id: 'exact-version', content: 'AAPL wait for earnings', sections: [{ id: 'summary', title: 'Summary', content: 'AAPL wait for earnings' }] } } });
  state.queries.set('investment-strategies', { data: { current: null, drafts: [{ id: 'draft-one', revision: 3, content: { title: 'My manual strategy', body: 'Keep my manually written view' } }], history: [] } });
  state.queries.set('investment-strategy-source', { data: { source: { title: 'Original report', createdAt: '2026-11-06T00:00:00Z' }, entries: [{ id: 'source-entry', text: 'AAPL wait for earnings', sourceKeys: ['report:exact-version'] }], alreadyAdded: false } });
  state.responses = new Map([['/api/investment-strategies/import-source', { id: 'new-draft' }]]);
  state.mutationFactory = options => ({ isPending: false, mutate() { return options.mutationFn().then(data => options.onSuccess?.(data)); } });
  const Dialog = load('pages/Today/InvestmentStrategySourceDialog.tsx').default;
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Dialog, { source: { kind: 'report', versionId: 'exact-version' }, onClose() {} }))));
    assert.match(document.body.textContent, /AAPL wait for earnings/);
    assert.equal(state.requests.length, 0, 'opening a source must not mutate a draft');
    const save = [...document.querySelectorAll('button')].find(button => button.textContent === 'Save to draft');
    assert.ok(save);
    await React.act(async () => save.click());
    assert.equal(state.requests[0].args[0], '/api/investment-strategies/import-source');
    assert.equal(state.requests[0].args[1].source.versionId, 'exact-version');
    assert.match(document.body.textContent, /Saved to your strategy draft/);
    assert.equal([...document.querySelectorAll('a')].find(link => link.textContent === 'Edit on Today').getAttribute('href'), '/');
    assert.doesNotMatch(state.requests[0].args[0], /apply|publish/);
  } finally {
    await React.act(async () => root.unmount());
    await new Promise(resolve => setTimeout(resolve, 0)); // Drain Radix's deferred unmount focus event before restoring DOM globals.
    dom.window.close();
    Object.assign(global, { window: previous.window, document: previous.document, Element: previous.Element, HTMLElement: previous.HTMLElement,
      MutationObserver: previous.MutationObserver, getComputedStyle: previous.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: previous.act });
    Object.assign(global, native);
  }
});

test('a long report requires an owned bounded section and saves that exact source', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = ['window', 'document', 'Element', 'HTMLElement', 'MutationObserver', 'getComputedStyle', 'Event', 'CustomEvent', 'Node', 'NodeFilter', 'HTMLInputElement'];
  const previous = Object.fromEntries(globals.map(key => [key, global[key]]));
  const previousAct = global.IS_REACT_ACT_ENVIRONMENT;
  for (const key of globals) global[key] = dom.window[key];
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const { state, load } = fixture();
  state.queries.set('investment-strategies', { data: { current: null, drafts: [], history: [], draftsCursor: 'older-draft-cursor' } });
  state.queries.set('investment-strategy-source-report', { data: { version: { id: 'large-version', content: 'Long report '.repeat(1500),
    sections: [{ id: 'risk', title: 'Risks to watch', content: 'AAPL await the next filing.' }, { id: 'oversize', title: 'Too long', content: 'x'.repeat(12001) }] } } });
  state.queries.set('investment-strategy-source', { data: { source: { title: 'Risks to watch', createdAt: '2026-11-06T00:00:00Z' }, entries: [{ id: 'source-entry', text: 'AAPL await the next filing.' }], alreadyAdded: false } });
  state.responses = new Map([['/api/investment-strategies/drafts', { items: [{ id: 'older-draft', revision: 4, sources: [], content: { title: 'Older manual draft', body: 'Keep the older manual content' } }], nextCursor: null }],
    ['/api/investment-strategies/older-draft/add-source', { id: 'older-draft' }]]);
  state.mutationFactory = options => ({ isPending: false, mutate() { return options.mutationFn().then(data => options.onSuccess?.(data)); } });
  const Dialog = load('pages/Today/InvestmentStrategySourceDialog.tsx').default;
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Dialog, { source: { kind: 'report', versionId: 'large-version' }, onClose() {} }))));
    const picker = document.querySelector('select[aria-label="Report content to add"]');
    assert.ok(picker, 'long reports need a usable section picker instead of an unrecoverable error');
    const save = [...document.querySelectorAll('button')].find(button => button.textContent === 'Save to draft');
    assert.equal(save.disabled, true, 'an oversized whole report cannot be saved');
    assert.equal(picker.querySelector('option[value="oversize"]').disabled, true);
    await React.act(async () => { picker.value = 'risk'; picker.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.equal(save.disabled, false);
    const moreDrafts = [...document.querySelectorAll('button')].find(button => button.textContent === 'Load older drafts');
    assert.ok(moreDrafts, 'older draft targets must remain reachable beyond the first page');
    await React.act(async () => moreDrafts.click());
    const draftPicker = document.querySelector('select[aria-label="Save to"]');
    assert.ok(draftPicker.querySelector('option[value="older-draft"]'));
    await React.act(async () => { draftPicker.value = 'older-draft'; draftPicker.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.match(document.body.textContent, /Keep the older manual content/u);
    await React.act(async () => save.click());
    const write = state.requests.find(request => request.method === 'post');
    assert.equal(write.args[0], '/api/investment-strategies/older-draft/add-source');
    assert.equal(write.args[1].source.versionId, 'large-version');
    assert.equal(write.args[1].source.sectionId, 'risk');
  } finally {
    await React.act(async () => root.unmount());
    await new Promise(resolve => setTimeout(resolve, 0));
    dom.window.close();
    Object.assign(global, previous); global.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

test('reports with a saved execution plan default to its strategy section and show proposed execution details', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = ['window', 'document', 'Element', 'HTMLElement', 'MutationObserver', 'getComputedStyle', 'Event', 'CustomEvent', 'Node', 'NodeFilter', 'HTMLInputElement'];
  const previous = Object.fromEntries(globals.map(key => [key, global[key]])); const previousAct = global.IS_REACT_ACT_ENVIRONMENT;
  for (const key of globals) global[key] = dom.window[key]; global.IS_REACT_ACT_ENVIRONMENT = true;
  const { state, load } = fixture();
  const strategyPlan = { schemaVersion: 1, parameterOrigin: 'ai_proposed', readiness: 'needs_info', gaps: ['Confirm the total position cap.'],
    strategy: { title: 'AI proposed plan', entries: [], limits: { maxPositionPct: 10 } },
    preview: { entries: [{ id: 'aapl-buy', state: 'needs_review', explanation: { en: 'Buy AAPL: 2 shares when price ≤ 100.', 'zh-CN': '价格不高于 100 时买入 AAPL 2 股。' } }], issues: [] } };
  state.queries.set('investment-strategies', { data: { drafts: [] } });
  state.queries.set('investment-strategy-source-report', { data: { version: { id: 'exact-version', content: 'Research and proposed strategy', snapshot: { executionPlan: strategyPlan },
    sections: [{ id: 'summary', title: 'Research', content: 'Research only' }, { id: 'execution-strategy', title: 'Execution strategy', content: 'Buy 2 AAPL at or below 100.' }] } } });
  state.queries.set('investment-strategy-source', { data: { source: { title: 'Execution strategy', createdAt: '2026-11-06T00:00:00Z', executionPlan: strategyPlan }, entries: [{ id: 'aapl-buy', text: 'Buy 2 AAPL at or below 100.', sourceKeys: ['report:exact-version:execution-strategy'] }], alreadyAdded: false } });
  state.responses = new Map([['/api/investment-strategies/import-source', { id: 'saved-draft' }]]);
  state.mutationFactory = options => ({ isPending: false, mutate() { return options.mutationFn().then(data => options.onSuccess?.(data)); } });
  const Dialog = load('pages/Today/InvestmentStrategySourceDialog.tsx').default; const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Dialog, { source: { kind: 'report', versionId: 'exact-version' }, onClose() {} }))));
    assert.equal(document.querySelector('select[aria-label="Report content to add"]').value, 'execution-strategy');
    assert.match(document.body.textContent, /Strategy entries to add/); assert.match(document.body.textContent, /AI-proposed risk limits/);
    assert.match(document.body.textContent, /Buy AAPL: 2 shares/); assert.match(document.body.textContent, /Confirm the total position cap/);
    assert.equal(state.requests.length, 0);
    await React.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Save to draft').click());
    assert.equal(state.requests[0].args[1].source.sectionId, 'execution-strategy');
    assert.equal(state.requests[0].args[1].source.versionId, 'exact-version');
    assert.doesNotMatch(state.requests[0].args[0], /prepare|apply/);
  } finally {
    await React.act(async () => root.unmount()); await new Promise(resolve => setTimeout(resolve, 0)); dom.window.close();
    Object.assign(global, previous); global.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

test('a plan period conflict tells the investor to select a new draft', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = ['window', 'document', 'Element', 'HTMLElement', 'MutationObserver', 'getComputedStyle', 'Event', 'CustomEvent', 'Node', 'NodeFilter', 'HTMLInputElement'];
  const previous = Object.fromEntries(globals.map(key => [key, global[key]])); const previousAct = global.IS_REACT_ACT_ENVIRONMENT;
  for (const key of globals) global[key] = dom.window[key]; global.IS_REACT_ACT_ENVIRONMENT = true;
  const { state, load } = fixture();
  state.queries.set('investment-strategies', { data: { drafts: [] } });
  state.queries.set('investment-strategy-source-report', { data: { version: { content: 'Proposal', sections: [{ id: 'execution-strategy', title: 'Strategy', content: 'Proposal' }] } } });
  state.queries.set('investment-strategy-source', { data: { source: { title: 'Strategy', createdAt: '2026-11-06T00:00:00Z' }, entries: [], alreadyAdded: false } });
  state.mutation = { isPending: false, isError: true, error: { response: { data: { message: 'Report strategy validity exceeds this draft; create a new draft to preserve its proposed period' } } }, mutate() {} };
  const Dialog = load('pages/Today/InvestmentStrategySourceDialog.tsx').default; const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Dialog, { source: { kind: 'report', versionId: 'exact-version', sectionId: 'execution-strategy' }, onClose() {} }))));
    assert.match(document.body.textContent, /Choose “Create a new draft” to keep the proposed period/);
    assert.match(document.body.textContent, /Your existing draft stays unchanged/);
  } finally {
    await React.act(async () => root.unmount()); await new Promise(resolve => setTimeout(resolve, 0)); dom.window.close();
    Object.assign(global, previous); global.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
