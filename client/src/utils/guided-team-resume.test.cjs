const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');
const clone = value => JSON.parse(JSON.stringify(value));

function scenario(lost) {
  const record = { version: 1, key: 'original-intent', name: 'Fictional team', agents: [{ id: 'person', name: 'Researcher', specialty: 'Check evidence', description: 'x'.repeat(2000), status: 'active', currentVersionId: 'person-v1', currentVersion: { config: { templateId: 'moderator', executor: { executionMode: 'model', connectionId: 'model', model: 'fast' }, allowedToolIds: [] } } }], models: [{ id: 'model', available: true, fastModel: 'fast', slowModel: 'slow' }], preview: { previewId: 'seed', expiresAt: '2099-01-01', needsInput: [], markets: ['CN'], seed: { capturedAt: '2026-11-12', positions: [], cash: [] } }, market: 'CN', dailyUsd: '2' };
  let detail = { id: 'team', name: record.name, status: 'active', semanticRevision: 1, displayRevision: 1, bindingRevision: 0, currentVersionId: null, binding: null, accountId: null, draft: { config: {} }, display: { name: record.name, roleLabels: {}, departmentLabels: {}, avatar: null } };
  let agreement = null; let lostOnce = false; const calls = []; const receipts = new Map();
  const mutation = async (name, input, commit) => {
    calls.push({ name, input: clone(input) });
    if (receipts.has(input.requestKey)) return clone(receipts.get(input.requestKey));
    const result = commit(); receipts.set(input.requestKey, clone(result));
    if (name === lost && !lostOnce) { lostOnce = true; throw new Error('connection dropped after commit'); }
    return clone(result);
  };
  const preview = input => ({ previewId: input.requestKey, previewHash: 'hash', expiresAt: '2099-01-01', guards: { semanticRevision: detail.semanticRevision }, result: {}, warnings: [] });
  const ports = {
    teams: {
      create: input => mutation('create', input, () => detail), detail: async () => clone(detail),
      saveDraft: (_, input) => mutation('draft', input, () => { detail.draft.config = clone(input.config); detail.semanticRevision++; return detail; }),
      saveDisplay: (_, input) => mutation('display', input, () => { detail.display = clone(input.display); detail.displayRevision++; return detail; }),
      publishPreview: (_, input) => mutation('publishPreview', input, () => preview(input)),
      publish: (_, input) => mutation('publish', input, () => { detail.currentVersionId = 'team-v1'; detail.publishedVersion = { id: 'team-v1', config: clone(detail.draft.config) }; return { version: detail.publishedVersion, team: detail }; }),
      bindingPreview: (_, input) => mutation('bindingPreview', input, () => preview(input)),
      binding: (_, input) => mutation('binding', input, () => { detail.bindingRevision++; detail.accountId = 'account'; detail.binding = { id: 'binding', accountId: 'account', teamVersionId: 'team-v1', state: 'active' }; return { binding: detail.binding, team: detail }; }),
    },
    accounts: { create: input => mutation('account', input, () => ({ accountId: 'account' })) },
    runs: {
      status: async () => ({ agreement: clone(agreement) }),
      preview: (_, input) => mutation('agreementPreview', input, () => ({ ...preview(input), result: { configuration: clone(input) } })),
      confirm: (_, input) => mutation('confirm', input, () => { const configuration = clone(calls.find(call => call.name === 'agreementPreview').input); delete configuration.requestKey; agreement = { id: 'agreement', teamId: 'team', accountId: 'account', revision: 1, state: 'confirmed', configuration }; return agreement; }),
      start: (_, input) => mutation('start', input, () => { agreement.state = 'running'; agreement.revision++; return agreement; }),
    },
  };
  return { record, ports, calls, detail: () => detail, mutateDetail: change => { detail = { ...detail, ...change }; }, receipts };
}

for (const lost of ['create', 'draft', 'display', 'publish', 'account', 'binding', 'confirm', 'start']) {
  test(`resumes ${lost} after lost response with the original receipt and exact payload`, async () => {
    const { executeGuidedTeam } = fixture().load('features/teams/guided-team-create.ts');
    const f = scenario(lost); let saved;
    const persist = record => { saved = clone(record); };
    await assert.rejects(executeGuidedTeam(f.record, persist, f.ports));
    const id = await executeGuidedTeam(saved, persist, f.ports);
    assert.equal(id, 'team');
    const attempts = f.calls.filter(call => call.name === lost);
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].input, attempts[1].input);
    assert.equal(new Set(f.calls.filter(call => call.name === 'account').map(call => call.input.requestKey)).size, 1);
    assert.equal(f.detail().binding.teamVersionId, 'team-v1');
  });
}

test('an unrelated latest publication never becomes the resumed startup version', async () => {
  const { executeGuidedTeam } = fixture().load('features/teams/guided-team-create.ts');
  const f = scenario('account'); let saved;
  await assert.rejects(executeGuidedTeam(f.record, record => { saved = clone(record); }, f.ports));
  f.mutateDetail({ currentVersionId: 'different-version' });
  await assert.rejects(executeGuidedTeam(saved, () => {}, f.ports), /changed/i);
  assert.equal(f.calls.filter(call => call.name === 'binding').length, 0);
});

test('invalid budget or unavailable model fails before the first write', async () => {
  const { executeGuidedTeam } = fixture().load('features/teams/guided-team-create.ts');
  for (const invalid of ['budget', 'model']) {
    const f = scenario(); if (invalid === 'budget') f.record.dailyUsd = '0'; else f.record.models = [];
    await assert.rejects(executeGuidedTeam(f.record, () => {}, f.ports)); assert.equal(f.calls.length, 0);
  }
});

test('expired seed does not prevent reading the receipt for an already-created account', async () => {
  const { executeGuidedTeam } = fixture().load('features/teams/guided-team-create.ts');
  const f = scenario('account'); let saved;
  await assert.rejects(executeGuidedTeam(f.record, record => { saved = clone(record); }, f.ports));
  saved.preview.expiresAt = '2000-01-01';
  assert.equal(await executeGuidedTeam(saved, () => {}, f.ports), 'team');
});

test('definitive expired seed requires review while unknown transport failures retain the request', async () => {
  const { executeGuidedTeam } = fixture().load('features/teams/guided-team-create.ts');
  const f = scenario(); f.ports.accounts.create = async () => { throw { response: { status: 409, data: { message: 'PREVIEW_EXPIRED' } } }; };
  await assert.rejects(executeGuidedTeam(f.record, () => {}, f.ports), error => error.stage === 'seed');
  assert.equal(f.record.reviewRequired, 'seed');
  const priorCalls = f.calls.length;
  await assert.rejects(executeGuidedTeam(f.record, () => {}, f.ports)); assert.equal(f.calls.length, priorCalls);
});

for (const [operation, stage] of [['publish', 'publish'], ['account', 'seed'], ['binding', 'binding'], ['confirm', 'agreement']]) {
  test(`a definitively rejected ${operation} prepares a fresh review without repeating completed steps`, async () => {
    const { executeGuidedTeam, refreshGuidedTeamReview } = fixture().load('features/teams/guided-team-create.ts');
    const f = scenario(); const port = operation === 'account' ? f.ports.accounts : operation === 'confirm' ? f.ports.runs : f.ports.teams;
    const method = operation === 'account' ? 'create' : operation;
    const original = port[method]; let rejected = false;
    port[method] = async (...args) => { if (!rejected) { rejected = true; throw { response: { status: 409, data: { error: { code: stage === 'seed' ? 'PREVIEW_EXPIRED' : 'TEAM_PREVIEW_STALE' } } } }; } return original(...args); };
    f.ports.previewHoldings = async () => ({ ...f.record.preview, previewId: 'refreshed-seed' });
    await assert.rejects(executeGuidedTeam(f.record, () => {}, f.ports), error => error.stage === stage);
    const completedTeams = f.calls.filter(call => call.name === 'create').length;
    await refreshGuidedTeamReview(f.record, () => {}, f.ports);
    assert.equal(f.record.reviewRequired, undefined);
    assert.equal(f.calls.filter(call => call.name === operation).length, 0, 'refresh must never confirm a mutation');
    assert.equal(await executeGuidedTeam(f.record, () => {}, f.ports), 'team');
    assert.equal(f.calls.filter(call => call.name === 'create').length, completedTeams);
    assert.match(f.calls.find(call => call.name === operation).input.requestKey, /:1$/);
  });
}

test('a pause after a lost start response remains paused when its old receipt is read', async () => {
  const { executeGuidedTeam } = fixture().load('features/teams/guided-team-create.ts');
  const f = scenario('start'); let saved;
  await assert.rejects(executeGuidedTeam(f.record, record => { saved = clone(record); }, f.ports));
  const originalStatus = f.ports.runs.status;
  f.ports.runs.status = async () => { const status = await originalStatus(); status.agreement.state = 'paused'; return status; };
  await assert.rejects(executeGuidedTeam(saved, () => {}, f.ports), error => error.stage === 'changed');
  assert.equal(f.calls.filter(call => call.name === 'start').length, 2, 'only the original start receipt is recovered');
});

test('reviewed virtual opening resolves sellability and cash availability, while missing cash totals still block', async () => {
  const { executeGuidedTeam } = fixture().load('features/teams/guided-team-create.ts');
  const f = scenario();
  f.record.preview.needsInput = ['SELLABILITY_UNKNOWN:FIXTURE', 'CASH_AVAILABILITY_UNKNOWN:CNY'];
  assert.equal(await executeGuidedTeam(f.record, () => {}, f.ports), 'team');
  assert.equal(f.calls.find(call => call.name === 'account').input.confirmOpeningCash, true);
  const missingCash = scenario(); missingCash.record.preview.needsInput = ['CASH_UNKNOWN'];
  await assert.rejects(executeGuidedTeam(missingCash.record, () => {}, missingCash.ports), error => error.code === 'holdings');
  assert.equal(missingCash.calls.length, 0);
});

test('missing cash after a refreshed seed keeps the guided review available after the user fixes assets', async () => {
  const { refreshGuidedTeamReview } = fixture().load('features/teams/guided-team-create.ts');
  const f = scenario(); f.record.reviewRequired = 'seed';
  f.ports.previewHoldings = async () => ({ ...f.record.preview, previewId: 'cash-still-missing', needsInput: ['CASH_UNKNOWN'] });
  await refreshGuidedTeamReview(f.record, () => {}, f.ports);
  assert.equal(f.record.reviewRequired, 'seed'); assert.equal(f.record.refreshPending, undefined);
  f.ports.previewHoldings = async () => ({ ...f.record.preview, previewId: 'cash-confirmed', needsInput: [] });
  await refreshGuidedTeamReview(f.record, () => {}, f.ports);
  assert.equal(f.record.reviewRequired, undefined); assert.equal(f.record.reviewEpochs.seed, 2);
});
