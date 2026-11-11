const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/teams/team-one' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

function team() {
  return { id: 'team-one', name: 'Fictional team', description: '', status: 'active', displayRevision: 2, layoutRevision: 3, semanticRevision: 4, bindingRevision: 0, scopeRevision: 0,
    currentVersionId: null, currentVersion: null, accountId: null, binding: null, publishedVersion: null, capabilities: { workspaceEnabled: true, researchEnabled: true },
    display: { name: 'Fictional team', avatar: null, departmentLabels: {}, roleLabels: { role: 'Analyst' } },
    draft: { semanticRevision: 4, baseVersionId: null, config: { schemaVersion: 1, departments: [], roles: [{ id: 'role', departmentId: null, participation: 'placeholder', responsibility: '', expectedOutput: '', executor: null, allowedToolIds: [], sourceGrantIds: [] }], relations: [], defaults: { leadRoleId: null, parallelism: 1 } } },
    layout: { schemaVersion: 1, positions: { role: { x: 10, y: 20 } }, collapsedDepartmentIds: [], viewport: { x: 0, y: 0, zoom: 1 } } };
}
async function mount() {
  window.sessionStorage.clear();
  const f = fixture({ realQuery: true }); const api = f.load('api/teams.ts').teamsApi;
  const useTeamDraft = f.load('features/teams/use-team-draft.ts').useTeamDraft;
  const current = team(); let observed;
  api.detail = async () => current;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const root = createRoot(document.getElementById('root'));
  function Observed() { observed = useTeamDraft(current, false); return null; }
  await React.act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Observed))));
  const flush = async (ms = 30) => React.act(async () => new Promise(resolve => setTimeout(resolve, ms)));
  return { api, current, get value() { return observed; }, flush, async close() { await React.act(async () => root.unmount()); client.clear(); } };
}

test('semantic save uses CAS, preserves local edits after failure and reuses the exact request key', async () => {
  const f = await mount(); const calls = []; let fail = true;
  f.api.saveDraft = async (id, input) => { calls.push({ id, input }); if (fail) throw new Error('fictional disconnect'); return { ...f.current, semanticRevision: 5, draft: { ...f.current.draft, semanticRevision: 5, config: input.config } }; };
  try {
    await React.act(async () => f.value.edit(current => ({ ...current, config: { ...current.config, roles: current.config.roles.map(role => ({ ...role, responsibility: 'Exact scope' })) } })));
    await React.act(async () => { await f.value.save.mutateAsync('all').catch(() => {}); }); await f.flush();
    assert.equal(f.value.state.config.roles[0].responsibility, 'Exact scope');
    assert.equal(f.value.semanticDirty, true);
    fail = false;
    await React.act(async () => { await f.value.save.mutateAsync('all'); }); await f.flush();
    assert.equal(calls.length, 2); assert.equal(calls[0].input.expectedSemanticRevision, 4);
    assert.equal(calls[0].input.requestKey, calls[1].input.requestKey);
    assert.equal(f.value.semanticDirty, false); assert.equal(f.value.baseline.semanticRevision, 5);
  } finally { await f.close(); }
});

test('layout autosave never publishes new semantic nodes or automatically retries failed writes', async () => {
  const f = await mount(); let layoutWrites = 0;
  f.api.saveLayout = async () => { layoutWrites++; throw new Error('fictional disconnect'); };
  try {
    await React.act(async () => f.value.edit(current => ({ ...current, layout: { ...current.layout, positions: { role: { x: 40, y: 50 } } } })));
    await f.flush(1700); await f.flush(1700);
    assert.equal(layoutWrites, 1, 'failed autosave requires an explicit user retry');
    assert.equal(f.value.layoutDirty, true);
    await React.act(async () => f.value.edit(current => ({ ...current, config: { ...current.config, roles: [...current.config.roles, { ...current.config.roles[0], id: 'new-role' }] }, layout: { ...current.layout, positions: { ...current.layout.positions, 'new-role': { x: 50, y: 50 } } } })));
    await f.flush(1500);
    assert.equal(layoutWrites, 1, 'a layout request cannot silently persist semantic nodes');
  } finally { await f.close(); }
});

test('CAS conflict keeps both drafts and reconnecting requires a read before another write', async () => {
  const f = await mount(); let writes = 0;
  f.api.saveDraft = async () => { writes++; throw new Error('Revision changed'); };
  f.api.detail = async () => ({ ...f.current, semanticRevision: 8, draft: { ...f.current.draft, semanticRevision: 8 } });
  try {
    await React.act(async () => f.value.edit(current => ({ ...current, config: { ...current.config, roles: current.config.roles.map(role => ({ ...role, responsibility: 'Local preserved scope' })) } })));
    await React.act(async () => { await f.value.save.mutateAsync('all').catch(() => {}); }); await f.flush();
    assert.equal(f.value.conflict.semanticRevision, 8); assert.equal(f.value.state.config.roles[0].responsibility, 'Local preserved scope');
    await React.act(async () => window.dispatchEvent(new Event('online'))); await f.flush();
    assert.equal(f.value.needsReconcile, true);
    await React.act(async () => { await f.value.save.mutateAsync('all').catch(() => {}); });
    assert.equal(writes, 1, 'reconnect must not resend a mutation before reconciliation');
  } finally { await f.close(); }
});

test('server normalization does not leave a saved draft dirty or issue a redundant revision', async () => {
  const f = await mount(); let writes = 0;
  f.api.saveDraft = async (_id, input) => { writes++; const config = { ...input.config, roles: [...input.config.roles].sort((a, b) => a.id.localeCompare(b.id)) }; return { ...f.current, semanticRevision: 5, draft: { ...f.current.draft, semanticRevision: 5, config } }; };
  try {
    await React.act(async () => f.value.edit(current => ({ ...current, config: { ...current.config, roles: [...current.config.roles, { ...current.config.roles[0], id: 'a-role' }] } })));
    await React.act(async () => { await f.value.save.mutateAsync('all'); }); await f.flush();
    assert.equal(f.value.semanticDirty, false);
    assert.equal(window.sessionStorage.getItem('squabble.team-draft.team-one'), null);
    await React.act(async () => { await f.value.save.mutateAsync('all'); }); await f.flush();
    assert.equal(writes, 1);
  } finally { await f.close(); }
});

test('a save receipt never overwrites semantic input edited while its request is pending', async () => {
  const f = await mount(); let release; const gate = new Promise(resolve => { release = resolve; }); let pending;
  f.api.saveDraft = async (_id, input) => { await gate; return { ...f.current, semanticRevision: 5, draft: { ...f.current.draft, semanticRevision: 5, config: input.config } }; };
  try {
    await React.act(async () => f.value.edit(current => ({ ...current, config: { ...current.config, roles: current.config.roles.map(role => ({ ...role, responsibility: 'First scope' })) } })));
    await React.act(async () => { pending = f.value.save.mutateAsync('all'); await Promise.resolve(); });
    await React.act(async () => f.value.edit(current => ({ ...current, config: { ...current.config, roles: current.config.roles.map(role => ({ ...role, responsibility: 'Newer local scope' })) } })));
    await React.act(async () => { release(); await pending; }); await f.flush();
    assert.equal(f.value.state.config.roles[0].responsibility, 'Newer local scope');
    assert.equal(f.value.baseline.draft.config.roles[0].responsibility, 'First scope');
    assert.equal(f.value.semanticDirty, true);
  } finally { await f.close(); }
});
