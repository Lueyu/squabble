const test = require('node:test');
// The fixture loader evaluates TypeScript inside a separate vm context, so returned
// arrays and objects carry that realm's prototypes; loose deepEqual compares content only.
const assert = require('node:assert');
const fixture = require('./simple-test-loader.cjs');

const quick = () => fixture().load('features/teams/team-quick-start.ts');
const commission = () => fixture().load('features/teams/team-commission-state.ts');

/** Small axios-shaped error: the quick-start code only reads isAxiosError, response.status and the code body. */
function axiosError(status, data) {
  return Object.assign(new Error('fixture'), { isAxiosError: true, response: { status, data } });
}
function withSessionStorage(run) {
  const store = new Map();
  globalThis.window = { sessionStorage: {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  } };
  try { return run(store); } finally { delete globalThis.window; }
}
const connection = { id: 'connection-1', name: 'Main', available: true, fastModel: 'gpt-fast', slowModel: 'gpt-deep' };
const baseInput = (seed) => ({ name: '铁三角', description: '', avatar: '', templateId: 'huawei-style', seed, accountName: '', connectionId: 'connection-1' });
const templateConfig = () => ({
  schemaVersion: 1, departments: [], relations: [],
  defaults: { leadRoleId: 'role-lead', parallelism: 1 },
  roles: [
    { id: 'role-lead', departmentId: null, participation: 'placeholder', responsibility: '综合', expectedOutput: '结论', executor: null, allowedToolIds: [], sourceGrantIds: [] },
    { id: 'role-a', departmentId: null, participation: 'placeholder', responsibility: '核查', expectedOutput: '数据', executor: null, allowedToolIds: [], sourceGrantIds: [] },
  ],
});

test('quick start plans exactly the steps the chosen seed and connection require', () => {
  const { quickStartSteps } = quick();
  const cash = baseInput({ kind: 'cash', amount: '100000', currency: 'USD' });
  assert.deepEqual(quickStartSteps(cash), ['team', 'draft', 'publish', 'account', 'binding']);
  assert.deepEqual(quickStartSteps({ ...cash, connectionId: null }), ['team', 'publish', 'account', 'binding']);
  assert.deepEqual(quickStartSteps({ ...cash, seed: { kind: 'none' } }), ['team', 'draft', 'publish']);
  assert.deepEqual(quickStartSteps({ ...cash, seed: { kind: 'existing', accountId: 'account-1' }, connectionId: null }), ['team', 'publish', 'binding']);
});

test('the lead works at the deep tier and specialists answer at the fast tier', () => {
  const { quickStartExecutor, applyQuickStartExecutors, quickStartEligibleConnection } = quick();
  const lead = quickStartExecutor(connection, true);
  assert.equal(lead.model, 'gpt-deep'); assert.equal(lead.tier, 'slow');
  const specialist = quickStartExecutor(connection, false);
  assert.equal(specialist.model, 'gpt-fast'); assert.equal(specialist.tier, 'fast');
  assert.equal(quickStartExecutor(connection, true).connectionId, 'connection-1');
  assert.equal(quickStartExecutor({ ...connection, slowModel: '' }, true).tier, 'fast');
  assert.equal(quickStartExecutor({ ...connection, fastModel: '', slowModel: '' }, false), null);
  assert.equal(quickStartEligibleConnection(connection), true);
  assert.equal(quickStartEligibleConnection({ ...connection, available: false }), false);
  assert.equal(quickStartEligibleConnection({ ...connection, fastModel: '', slowModel: '' }), false);

  const configured = applyQuickStartExecutors(templateConfig(), connection, 'role-lead');
  assert.deepEqual(configured.roles.map(role => [role.participation, role.executor?.model, role.executor?.tier]),
    [['enabled', 'gpt-deep', 'slow'], ['enabled', 'gpt-fast', 'fast']]);
});

test('input validation mirrors the server name, cash and account rules', () => {
  const { validateQuickStartInput } = quick();
  assert.deepEqual(validateQuickStartInput(baseInput({ kind: 'cash', amount: '100000', currency: 'USD' })), []);
  assert.ok(validateQuickStartInput(baseInput({ kind: 'cash', amount: '100000', currency: 'USD' })).length === 0);
  assert.ok(validateQuickStartInput({ ...baseInput({ kind: 'cash', amount: '0', currency: 'USD' }), name: ' ' }).length >= 2);
  assert.deepEqual(validateQuickStartInput(baseInput({ kind: 'cash', amount: '-5', currency: 'USD' })).map(issue => issue.field), ['amount']);
  assert.deepEqual(validateQuickStartInput(baseInput({ kind: 'cash', amount: 'abc', currency: 'USD' })).map(issue => issue.field), ['amount']);
  assert.deepEqual(validateQuickStartInput({ ...baseInput({ kind: 'cash', amount: '10', currency: 'USD' }), accountName: 'x'.repeat(81) }).map(issue => issue.field), ['accountName']);
  assert.deepEqual(validateQuickStartInput(baseInput({ kind: 'existing', accountId: '' })).map(issue => issue.field), ['accountId']);
  assert.deepEqual(validateQuickStartInput(baseInput({ kind: 'holdings' })), []);
});

test('an unnamed account inherits the team name and stays within 80 characters', () => {
  const { quickStartAccountName } = quick();
  assert.equal(quickStartAccountName(baseInput({ kind: 'cash', amount: '1', currency: 'USD' }), true), '铁三角 模拟盘');
  assert.equal(quickStartAccountName(baseInput({ kind: 'cash', amount: '1', currency: 'USD' }), false), '铁三角 simulation');
  assert.equal(quickStartAccountName({ ...baseInput({ kind: 'holdings' }), name: 'n'.repeat(100) }, true).length, 80);
  assert.equal(quickStartAccountName({ ...baseInput({ kind: 'holdings' }), accountName: '我的实验盘' }, true), '我的实验盘');
});

test('the account seed request follows the chosen origin', () => {
  const { quickStartPreviewRequest, quickStartCreateAccountRequest } = quick();
  assert.deepEqual(quickStartPreviewRequest({ kind: 'cash', amount: '100000.5', currency: 'HKD' }, 'key-1'),
    { origin: 'cash', cash: { currency: 'HKD', amount: 100000.5 }, requestKey: 'key-1' });
  assert.deepEqual(quickStartPreviewRequest({ kind: 'holdings' }, 'key-2'), { origin: 'holdings', requestKey: 'key-2' });
  assert.deepEqual(quickStartCreateAccountRequest('实验盘', 'preview-1', 'key-3'), { previewId: 'preview-1', requestKey: 'key-3', name: '实验盘' });
  assert.throws(() => quickStartPreviewRequest({ kind: 'none' }, 'key-4'), /cash or holdings/);
});

test('an expired preview adopts only an account this chain created', () => {
  const { adoptCreatedAccount } = quick();
  const known = new Set(['old-1']);
  const accounts = [
    { id: 'old-1', name: '铁三角 模拟盘' },
    { id: 'fresh-1', name: '铁三角 模拟盘' },
  ];
  assert.equal(adoptCreatedAccount(accounts, known, '铁三角 模拟盘'), 'fresh-1');
  assert.equal(adoptCreatedAccount([...accounts, { id: 'fresh-2', name: '铁三角 模拟盘' }], known, '铁三角 模拟盘'), null);
  assert.equal(adoptCreatedAccount(accounts, new Set(['old-1', 'fresh-1']), '铁三角 模拟盘'), null);
  assert.equal(adoptCreatedAccount(accounts, known, '别的名字'), null);
});

test('failures classify into recoverable previews, definitive rejections and unknown outcomes', () => {
  const { quickStartFailureKind, quickStartErrorCode } = quick();
  assert.equal(quickStartFailureKind(axiosError(409, { code: 'TEAM_PREVIEW_STALE' })), 'recoverable-preview');
  assert.equal(quickStartFailureKind(axiosError(409, { code: 'PREVIEW_EXPIRED' })), 'recoverable-preview');
  assert.equal(quickStartFailureKind(axiosError(400, { error: { code: 'TEAM_INVALID_INPUT' } })), 'rejected');
  assert.equal(quickStartErrorCode(axiosError(400, { error: { code: 'TEAM_INVALID_INPUT' } })), 'TEAM_INVALID_INPUT');
  assert.equal(quickStartFailureKind(axiosError(503, { code: 'TEAM_DEPENDENCY_UNAVAILABLE' })), 'server');
  assert.equal(quickStartFailureKind(Object.assign(new Error('network'), { isAxiosError: true })), 'network');
  assert.equal(quickStartFailureKind(new Error('本地连接已不可用')), 'rejected');
  assert.equal(quickStartErrorCode(axiosError(410, { message: 'PREVIEW_EXPIRED' })), 'PREVIEW_EXPIRED');
});

test('the session record round-trips and stays resumable until every step finishes', () => {
  withSessionStorage(() => {
    // The fixture loader snapshots window into the vm context at load time, so load inside the stub.
    const qs = quick();
    const input = baseInput({ kind: 'cash', amount: '100000', currency: 'USD' });
    const progress = qs.initialQuickStartProgress(input);
    assert.deepEqual(progress.steps.map(step => step.state), ['pending', 'pending', 'pending', 'pending', 'pending']);
    assert.equal(qs.storedQuickStartResumable(null), false);
    const updated = qs.updateQuickStartStep(progress, 'team', 'done');
    assert.equal(updated.steps[0].state, 'done');
    assert.equal(progress.steps[0].state, 'pending');
    const record = { savedAt: '2026-11-12T10:00:00.000Z', input, keys: qs.initialQuickStartKeys(() => 'k'), progress: updated };
    assert.equal(qs.writeStoredQuickStart(record), true);
    const read = qs.readStoredQuickStart();
    assert.equal(read.input.templateId, 'huawei-style');
    assert.equal(read.progress.steps[0].state, 'done');
    assert.equal(qs.storedQuickStartResumable(read), true);
    const finished = { ...read, progress: { ...read.progress, steps: read.progress.steps.map(step => ({ ...step, state: 'done' })) } };
    qs.writeStoredQuickStart(finished);
    assert.equal(qs.storedQuickStartResumable(qs.readStoredQuickStart()), false);
    qs.clearStoredQuickStart();
    assert.equal(qs.readStoredQuickStart(), null);
  });
  withSessionStorage(store => {
    const qs = quick();
    store.set('squabble.team-quick-start', '{ not json');
    assert.equal(qs.readStoredQuickStart(), null);
    store.set('squabble.team-quick-start', JSON.stringify({ savedAt: 'x', input: { name: 'n', templateId: 't', seed: { kind: 'surprise' } }, keys: {}, progress: { steps: [] } }));
    assert.equal(qs.readStoredQuickStart(), null);
  });
});

test('the first commission prefills ready participants and a one-day deadline', () => {
  const { defaultCommissionParticipants, defaultCommissionDeadline, teamLeadSuggestion } = commission();
  const config = templateConfig();
  config.roles = [
    { id: 'role-lead', departmentId: null, participation: 'enabled', responsibility: 'a', expectedOutput: 'a', executor: { executionMode: 'model', connectionId: 'c', model: 'm', settings: {} }, allowedToolIds: [], sourceGrantIds: [] },
    { id: 'role-a', departmentId: null, participation: 'enabled', responsibility: 'a', expectedOutput: 'a', executor: { executionMode: 'model', connectionId: 'c', model: 'm', settings: {} }, allowedToolIds: [], sourceGrantIds: [] },
    { id: 'role-b', departmentId: null, participation: 'placeholder', responsibility: 'a', expectedOutput: 'a', executor: null, allowedToolIds: [], sourceGrantIds: [] },
  ];
  assert.equal(teamLeadSuggestion(config), 'role-lead');
  assert.deepEqual(defaultCommissionParticipants(config, 'role-lead'), ['role-lead', 'role-a']);
  const wide = { ...config, roles: Array.from({ length: 8 }, (_, index) => ({ ...config.roles[0], id: `role-${index}` })) };
  assert.equal(defaultCommissionParticipants(wide, 'role-3').length, 6);
  assert.equal(defaultCommissionParticipants(wide, 'role-3')[0], 'role-3');
  const deadline = defaultCommissionDeadline(new Date('2026-11-12T08:05:00'));
  assert.equal(deadline, '2026-11-13T08:05');
  assert.match(deadline, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});
