const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/teams/team' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'FormData', 'CustomEvent', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'getComputedStyle', 'Element', 'Node', 'Event']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const { Routes, Route } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

test('overview staffing exposes reviewed suggestions and publication without saving or running research on render', async () => {
  const f = fixture();
  const { TeamAutoRunStaffing } = f.load('features/teams/TeamAutoRunStaffing.tsx');
  const { TEAM_TEMPLATES } = f.load('../../shared/team-templates.ts');
  const { instantiateTemplate } = f.load('../../shared/team-template-instantiation.ts');
  let sequence = 0;
  let state = instantiateTemplate(TEAM_TEMPLATES[0], () => `fixture-${++sequence}`);
  const roster = ['business', 'financials', 'bear', 'portfolio'].map(id => ({ id, name: `Saved ${id}`, specialty: id, status: 'active', availability: 'configured', currentVersionId: `${id}-v1`, currentVersion: { config: { templateId: id, executor: { executionMode: 'model', connectionId: 'model', model: 'fast' }, allowedToolIds: [] } } }));
  const calls = [];
  const root = createRoot(document.getElementById('root'));
  const props = { zh: false, state, team: { currentVersionId: 'version', publishedVersion: { config: state.config } }, agents: roster, models: [{ id: 'model', available: true, fastModel: 'fast', slowModel: 'slow' }], disabled: false, loading: false, dirty: false, onEdit: next => { calls.push('edit'); state = next; }, onPublish: () => calls.push('publish'), onConfigure: () => calls.push('configure') };
  const render = () => React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(TeamAutoRunStaffing, { ...props, state }))));
  const click = async name => { const button = [...document.querySelectorAll('button')].find(item => item.textContent === name); assert.ok(button, name); assert.equal(button.disabled, false); await React.act(async () => button.click()); };
  try {
    await render();
    assert.deepEqual(calls, []);
    assert.match(document.body.textContent, /Saved business/);
    assert.match(document.body.textContent, /does not publish or start research/);
    await click('Apply suggested friends');
    assert.deepEqual(calls, ['edit'], document.body.textContent);
    assert.ok(state.config.roles.every(role => role.agentId && role.participation === 'enabled'));
    await render();
    await click('Save and review publication');
    assert.deepEqual(calls, ['edit', 'publish']);
  } finally { await React.act(async () => root.unmount()); }
});

test('ready published team without draft differences has no redundant setup card', () => {
  const f = fixture();
  const { TeamAutoRunStaffing } = f.load('features/teams/TeamAutoRunStaffing.tsx');
  const config = { roles: [{ id: 'role', agentId: 'friend', agentVersionId: 'v1', executor: { executionMode: 'model' }, participation: 'enabled' }] };
  const html = f.render(TeamAutoRunStaffing, { state: { config }, team: { currentVersionId: 'version', publishedVersion: { config } }, agents: [], models: [], zh: false, disabled: false, dirty: false });
  assert.equal(html, '');
});

test('a staffed lead cannot hide required unstaffed blueprint researchers', () => {
  const f = fixture();
  const { TeamAutoRunStaffing } = f.load('features/teams/TeamAutoRunStaffing.tsx');
  const config = { roles: [{ id: 'lead', agentId: 'friend', agentVersionId: 'v1', executor: { executionMode: 'model' }, participation: 'enabled' }, { id: 'researcher', responsibility: 'Custom research', expectedOutput: 'Evidence', participation: 'placeholder' }], defaults: { leadRoleId: 'lead' }, workBlueprint: { works: [{ roleId: 'researcher', reviewerRoleId: 'lead' }], summary: { reviewerRoleId: 'researcher' } } };
  const html = f.render(TeamAutoRunStaffing, { state: { config, display: { roleLabels: {} } }, team: { currentVersionId: 'version', publishedVersion: { config } }, agents: [], models: [], zh: false, disabled: false, dirty: false });
  assert.match(html, /Staff the team first/);
  assert.match(html, /researcher/);
});

test('published unbound overview exposes account setup without searching the organization editor', async () => {
  const f = fixture({ realQuery: true });
  const { TEAM_TEMPLATES } = f.load('../../shared/team-templates.ts');
  const { instantiateTemplate } = f.load('../../shared/team-template-instantiation.ts');
  let sequence = 0;
  const state = instantiateTemplate(TEAM_TEMPLATES[0], () => `fixture-${++sequence}`);
  const team = { id: 'team', status: 'active', currentVersionId: 'version', currentVersion: 1, semanticRevision: 1, layoutRevision: 1, displayRevision: 1, bindingRevision: 0, binding: null, draft: { config: state.config }, display: state.display, layout: state.layout, publishedVersion: { config: state.config }, capabilities: { workspaceEnabled: true, researchEnabled: true } };
  f.load('api/teams.ts').teamsApi.detail = async () => team;
  f.load('api/teams.ts').teamsApi.list = async () => ({ items: [] });
  f.load('api/teams.ts').teamsApi.sources = async () => ({ items: [] });
  f.load('api/team-runs.ts').teamRunsApi.status = async () => ({ agreement: null, recentCycles: [] });
  f.load('api/agent-roster.ts').agentRosterApi.list = async () => ({ items: [] });
  f.load('api/model-connections.ts').fetchModelConnections = async () => [];
  f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi.accounts = async () => [];
  const Page = f.load('pages/Teams/TeamWorkspacePage.tsx').default;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, { initialEntries: ['/teams/team?panel=overview'] }, React.createElement(Routes, null, React.createElement(Route, { path: '/teams/:id', element: React.createElement(Page) }))))));
    await settle();
    assert.match(document.body.textContent, /Staff the team first/);
    const accountButton = [...document.querySelectorAll('button')].find(button => button.textContent === 'Link paper account');
    assert.ok(accountButton, 'overview must offer an account action');
    assert.equal(accountButton.disabled, false);
    await React.act(async () => accountButton.click());
    await settle();
    assert.ok(document.querySelector('[role="dialog"]'), 'account setup opens directly from overview');
  } finally { await React.act(async () => root.unmount()); client.clear(); window.sessionStorage.clear(); }
});
