const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

test('companion changes address one account with their own revision and cannot silently change policy authority', async () => {
  const f = fixture();
  const { portfolioWorkspaceApi: api } = f.load('api/portfolio-workspace.ts');
  assert.equal(typeof api.setCompanion, 'function');
  const input = { companionId: 'macro', expectedRevision: 0, requestKey: 'choose-friend' };
  await api.setCompanion('account/a', input);
  assert.equal(f.state.requests[0].args[0], '/api/ai-investment/accounts/account%2Fa/companion');
  assert.deepEqual(f.state.requests[0].args[1], input);
  await assert.rejects(api.setCompanion('', input), /explicit simulation account/);
});

test('every account read and write requires explicit identity and preserves it in URLs and cache keys', async () => {
  const f = fixture();
  const { portfolioWorkspaceApi: api, portfolioWorkspaceKeys: keys } = f.load(
    'api/portfolio-workspace.ts',
  );
  const payload = {
    expectedPolicyRevision: 7,
    requestKey: 'request',
    allocations: [],
  };
  await api.account('account/a');
  await api.combination('account/b');
  await api.saveDraft('account/a', payload);
  await api.preview('account/b', payload);
  await api.apply('account/a', { ...payload, previewHash: 'reviewed' });
  await api.pause('account/b', payload);
  await api.resume('account/a', payload);
  assert.deepEqual(
    f.state.requests.map((request) => request.args[0]),
    [
      '/api/ai-investment/accounts/account%2Fa',
      '/api/ai-investment/accounts/account%2Fb/strategies',
      '/api/ai-investment/accounts/account%2Fa/strategies/draft',
      '/api/ai-investment/accounts/account%2Fb/strategies/preview',
      '/api/ai-investment/accounts/account%2Fa/strategies/apply',
      '/api/ai-investment/accounts/account%2Fb/pause',
      '/api/ai-investment/accounts/account%2Fa/resume',
    ],
  );
  assert.notDeepEqual(keys.account('account/a'), keys.account('account/b'));
  assert.notDeepEqual(
    keys.combination('account/a'),
    keys.combination('account/b'),
  );
  await assert.rejects(api.account(''), /explicit simulation account/);
  await assert.rejects(api.pause(' ', payload), /explicit simulation account/);
});

test('reviewed combination identity rejects account, revision, strategy, budget, enablement and expiry changes', () => {
  const { load } = fixture();
  const { canApplyCombination, combinationIdentity } = load(
    'utils/portfolio-workspace.ts',
  );
  const allocation = {
    strategyId: 'strategy-a',
    strategyRevision: 2,
    allocationPct: 40,
    enabled: true,
  };
  const allocations = [allocation];
  const preview = {
    accountId: 'account-a',
    expectedPolicyRevision: 7,
    canApply: true,
    expiresAt: '2026-11-09T01:00:00Z',
  };
  const identity = combinationIdentity('account-a', 7, allocations);
  const now = Date.parse('2026-11-09T00:00:00Z');
  assert.equal(
    canApplyCombination('account-a', 7, allocations, preview, identity, now),
    true,
  );
  for (const change of [
    { strategyId: 'strategy-b' },
    { strategyRevision: 3 },
    { allocationPct: 45 },
    { enabled: false },
  ]) {
    assert.equal(
      canApplyCombination(
        'account-a',
        7,
        [{ ...allocation, ...change }],
        preview,
        identity,
        now,
      ),
      false,
    );
  }
  assert.equal(
    canApplyCombination('account-b', 7, allocations, preview, identity, now),
    false,
  );
  assert.equal(
    canApplyCombination('account-a', 8, allocations, preview, identity, now),
    false,
  );
  assert.equal(
    canApplyCombination(
      'account-a',
      7,
      allocations,
      { ...preview, canApply: false },
      identity,
      now,
    ),
    false,
  );
  assert.equal(
    canApplyCombination('account-a', 7, allocations, preview, null, now),
    false,
  );
  assert.equal(
    canApplyCombination(
      'account-a',
      7,
      allocations,
      preview,
      identity,
      Date.parse(preview.expiresAt),
    ),
    false,
  );
});

test('report staging preserves existing account allocations and adds disabled zero-budget material only once', () => {
  const { load } = fixture();
  const { stageStrategyAllocation } = load('utils/portfolio-workspace.ts');
  const initial = [
    {
      strategyId: 'existing',
      strategyRevision: 4,
      allocationPct: 80,
      enabled: true,
    },
  ];
  const staged = stageStrategyAllocation(initial, 'report-draft', 2);
  assert.deepEqual(JSON.parse(JSON.stringify(staged)), [
    ...initial,
    {
      strategyId: 'report-draft',
      strategyRevision: 2,
      allocationPct: 0,
      enabled: false,
    },
  ]);
  const retried = stageStrategyAllocation(staged, 'report-draft', 3);
  assert.equal(retried.length, 2);
  assert.equal(retried[1].enabled, false);
  assert.equal(retried[1].allocationPct, 0);
  assert.equal(retried[1].strategyRevision, 3);
  assert.equal(
    initial.length,
    1,
    'staging does not mutate the loaded account snapshot',
  );
});
