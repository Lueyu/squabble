import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { RuntimeJournalService } from '../runtime-journal.service';
import { RuntimeInvocationsService } from '../runtime-invocations.service';
import { DeepAgentCheckpointsService } from './deep-agent-checkpoints.service';
import { DeepAgentsDriver } from './deep-agents.driver';
import { canonicalHash } from '../../../common/agent-contract';
import type { RuntimeExecuteInput, RuntimeLoopPorts } from '../research-runtime.service';
import { ControlledRuntimeDriver } from './controlled-runtime.driver';
import { assertChildAllocation } from './deep-agents-policy';
import type { ModelStepPort, ModelStepResult } from '../../research-core/model-step.interface';

const response = (text: string, toolCalls: ModelStepResult['toolCalls'] = []): ModelStepResult =>
  ({ text, toolCalls, finishReason: toolCalls.length ? 'tool-calls' : 'stop', usage: null, providerRequestId: null });

async function fixture(run: (f: { input: RuntimeExecuteInput; ports: RuntimeLoopPorts;
  create: (model: ModelStepPort) => DeepAgentsDriver; journal: RuntimeJournalService; client: ReturnType<typeof postgres>;
  invocations: RuntimeInvocationsService;
}) => Promise<void>) {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'A disposable test database is required');
  const ns = `deep_${randomUUID().replaceAll('-', '')}`, owner = randomUUID();
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
  try {
    await admin.unsafe(`create schema ${ns}`);
    for (const name of ['01_schema.sql', '53_agent_tool_runtime.sql', '58_deep_agent_driver.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    }
    const db = drizzle(client), key = 'deep-agents-test-encryption-key';
    const journal = new RuntimeJournalService(db, key), invocations = new RuntimeInvocationsService(db, key);
    const checkpoints = new DeepAgentCheckpointsService(db, key);
    const payload = { holdings: [{ accountId: 'account', instrumentId: 'US:EXAMPLE', quantity: '77' }],
      cash: [{ accountId: 'account', currency: 'USD', amount: '98765.43' }], sourcePayloads: [] };
    const row = await journal.create({ identity: { owner, sessionId: randomUUID(), cycleId: randomUUID(), revision: 1,
      memberId: 'member', turn: 0, executionAttempt: 1 }, driver: 'deep_agents',
    frozenInput: { version: 1, payload, payloadHash: canonicalHash(payload), datasets: [], datasetVersionIds: [] },
    policy: { loopOwner: 'runtime', maxModelRequestsPerStep: 1, sdkRetries: 0, sdkToolExecution: false,
      sdkToolApproval: false, providerExecutedWrites: false, fallback: null, maxSteps: 6, maxTools: 24 } });
    const input: RuntimeExecuteInput = { owner, runId: row.id, modelRequest: { owner, model: 'fake', connectionId: 'model', connectionRevision: 1,
      messages: [{ role: 'user', content: 'Read one source and answer.' }],
      catalog: { catalogVersionId: 'catalog', schemaHash: 'a'.repeat(64), aliases: { lookup: 'lookup' }, connectionRevisions: {},
        descriptors: [{ id: 'lookup', name: 'lookup', connectionId: null, catalogVersionId: 'catalog', schemaHash: 'a'.repeat(64),
          description: 'Read a source', inputSchema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'], additionalProperties: false },
          effect: 'read', dataClasses: ['public'], timeoutMs: 1000, maxOutputBytes: 1000,
          supportsCancellation: false, supportsStatusLookup: false, remoteIdempotency: 'unsupported' }] } },
      scope: { owner, runId: row.id, sessionId: String(row.identity.sessionId), revision: 1, leaseToken: '',
        allowedInstrumentIds: ['US:EXAMPLE'], allowedAccountIds: ['account'], allowedDataClasses: ['public'], sourceVersions: [], permissionRevision: 1 },
      validateFinal: async () => {} };
    const ports: RuntimeLoopPorts = { dispatch: { reserve: async () => ({ budgetId: randomUUID() }), settle: async () => {} },
      assertScope: async () => {}, shouldContinue: async () => true,
      tools: { invoke: async () => ({ marker: 'read-result' }) }, approvals: { park: async () => { throw new Error('writes disabled'); } } };
    await run({ input, ports, journal, invocations, client, create: model => new DeepAgentsDriver(journal, model, invocations, checkpoints) });
  } finally { await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end(); }
}

test('actual Deep Agents uses the controlled LangChain model, budget and tool receipts with no hidden tools', async () => fixture(async f => {
  let sends = 0, reservations = 0, tools = 0;
  f.ports.dispatch.reserve = async () => { reservations += 1; return { budgetId: randomUUID() }; };
  f.ports.tools.invoke = async () => { tools += 1; return { marker: 'read-result' }; };
  const driver = f.create({ generate: async request => {
    sends += 1;
    assert.match(JSON.stringify(request.messages), /98765.43/);
    assert.deepEqual(Object.keys(request.catalog.aliases), ['lookup']);
    if (sends === 1) return response('', [{ id: 'deep-call', toolId: 'lookup', arguments: { ticker: 'US:EXAMPLE' } }]);
    assert.match(JSON.stringify(request.messages), /read-result/);
    return response('deep-final');
  } });
  assert.equal(driver.capabilities().mode, 'read_only');
  const result = await driver.execute(f.input, f.ports);
  assert.equal(result.status, 'accepted'); assert.equal(result.text, 'deep-final');
  assert.equal(sends, 2); assert.equal(reservations, 2); assert.equal(tools, 1);
  assert.equal((await f.client`select * from deep_agent_driver_checkpoints`).length, 1);
}));

test('Deep Agents restores a saved model response and completed read after a local settlement interruption', async () => fixture(async f => {
  f.input.modelRequest.messages.unshift({ role: 'system', content: 'The literal Squabble Deep Agents driver v1 is part of this frozen user instruction.' });
  let sends = 0, settlements = 0, tools = 0;
  f.ports.dispatch.settle = async () => { settlements += 1; if (settlements === 1) throw new Error('fixture interruption after receive'); };
  f.ports.tools.invoke = async () => { tools += 1; return { marker: 'once' }; };
  const driver = f.create({ generate: async () => {
    sends += 1; return sends === 1 ? response('', [{ id: 'saved-call', toolId: 'lookup', arguments: { ticker: 'US:EXAMPLE' } }]) : response('resumed');
  } });
  assert.equal((await driver.execute(f.input, f.ports)).status, 'failed');
  const lease = (await f.journal.claim(f.input.owner, f.input.runId))!;
  const step = (await f.journal.read(f.input.owner, f.input.runId)).steps[0];
  await f.journal.recordParse(f.input.owner, f.input.runId, step.id, true, null, { leaseToken: lease.token });
  await f.invocations.execute({ owner: f.input.owner, runId: f.input.runId, stepId: step.id, leaseToken: lease.token,
    descriptor: f.input.modelRequest.catalog.descriptors[0], call: { id: 'saved-call', toolId: 'lookup', arguments: { ticker: 'US:EXAMPLE' } } }, async () => ({ marker: 'saved-read' }));
  await f.journal.release(f.input.owner, f.input.runId, lease.token);
  assert.equal((await driver.execute(f.input, f.ports)).status, 'accepted');
  assert.equal(sends, 2); assert.equal(tools, 0);
}));

test('external-write catalogs never enable an uncontrolled Deep Agents path', async () => fixture(async f => {
  let sends = 0;
  const driver = f.create({ generate: async () => { sends += 1; return response('must not run'); } });
  f.input.modelRequest.catalog.descriptors[0].effect = 'external_write';
  await assert.rejects(driver.execute(f.input, f.ports), /READ_ONLY/);
  assert.equal(sends, 0);
}));

test('unknown tool receipt stops the framework before another model call and cannot be replayed', async () => fixture(async f => {
  let sends = 0, tools = 0;
  f.ports.tools.invoke = async () => { tools += 1; throw new Error('provider tool response lost'); };
  const driver = f.create({ generate: async () => { sends += 1; return response('', [
    { id: 'unknown-call', toolId: 'lookup', arguments: { ticker: 'US:EXAMPLE' } },
  ]); } });
  assert.equal((await driver.execute(f.input, f.ports)).status, 'provider_unknown');
  assert.equal((await driver.execute(f.input, f.ports)).status, 'provider_unknown');
  assert.equal(sends, 1); assert.equal(tools, 1);
}));

test('duplicate calls become bounded local feedback and stop intent prevents further tools', async () => fixture(async f => {
  let sends = 0, tools = 0;
  f.ports.tools.invoke = async () => { tools += 1; return {}; };
  const driver = f.create({ generate: async request => {
    sends += 1;
    if (sends === 1) return response('', [
      { id: 'same', toolId: 'lookup', arguments: {} }, { id: 'same', toolId: 'lookup', arguments: {} },
    ]);
    assert.match(JSON.stringify(request.messages), /DUPLICATE_TOOL_CALL/);
    await f.journal.cancel(f.input.owner, f.input.runId);
    return response('', [{ id: 'stopped-call', toolId: 'lookup', arguments: { ticker: 'US:EXAMPLE' } }]);
  } });
  assert.equal((await driver.execute(f.input, f.ports)).status, 'cancelled');
  assert.equal(tools, 0); assert.equal(sends, 2);
}));

test('default and Deep Agents read-only drivers agree on the same fictional sample without hidden calls', async () => fixture(async f => {
  let defaultCalls = 0, deepCalls = 0;
  const run = await f.journal.read(f.input.owner, f.input.runId);
  const native = await f.journal.create({ identity: { owner: f.input.owner, sessionId: f.input.scope.sessionId,
    cycleId: String(run.identity.cycleId), revision: 1, memberId: 'member', turn: 0, executionAttempt: 2 },
  driver: 'controlled', frozenInput: run.frozenInput as import('../../../../shared/research-runtime.interface').RuntimeFrozenInputSnapshot,
  policy: run.policy });
  const output = (ordinal: number) => ordinal === 1 ? response('', [{ id: 'compare-call', toolId: 'lookup', arguments: { ticker: 'US:EXAMPLE' } }]) : response('same-evidence-answer');
  const standard = new ControlledRuntimeDriver(f.journal, { generate: async () => output(++defaultCalls) }, f.invocations);
  const defaultResult = await standard.execute({ ...f.input, runId: native.id,
    scope: { ...f.input.scope, runId: native.id } }, f.ports);
  const deepResult = await f.create({ generate: async () => output(++deepCalls) }).execute(f.input, f.ports);
  assert.equal(defaultResult.status, 'accepted'); assert.equal(deepResult.status, 'accepted');
  assert.equal(defaultResult.text, deepResult.text);
  assert.equal(defaultCalls, 2); assert.equal(deepCalls, 2);
}));

test('future child allocation cannot increase parent permissions or model-step budget', () => {
  const parent = { owner: 'owner', runId: 'parent', sessionId: 'session', revision: 1, leaseToken: 'lease',
    allowedInstrumentIds: ['US:EXAMPLE'], allowedAccountIds: ['a'], allowedDataClasses: ['public' as const],
    sourceVersions: [], permissionRevision: 1 };
  assert.doesNotThrow(() => assertChildAllocation(parent, { ...parent, runId: 'child' }, 6, 2));
  assert.throws(() => assertChildAllocation(parent, { ...parent, allowedAccountIds: ['foreign'] }, 6, 2), /SCOPE_ESCALATION/);
  assert.throws(() => assertChildAllocation(parent, { ...parent }, 6, 6), /SCOPE_ESCALATION/);
});

test('framework feedback cannot exceed the same frozen model and tool limits', async () => fixture(async f => {
  await f.client`update agent_runtime_runs set policy=policy || '{"maxSteps":2}'::jsonb where id=${f.input.runId}`;
  let sends = 0, reservations = 0, tools = 0;
  f.ports.dispatch.reserve = async () => { reservations += 1; return { budgetId: randomUUID() }; };
  f.ports.tools.invoke = async () => { tools += 1; return {}; };
  const outcome = await f.create({ generate: async () => { sends += 1; return response('', [
    { id: `bounded-${sends}`, toolId: 'lookup', arguments: { ticker: 42 } },
  ]); } }).execute(f.input, f.ports);
  assert.equal(outcome.status, 'failed'); assert.equal(sends, 2); assert.equal(reservations, 2); assert.equal(tools, 0);
}));
