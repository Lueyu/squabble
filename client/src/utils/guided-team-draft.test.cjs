const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values }; };

test('editable guided drafts survive a refresh or trip to friends without caching profiles or previews', () => {
  const state = fixture().load('features/teams/guided-team-storage.ts');
  const tab = storage();
  state.saveGuidedDraft('owner-a', { name: 'My evidence team', selected: ['friend-1'], daily: '3', market: 'HK', step: 3, agents: [{ private: true }], preview: { secret: true } }, tab);
  const restored = state.readGuidedDraft('owner-a', tab);
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), { version: 1, name: 'My evidence team', selected: ['friend-1'], daily: '3', market: 'HK', step: 2 });
  assert.doesNotMatch([...tab.values.values()].join(''), /private|secret|agents|preview/);
  assert.equal(state.readGuidedDraft('owner-b', tab), null);
});

test('startup receipts are owner scoped and only resolved obsolete progress can end', () => {
  const state = fixture().load('features/teams/guided-team-storage.ts');
  const tab = storage();
  const progress = { version: 1, key: 'original-key', agents: [], preview: { previewId: 'review' }, teamId: 'team', reviewRequired: 'changed' };
  state.saveGuidedProgress('owner-a', progress, tab);
  assert.equal(state.readGuidedProgress('owner-b', tab), null);
  assert.equal(state.readGuidedProgress('owner-a', tab).key, 'original-key');
  assert.equal(state.endGuidedProgress('owner-a', { ...progress, pendingOperation: 'account' }, tab), false);
  assert.equal(state.readGuidedProgress('owner-a', tab).key, 'original-key');
  assert.equal(state.endGuidedProgress('owner-a', progress, tab), true);
  assert.equal(state.readGuidedProgress('owner-a', tab), null);
  assert.match([...tab.values.values()].join(''), /original-key/);
});

const legacy = overrides => ({ version: 1, key: 'legacy-original', name: 'Private old team', agents: [{ id: 'agent', currentVersionId: 'old-v1' }], preview: { previewId: 'old-preview' }, teamId: 'team', accountId: 'account', ...overrides });
function ownership(owner = 'owner-a') {
  const calls = [];
  return { calls, ports: {
    agents: { detail: async id => { calls.push(['GET agent', id]); return { id, currentVersionId: 'new-v2' }; } },
    teams: { detail: async id => { calls.push(['GET team', id]); return { id }; } },
    accounts: { account: async id => { calls.push(['GET account', id]); return { id }; } },
    currentOwner: () => owner,
  } };
}

test('legacy migration proves agent, team and account ownership independently before copying private progress', async () => {
  const state = fixture().load('features/teams/guided-team-storage.ts');
  assert.equal(typeof state.migrateLegacyGuidedProgress, 'function');
  const tab = storage(); const original = legacy(); tab.setItem('squabble.team-guided-create', JSON.stringify(original));
  const { calls, ports } = ownership();
  const restored = await state.migrateLegacyGuidedProgress('owner-a', ports, tab);
  assert.deepEqual(calls, [['GET agent', 'agent'], ['GET team', 'team'], ['GET account', 'account']]);
  assert.equal(restored.key, 'legacy-original');
  assert.equal(restored.agents[0].currentVersionId, 'old-v1');
  assert.equal(state.readGuidedProgress('owner-a', tab).teamId, 'team');
  assert.equal(restored.teamCreateInput.description, 'Guided team: persistent agents and independent paper account');
});

test('foreign or temporarily unavailable legacy ownership never copies, deletes or dispatches the old workflow', async () => {
  const state = fixture().load('features/teams/guided-team-storage.ts');
  assert.equal(typeof state.migrateLegacyGuidedProgress, 'function');
  for (const failure of ['agent', 'team', 'account', 'temporary', 'switched']) {
    const tab = storage(); const raw = JSON.stringify(legacy()); tab.setItem('squabble.team-guided-create', raw);
    const { calls, ports } = ownership();
    if (failure === 'agent') ports.agents.detail = async () => { throw { response: { status: 404 } }; };
    if (failure === 'team') ports.teams.detail = async () => ({ id: 'foreign-team' });
    if (failure === 'account') ports.accounts.account = async () => ({ id: 'foreign-account' });
    if (failure === 'temporary') ports.teams.detail = async () => { throw new Error('Lost GET response'); };
    if (failure === 'switched') ports.currentOwner = () => 'owner-b';
    await assert.rejects(state.migrateLegacyGuidedProgress('owner-a', ports, tab));
    assert.equal(state.readGuidedProgress('owner-a', tab), null);
    assert.equal(tab.getItem('squabble.team-guided-create'), raw);
    assert.ok(calls.every(([method]) => method.startsWith('GET')));
  }
});

test('an unknown legacy create retains the exact old request and source cache until its receipt is resolved', async () => {
  const f = fixture(); const state = f.load('features/teams/guided-team-storage.ts');
  assert.equal(typeof state.migrateLegacyGuidedProgress, 'function');
  const tab = storage(); const original = legacy({ teamId: undefined, accountId: undefined });
  tab.setItem('squabble.team-guided-create', JSON.stringify(original));
  const { ports } = ownership(); const restored = await state.migrateLegacyGuidedProgress('owner-a', ports, tab);
  assert.equal(restored.pendingOperation, 'team');
  assert.ok(tab.getItem('squabble.team-guided-create'));
  const posts = [];
  await assert.rejects(f.load('features/teams/guided-team-create.ts').executeGuidedTeam(restored, value => state.saveGuidedProgress('owner-a', value, tab), {
    teams: { create: async input => { posts.push(JSON.parse(JSON.stringify(input))); throw new Error('Unknown response'); } },
  }));
  assert.deepEqual(posts, [{ requestKey: 'legacy-original:team', name: 'Private old team', description: 'Guided team: persistent agents and independent paper account' }]);
  assert.equal(state.readGuidedProgress('owner-a', tab).pendingOperation, 'team');
  assert.ok(tab.getItem('squabble.team-guided-create'));
});
