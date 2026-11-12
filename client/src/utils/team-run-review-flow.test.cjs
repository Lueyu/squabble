const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/teams/team' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'FormData', 'CustomEvent', 'DocumentFragment', 'getComputedStyle', 'Element', 'Node', 'Event']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

test('expired run preview is explicitly renewed, unknown renewal keeps its exact key, and renewed terms require confirmation', async () => {
  const f = fixture({ realQuery: true }); let sequence = 0;
  f.state.randomUUID = () => 'intent-' + ++sequence;
  const api = f.load('api/team-runs.ts').teamRunsApi;
  const calls = []; let renewalUncertain = true; let agreement = null;
  api.status = async () => ({ agreement, recentCycles: [] });
  api.preview = async (_id, input) => {
    calls.push(['preview', input]);
    if (calls.filter(([op]) => op === 'preview').length === 2 && renewalUncertain) { renewalUncertain = false; throw new Error('Lost renewal response'); }
    return { previewId: input.requestKey.endsWith('intent-1:preview') ? 'expired' : 'renewed', previewHash: input.requestKey, result: { accountId: 'account', members: [{ label: 'Reviewed analyst' }] } };
  };
  api.confirm = async (_id, input) => {
    calls.push(['confirm', input]);
    if (input.previewId === 'expired') throw { response: { status: 409, data: { code: 'TEAM_PREVIEW_STALE' } } };
    agreement = { id: 'agreement', revision: 1, state: 'confirmed', accountId: 'account', members: [], configuration: { market: 'CN', cadence: { delayMinutes: 60 }, budget: { daily: { costUsd: '2' }, monthly: { costUsd: '40' } } } };
    return agreement;
  };
  api.start = async (_id, input) => { calls.push(['start', input]); agreement = { ...agreement, state: 'running' }; return agreement; };
  const { TeamRunPanel } = f.load('features/teams/TeamRunPanel.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const button = name => [...document.querySelectorAll('button')].find(item => item.textContent === name);
  async function click(name) { const item = button(name); assert.ok(item, name); assert.equal(item.disabled, false); await React.act(async () => item.click()); await settle(); }
  async function acknowledge() { await React.act(async () => document.querySelector('[role="checkbox"]').click()); await settle(); }
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(TeamRunPanel, { zh: false, team: { id: 'team', currentVersionId: 'version', bindingRevision: 1, binding: { id: 'binding' }, status: 'active', publishedVersion: { config: { roles: [{ participation: 'enabled', executor: { executionMode: 'model' } }] } } } })))));
    await settle();
    await click('Set up automatic runs');
    await acknowledge();
    await click('Confirm and start');
    assert.match(document.body.textContent, /preview expired/);
    assert.equal(button('Confirm and start').disabled, true);
    await click('Refresh run review');
    assert.equal(document.querySelector('input[type=number]').disabled, true);
    await click('Refresh run review');
    const previews = calls.filter(([op]) => op === 'preview');
    assert.notEqual(previews[0][1].requestKey, previews[1][1].requestKey);
    assert.deepEqual(previews[1][1], previews[2][1]);
    assert.match(document.body.textContent, /Reviewed analyst/);
    assert.equal(button('Confirm and start').disabled, true);
    await acknowledge();
    await click('Confirm and start');
    assert.equal(calls.filter(([op]) => op === 'start').length, 1);
    assert.match(document.body.textContent, /Running automatically/);
  } finally { await React.act(async () => root.unmount()); client.clear(); }
});

test('a delayed legacy-seat conversion never assigns its profile to a newly selected seat', async () => {
  const f = fixture({ realQuery: true });
  const api = f.load('api/agent-roster.ts').agentRosterApi;
  api.list = async () => ({ items: [] });
  let finish;
  api.create = async () => new Promise(resolve => { finish = resolve; });
  const { TeamRosterBinding } = f.load('features/teams/TeamRosterBinding.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root')); const assignments = [];
  const models = [{ id: 'connection', available: true, fastModel: 'fast-model', slowModel: 'slow-model' }];
  const role = id => ({ id, responsibility: id, expectedOutput: 'Evidence', allowedToolIds: [], executor: { executionMode: 'model', connectionId: 'connection', model: 'fast-model', tier: 'fast' } });
  const render = id => React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(TeamRosterBinding, { role: role(id), label: id, models, zh: false, disabled: false, onBind: value => assignments.push([id, value]) })))));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  try {
    await render('original-seat'); await settle();
    const save = [...document.querySelectorAll('button')].find(button => button.textContent === 'Save this seat as my agent');
    assert.ok(save);
    await React.act(async () => save.click()); await settle();
    await render('another-seat');
    await React.act(async () => finish({ id: 'saved-person', status: 'active', availability: 'configured', specialty: 'Original duty', currentVersionId: 'v1', currentVersion: { config: { executor: { executionMode: 'model', connectionId: 'connection', model: 'fast' }, allowedToolIds: [] } } }));
    await settle();
    assert.deepEqual(assignments, []);
    assert.match(document.body.textContent, /This seat changed/);
  } finally { await React.act(async () => root.unmount()); client.clear(); }
});
