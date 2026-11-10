import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryInventoryQuerySchema } from './research-memory.requests';

test('workspace inventory is bounded and validates pagination before querying', () => {
  assert.deepEqual(memoryInventoryQuerySchema.parse({}), { offset: 0, limit: 24 });
  assert.equal(memoryInventoryQuerySchema.safeParse({ limit: 101 }).success, false);
  assert.equal(memoryInventoryQuerySchema.safeParse({ offset: -1 }).success, false);
  assert.equal(memoryInventoryQuerySchema.safeParse({ owner: 'someone-else' }).success, false);
  assert.deepEqual(memoryInventoryQuerySchema.parse({ offset: '24', limit: '24' }), { offset: 24, limit: 24 });
});
