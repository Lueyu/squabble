const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { JSDOM } = require('jsdom');
const { MemoryRouter } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');

async function withSourceDialog(stateSetup, props, run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = ['window', 'document', 'Element', 'HTMLElement', 'MutationObserver', 'getComputedStyle', 'Event', 'CustomEvent', 'Node', 'NodeFilter', 'HTMLInputElement'];
  const previous = Object.fromEntries(globals.map(key => [key, global[key]])), previousAct = global.IS_REACT_ACT_ENVIRONMENT;
  for (const key of globals) global[key] = dom.window[key];
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const { state, load } = fixture();
  state.queries.set('investment-strategies', { data: { drafts: [] } });
  stateSetup(state);
  state.mutationFactory ??= options => ({ isPending: false, mutate() { return options.mutationFn().then(data => options.onSuccess?.(data)); } });
  const Dialog = load('pages/Today/InvestmentStrategySourceDialog.tsx').default, root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Dialog, { onClose() {}, ...props }))));
    await run({ state, dom, root });
  } finally {
    await React.act(async () => root.unmount()); await new Promise(resolve => setTimeout(resolve, 0)); dom.window.close();
    Object.assign(global, previous); global.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
}

const longResearch = 'Fictional full portfolio research. '.repeat(445);
const noPlanReport = { id: 'long-research', content: longResearch, snapshot: { executionPlanError: 'missing' }, sections: [
  { id: 'summary', title: 'Full research', content: longResearch },
  { id: 'evidence', title: 'Private metadata', content: '[{"content":"PRIVATE_SOURCE_ENVELOPE"}]' },
  { id: 'researchStance', title: 'Research stance', content: 'balanced' },
  { id: 'execution-strategy', title: 'Execution strategy proposal', content: 'This report did not return a structured execution proposal.' },
] };

function longResearchState(state) {
  state.responses = new Map([['/api/investment-strategies/import-source', { id: 'saved-draft' }]]);
  state.queries.set('investment-strategy-source-report', { data: { version: noPlanReport } });
  state.queries.set('investment-strategy-source', { data: { source: { title: 'Full research', createdAt: '2026-11-07T00:00:00Z' },
    entries: [{ id: 'one', text: longResearch.slice(0, 12000) }, { id: 'two', text: longResearch.slice(12000) }], alreadyAdded: false } });
}

test('a long AI report without a plan saves its full research as observation items instead of selecting the missing-plan placeholder', async () =>
  withSourceDialog(longResearchState, { source: { kind: 'report', versionId: 'long-research' } }, async ({ state }) => {
    const picker = document.querySelector('select[aria-label="Report content to add"]');
    assert.equal(picker.value, '');
    assert.equal(picker.querySelector('option[value="execution-strategy"]'), null);
    assert.equal(picker.querySelector('option[value="evidence"]'), null);
    assert.equal(picker.querySelector('option[value="researchStance"]'), null);
    assert.match(document.body.textContent, /observation items/);
    assert.match(document.body.textContent, /12,000/);
    const save = [...document.querySelectorAll('button')].find(button => button.textContent === 'Save to draft');
    assert.equal(save.disabled, false);
    assert.equal(state.requests.length, 0, 'reviewing research must not write a draft or invoke AI');
    await React.act(async () => save.click());
    assert.deepEqual(JSON.parse(JSON.stringify(state.requests)), [{ method: 'post', args: ['/api/investment-strategies/import-source', { source: { kind: 'report', versionId: 'long-research' } }] }]);
    assert.match(document.body.textContent, /Saved to your strategy draft/);
  }));

test('an explicitly requested missing plan can be replaced with the full readable research before saving', async () =>
  withSourceDialog(longResearchState, { source: { kind: 'report', versionId: 'long-research', sectionId: 'execution-strategy' } }, async ({ state, dom }) => {
    const picker = document.querySelector('select[aria-label="Report content to add"]');
    assert.equal(picker.value, '__choose__');
    assert.match(document.body.textContent, /selected strategy section is unavailable/);
    const save = [...document.querySelectorAll('button')].find(button => button.textContent === 'Save to draft');
    assert.equal(save.disabled, true);
    await React.act(async () => { picker.value = ''; picker.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.equal(save.disabled, false);
    await React.act(async () => save.click());
    assert.equal(state.requests[0].args[1].source.sectionId, undefined);
  }));

test('a rejected plan object never becomes the default execution section and keeps whole-research observation saving available', async () =>
  withSourceDialog(state => {
    longResearchState(state);
    state.queries.set('investment-strategy-source-report', { data: { version: { ...noPlanReport,
      snapshot: { executionPlan: { schemaVersion: 1 }, executionPlanError: 'invalid' } } } });
  }, { source: { kind: 'report', versionId: 'long-research' } }, async () => {
    const picker = document.querySelector('select[aria-label="Report content to add"]');
    assert.equal(picker.value, '');
    assert.equal(picker.querySelector('option[value="execution-strategy"]'), null);
    assert.match(document.body.textContent, /no validated structured execution proposal/);
    assert.equal([...document.querySelectorAll('button')].find(button => button.textContent === 'Save to draft').disabled, false);
  }));

test('a system observation remains selectable with the original AI failure and avoids irrelevant trading limits', async () =>
  withSourceDialog(state => {
    const executionPlan = { parameterOrigin: 'system_observation', readiness: 'no_trade', noTradeReason: 'The AI proposal failed validation. This system observation does not authorize trading.',
      strategy: { entries: [{ id: 'watch', text: 'Review the next filing.' }] }, preview: { entries: [], issues: [] }, gaps: [] };
    state.queries.set('investment-strategy-source-report', { data: { version: { id: 'observation-report', content: 'Saved research', snapshot: { executionPlan, executionPlanError: 'invalid' },
      sections: [{ id: 'summary', title: 'Research', content: 'Saved research' }, { id: 'execution-strategy', title: 'System observation plan', content: executionPlan.noTradeReason }] } } });
    state.queries.set('investment-strategy-source', { data: { source: { title: 'System observation plan', createdAt: '2026-11-07T00:00:00Z', executionPlan }, entries: executionPlan.strategy.entries, alreadyAdded: false } });
    state.responses = new Map([['/api/investment-strategies/import-source', { id: 'observation-draft' }]]);
  }, { source: { kind: 'report', versionId: 'observation-report' } }, async ({ state }) => {
    assert.equal(document.querySelector('select[aria-label="Report content to add"]').value, 'execution-strategy');
    assert.match(document.body.textContent, /system observation/); assert.match(document.body.textContent, /failed validation/);
    assert.doesNotMatch(document.body.textContent, /AI-proposed risk limits|Complete and review risk limits/);
    await React.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Save to draft').click());
    assert.equal(state.requests[0].args[1].source.sectionId, 'execution-strategy');
    assert.equal(document.querySelector('a').getAttribute('href'), '/paper?investmentStrategyId=observation-draft#investment-strategy');
  }));

test('preview failures explain a draft period conflict and source capacity without suggesting a generic close-and-reopen', async () => {
  for (const [message, expected] of [
    ['Report strategy validity exceeds this draft; create a new draft to preserve its proposed period', /Choose “Create a new draft” to keep the proposed period/],
    ['At most 20 strategy sources and entries', /20 sources or entries/],
    ['No validated report execution strategy is available; select another section for observation', /Select the full report or a readable research section to save observation items/],
    ['Report source exceeds 200000 characters; select a smaller readable section', /Select a smaller readable section; text will not be truncated/],
    ['Strategy changed or is immutable; reload the draft', /Reload it or choose another editable draft/],
    ['Report revoked', /pinned report is withdrawn or unavailable/],
  ]) await withSourceDialog(state => {
    longResearchState(state);
    state.queries.set('investment-strategy-source', { isError: true, error: { response: { data: { error: { message } } } } });
  }, { source: { kind: 'report', versionId: 'long-research' } }, async () => {
    assert.match(document.body.textContent, expected);
    assert.doesNotMatch(document.body.textContent, /Close and review again/);
    assert.equal([...document.querySelectorAll('button')].find(button => button.textContent === 'Save to draft').disabled, true);
  });
});

test('a save capacity error gives the same recovery as preview and clears when the source is changed', async () => {
  let resets = 0;
  await withSourceDialog(state => {
    longResearchState(state);
    state.mutationFactory = () => ({ isPending: false, isError: true,
      error: { response: { data: { message: 'At most 20 strategy sources and entries' } } }, mutate() {}, reset() { resets++; } });
  }, { source: { kind: 'report', versionId: 'long-research' } }, async ({ dom }) => {
    assert.match(document.body.textContent, /20 sources or entries/);
    assert.doesNotMatch(document.body.textContent, /Close and review again/);
    const picker = document.querySelector('select[aria-label="Report content to add"]');
    await React.act(async () => { picker.value = 'summary'; picker.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.equal(resets, 1);
  });
});

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
    assert.equal([...document.querySelectorAll('a')].find(link => link.textContent === 'Review in AI simulation').getAttribute('href'), '/paper?investmentStrategyId=new-draft#investment-strategy');
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
  state.queries.set('investment-strategy-source-report', { data: { version: { id: 'large-version', content: 'Long report '.repeat(20000),
    sections: [{ id: 'risk', title: 'Risks to watch', content: 'AAPL await the next filing.' }, { id: 'oversize', title: 'Too long', content: 'x'.repeat(200001) }] } } });
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
