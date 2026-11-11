import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { RuntimeJournalService } from './runtime-journal.service';
import { RuntimeInvocationsService } from './runtime-invocations.service';
import { ResearchRuntimeService } from './research-runtime.service';
import type { RuntimeLoopPorts } from './research-runtime.service';
import { canonicalHash } from './runtime-contract';
import type { ModelStepPort, ModelStepRequest, ModelStepResult } from '../research-core/model-step.interface';
import { AiSdkModelAdapter } from '../research-core/ai-sdk-model.adapter';
import { ModelStepService } from '../research-core/model-step.service';
import type { AgentToolScope } from '../../../shared/agent-tooling.interface';

const result = (text: string, toolCalls: ModelStepResult['toolCalls'] = []): ModelStepResult =>
  ({ text, toolCalls, finishReason: toolCalls.length ? 'tool-calls' : 'stop', usage: null, providerRequestId: null });

async function fixture(run: (f: {
  journal: RuntimeJournalService; invocations: RuntimeInvocationsService; owner: string; runId: string;
  request: ModelStepRequest; scope: AgentToolScope; ports: RuntimeLoopPorts; client: ReturnType<typeof postgres>;
  validateFinal: (text: string, scope: AgentToolScope) => Promise<void>;
}) => Promise<void>) {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'A disposable test database is required');
  const ns = `loop_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
  try {
    await admin.unsafe(`create schema ${ns}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/53_agent_tool_runtime.sql', 'utf8'));
    const db = drizzle(client), journal = new RuntimeJournalService(db, 'runtime-test-encryption-key-2026');
    const invocations = new RuntimeInvocationsService(db, 'runtime-test-encryption-key-2026');
    const owner = randomUUID();
    const payload = { holdings: [{ accountId: 'account', instrumentId: 'US:EXAMPLE', quantity: '22' }],
      cash: [{ accountId: 'account', currency: 'USD', amount: '12345.67' }], sourcePayloads: [] };
    const row = await journal.create({ identity: { owner, sessionId: randomUUID(), cycleId: randomUUID(), revision: 1,
      memberId: 'member', turn: 0, executionAttempt: 1 }, driver: 'controlled',
    frozenInput: { version: 1, payload, payloadHash: canonicalHash(payload), datasets: [], datasetVersionIds: [] },
    policy: { loopOwner: 'runtime', maxModelRequestsPerStep: 1, sdkRetries: 0, sdkToolExecution: false,
      sdkToolApproval: false, providerExecutedWrites: false, fallback: null, maxSteps: 6, maxTools: 24 } });
    const request: ModelStepRequest = { owner, model: 'fake', connectionId: 'model', connectionRevision: 1,
      messages: [{ role: 'user', content: 'Research with whole holdings and cash.' }],
      catalog: { catalogVersionId: 'catalog', schemaHash: 'a'.repeat(64), aliases: { lookup: 'lookup' },
        connectionRevisions: {}, descriptors: [{ id: 'lookup', name: 'lookup', connectionId: null,
          catalogVersionId: 'catalog', schemaHash: 'a'.repeat(64), description: 'Read the ticker', effect: 'read',
          inputSchema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'], additionalProperties: false },
          dataClasses: ['public'], timeoutMs: 1000, maxOutputBytes: 1000, supportsCancellation: false,
          supportsStatusLookup: false, remoteIdempotency: 'unsupported' }] } };
    const scope: AgentToolScope = { owner, runId: row.id, sessionId: String(row.identity.sessionId), revision: 1,
      leaseToken: '', allowedInstrumentIds: ['US:EXAMPLE'], allowedAccountIds: ['account'],
      allowedDataClasses: ['public'], sourceVersions: [], permissionRevision: 1 };
    const ports: RuntimeLoopPorts = { dispatch: { reserve: async () => ({ budgetId: randomUUID() }), settle: async () => {} },
      assertScope: async () => {}, shouldContinue: async () => true,
      tools: { invoke: async () => ({ status: 'succeeded', data: { marker: 'saved-read' } }) },
      approvals: { park: async () => ({ status: 'waiting_approval', results: [] }) } };
    await run({ journal, invocations, owner, runId: row.id, request, scope, ports, client, validateFinal: async () => {} });
  } finally { await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end(); }
}

test('three-round durable model loop supplies complete tool messages and frozen input to the next model', async () => fixture(async f => {
  const prompts: ModelStepRequest[] = []; let tools = 0;
  f.ports.tools.invoke = async () => { tools += 1; return { status: 'succeeded', data: { marker: `saved-read-${tools}` } }; };
  const model: ModelStepPort = { generate: async request => {
    prompts.push(structuredClone(request));
    return prompts.length < 3 ? result('', [{ id: `call-${prompts.length}`, toolId: 'lookup', arguments: { ticker: 'US:EXAMPLE' } }]) : result('final');
  } };
  const runtime = new ResearchRuntimeService(f.journal, model, f.invocations, f.ports);
  assert.equal((await runtime.execute({ ...f, modelRequest: f.request })).status, 'accepted');
  assert.equal(prompts.length, 3); assert.equal(tools, 2);
  assert.match(JSON.stringify(prompts[1].messages), /saved-read-1/);
  assert.match(JSON.stringify(prompts[2].messages), /saved-read-2/);
  assert.match(JSON.stringify(prompts[2].messages), /12345.67/);
  assert.match(JSON.stringify(prompts[2].messages), /call-1/);
  assert.equal((await f.journal.read(f.owner, f.runId)).steps.length, 3);
}));

test('invalid schema and duplicate call IDs become feedback without executing tools', async () => fixture(async f => {
  let sends = 0, tools = 0; const prompts: ModelStepRequest[] = [];
  f.ports.tools.invoke = async () => { tools += 1; return {}; };
  const model: ModelStepPort = { generate: async request => {
    prompts.push(request); sends += 1;
    if (sends === 1) return result('', [{ id: 'invalid', toolId: 'lookup', arguments: { ticker: 42 } }]);
    if (sends === 2) return result('', [{ id: 'duplicate', toolId: 'lookup', arguments: {} }, { id: 'duplicate', toolId: 'lookup', arguments: {} }]);
    return result('final');
  } };
  const runtime = new ResearchRuntimeService(f.journal, model, f.invocations, f.ports);
  assert.equal((await runtime.execute({ ...f, modelRequest: f.request })).status, 'accepted');
  assert.equal(tools, 0); assert.match(JSON.stringify(prompts[1]), /INVALID_TOOL_ARGUMENTS/);
  assert.match(JSON.stringify(prompts[2]), /DUPLICATE_TOOL_CALL/);
}));

test('saved response and completed tool receipt resume without repeating either send', async () => fixture(async f => {
  const lease = (await f.journal.claim(f.owner, f.runId))!;
  const modelResponse = result('', [{ id: 'saved-call', toolId: 'lookup', arguments: { ticker: 'US:EXAMPLE' } }]);
  const runtime = new ResearchRuntimeService(f.journal, { generate: async () => result('final') }, f.invocations, f.ports);
  const stepRequest = runtime.initialRequest(f.request, (await f.journal.read(f.owner, f.runId)).frozenInput);
  const { step } = await f.journal.beginStep(f.owner, f.runId, lease.token, { index: 0, model: 'fake', request: stepRequest });
  await f.journal.receive(f.owner, f.runId, step.id, modelResponse);
  await f.journal.recordParse(f.owner, f.runId, step.id, true, null, { leaseToken: lease.token });
  await f.invocations.execute({ owner: f.owner, runId: f.runId, stepId: step.id, leaseToken: lease.token,
    descriptor: f.request.catalog.descriptors[0], call: modelResponse.toolCalls[0] }, async () => ({ marker: 'completed-before-restart' }));
  await f.journal.release(f.owner, f.runId, lease.token);
  f.ports.tools.invoke = async () => { throw new Error('completed read must never repeat'); };
  const resumed = await runtime.execute({ ...f, modelRequest: f.request });
  assert.equal(resumed.status, 'accepted');
  const rows = await f.client`select * from agent_tool_invocations`;
  assert.equal(rows.length, 1);
}));

test('unresolved model receipt halts unknown and never sends it again', async () => fixture(async f => {
  const lease = (await f.journal.claim(f.owner, f.runId))!;
  const runtime = new ResearchRuntimeService(f.journal, { generate: async () => { throw new Error('must not send'); } }, f.invocations, f.ports);
  await f.journal.beginStep(f.owner, f.runId, lease.token, { index: 0, model: 'fake', request: runtime.initialRequest(f.request,
    (await f.journal.read(f.owner, f.runId)).frozenInput) });
  await f.client`update agent_runtime_runs set lease_until=now()-interval '1 second' where id=${f.runId}`;
  assert.equal((await runtime.execute({ ...f, modelRequest: f.request })).status, 'provider_unknown');
}));

test('stop after model response prevents new tools and acceptance', async () => fixture(async f => {
  let tools = 0;
  f.ports.tools.invoke = async () => { tools += 1; return {}; };
  const model: ModelStepPort = { generate: async () => {
    await f.journal.cancel(f.owner, f.runId);
    return result('', [{ id: 'stopped-call', toolId: 'lookup', arguments: { ticker: 'US:EXAMPLE' } }]);
  } };
  const runtime = new ResearchRuntimeService(f.journal, model, f.invocations, f.ports);
  assert.equal((await runtime.execute({ ...f, modelRequest: f.request })).status, 'cancelled');
  assert.equal(tools, 0);
}));

test('domain parse failure reparses the saved response locally and keeps the same model receipt', async () => fixture(async f => {
  let sends = 0;
  const runtime = new ResearchRuntimeService(f.journal, { generate: async () => { sends += 1; return result('saved-final'); } }, f.invocations, f.ports);
  const first = await runtime.execute({ ...f, modelRequest: f.request,
    validateFinal: async () => { throw new Error('INVALID_CITATION'); } });
  assert.equal(first.status, 'failed'); assert.equal(sends, 1);
  const reparsed = await runtime.execute({ ...f, modelRequest: f.request,
    validateFinal: async text => { assert.equal(text, 'saved-final'); } });
  assert.equal(reparsed.status, 'accepted'); assert.equal(sends, 1);
  assert.equal((await f.journal.read(f.owner, f.runId)).steps.length, 1);
}));

test('mixed batch saves reads before approval and resume does not repeat reads or the model step', async () => fixture(async f => {
  const write = { ...f.request.catalog.descriptors[0], id: 'publish', name: 'publish', effect: 'external_write' as const };
  f.request.catalog.descriptors.push(write); f.request.catalog.aliases.publish = 'publish';
  let sends = 0, reads = 0, approved = false;
  f.ports.tools.invoke = async () => { reads += 1; return { marker: 'read-before-write' }; };
  f.ports.approvals.park = async input => {
    assert.equal(reads, 1);
    return approved ? { status: 'completed', results: input.calls.map(call => ({ call, result: { marker: 'approved-write' } })) }
      : { status: 'waiting_approval', results: [] };
  };
  const runtime = new ResearchRuntimeService(f.journal, { generate: async request => {
    sends += 1;
    if (sends === 1) return result('', [
      { id: 'read-call', toolId: 'lookup', arguments: { ticker: 'US:EXAMPLE' } },
      { id: 'write-call', toolId: 'publish', arguments: { ticker: 'US:EXAMPLE' } },
    ]);
    assert.match(JSON.stringify(request.messages), /approved-write/);
    return result('final');
  } }, f.invocations, f.ports);
  assert.equal((await runtime.execute({ ...f, modelRequest: f.request })).status, 'waiting_approval');
  assert.equal(sends, 1); assert.equal(reads, 1);
  approved = true;
  await f.journal.resumeApproval(f.owner, f.runId, async () => { assert.equal(approved, true); });
  assert.equal((await runtime.execute({ ...f, modelRequest: f.request })).status, 'accepted');
  assert.equal(sends, 2); assert.equal(reads, 1);
}));

test('read concurrency is at most two overall and one per connection', async () => fixture(async f => {
  const original = f.request.catalog.descriptors[0];
  f.request.catalog.descriptors = ['a', 'b', 'c', 'd'].map((id, ordinal) => ({ ...original, id, name: id,
    connectionId: ordinal < 2 ? 'connection-one' : 'connection-two' }));
  f.request.catalog.aliases = { a: 'a', b: 'b', c: 'c', d: 'd' };
  let active = 0, high = 0, sends = 0;
  let releaseFirstPair: () => void;
  const firstPair = new Promise<void>(resolve => { releaseFirstPair = resolve; });
  const perConnection = new Map<string, number>();
  f.ports.tools.invoke = async descriptor => {
    active += 1; high = Math.max(high, active);
    const count = (perConnection.get(descriptor.connectionId) ?? 0) + 1;
    perConnection.set(descriptor.connectionId, count); assert.equal(count, 1);
    if (active === 2) releaseFirstPair();
    await firstPair;
    await new Promise(resolve => setTimeout(resolve, 15));
    active -= 1; perConnection.set(descriptor.connectionId, count - 1);
    return { marker: descriptor.id };
  };
  const runtime = new ResearchRuntimeService(f.journal, { generate: async () => {
    sends += 1;
    return sends === 1 ? result('', ['a', 'b', 'c', 'd'].map(id => ({ id, toolId: id, arguments: { ticker: 'US:EXAMPLE' } }))) : result('final');
  } }, f.invocations, f.ports);
  assert.equal((await runtime.execute({ ...f, modelRequest: f.request })).status, 'accepted');
  assert.equal(high, 2);
}));

test('an uncertain tool receipt never repeats', async () => fixture(async f => {
  let tools = 0;
  f.ports.tools.invoke = async () => { tools += 1; throw new Error('connection lost after send'); };
  const runtime = new ResearchRuntimeService(f.journal, { generate: async () => result('', [
    { id: 'uncertain-call', toolId: 'lookup', arguments: { ticker: 'US:EXAMPLE' } },
  ]) }, f.invocations, f.ports);
  assert.equal((await runtime.execute({ ...f, modelRequest: f.request })).status, 'provider_unknown');
  assert.equal((await runtime.execute({ ...f, modelRequest: f.request })).status, 'provider_unknown');
  assert.equal(tools, 1);
  const rows = await f.client`select state from agent_tool_invocations`;
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'provider_unknown');
}));

test('invalid action feedback is charged to the frozen step cap without a repair request', async () => fixture(async f => {
  await f.client`update agent_runtime_runs set policy=policy || '{"maxSteps":1}'::jsonb where id=${f.runId}`;
  let sends = 0;
  const runtime = new ResearchRuntimeService(f.journal, { generate: async () => {
    sends += 1; return result('', [{ id: 'invalid-call', toolId: 'lookup', arguments: { ticker: 42 } }]);
  } }, f.invocations, f.ports);
  assert.deepEqual(await runtime.execute({ ...f, modelRequest: f.request }), { status: 'failed', code: 'RUNTIME_STEP_LIMIT' });
  assert.equal(sends, 1);
}));

test('tool budget rejection rolls back the receipt and writes require a server approval hook', async () => fixture(async f => {
  const lease = (await f.journal.claim(f.owner, f.runId))!;
  const { step } = await f.journal.beginStep(f.owner, f.runId, lease.token, { index: 0, model: 'fake', request: {} });
  await f.journal.receive(f.owner, f.runId, step.id, result('saved'));
  const invocation = { owner: f.owner, runId: f.runId, stepId: step.id, leaseToken: lease.token,
    descriptor: f.request.catalog.descriptors[0], call: { id: 'budget-call', toolId: 'lookup', arguments: { ticker: 'US:EXAMPLE' } } };
  let sends = 0;
  await assert.rejects(f.invocations.execute(invocation, async () => { sends += 1; return {}; }, {
    beforeDispatch: async (tx, input) => {
      const rows = await tx.select().from((await import('../../database/agent-tooling.schema')).agentToolInvocations);
      assert.equal(rows[0].id, input.invocationId); throw new Error('TOOL_BUDGET_EXCEEDED');
    },
  }), /TOOL_BUDGET_EXCEEDED/);
  assert.equal(await f.invocations.count(f.owner, f.runId), 0); assert.equal(sends, 0);
  await assert.rejects(f.invocations.execute({ ...invocation,
    descriptor: { ...invocation.descriptor, effect: 'external_write' } }, async () => { sends += 1; return {}; }), /APPROVAL_REQUIRED/);
  assert.equal(sends, 0);
}));

test('an explicitly selected JSON action protocol uses bounded feedback and local final parsing', async () => fixture(async f => {
  f.request.jsonActionMode = true;
  let sends = 0;
  const runtime = new ResearchRuntimeService(f.journal, { generate: async request => {
    sends += 1;
    if (sends === 1) return result('{broken');
    assert.match(JSON.stringify(request.messages), /INVALID_JSON_ACTION/);
    return result('{"type":"final","text":"parsed-final"}');
  } }, f.invocations, f.ports);
  const outcome = await runtime.execute({ ...f, modelRequest: f.request,
    validateFinal: async text => { assert.equal(text, 'parsed-final'); } });
  assert.equal(outcome.text, 'parsed-final'); assert.equal(sends, 2);
}));

test('accepted receipt replay revalidates source scope without dispatching again', async () => fixture(async f => {
  let sends = 0;
  const runtime = new ResearchRuntimeService(f.journal, { generate: async () => { sends += 1; return result('final'); } }, f.invocations, f.ports);
  assert.equal((await runtime.execute({ ...f, modelRequest: f.request })).status, 'accepted');
  f.ports.assertScope = async () => { throw new Error('SOURCE_DISABLED'); };
  await assert.rejects(runtime.execute({ ...f, modelRequest: f.request }), /SOURCE_DISABLED/);
  assert.equal(sends, 1);
}));

test('real SDK single-step adapter carries durable tool results through three fake HTTP rounds', async () => fixture(async f => {
  let sends = 0;
  const adapter = new AiSdkModelAdapter(async (_url, init) => {
    sends += 1;
    const body = String(init.body);
    assert.match(body, /12345.67/);
    if (sends > 1) assert.match(body, /saved-read/);
    return Response.json({ id: `fake-http-${sends}`, model: 'fake', created: 1, choices: [
      { index: 0, finish_reason: sends < 3 ? 'tool_calls' : 'stop', message: sends < 3
        ? { role: 'assistant', content: null, tool_calls: [{ id: `http-call-${sends}`, type: 'function',
          function: { name: 'lookup', arguments: '{"ticker":"US:EXAMPLE"}' } }] }
        : { role: 'assistant', content: 'final-from-sdk' } },
    ] });
  });
  const model = new ModelStepService({ getLlmConfig: async () => ({ source: 'user', baseUrl: 'https://fake.provider.com/v1',
    fastModel: 'fake', slowModel: 'fake', apiKey: 'fake-fixture-key' }) }, adapter);
  Object.assign(f.request, await model.resolve(f.owner, 'model', 'fast'));
  const runtime = new ResearchRuntimeService(f.journal, model, f.invocations, f.ports);
  assert.equal((await runtime.execute({ ...f, modelRequest: f.request })).text, 'final-from-sdk');
  assert.equal(sends, 3); assert.equal((await f.journal.read(f.owner, f.runId)).steps.length, 3);
}));
