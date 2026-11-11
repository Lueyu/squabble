const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

function teamVersion() {
  return { id: 'version-one', teamId: 'team-one', version: 1, semanticRevision: 1, config: { schemaVersion: 1,
    departments: [{ id: 'research', parentDepartmentId: null, purpose: 'Read financial statements' }, { id: 'risk', parentDepartmentId: null, purpose: 'Challenge assumptions' }],
    roles: [{ id: 'lead', departmentId: 'research', participation: 'enabled', responsibility: 'Original synthesis', expectedOutput: 'Original evidence', executor: { executionMode: 'model', connectionId: 'connection-one', model: 'model-one', tier: 'slow', settings: {} }, allowedToolIds: ['tool-original'], sourceGrantIds: ['grant-original'] },
      { id: 'analyst', departmentId: 'research', participation: 'placeholder', responsibility: '', expectedOutput: '', executor: null, allowedToolIds: [], sourceGrantIds: [] }],
    relations: [{ id: 'reporting', fromRoleId: 'analyst', toRoleId: 'lead', kind: 'reports_to', responsibilityScope: 'Original scope' }], defaults: { leadRoleId: 'lead', parallelism: 1 } },
    displaySnapshot: { name: 'Fictional team', avatar: null, departmentLabels: { research: 'Research department', risk: 'Risk department' }, roleLabels: { lead: 'Research lead', analyst: 'Accounting analyst' } } };
}

test('publication shows concrete before/after fields even when all object counts are unchanged', () => {
  const f = fixture(); const { TeamPublicationChanges } = f.load('features/teams/TeamPublicationChanges.tsx');
  const previous = teamVersion(); const config = structuredClone(previous.config);
  config.roles[0] = { ...config.roles[0], departmentId: 'risk', responsibility: 'Revised synthesis with counterevidence', expectedOutput: 'Revised evidence and gaps', executor: { executionMode: 'local', localAgentId: 'native-two', settings: { model: 'native-model', reasoningEffort: 'high' } }, allowedToolIds: ['tool-revised'], sourceGrantIds: ['grant-revised'] };
  config.relations[0].responsibilityScope = 'Revised liquidity scope'; config.defaults = { leadRoleId: 'analyst', parallelism: 2 };
  const html = f.render(TeamPublicationChanges, { previous, config, display: previous.displaySnapshot, zh: false });
  for (const text of ['Original synthesis', 'Revised synthesis with counterevidence', 'Original evidence', 'Revised evidence and gaps', 'connection-one', 'model-one', 'native-two', 'native-model', 'tool-original', 'tool-revised', 'grant-original', 'grant-revised', 'Original scope', 'Revised liquidity scope', 'Research department', 'Risk department', 'Suggested final lead', 'Research lead', 'Accounting analyst', 'Parallelism']) assert.ok(html.includes(text), text);
  assert.match(html, /Before/); assert.match(html, /After/); assert.doesNotMatch(html, /content changed|unchanged/);
});

test('defaults-only changes remain visible and added/removed objects distinguish absence from empty values', () => {
  const f = fixture(); const { TeamPublicationChanges } = f.load('features/teams/TeamPublicationChanges.tsx');
  const previous = teamVersion(); const config = structuredClone(previous.config); config.defaults = { leadRoleId: null, parallelism: 2 };
  const defaults = f.render(TeamPublicationChanges, { previous, config, display: previous.displaySnapshot, zh: true });
  assert.match(defaults, /默认负责人/); assert.match(defaults, /未指定/); assert.match(defaults, /并行度/); assert.doesNotMatch(defaults, /没有运行语义变化/);
  config.roles = [config.roles[0], { ...config.roles[1], id: 'new-role' }]; config.relations = [];
  const html = f.render(TeamPublicationChanges, { previous, config, display: { ...previous.displaySnapshot, roleLabels: { lead: 'Research lead', 'new-role': 'New placeholder' } }, zh: false });
  assert.match(html, /Added/); assert.match(html, /Removed/); assert.match(html, /Not present/); assert.match(html, /Empty/); assert.match(html, /New placeholder/);
});

test('inflight previews show original identities, states, effects and exact cancellation destinations', () => {
  const f = fixture(); const { TeamInflightCommissions, readInflightCommissions } = f.load('features/teams/TeamInflightCommissions.tsx');
  const result = { inflightCommissions: [{ id: 'commission-old', teamId: 'team-old', accountId: 'account-old', teamVersionId: 'frozen-version', state: 'uncertain', objective: 'Retained liquidity investigation', handoverEffect: 'stop_new_work_settle_dispatched', canRequestCancellation: true }] };
  const html = f.render(TeamInflightCommissions, { result, zh: false, kind: 'binding', teams: [{ id: 'team-old', name: 'Original research team' }], accounts: [{ id: 'account-old', name: 'Original simulation account' }] });
  for (const text of ['Retained liquidity investigation', 'Original research team', 'Original simulation account', 'frozen-version', 'Outcome unknown', 'No new work', 'dispatched calls', 'remain unsettled']) assert.ok(html.includes(text), text);
  assert.match(html, /\/teams\/team-old\?panel=history&amp;commissionId=commission-old/);
  assert.equal(readInflightCommissions({}), null, 'missing server impact is unknown, not an empty list');
  assert.equal(readInflightCommissions({ inflightCommissions: [{ id: 'partial' }] }), null);
  assert.equal(readInflightCommissions({ inflightCommissions: [] }).length, 0);
});

test('archive impact keeps explicit unknown and empty states in visible content', () => {
  const f = fixture(); const { TeamInflightCommissions } = f.load('features/teams/TeamInflightCommissions.tsx');
  const missing = f.render(TeamInflightCommissions, { result: {}, zh: true, kind: 'archive' });
  assert.match(missing, /未返回完整在途委托清单/); assert.match(missing, /重新检查/); assert.doesNotMatch(missing, /未发现/);
  const empty = f.render(TeamInflightCommissions, { result: { inflightCommissions: [] }, zh: true, kind: 'archive' });
  assert.match(empty, /本次服务器检查未发现/);
});
