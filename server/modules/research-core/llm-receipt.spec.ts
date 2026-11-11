import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmService } from './llm.service';

test('a completed malformed provider response is saved before JSON validation without a second call', async () => {
  let calls = 0;
  const receipts: unknown[] = [];
  const service = Object.create(LlmService.prototype) as LlmService;
  Object.assign(service, { chat: async () => { calls++; return { content: 'private malformed provider response', totalTokens: 17, usageKnown: true }; } });
  await assert.rejects(service.chatSlowJSON([], 'fixture-owner', {
    onResponseReceived: async result => { receipts.push(result); },
  }), error => error instanceof Error && error.message === 'LLM_INVALID_JSON');
  assert.equal(calls, 1);
  assert.deepEqual(receipts, [{ content: 'private malformed provider response', totalTokens: 17, usageKnown: true }]);
});
