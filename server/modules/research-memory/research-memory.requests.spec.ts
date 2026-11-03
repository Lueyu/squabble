import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryQuerySchema, memoryPreferencesSchema, thesisDeleteSchema, thesisUpdateSchema } from './research-memory.requests';

test('memory API validates all owner-independent input and requires explicit optimistic versions', () => {
  assert.equal(memoryQuerySchema.safeParse({ ticker: 'AAPL', market: 'US' }).success, true);
  assert.equal(memoryQuerySchema.safeParse({ ticker: 'AAPL', owner: 'another-user' }).success, false);
  assert.equal(memoryQuerySchema.safeParse({ ticker: 'AAPL', market: 'EU' }).success, false);
  assert.equal(memoryPreferencesSchema.safeParse({ autoArchive: false, recallEnabled: false }).success, true);
  assert.equal(memoryPreferencesSchema.safeParse({ autoArchive: 'false', recallEnabled: true }).success, false);
  assert.equal(thesisUpdateSchema.safeParse({ action: 'confirm' }).success, false);
  assert.equal(thesisUpdateSchema.safeParse({ action: 'confirm', expectedVersion: 0 }).success, false);
  assert.equal(thesisUpdateSchema.safeParse({ action: 'confirm', expectedVersion: 1, status: 'confirmed' }).success, false);
  assert.equal(thesisUpdateSchema.safeParse({ action: 'edit', expectedVersion: 1 }).success, false);
  assert.equal(thesisUpdateSchema.safeParse({ action: 'exclude', expectedVersion: 1 }).success, false);
  assert.equal(thesisDeleteSchema.safeParse({ expectedVersion: 1 }).success, true);
  assert.equal(thesisDeleteSchema.safeParse({}).success, false);
});
