const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/teams?guided=1' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'getComputedStyle']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, Routes, Route, Link } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');
const agents = [
  { id: 'good', name: 'Cashflow owl', specialty: 'Read cash flow', avatar: 'technical', availability: 'configured' },
  { id: 'offline', name: 'Offline bear', specialty: 'Check risk', avatar: 'risk', availability: 'unavailable' },
  { id: 'other', name: 'Value rabbit', specialty: 'Read valuation', avatar: 'growth', availability: 'configured' },
].map(a => ({ ...a, status: 'active', currentVersionId: `${a.id}-v1`, currentVersion: { config: { templateId: 'financials', executor: { executionMode: 'model', connectionId: 'model', model: 'fast' }, allowedToolIds: [] } } }));
async function scenario(run) {
  window.sessionStorage.clear();
  const f = fixture(); f.load('api/auth-mode.ts').setAuthMode('local');
  f.state.queries.set('agent-roster', { data: { items: agents } });
  f.state.queries.set('settings', { data: [{ id: 'model', available: true, fastModel: 'fast' }] });
  f.load('api/ai-investment.ts').previewAiInvestment = async () => ({ previewId: 'fixture-seed', expiresAt: '2099-01-01', needsInput: [], markets: ['CN'], seed: { positions: [], cash: [], capturedAt: '2026-11-12' } });
  const Page = f.load('features/teams/GuidedTeamCreate.tsx').default;
  let root;
  const mount = async () => {
    root = createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ['/teams?guided=1'] }, React.createElement(Routes, null,
      React.createElement(Route, { path: '/teams', element: React.createElement(Page) }),
      React.createElement(Route, { path: '/friends', element: React.createElement(Link, { to: '/teams?guided=1' }, 'Return to creation') }),
    ))));
  };
  const click = async text => { const item = [...document.querySelectorAll('button,a')].find(e => e.textContent === text || e.getAttribute('aria-label') === text); assert.ok(item, `Missing ${text}`); assert.ok(!item.disabled); await React.act(async () => item.click()); };
  const type = async (id, value) => React.act(async () => { const input = document.getElementById(id); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  const remount = async () => { await React.act(async () => root.unmount()); await mount(); };
  try { await mount(); await run({ f, click, type, remount }); } finally { await React.act(async () => root.unmount()); window.sessionStorage.clear(); }
}
test('the editable form survives refresh and a visit to friends and explains unavailable selection', async () => {
  await scenario(async ({ click, type, remount }) => {
    await type('guided-name', 'My retained team');
    await click('Next: choose agents');
    assert.match(document.body.textContent, /Cashflow owl/);
    assert.match(document.body.textContent, /Restore connection/);
    assert.equal(document.querySelectorAll('[role=checkbox]')[1].disabled, true);
    await click('Select Cashflow owl');
    await click('Select Value rabbit');
    await click('Add or edit agents first');
    await click('Return to creation');
    assert.match(document.body.textContent, /Choose from your agents/);
    assert.equal(document.querySelector('[aria-label="Select Value rabbit"]').getAttribute('aria-checked'), 'true');
    assert.equal(document.querySelector('[aria-label="Select Cashflow owl"]').getAttribute('aria-checked'), 'false');
    await click('Next: review startup');
    await type('guided-budget', '7');
    await remount();
    await click('Next: review startup');
    assert.equal(document.getElementById('guided-budget').value, '7');
    await click('Back');
    await click('Back');
    assert.equal(document.getElementById('guided-name').value, 'My retained team');
    await remount();
    assert.equal(document.getElementById('guided-name').value, 'My retained team');
  });
});
test('resolved changed progress has a safe exit which keeps resources and allows a fresh form', async () => {
  await scenario(async ({ f, remount, click }) => {
    f.load('features/teams/guided-team-storage.ts').saveGuidedProgress('local', { version: 1, key: 'old', name: 'Old team', agents: [], preview: { previewId: 'p' }, teamId: 'saved-team', accountId: 'saved-account', reviewRequired: 'changed' }, window.sessionStorage);
    await remount();
    await click('Keep created resources and end setup');
    assert.equal(document.getElementById('guided-name').disabled, false);
    assert.equal(f.load('features/teams/guided-team-storage.ts').readGuidedProgress('local', window.sessionStorage), null);
    assert.match([...Array(window.sessionStorage.length)].map((_, i) => window.sessionStorage.getItem(window.sessionStorage.key(i))).join(''), /saved-account/);
  });
});

test('changing account owners never restores another owner’s editable form', async () => {
  await scenario(async ({ f, remount, type }) => {
    f.load('api/auth-mode.ts').setAuthMode('account');
    const login = owner => window.localStorage.setItem('sq-at', `header.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.signature`);
    login('owner-a'); await remount();
    await type('guided-name', 'Private owner A team');
    login('owner-b'); await remount();
    assert.equal(document.getElementById('guided-name').value, 'My research team');
    login('owner-a'); await remount();
    assert.equal(document.getElementById('guided-name').value, 'Private owner A team');
    window.localStorage.removeItem('sq-at');
  });
});

test('unresolved startup progress keeps its original key and offers no end-and-recreate action', async () => {
  await scenario(async ({ f, remount }) => {
    const storage = f.load('features/teams/guided-team-storage.ts');
    storage.saveGuidedProgress('local', { version: 1, key: 'original-unknown', name: 'Unresolved setup', agents: [], preview: { previewId: 'p' }, pendingOperation: 'account' }, window.sessionStorage);
    await remount();
    assert.match(document.body.textContent, /original request is unresolved/);
    assert.ok(![...document.querySelectorAll('button')].some(button => button.textContent === 'Keep created resources and end setup'));
    assert.equal(storage.readGuidedProgress('local', window.sessionStorage).key, 'original-unknown');
  });
});

test('a reviewed market and the visible default members survive refresh without being silently replaced', async () => {
  await scenario(async ({ f, click, remount }) => {
    await click('Next: choose agents');
    f.state.queries.set('agent-roster', { data: { items: [agents[2], agents[1], agents[0]] } });
    await click('Add or edit agents first'); await click('Return to creation');
    assert.equal(document.querySelector('[aria-label="Select Cashflow owl"]').getAttribute('aria-checked'), 'true');
    assert.equal(document.querySelector('[aria-label="Select Value rabbit"]').getAttribute('aria-checked'), 'false');
    await click('Next: review startup');
    await React.act(async () => { const select = document.getElementById('guided-market'); select.value = 'HK'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await remount(); await click('Next: review startup');
    assert.equal(document.getElementById('guided-market').value, 'HK');
  });
});

test('member presets pick matching agents and manual choice stays available', async () => {
  await scenario(async ({ f, click, remount }) => {
    const roster = [
      { id: 'fin1', name: 'Cashflow owl', specialty: 'Read accounts and cash flow', avatar: 'technical', templateId: 'financials' },
      { id: 'val1', name: 'Value rabbit', specialty: 'Estimate value', avatar: 'value', templateId: 'valuation' },
      { id: 'bear1', name: 'Counterpoint cat', specialty: 'Find counterevidence', avatar: 'risk', templateId: 'bear' },
      { id: 'mod1', name: 'Moderator dog', specialty: 'Clarify agreement', avatar: 'moderator', templateId: 'moderator' },
    ].map(a => ({ id: a.id, name: a.name, specialty: a.specialty, avatar: a.avatar, availability: 'configured', status: 'active', currentVersionId: `${a.id}-v1`, currentVersion: { config: { templateId: a.templateId, executor: { executionMode: 'model', connectionId: 'model', model: 'fast' }, allowedToolIds: [] } } }));
    f.state.queries.set('agent-roster', { data: { items: roster } });
    window.sessionStorage.clear();
    await remount();
    await click('Next: choose agents');
    const checked = () => [...document.querySelectorAll('[role=checkbox]')].filter(box => box.getAttribute('aria-checked') === 'true').map(box => box.getAttribute('aria-label'));
    const pressed = text => [...document.querySelectorAll('button')].find(button => button.textContent === text)?.getAttribute('aria-pressed');
    assert.equal(checked().sort().join('|'), ['Select Cashflow owl', 'Select Counterpoint cat', 'Select Moderator dog'].sort().join('|'));
    assert.equal(pressed('Recommended'), 'true');
    await click('Valuation');
    assert.equal(checked().sort().join('|'), ['Select Cashflow owl', 'Select Value rabbit', 'Select Moderator dog'].sort().join('|'));
    assert.equal(pressed('Valuation'), 'true');
    await click('Full research');
    assert.equal(checked().length, 4);
    assert.equal(pressed('Full research'), 'true');
    await click('Choose my own');
    assert.equal(checked().length, 0);
    assert.equal(pressed('Choose my own'), 'true');
    await click('Select Counterpoint cat');
    assert.equal(pressed('Choose my own'), 'true');
    await click('Next: review startup');
    assert.match(document.body.textContent, /Counterpoint cat/);
  });
});

test('the seed preview request key satisfies the strict investment idempotency contract', async () => {
  await scenario(async ({ f, click }) => {
    const sent = [];
    f.load('api/ai-investment.ts').previewAiInvestment = async payload => { sent.push(payload); return { previewId: 'fixture-seed', expiresAt: '2099-01-01', needsInput: [], markets: ['CN'], seed: { positions: [], cash: [], capturedAt: '2026-11-12' } }; };
    await click('Next: choose agents');
    await click('Next: review startup');
    assert.equal(sent.length, 1);
    // The investment schema (investment-policy.rules.ts) rejects ':' outright; the guided flow
    // used to fail review with a 400 "Please check the supplied investment details.".
    assert.ok(!sent[0].requestKey.includes(':'));
    assert.match(sent[0].requestKey, /^[a-zA-Z0-9_-]{8,128}$/u);
  });
});

test('legacy ownership failures conceal private content and retain the old receipt without new requests', async () => {
  await scenario(async ({ f, remount, click }) => {
    const raw = JSON.stringify({ version: 1, key: 'legacy', name: 'Hidden private team', agents: [{ id: 'old-person' }], preview: { previewId: 'old' }, teamId: 'old-team', accountId: 'old-account' });
    window.sessionStorage.setItem('squabble.team-guided-create', raw);
    const calls = [];
    f.load('api/agent-roster.ts').agentRosterApi.detail = async id => { calls.push(['GET agent', id]); return { id }; };
    let unavailable = true;
    f.load('api/teams.ts').teamsApi.detail = async id => { calls.push(['GET team', id]); if (unavailable) throw new Error('GET unavailable'); return { id }; };
    f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi.account = async id => { calls.push(['GET account', id]); return { id }; };
    await remount();
    assert.match(document.body.textContent, /legacy setup could not be verified/i);
    assert.doesNotMatch(document.body.textContent, /Hidden private team|old-person|old-team|old-account/);
    assert.equal(document.getElementById('guided-name'), null);
    assert.equal(window.sessionStorage.getItem('squabble.team-guided-create'), raw);
    assert.equal(f.state.requests.filter(request => request.method === 'post').length, 0);
    unavailable = false; await click('Check legacy progress again');
    assert.match(document.body.textContent, /Hidden private team/);
    assert.equal(f.state.requests.filter(request => request.method === 'post').length, 0);
    assert.ok(calls.every(([method]) => method.startsWith('GET')));
  });
});

test('an expired seed before first dispatch still revalidates agent versions before creating anything', async () => {
  await scenario(async ({ f, click }) => {
    let expired = true; let changed = false;
    f.load('api/ai-investment.ts').previewAiInvestment = async () => ({ previewId: expired ? 'expired' : 'refreshed', expiresAt: expired ? '2000-01-01' : '2099-01-01', needsInput: [], markets: ['CN'], seed: { positions: [], cash: [], capturedAt: '2026-11-12' } });
    f.load('api/agent-roster.ts').agentRosterApi.list = async () => ({ items: agents.map(agent => ({ ...agent, currentVersionId: changed ? `${agent.id}-v2` : agent.currentVersionId })) });
    f.load('api/model-connections.ts').fetchModelConnections = async () => [{ id: 'model', available: true, fastModel: 'fast' }];
    await click('Next: choose agents'); await click('Next: review startup');
    await React.act(async () => document.querySelector('[role=checkbox]').click());
    await click('Start my team');
    expired = false; changed = true;
    await click('Refresh review and keep progress');
    await React.act(async () => document.querySelector('[role=checkbox]').click());
    await click('Check and continue');
    assert.equal(f.state.requests.filter(request => request.method === 'post').length, 0);
    assert.match(document.body.textContent, /Review the members again/);
    assert.ok(document.querySelector('[aria-label="Select Cashflow owl"]'));
  });
});

test('legacy changed progress can settle its unknown original account receipt before ending setup', async () => {
  await scenario(async ({ f, remount, click }) => {
    const input = { requestKey: 'old:account', previewId: 'original-seed', name: 'Old paper account', confirmOpeningCash: true };
    window.sessionStorage.setItem('squabble.team-guided-create', JSON.stringify({ version: 1, key: 'old', name: 'Old workflow', agents: [agents[0]], models: [], market: 'CN', dailyUsd: '2', preview: { previewId: 'original-seed', needsInput: [], seed: { capturedAt: '2026-11-12', positions: [], cash: [] } }, teamId: 'old-team', accountInput: input, reviewRequired: 'changed' }));
    f.load('api/agent-roster.ts').agentRosterApi.detail = async id => ({ id });
    f.load('api/teams.ts').teamsApi.detail = async id => ({ id });
    const posts = [];
    f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi.create = async value => { posts.push(JSON.parse(JSON.stringify(value))); return { accountId: 'recovered-account' }; };
    await remount(); await click('Restore progress');
    await React.act(async () => document.querySelector('[role=checkbox]').click());
    await click('Check and continue');
    assert.deepEqual(posts, [input]);
    await click('Keep created resources and end setup');
    assert.equal(document.getElementById('guided-name').disabled, false);
  });
});
