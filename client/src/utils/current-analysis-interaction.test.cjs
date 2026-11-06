const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const { JSDOM } = require('jsdom');
const fixture = require('./simple-test-loader.cjs');

test('fresh completed parent data replaces the initial generating mutation receipt', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const { state, load } = fixture();
  const Panel = load('pages/Today/CurrentAnalysisPanel.tsx').default;
  const generating = { title: 'Portfolio', state: 'generating', taskId: 'same-task', researchLevel: 'ai', summary: 'Earlier saved finding.' };
  state.mutation = { data: generating, isPending: false, mutate() {} };
  const root = createRoot(document.getElementById('root'));
  const draw = view => React.createElement(MemoryRouter, null, React.createElement(Panel, { view, topicKey: 'portfolio' }));
  try {
    await React.act(async () => root.render(draw(generating)));
    assert.match(document.body.textContent, /Updating/);
    await React.act(async () => root.render(draw({ ...generating, state: 'ready', summary: 'Final completed finding.' })));
    assert.match(document.body.textContent, /Final completed finding/);
    assert.doesNotMatch(document.body.textContent, /Updating…/);
    assert.equal([...document.querySelectorAll('button')].find(button => button.textContent === 'Update analysis')?.disabled, false);
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    global.window = previous.window; global.document = previous.document; global.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('Today explicitly updates with manual intent and can stop queued work without a task id', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const { state, load } = fixture();
  state.mutationFactory = options => ({ isPending: false, mutate() { void options.mutationFn().then(data => options.onSuccess?.(data)); } });
  const Panel = load('pages/Today/CurrentAnalysisPanel.tsx').default;
  const root = createRoot(document.getElementById('root'));
  const base = { title: 'Portfolio', state: 'ready', researchLevel: 'ai', summary: 'Saved complete finding.' };
  const draw = view => React.createElement(MemoryRouter, null, React.createElement(Panel, { view, topicKey: 'portfolio', date: '2026-11-06' }));
  try {
    await React.act(async () => root.render(draw(base)));
    await React.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Update analysis').click());
    assert.equal(state.requests.find(item => item.args[0].endsWith('/refresh'))?.args[1].trigger, 'manual');
    await React.act(async () => root.render(draw({ ...base, state: 'generating', taskId: null, startedAt: new Date(Date.now() - 65_000).toISOString() })));
    assert.match(document.body.textContent, /1m 5s|1m 6s/);
    const stop = [...document.querySelectorAll('button')].find(button => button.textContent === 'Stop analysis');
    assert.ok(stop, 'queued analysis exposes stop without a dispatched task id');
    await React.act(async () => stop.click());
    assert.equal(state.requests.find(item => item.args[0].endsWith('/cancel'))?.args[1].topicKey, 'portfolio');
    await React.act(async () => root.render(draw({ ...base, state: 'generating', cancelling: true })));
    assert.equal([...document.querySelectorAll('button')].find(button => button.textContent === 'Stopping…')?.disabled, true);
    assert.match(document.body.textContent, /Saved complete finding/);
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    global.window = previous.window; global.document = previous.document; global.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('Today does not auto-start again after entering with running import analysis and then stopping it', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const { state, load } = fixture();
  const Page = load('pages/Today/TodayPage.tsx').default;
  const data = { date: '2026-11-06', timezone: 'Asia/Shanghai', asOf: '2026-11-06T01:00:00Z', overview: { holdingCount: 1, totalValueUsd: null, dailyPnlUsd: null, returnPct: null },
    summary: null, gaps: [], marketTimes: [], attention: [], analysis: { state: 'generating', researchLevel: 'facts_only' }, aiAvailable: true };
  state.queries.set('today', { data });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Page))));
    state.queries.set('today', { data: { ...data, analysis: { state: 'empty', researchLevel: 'facts_only', changeSummary: 'Analysis stopped.' } } });
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Page))));
    assert.equal(state.requests.filter(item => item.args[0].endsWith('/refresh')).length, 0);
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    global.window = previous.window; global.document = previous.document; global.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
