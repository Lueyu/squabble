import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { RuntimeJournalService } from './runtime-journal.service';
import { canonicalHash } from './runtime-contract';

async function fixture(run: (journal: RuntimeJournalService, client: ReturnType<typeof postgres>) => Promise<void>) {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'A disposable test database is required');
  const ns = `runtime_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
  try {
    await admin.unsafe(`create schema ${ns}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/53_agent_tool_runtime.sql', 'utf8'));
    await run(new RuntimeJournalService(drizzle(client), 'runtime-test-encryption-key-2026'), client);
  } finally {
    await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end();
  }
}
const input = (owner = randomUUID()) => {
  const payload = { holdings: [{ accountId: 'account', instrumentId: 'US:EXAMPLE', quantity: '10' }],
    cash: [{ accountId: 'account', currency: 'USD', amount: '100' }], sourcePayloads: [] };
  return {
    identity: { owner, sessionId: randomUUID(), cycleId: randomUUID(), revision: 1, memberId: 'analyst', turn: 0, executionAttempt: 1 },
    driver: 'controlled' as const, frozenInput: { version: 1 as const, payload, payloadHash: canonicalHash(payload), datasets: [], datasetVersionIds: [] },
    policy: { loopOwner: 'runtime', maxModelRequestsPerStep: 1, sdkRetries: 0, sdkToolExecution: false,
      sdkToolApproval: false, providerExecutedWrites: false, fallback: null, maxSteps: 6, maxTools: 24 },
  };
};

test('runtime identity is owner scoped; same identity cannot silently change frozen content', async () => fixture(async journal => {
  const request = input(), first = await journal.create(request);
  assert.equal((await journal.create(request)).id, first.id);
  const changed = { ...request.frozenInput.payload, cash: [] };
  await assert.rejects(journal.create({ ...request, frozenInput: { ...request.frozenInput, payload: changed, payloadHash: canonicalHash(changed) } }), /INPUT_CONFLICT/);
  await assert.rejects(journal.read(randomUUID(), first.id), /NOT_FOUND/);
}));

test('only one worker owns a lease and only one dispatch receipt is created', async () => fixture(async (journal, client) => {
  const request = input(), run = await journal.create(request), owner = request.identity.owner;
  const claims = await Promise.all([journal.claim(owner, run.id), journal.claim(owner, run.id)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const lease = claims.find(Boolean)!;
  const dispatch = { index: 0, request: { messages: [{ role: 'user', content: 'private research input' }] }, model: 'fake-model' };
  const [a, b] = await Promise.all([journal.beginStep(owner, run.id, lease.token, dispatch), journal.beginStep(owner, run.id, lease.token, dispatch)]);
  assert.equal(a.step.id, b.step.id); assert.equal(Number(a.fresh) + Number(b.fresh), 1);
  await assert.rejects(journal.beginStep(owner, run.id, lease.token, { ...dispatch, request: { different: true } }), /REQUEST_CONFLICT/);
  const rows = await client`select request_enc from agent_runtime_steps`;
  assert.ok(!rows[0].request_enc.includes('private research input'));
  await assert.rejects(journal.beginStep(owner, run.id, 'stale-token', { ...dispatch, index: 1 }), /LEASE/);
}));

test('stored responses can be reparsed without new dispatch and cancelled results cannot be accepted', async () => fixture(async journal => {
  const request = input(), run = await journal.create(request), owner = request.identity.owner;
  const lease = (await journal.claim(owner, run.id))!;
  const { step } = await journal.beginStep(owner, run.id, lease.token, { index: 0, request: {}, model: 'fake' });
  await journal.receive(owner, run.id, step.id, { text: '{broken', usage: null });
  await journal.recordParse(owner, run.id, step.id, false, 'INVALID_JSON', { leaseToken: lease.token });
  assert.deepEqual(await journal.response(owner, run.id, step.id), { text: '{broken', usage: null });
  await journal.recordParse(owner, run.id, step.id, true, null, { leaseToken: lease.token });
  assert.equal((await journal.read(owner, run.id)).steps.length, 1);
  await journal.cancel(owner, run.id);
  await assert.rejects(journal.accept(owner, run.id, lease.token), /CANCELLED|STATE/);
}));

test('expired dispatched work becomes unknown; closing it does not delete accounting or accept late output', async () => fixture(async (journal, client) => {
  const request = input(), run = await journal.create(request), owner = request.identity.owner;
  const lease = (await journal.claim(owner, run.id))!;
  const { step } = await journal.beginStep(owner, run.id, lease.token, { index: 0, request: {}, model: 'fake' });
  await client`update agent_runtime_runs set lease_until=now()-interval '1 second' where id=${run.id}`;
  assert.equal(await journal.recover(owner, run.id), 'provider_unknown');
  await journal.settleUnknown(owner, run.id);
  await journal.receive(owner, run.id, step.id, { text: 'late output' });
  assert.equal((await journal.read(owner, run.id)).state, 'settled_unknown');
  assert.equal((await journal.read(owner, run.id)).steps.length, 1);
  assert.equal(await journal.claim(owner, run.id), null);
}));

test('cancel intent survives a late provider result and forbids all further sends', async () => fixture(async journal => {
  const request = input(), run = await journal.create(request), owner = request.identity.owner;
  const lease = (await journal.claim(owner, run.id))!;
  const { step } = await journal.beginStep(owner, run.id, lease.token, { index: 0, request: {}, model: 'fake' });
  await journal.cancel(owner, run.id);
  await journal.receive(owner, run.id, step.id, { text: 'late result after stop' });
  assert.equal((await journal.read(owner, run.id)).state, 'cancelled');
  await assert.rejects(journal.accept(owner, run.id, lease.token), /STATE|CANCELLED/);
  await assert.rejects(journal.beginStep(owner, run.id, lease.token, { index: 1, request: {}, model: 'fake' }), /STATE|CANCELLED/);
}));

test('one model request is in flight; acceptance requires the latest validated response', async () => fixture(async journal => {
  const request = input(), run = await journal.create(request), owner = request.identity.owner;
  const lease = (await journal.claim(owner, run.id))!;
  await assert.rejects(journal.beginStep(owner, run.id, lease.token, { index: 2, request: {}, model: 'fake' }), /STEP_ORDER/);
  const { step } = await journal.beginStep(owner, run.id, lease.token, { index: 0, request: {}, model: 'fake' });
  await assert.rejects(journal.beginStep(owner, run.id, lease.token, { index: 1, request: {}, model: 'fake' }), /IN_FLIGHT|STEP_ORDER/);
  await journal.receive(owner, run.id, step.id, { text: 'not yet validated' });
  await assert.rejects(journal.accept(owner, run.id, lease.token), /VALIDATION/);
  await journal.recordParse(owner, run.id, step.id, true, null, { leaseToken: lease.token });
  await journal.accept(owner, run.id, lease.token);
}));
