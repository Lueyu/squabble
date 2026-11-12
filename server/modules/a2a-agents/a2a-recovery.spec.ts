import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeExecutionFailure } from '../../local-agents/failures';

test('uncertain external outcomes only offer original-task reconciliation', () => {
  for (const code of ['A2A_DISPATCH_UNKNOWN', 'A2A_TIMEOUT', 'A2A_STATUS_UNKNOWN', 'A2A_CANCEL_UNKNOWN', 'A2A_CANCEL_PENDING', 'A2A_INPUT_REQUIRED', 'A2A_AUTH_REQUIRED', 'A2A_INVALID_OUTPUT']) {
    const failure = safeExecutionFailure(new Error(code));
    assert.equal(failure.code, code); assert.deepEqual(failure.recoveries, ['check_existing']);
  }
  assert.deepEqual(safeExecutionFailure(new Error('A2A_CONNECTION_DISABLED')).recoveries, ['fix_configuration']);
});
