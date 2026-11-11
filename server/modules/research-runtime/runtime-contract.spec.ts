import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertDispatchReplay, assertFrozenInputSnapshot, assertRuntimeExecutionPolicy,
  assertRuntimeTransition, availableBudget, canonicalHash, parseJsonAction,
  planToolBatch, reviseActionPreview, toAgentToolEnvelope, validateAgentToolDescriptor,
} from './runtime-contract';
import { descriptor, frozenInput, preview } from './testing/contract-fixtures';

test('a received result can be cancelled before local acceptance', () => {
  assert.doesNotThrow(() => assertRuntimeTransition('result_received', 'cancelled', { event: 'cancel' }));
  assert.throws(() => assertRuntimeTransition('accepted', 'running', { event: 'resume' }), /RUNTIME_TRANSITION/);
});

test('failed parsing can reparse only the saved response with an audit record', () => {
  assert.doesNotThrow(() => assertRuntimeTransition('failed', 'result_received', {
    event: 'reparse', hasStoredResponse: true, parseAttemptId: 'parse-2',
  }));
  assert.throws(() => assertRuntimeTransition('failed', 'result_received', { event: 'reparse' }), /REPARSE/);
  assert.throws(() => assertRuntimeTransition('failed', 'running', { event: 'resume' }), /RUNTIME_TRANSITION/);
});

test('closing an unknown workflow preserves uncertainty and permits billing reconciliation only', () => {
  assert.doesNotThrow(() => assertRuntimeTransition('provider_unknown', 'settled_unknown', { event: 'close_unknown' }));
  assert.doesNotThrow(() => assertRuntimeTransition('settled_unknown', 'settled_unknown', { event: 'billing_correction' }));
  assert.throws(() => assertRuntimeTransition('settled_unknown', 'result_received', { event: 'provider_result' }), /RUNTIME_TRANSITION/);
});

test('a cancelled unknown request may settle late without publishing', () => {
  assert.doesNotThrow(() => assertRuntimeTransition('provider_unknown', 'cancelled', {
    event: 'cancel_confirmed', providerTerminationConfirmed: true,
  }));
  assert.throws(() => assertRuntimeTransition('provider_unknown', 'cancelled', { event: 'cancel_confirmed' }), /PROVIDER_FACT/);
});

test('dispatch identity reuses identical content and conflicts on edited content', () => {
  const prior = { owner: 'owner-a', dispatchKey: 'run-a:step:0', requestHash: canonicalHash({ model: 'fake', input: 'one' }) };
  assert.equal(assertDispatchReplay(prior, { ...prior }), 'reuse');
  assert.throws(() => assertDispatchReplay(prior, { ...prior, requestHash: canonicalHash({ model: 'fake', input: 'two' }) }), /DISPATCH_IDENTITY_CONFLICT/);
  assert.throws(() => assertDispatchReplay(prior, { ...prior, owner: 'owner-b' }), /DISPATCH_IDENTITY_CONFLICT/);
});

test('budget subtracts settled use and all in-flight reservations once', () => {
  assert.equal(availableBudget({ limit: 100, settled: 25, inFlight: [15, 30] }), 30);
  assert.equal(availableBudget({ limit: 10, settled: 12, inFlight: [] }), 0);
  assert.throws(() => availableBudget({ limit: 100, settled: -1, inFlight: [] }), /INVALID_BUDGET/);
});

test('canonical request hashes ignore key order but retain payload and array ordering', () => {
  assert.equal(canonicalHash({ a: 1, b: ['x', 'y'] }), canonicalHash({ b: ['x', 'y'], a: 1 }));
  assert.notEqual(canonicalHash({ a: ['x', 'y'] }), canonicalHash({ a: ['y', 'x'] }));
  assert.throws(() => canonicalHash({ value: undefined }), /INVALID_JSON/);
});

test('descriptor validation accepts a bounded trusted descriptor and preserves the full contract', () => {
  assert.deepEqual(validateAgentToolDescriptor(descriptor()), descriptor());
  assert.throws(() => validateAgentToolDescriptor({ ...descriptor(), effect: 'shell' }), /TOOL_DESCRIPTOR/);
  assert.throws(() => validateAgentToolDescriptor({ ...descriptor(), timeoutMs: 0 }), /TOOL_DESCRIPTOR/);
});

test('tool schemas cannot reference remote or local files or exceed depth and bytes', () => {
  for (const ref of ['https://bad.example/schema', 'file:///secret', '../schema']) {
    assert.throws(() => validateAgentToolDescriptor({ ...descriptor(), inputSchema: { $ref: ref } }), /SCHEMA_REF/);
  }
  assert.doesNotThrow(() => validateAgentToolDescriptor({ ...descriptor(), inputSchema: { $defs: { x: { type: 'string' } }, $ref: '#/$defs/x' } }));
  assert.throws(() => validateAgentToolDescriptor({ ...descriptor(), inputSchema: { description: 'x'.repeat(65_537) } }), /SCHEMA_SIZE/);
  let nested: Record<string, unknown> = { type: 'string' };
  for (let index = 0; index < 18; index += 1) nested = { properties: { nested } };
  assert.throws(() => validateAgentToolDescriptor({ ...descriptor(), inputSchema: nested }), /SCHEMA_DEPTH/);
});

test('runtime policy has one loop owner, one HTTP request per step, and runtime-only approval', () => {
  const policy = { loopOwner: 'runtime' as const, maxModelRequestsPerStep: 1 as const,
    sdkRetries: 0 as const, sdkToolExecution: false as const, sdkToolApproval: false as const,
    providerExecutedWrites: false as const, fallback: null };
  assert.doesNotThrow(() => assertRuntimeExecutionPolicy(policy));
  assert.throws(() => assertRuntimeExecutionPolicy({ ...policy, sdkToolApproval: true }), /RUNTIME_POLICY/);
  assert.throws(() => assertRuntimeExecutionPolicy({ ...policy, providerExecutedWrites: true }), /RUNTIME_POLICY/);
  assert.throws(() => assertRuntimeExecutionPolicy({ ...policy, maxModelRequestsPerStep: 2 }), /RUNTIME_POLICY/);
  assert.throws(() => assertRuntimeExecutionPolicy({ ...policy, fallback: { connectionId: 'other', explicitlyConfigured: false, visible: true, errorTriggered: true } }), /FALLBACK_POLICY/);
});

test('a mixed batch runs eligible reads before parking writes and never repeats a saved read', () => {
  const calls = [{ toolCallId: 'read-1', toolId: 'quotes', effect: 'read' as const },
    { toolCallId: 'write-1', toolId: 'send', effect: 'external_write' as const },
    { toolCallId: 'read-2', toolId: 'facts', effect: 'read' as const }];
  const first = planToolBatch(calls, []);
  assert.deepEqual(first.executable.map(call => call.toolCallId), ['read-1', 'read-2']);
  assert.deepEqual(first.parkedWrites.map(call => call.toolCallId), ['write-1']);
  assert.deepEqual(planToolBatch(calls, ['read-1', 'read-2']).executable, []);
  assert.throws(() => planToolBatch([...calls, calls[0]], []), /DUPLICATE_TOOL_CALL/);
});

test('preview edits stay in waiting approval, bind a new hash and invalidate the old approval', () => {
  const original = preview();
  const revised = reviseActionPreview(original, { ...original.payload, body: 'Revised text' }, 1_000);
  assert.equal(revised.state, 'waiting_approval');
  assert.equal(revised.revision, original.revision + 1);
  assert.equal(revised.approval, null);
  assert.notEqual(revised.payloadHash, original.payloadHash);
  assert.equal(revised.expiresAt, 901_000);
  assert.throws(() => reviseActionPreview({ ...original, state: 'accepted' }, original.payload, 1_000), /PREVIEW_STATE/);
});

const actionContext = { stepId: 'step-1', maxToolCalls: 4, catalog: [descriptor()],
  validateArguments: (_tool: unknown, args: Record<string, unknown>): string | null =>
    typeof args.ticker === 'string' ? null : 'ticker must be a string' };

test('valid JSON actions become bounded tool calls with stable model call IDs', () => {
  const result = parseJsonAction(JSON.stringify({ type: 'tool_calls', toolCalls: [{ id: 'call-1', toolId: 'quotes', arguments: { ticker: 'TEST' } }] }), actionContext);
  assert.equal(result.toolCalls[0].id, 'call-1');
  assert.deepEqual(result.toolResults, []);
});

test('invalid JSON becomes a structured local result with a stable synthetic identity', () => {
  const first = parseJsonAction('{broken', actionContext);
  const replay = parseJsonAction('{broken', actionContext);
  assert.deepEqual(first, replay);
  assert.equal(first.toolCalls.length, 0);
  assert.equal(first.toolResults[0].toolCallId, 'json-action:step-1:0');
  assert.equal(first.toolResults[0].error.code, 'INVALID_JSON_ACTION');
});

test('unknown tools and invalid arguments return feedback without an invocation', () => {
  const result = parseJsonAction(JSON.stringify({ type: 'tool_calls', toolCalls: [
    { id: 'unknown-1', toolId: 'unknown', arguments: {} },
    { id: 'bad-1', toolId: 'quotes', arguments: { ticker: 1 } },
  ] }), actionContext);
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.toolResults.map(value => value.error.code), ['UNKNOWN_TOOL', 'INVALID_TOOL_ARGUMENTS']);
  assert.deepEqual(result.toolResults.map(value => value.toolCallId), ['unknown-1', 'bad-1']);
});

test('duplicate call identities reject the whole action batch without ambiguity', () => {
  const result = parseJsonAction(JSON.stringify({ type: 'tool_calls', toolCalls: [
    { id: 'same', toolId: 'quotes', arguments: { ticker: 'A' } },
    { id: 'same', toolId: 'quotes', arguments: { ticker: 'B' } },
  ] }), actionContext);
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.toolResults[0].error.code, 'DUPLICATE_TOOL_CALL');
});

test('JSON action feedback cannot trigger an implicit paid repair or exceed tool limits', () => {
  const calls = Array.from({ length: 5 }, (_, index) => ({ id: `call-${index}`, toolId: 'quotes', arguments: { ticker: 'A' } }));
  const result = parseJsonAction(JSON.stringify({ type: 'tool_calls', toolCalls: calls }), actionContext);
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.toolResults[0].error.code, 'TOOL_CALL_LIMIT');
  assert.equal(result.requiresNewModelStep, true);
  const final = parseJsonAction('{"type":"final","text":"Complete"}', actionContext);
  assert.equal(final.text, 'Complete');
  assert.equal(final.requiresNewModelStep, false);
});

test('frozen facts require dataset versions, content hashes and immutable payload content', () => {
  const snapshot = frozenInput();
  assert.doesNotThrow(() => assertFrozenInputSnapshot(snapshot));
  assert.throws(() => assertFrozenInputSnapshot({ ...snapshot, payload: { ...snapshot.payload, cash: [] } }), /FROZEN_INPUT_HASH/);
  assert.throws(() => assertFrozenInputSnapshot({ ...snapshot, datasets: [{ ...snapshot.datasets[0], contentHash: '' }] }), /DATASET_VERSION/);
  assert.throws(() => assertFrozenInputSnapshot({ ...snapshot, datasets: [] }), /DATASET_VERSION/);
});

test('the frozen hash binds actual holdings and cash, not just the ticker allowlist', () => {
  const snapshot = frozenInput();
  const changed = { ...snapshot.payload, holdings: [{ ...snapshot.payload.holdings[0], quantity: '200' }] };
  assert.notEqual(canonicalHash(changed), snapshot.payloadHash);
});

test('unknown frozen cash remains null and the full research context is hash bound', () => {
  const original = frozenInput();
  const payload = { ...original.payload, cash: [{ accountId: 'account', amount: null, currency: 'HKD' }],
    context: { evidence: [{ text: 'complete original evidence' }] } };
  const snapshot = { ...original, payload, payloadHash: canonicalHash(payload) };
  assert.doesNotThrow(() => assertFrozenInputSnapshot(snapshot));
  assert.throws(() => assertFrozenInputSnapshot({ ...snapshot, payload: { ...payload, context: {} } }), /HASH/);
});

test('the envelope leaves unknown business time null and remains readable by old consumers', () => {
  const legacy = { status: 'succeeded' as const, data: { price: '10' }, sources: [], asOf: '2026-11-11T00:00:00.000Z', truncated: false };
  const envelope = toAgentToolEnvelope(legacy, { invocationId: 'inv-1', observedAt: legacy.asOf, completedAt: legacy.asOf, dataAsOf: null });
  assert.equal(envelope.asOf, legacy.asOf);
  assert.equal(envelope.provenance.dataAsOf, null);
  assert.equal(envelope.usage, null);
  assert.deepEqual(envelope.data, legacy.data);
  assert.equal(JSON.parse(JSON.stringify(envelope)).provenance.dataAsOf, null);
});
