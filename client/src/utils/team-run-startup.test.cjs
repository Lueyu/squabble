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

const role = id => ({ id, participation: 'enabled', agentId: `agent-${id}`, agentVersionId: `agent-version-${id}`, executor: { executionMode: 'model' } });
const config = { roles: [role('lead'), role('research')], defaults: { leadRoleId: 'lead' } };
const team = { id: 'team', status: 'active', currentVersionId: 'version', bindingRevision: 1, binding: { id: 'binding', state: 'active' }, publishedVersion: { config }, capabilities: { researchEnabled: true } };
const budget = { perRun: { ceiling: { amount: '1', currency: 'USD' }, callLimit: 8 }, daily: { costUsd: '2', calls: 16 }, monthly: { costUsd: '40', calls: 320 } };
const click = async text => {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent === text);
  assert.ok(button, `Missing ${text}`); assert.equal(button.disabled, false, `${text} is disabled`);
  await React.act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
};

test('unbound and unpublished teams expose setup actions instead of a disabled dead end', async () => {
  const f = fixture(); f.state.queries.set('team-run', { data: { agreement: null, recentCycles: [] } });
  const { TeamRunPanel } = f.load('features/teams/TeamRunPanel.tsx');
  const html = f.render(TeamRunPanel, { team: { ...team, binding: null, currentVersionId: null, publishedVersion: null }, zh: false, onPublish() {}, onBind() {}, onConfigure() {} });
  assert.match(html, /Publish team version/);
  assert.match(html, /Link paper account/);
  assert.match(html, /Configure members/);
});

test('unknown run state cannot open a new run setup', () => {
  const f = fixture(); f.state.queries.set('team-run', { isPending: true });
  const { TeamRunPanel } = f.load('features/teams/TeamRunPanel.tsx');
  const html = f.render(TeamRunPanel, { team, zh: false });
  assert.match(html, /Reading run state/);
  assert.doesNotMatch(html, />Set up automatic runs</);
  f.state.queries.set('team-run', { isError: true, data: { agreement: null, recentCycles: [] } });
  assert.doesNotMatch(f.render(TeamRunPanel, { team, zh: false }), />Set up automatic runs</);
});

test('a failed refresh prevents starting a previously confirmed agreement', () => {
  const f = fixture();
  f.state.queries.set('team-run', { isError: true, data: { agreement: { state: 'confirmed', accountId: 'paper', members: [], configuration: { market: 'CN', cadence: { delayMinutes: 60 }, budget } }, recentCycles: [] } });
  const { TeamRunPanel } = f.load('features/teams/TeamRunPanel.tsx');
  const html = f.render(TeamRunPanel, { team, zh: false });
  const doc = new JSDOM(html).window.document;
  assert.equal([...doc.querySelectorAll('button')].find(button => button.textContent === 'Start confirmed rules').disabled, true);
});

test('run calls follow actual blueprint work or legacy role requirements within finite periods', () => {
  const { requiredRunCalls } = fixture().load('features/teams/team-run-setup.ts');
  assert.equal(requiredRunCalls({ ...config, roles: Array.from({ length: 6 }, (_, i) => role(String(i))) }), 12);
  assert.equal(requiredRunCalls({ ...config, workBlueprint: { works: Array.from({ length: 4 }, () => ({})) } }), 10);
  assert.equal(requiredRunCalls(config), 8);
});

test('an optional daily amount leaves unrequested monthly and period call caps absent', () => {
  const { automaticRunBudget } = fixture().load('features/teams/team-run-setup.ts');
  const chosen = automaticRunBudget('2500', false, 12);
  assert.equal(chosen.perRun.ceiling.amount, '2500.00');
  assert.equal(chosen.daily.costUsd, '2500.00');
  assert.equal(chosen.monthly.costUsd, null);
  assert.equal(chosen.daily.calls, null);
  assert.equal(chosen.monthly.calls, null);
  assert.throws(() => automaticRunBudget('', false, 12));
});

test('an unstaffed blueprint work cannot appear ready just because the lead is enabled', () => {
  const f = fixture(); f.state.queries.set('team-run', { data: { agreement: null, recentCycles: [] } });
  const { TeamRunPanel } = f.load('features/teams/TeamRunPanel.tsx');
  const partial = { ...team, publishedVersion: { config: { ...config, roles: [role('lead'), { ...role('research'), participation: 'disabled' }], workBlueprint: { works: [{ roleId: 'research', reviewerRoleId: 'lead' }], summary: { reviewerRoleId: 'lead' } } } } };
  const html = f.render(TeamRunPanel, { team: partial, zh: false, onConfigure() {} });
  assert.match(html, /Configure members/);
  assert.equal([...new JSDOM(html).window.document.querySelectorAll('button')].find(button => button.textContent === 'Set up automatic runs').disabled, true);
});

test('startup previews exact terms before confirmation, then retries an unknown confirm with the same frozen intent', async () => {
  const f = fixture({ realQuery: true }); let sequence = 0;
  f.load('api/auth-mode.ts').setAuthMode('local');
  window.sessionStorage.clear();
  f.state.randomUUID = () => `intent-${++sequence}`;
  const api = f.load('api/team-runs.ts').teamRunsApi;
  const calls = []; let lost = true; let agreement = null;
  api.status = async () => ({ agreement, recentCycles: [] });
  api.preview = async (_id, input) => { calls.push(['preview', input]); return { previewId: 'preview', previewHash: 'hash', expiresAt: '2099-01-01T00:00:00Z', result: { accountId: 'reviewed-account', members: [{ label: 'Actual reviewed analyst' }], configuration: { ...input, budget, cadence: { delayMinutes: 60 } } } }; };
  api.confirm = async (_id, input) => { calls.push(['confirm', input]); if (lost) { lost = false; throw new Error('Lost confirmation'); } agreement = { id: 'agreement', revision: 1, state: 'confirmed', accountId: 'reviewed-account', configuration: { budget, market: 'CN', cadence: { delayMinutes: 60 } }, members: [] }; return agreement; };
  api.start = async (_id, input) => { calls.push(['start', input]); return agreement = { ...agreement, state: 'running' }; };
  const { TeamRunPanel } = f.load('features/teams/TeamRunPanel.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => { root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(TeamRunPanel, { team, zh: false })))); await new Promise(resolve => setTimeout(resolve, 30)); });
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    await click('Set up automatic runs');
    assert.doesNotMatch(document.body.textContent, /I confirm scope/);
    await click('Preview run rules');
    assert.deepEqual(calls.map(row => row[0]), ['preview']);
    assert.equal(calls[0][1].initialRun, 'immediate');
    assert.equal(calls[0][1].budget.perRun.ceiling.amount, null);
    assert.equal(calls[0][1].budget.daily.costUsd, null);
    assert.equal(calls[0][1].budget.monthly.costUsd, null);
    assert.equal(calls[0][1].budget.daily.calls, null);
    assert.equal(calls[0][1].budget.monthly.calls, null);
    assert.match(document.body.textContent, /Actual reviewed analyst/);
    assert.ok(document.querySelector('a[href="/holdings?accountId=reviewed-account"]'));
    assert.match(document.body.textContent, /First research at startup/);
    await React.act(async () => document.querySelector('[role="checkbox"][aria-label="Confirm reviewed run rules"]').click());
    await click('Confirm and start');
    await React.act(async () => root.render(null));
    await React.act(async () => { root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(TeamRunPanel, { team, zh: false })))); await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.equal(calls.filter(row => row[0] === 'confirm').length, 1);
    await click('Check this startup');
    assert.deepEqual(calls.map(row => row[0]), ['preview', 'confirm', 'confirm', 'start']);
    assert.deepEqual(calls[1], calls[2]);
  } finally { await React.act(async () => root.unmount()); client.clear(); }
});

test('startup mode edits require a new preview and call limits fit the actual six-role work plan', async () => {
  const f = fixture({ realQuery: true }); let sequence = 0;
  f.load('api/auth-mode.ts').setAuthMode('local');
  window.sessionStorage.clear();
  f.state.randomUUID = () => `intent-${++sequence}`;
  const api = f.load('api/team-runs.ts').teamRunsApi;
  const calls = [];
  api.status = async () => ({ agreement: null, recentCycles: [] });
  api.preview = async (_id, input) => { calls.push(input); return { previewId: 'preview', previewHash: 'hash', expiresAt: '2099-01-01T00:00:00Z', result: { accountId: 'account', members: [{ label: 'Reviewed team' }], configuration: input } }; };
  const { TeamRunPanel } = f.load('features/teams/TeamRunPanel.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const sixRoles = { ...team, publishedVersion: { config: { ...config, roles: Array.from({ length: 6 }, (_, i) => role(String(i))) } } };
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(TeamRunPanel, { team: sixRoles, zh: false })))));
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    await click('Set up automatic runs');
    await React.act(async () => document.querySelector('[aria-label="Research once at startup"]').click());
    await click('Preview run rules');
    assert.equal(calls[0].initialRun, 'scheduled');
    assert.equal(calls[0].budget.perRun.callLimit, 12);
    assert.equal(calls[0].budget.daily.calls, null);
    assert.equal(calls[0].budget.monthly.calls, null);
    assert.match(document.body.textContent, /First research at the next valid after-close window/);
    await click('Edit run options');
    assert.equal(document.querySelector('[aria-label="Confirm reviewed run rules"]'), null);
    await React.act(async () => document.querySelector('[aria-label="Research once at startup"]').click());
    await click('Preview run rules');
    assert.equal(calls[1].initialRun, 'immediate');
    assert.notEqual(calls[0].requestKey, calls[1].requestKey);
  } finally { await React.act(async () => root.unmount()); client.clear(); }
});

test('a definitive preview denial releases editable fields and uses a new reviewed intent', async () => {
  const f = fixture({ realQuery: true }); let sequence = 0;
  f.load('api/auth-mode.ts').setAuthMode('local');
  window.sessionStorage.clear();
  f.state.randomUUID = () => `intent-${++sequence}`;
  const api = f.load('api/team-runs.ts').teamRunsApi;
  const previews = [];
  api.status = async () => ({ agreement: null, recentCycles: [] });
  api.preview = async (_id, input) => {
    previews.push(input);
    if (previews.length === 1) throw { response: { status: 400, data: { code: 'TEAM_BUDGET_BLOCKED' } } };
    return { previewId: 'review', previewHash: 'hash', expiresAt: '2099-01-01T00:00:00Z', result: { accountId: 'account', members: [], configuration: input } };
  };
  const { TeamRunPanel } = f.load('features/teams/TeamRunPanel.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(TeamRunPanel, { team, zh: false })))));
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    await click('Set up automatic runs');
    await click('Preview run rules');
    assert.equal(document.querySelector('[aria-label="Research once at startup"]').disabled, false);
    await React.act(async () => document.querySelector('[aria-label="Research once at startup"]').click());
    await click('Preview run rules');
    assert.notEqual(previews[0].requestKey, previews[1].requestKey);
    assert.equal(previews[1].initialRun, 'scheduled');
  } finally { await React.act(async () => root.unmount()); client.clear(); }
});
