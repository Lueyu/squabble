import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeExecutionFailure } from './failures';
import { nativeFailureCode } from '../modules/local-agents/local-agents.types';
test('native execution causes remain distinct and never expose diagnostic text', () => {
  for (const [native, local] of Object.entries({ NATIVE_AGENT_TIMEOUT:'LOCAL_TIMEOUT', NATIVE_AGENT_OUTPUT_LIMIT:'LOCAL_OUTPUT_LIMIT', NATIVE_AGENT_LAUNCH_FAILED:'LOCAL_LAUNCH_FAILED', NATIVE_AGENT_INCOMPLETE:'LOCAL_PROTOCOL_INCOMPLETE', NATIVE_AGENT_FAILED:'LOCAL_TASK_FAILED' })) assert.equal(nativeFailureCode(new Error(native)), local);
  const failure = safeExecutionFailure(Object.assign(new Error('PRIVATE secret-token'), { result: { code: 7, stdout: 'PRIVATE_PORTFOLIO', stderr: 'Bearer SECRET' } }));
  assert.equal(failure.code, 'LOCAL_TASK_FAILED'); assert.equal(failure.exitCode, 7); assert.doesNotMatch(JSON.stringify(failure), /PRIVATE|SECRET|Bearer/);
});
test('unknown delivery never offers paid replay while parse failure offers local reparse', () => {
  assert.deepEqual(safeExecutionFailure(new Error('LOCAL_DISPATCH_UNCERTAIN')).recoveries, ['check_existing']);
  assert.deepEqual(safeExecutionFailure({ fieldPath:'response.details', expectedType:'string', actualType:'object' }, 'parse').recoveries, ['reparse_existing']);
});
test('API transport failures cannot confirm that the upstream request has terminated', () => {
  for(const message of ['LLM_REQUEST_TIMEOUT','LLM request failed. Check provider URL and server network.']) {
    const failure=safeExecutionFailure(new Error(message));
    assert.equal(failure.code,'LOCAL_DISPATCH_UNCERTAIN');
    assert.deepEqual(failure.recoveries,['check_existing']);
  }
});
