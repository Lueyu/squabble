const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/teams' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'MutationObserver', 'NodeFilter', 'CustomEvent', 'DocumentFragment', 'Element', 'Node', 'Event', 'getComputedStyle']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

test('a definitively stale seed is visibly re-reviewed while retaining the original team and publication', async () => {
  window.sessionStorage.clear();
  const f = fixture(); let sequence = 0; f.state.randomUUID = () => `refresh-${++sequence}`;
  f.load('api/auth-mode.ts').setAuthMode('local');
  const teams = f.load('api/teams.ts').teamsApi;
  const portfolios = f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi;
  const team = { id: 'team', bindingRevision: 0, draft: { semanticRevision: 0, config: { roles: [] } }, currentVersionId: null };
  let createdTeams = 0; let published = 0; const accountRequests = [];
  teams.create = async () => { createdTeams++; return team; };
  teams.detail = async () => team;
  teams.publishPreview = async () => ({ previewId: 'publication', previewHash: 'hash' });
  teams.publish = async () => { published++; team.currentVersionId = 'version'; return { version: { id: 'version' } }; };
  teams.list = async () => ({ items: [] });
  teams.bindingPreview = async () => ({ previewId: 'binding', previewHash: 'binding-hash' });
  teams.binding = async () => ({ binding: { id: 'binding' } });
  portfolios.create = async request => { accountRequests.push(request); if (request.previewId === 'stale') throw Object.assign(new Error('Changed positions'), { isAxiosError: true, response: { status: 409, data: { message: 'SOURCE_CHANGED_REPREVIEW' } } }); return { accountId: 'new-account' }; };
  portfolios.setCompanion = async () => {};
  const fresh = { previewId: 'fresh', needsInput: [], expiresAt: '2099-01-01T00:00:00Z' };
  const refreshRequests = [];
  f.load('api/ai-investment.ts').previewAiInvestment = async request => {
    refreshRequests.push(request);
    if (refreshRequests.length === 1) throw Object.assign(new Error('Lost preview response'), { isAxiosError: true });
    return refreshRequests.length === 2 ? { ...fresh, previewId: 'expired-recovery', expiresAt: '2000-01-01T00:00:00Z' } : fresh;
  };
  const { useTeamQuickStart } = f.load('features/teams/use-team-quick-start.ts');
  let workflow;
  function Harness() { workflow = useTeamQuickStart(false); return null; }
  const root = createRoot(document.getElementById('root'));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Harness))));
    await React.act(async () => workflow.run({ name: 'Team', description: '', avatar: '', templateId: 'classic', seed: { kind: 'holdings', virtualCash: ['CNY', 'USD', 'HKD'].map(currency => ({ currency, amount: 10000 })) }, accountName: '', connectionId: null, reviewedSeed: { previewId: 'stale', requestKey: 'original' } }, new Set()));
    await settle();
    assert.equal(workflow.state.failureKind, 'recoverable-preview');
    await React.act(async () => { await assert.rejects(workflow.refreshSeedReview(), /Lost preview response/); });
    await React.act(async () => { await workflow.refreshSeedReview(); });
    let shown;
    await React.act(async () => { shown = await workflow.refreshSeedReview(); });
    assert.equal(refreshRequests[0].requestKey, refreshRequests[1].requestKey, 'unknown preview response keeps its request identity');
    assert.notEqual(refreshRequests[1].requestKey, refreshRequests[2].requestKey, 'a received expired review can be replaced');
    assert.equal(shown.previewId, 'fresh');
    assert.equal(accountRequests.length, 1, 'reading a new seed cannot commit the account');
    await React.act(async () => workflow.resumeWithSeedReview(shown, new Set()));
    await settle();
    assert.equal(workflow.state.status, 'done');
    assert.equal(createdTeams, 1);
    assert.equal(published, 1);
    assert.equal(accountRequests[1].previewId, 'fresh');
    assert.notEqual(accountRequests[1].requestKey, accountRequests[0].requestKey);
  } finally { await React.act(async () => root.unmount()); window.sessionStorage.clear(); }
});

test('reviewed multi-currency creation retries a lost account receipt without another team, preview or account identity', async () => {
  window.sessionStorage.clear();
  const f = fixture({ realQuery: true }); let sequence = 0; f.state.randomUUID = () => `workflow-${++sequence}`;
  f.load('api/auth-mode.ts').setAuthMode('local');
  const teams = f.load('api/teams.ts').teamsApi;
  const portfolios = f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi;
  const investment = f.load('api/ai-investment.ts');
  const calls = [];
  const team = { id: 'team', bindingRevision: 0, draft: { semanticRevision: 0, config: { roles: [], defaults: { leadRoleId: null } } }, currentVersionId: null, accountId: null, binding: null };
  teams.create = async input => { calls.push(['team', input]); return team; };
  teams.detail = async () => team;
  teams.publishPreview = async () => ({ previewId: 'publication', previewHash: 'hash' });
  teams.publish = async () => { team.currentVersionId = 'v1'; return { version: { id: 'v1' } }; };
  teams.list = async () => ({ items: [] });
  teams.bindingPreview = async () => ({ previewId: 'binding-preview', previewHash: 'binding-hash' });
  teams.binding = async () => { team.accountId = 'new-account'; team.binding = { id: 'binding', state: 'active' }; return { binding: team.binding }; };
  let lost = true;
  portfolios.create = async input => { calls.push(['account', input]); if (lost) { lost = false; throw Object.assign(new Error('Lost receipt'), { isAxiosError: true }); } return { accountId: 'new-account' }; };
  portfolios.setCompanion = async () => {};
  portfolios.accounts = async () => { calls.push(['accounts']); return [{ id: 'unrelated', name: 'New team simulation' }]; };
  investment.previewAiInvestment = async () => { calls.push(['preview']); return { previewId: 'unexpected-preview' }; };
  const { useTeamQuickStart } = f.load('features/teams/use-team-quick-start.ts');
  let workflow;
  let zh = false;
  function Harness() { workflow = useTeamQuickStart(zh); return null; }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  let root = createRoot(document.getElementById('root'));
  const mount = () => React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(Harness)))));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  try {
    await mount();
    await React.act(async () => workflow.run({ name: 'New team', description: '', avatar: '', templateId: '', creationMode: 'blank', seed: { kind: 'holdings', virtualCash: ['CNY', 'USD', 'HKD'].map(currency => ({ currency, amount: 10000 })) }, accountName: '', connectionId: null, reviewedSeed: { previewId: 'reviewed-preview', requestKey: 'reviewed-key' } }, new Set()));
    await settle();
    assert.equal(workflow.state.status, 'failed');
    assert.equal(calls.filter(([operation]) => operation === 'preview').length, 0, 'use the user-reviewed snapshot');
    await React.act(async () => root.unmount());
    root = createRoot(document.getElementById('root'));
    zh = true;
    await mount();
    await React.act(async () => workflow.resume(new Set(['unrelated'])));
    await settle();
    assert.equal(workflow.state.status, 'done');
    assert.equal(calls.filter(([operation]) => operation === 'team').length, 1);
    const accountRequests = calls.filter(([operation]) => operation === 'account').map(([, request]) => request);
    assert.equal(accountRequests.length, 2);
    assert.deepEqual(accountRequests[1], accountRequests[0]);
    assert.equal(accountRequests[0].previewId, 'reviewed-preview');
    assert.equal(calls.filter(([operation]) => operation === 'accounts').length, 0, 'never adopt an unrelated same-name account');
    assert.equal('templateId' in calls.find(([operation]) => operation === 'team')[1], false);
  } finally { await React.act(async () => root.unmount()); client.clear(); window.sessionStorage.clear(); }
});

test('creation previews edited three-currency funds and real positions before starting the new-account chain', async () => {
  window.sessionStorage.clear();
  const f = fixture({ realQuery: true });
  const requests = [];
  f.load('api/agent-roster.ts').agentRosterApi.list = async () => ({ items: [] });
  f.load('api/ai-investment.ts').previewAiInvestment = async request => {
    requests.push(request);
    return { id: 'seed', previewId: 'seed', expiresAt: new Date(Date.now() + 600000).toISOString(), needsInput: [], seed: { capturedAt: new Date().toISOString(), positions: [{ sourceHoldingId: 'real-position', ticker: 'FIXTURE', shares: '12', market: 'US', currency: 'USD' }], cash: request.virtualCash.map(row => ({ currency: row.currency, total: String(row.amount) })) } };
  };
  const { TeamCreateDialog } = f.load('features/teams/TeamCreateDialog.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  let confirmed = null;
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const click = async text => { const target = [...document.querySelectorAll('button')].find(button => button.textContent === text); assert.ok(target, text); assert.equal(target.disabled, false); await React.act(async () => target.click()); await settle(); };
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(TeamCreateDialog, { open: true, teams: [], onOpenChange() {}, recovery: { name: 'Reviewed team', description: '', avatar: '', mode: 'template', copyVersionId: '', templateId: 'classic', virtualCash: { CNY: '23456', USD: '10000', HKD: '10000' } }, onCreate: input => { confirmed = input; } })))));
    await settle();
    await click('Next');
    const amounts = [...document.querySelectorAll('input[type="number"]')];
    assert.deepEqual(amounts.map(input => input.value), ['23456', '10000', '10000']);
    assert.equal(confirmed, null);
    await click('Preview positions and virtual capital');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].origin, 'holdings');
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0].virtualCash)), [{ currency: 'CNY', amount: 23456 }, { currency: 'USD', amount: 10000 }, { currency: 'HKD', amount: 10000 }]);
    assert.match(document.body.textContent, /FIXTURE/);
    assert.match(document.body.textContent, /real cash is not used as starting capital/);
    assert.equal(confirmed, null, 'preview alone cannot create a team or account');
    const final = [...document.querySelectorAll('button')].find(button => button.textContent === 'Create team and independent paper account');
    assert.equal(final.disabled, true);
    await React.act(async () => document.querySelector('[role="checkbox"]').click());
    await settle();
    await click('Create team and independent paper account');
    assert.equal(confirmed.reviewedSeed.previewId, 'seed');
    assert.equal(confirmed.seed.virtualCash[0].amount, 23456);
  } finally { await React.act(async () => root.unmount()); client.clear(); window.sessionStorage.clear(); }
});
test('a template name conflict returns to the staffing form and submits the suggested name with a fresh key', async () => {
  window.sessionStorage.clear();
  const f = fixture({ realQuery: true });
  let sequence = 0;
  f.state.randomUUID = () => `name-conflict-${++sequence}`;
  f.load('api/auth-mode.ts').setAuthMode('local');
  const teams = f.load('api/teams.ts').teamsApi;
  const portfolios = f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi;
  const requests = [];
  const team = { id: 'new-team', bindingRevision: 0, draft: { semanticRevision: 0, config: { roles: [] } }, currentVersionId: null, accountId: null, binding: null };
  teams.list = async () => ({ items: [], capabilities: { workspaceEnabled: true } });
  teams.create = async input => {
    requests.push(input);
    if (requests.length === 1) throw Object.assign(new Error('Conflict'), { isAxiosError: true, response: { status: 409, data: { error: { code: 'TEAM_NAME_CONFLICT' } } } });
    return team;
  };
  teams.detail = async () => team;
  teams.publishPreview = async () => ({ previewId: 'publish', previewHash: 'hash' });
  teams.publish = async () => { team.currentVersionId = 'version'; return { version: { id: 'version' } }; };
  teams.bindingPreview = async () => ({ previewId: 'binding', previewHash: 'hash' });
  teams.binding = async () => ({ binding: { id: 'bound' } });
  portfolios.accounts = async () => [];
  portfolios.setCompanion = async () => {};
  let accountWrites = 0;
  portfolios.create = async () => { accountWrites++; return { accountId: 'new-account' }; };
  f.load('api/ai-investment.ts').previewAiInvestment = async request => ({
    previewId: 'seed', expiresAt: '2099-01-01T00:00:00Z', needsInput: [],
    seed: { capturedAt: '2026-11-18T00:00:00Z', positions: [], cash: request.virtualCash.map(row => ({ currency: row.currency, total: String(row.amount) })) },
  });

  f.load('api/local-agents.ts').fetchLocalAgentsStatus = async () => ({ agents: [] });
  f.load('api/model-connections.ts').fetchModelConnections = async () => [];
  const { TeamsPage } = f.load('pages/Teams/TeamsPage.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const button = text => [...document.querySelectorAll('button')].find(candidate => candidate.textContent === text);
  const click = async text => {
    const target = button(text);
    assert.ok(target, text);
    assert.equal(target.disabled, false);
    await React.act(async () => target.click());
    await settle();
  };
  const confirm = async () => {
    await click('Next');
    await click('Preview positions and virtual capital');
    await React.act(async () => document.querySelector('[role="checkbox"]').click());
    await click('Create team and independent paper account');
  };
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: ['/teams?advanced=1&create=1'] },
        React.createElement(TeamsPage)))));
    await settle();
    await click('Bull–bear committee');
    const staffing = document.querySelector('[aria-label="Automatic staffing preview"]');
    assert.equal(staffing.querySelectorAll('li').length, 12);
    assert.equal(staffing.querySelectorAll('li[data-assigned="true"]').length, 6);
    await confirm();
    assert.equal(requests.length, 1);
    assert.equal(accountWrites, 0);
    assert.match(document.querySelector('[role="alert"]').textContent, /already uses this name/);
    assert.equal(document.querySelector('input[aria-invalid="true"]').value, 'Bull–bear committee');
    assert.equal(button('Next').disabled, true);
    await click('Use “Bull–bear committee 2”');
    assert.equal(document.querySelector('input[aria-invalid="true"]'), null);
    await confirm();
    assert.deepEqual(requests.map(request => request.name), ['Bull–bear committee', 'Bull–bear committee 2']);
    assert.notEqual(requests[0].requestKey, requests[1].requestKey);
    assert.equal(requests[1].templateId, requests[0].templateId);
    assert.equal(accountWrites, 1);
  } finally { await React.act(async () => root.unmount()); client.clear(); window.sessionStorage.clear(); }
});

test('template setup replays a committed draft save after reload before publishing the saved revision', async () => {
  window.sessionStorage.clear();
  const f = fixture();
  let sequence = 0;
  f.state.randomUUID = () => `template-route-${++sequence}`;
  f.load('api/auth-mode.ts').setAuthMode('local');
  const teams = f.load('api/teams.ts').teamsApi;
  const portfolios = f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi;
  const team = {
    id: 'team', bindingRevision: 0, currentVersionId: null,
    draft: { semanticRevision: 3, config: {
      defaults: { leadRoleId: 'lead' },
      roles: [{ id: 'lead', agentId: 'built-in', agentVersionId: 'pinned', participation: 'placeholder', executor: null }],
    } },
  };
  const saves = [];
  const publications = [];
  let creates = 0;
  let commits = 0;
  let draftReceipt;
  teams.create = async () => { creates++; return structuredClone(team); };
  teams.detail = async () => structuredClone(team);
  teams.saveDraft = async (id, body) => {
    const request = { id, body: structuredClone(body) };
    saves.push(request);
    if (draftReceipt && body.requestKey === draftReceipt.key) {
      assert.deepEqual(request, saves[0], 'same-key replay must have the exact original body and revision');
      return structuredClone(draftReceipt.result);
    }
    assert.equal(body.expectedSemanticRevision, team.draft.semanticRevision, 'new saves must pass the revision fence');
    team.draft = { semanticRevision: team.draft.semanticRevision + 1, config: structuredClone(body.config) };
    commits++;
    draftReceipt = { key: body.requestKey, result: structuredClone(team) };
    throw Object.assign(new Error('Lost response after commit'), { isAxiosError: true });
  };
  teams.publishPreview = async (id, body) => {
    publications.push(['preview', id, structuredClone(body)]);
    assert.equal(body.expectedSemanticRevision, team.draft.semanticRevision);
    return { previewId: 'draft-4-preview', previewHash: 'draft-4-hash' };
  };
  teams.publish = async (id, body) => {
    publications.push(['confirm', id, structuredClone(body)]);
    return { version: { id: 'published-draft-4' } };
  };
  portfolios.create = async () => ({ accountId: 'simulation' });
  portfolios.setCompanion = async () => {};
  teams.bindingPreview = async () => ({ previewId: 'binding-preview', previewHash: 'binding-hash' });
  teams.binding = async () => ({ binding: { id: 'binding' } });

  const { useTeamQuickStart } = f.load('features/teams/use-team-quick-start.ts');
  let workflow;
  function Harness() { workflow = useTeamQuickStart(false); return null; }
  let root = createRoot(document.getElementById('root'));
  const mount = () => React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Harness))));
  try {
    await mount();
    await React.act(async () => workflow.run({
      name: 'Routed template', description: '', avatar: '', templateId: 'classic', creationMode: 'template',
      templateRoute: { kind: 'model', connection: { id: 'fixture-route', fastModel: 'fast', slowModel: 'slow' } },
      seed: { kind: 'holdings' }, reviewedSeed: { previewId: 'seed', requestKey: 'seed-key' },
      accountName: '', connectionId: null,
    }, new Set()));
    assert.equal(workflow.state.failureKind, 'network');
    assert.equal(workflow.state.progress.steps.find(step => step.id === 'draft').state, 'failed');
    assert.equal(team.draft.semanticRevision, 4, 'the draft was committed before the response was lost');
    assert.equal(saves[0].body.expectedSemanticRevision, 3);
    assert.ok(saves[0].body.requestKey);
    assert.equal(saves[0].body.config.roles[0].executor.model, 'slow');
    assert.deepEqual(publications, []);

    await React.act(async () => root.unmount());
    root = createRoot(document.getElementById('root'));
    await mount();
    assert.equal(workflow.state.failureKind, 'network');
    await React.act(async () => workflow.resume(new Set()));
    assert.equal(saves.length, 2);
    assert.deepEqual(saves[1], saves[0]);
    assert.equal(creates, 1);
    assert.equal(commits, 1);
    assert.deepEqual(publications.map(([step, id]) => [step, id]), [['preview', 'team'], ['confirm', 'team']]);
    assert.equal(publications[0][2].expectedSemanticRevision, 4);
    assert.equal(publications[1][2].previewId, 'draft-4-preview');
    assert.equal(publications[1][2].previewHash, 'draft-4-hash');
    assert.equal(workflow.state.status, 'done');
    assert.equal(workflow.state.progress.versionId, 'published-draft-4');
  } finally {
    await React.act(async () => root.unmount());
    window.sessionStorage.clear();
  }
});
