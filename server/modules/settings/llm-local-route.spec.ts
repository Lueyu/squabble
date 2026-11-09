import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmService } from '../research-core/llm.service';
import type { SettingsService } from './settings.service';
import type { LlmBudgetService } from '../llm-budget/llm-budget.service';

test('local route executes once without API budget and keeps stable stage IDs', async () => {
  const calls: Array<{ messageId: string; prompt: string }> = [];
  const agents = { validate: async () => {}, execute: async (_owner: string, input: { messageId: string; prompt: string }) => {
    calls.push(input);
    return { text: '```json\n{"ok":true}\n```', usageTokens: null };
  } };
  const service = new LlmService({} as SettingsService, { reserve: async () => { throw new Error('API budget used'); } } as unknown as LlmBudgetService,
    { get: () => agents } as never);
  const options = { route: { mode: 'local' as const, agentId: 'native-codex' }, taskId: 'run-1', purpose: 'bull-round-1' };
  const result = await service.chatSlowJSON([{ role: 'user', content: 'Analyze' }], 'alice', options);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(result.tokensKnown, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Analyze/);
  await service.chatSlowJSON([{ role: 'user', content: 'Analyze' }], 'alice', options);
  assert.equal(calls[1].messageId, calls[0].messageId);
  await service.chatSlowJSON([{ role: 'user', content: 'Analyze' }], 'alice', { ...options, purpose: 'bear-round-1' });
  assert.notEqual(calls[2].messageId, calls[0].messageId);
});

test('local dispatch checks cancellation before starting and serializes same Agent', async () => {
  let active = 0;
  let peak = 0;
  const agents = { validate: async () => {}, execute: async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    return { text: 'OK', usageTokens: 4 };
  } };
  const service = new LlmService({} as SettingsService, {} as LlmBudgetService, { get: () => agents } as never);
  const route = { mode: 'local' as const, agentId: 'native-codex' };
  await Promise.all([service.chatFast([{ role: 'user', content: 'one' }], 'alice', { route, taskId: 'one', purpose: 'stage' }),
    service.chatFast([{ role: 'user', content: 'two' }], 'alice', { route, taskId: 'two', purpose: 'stage' })]);
  assert.equal(peak, 1);
  await assert.rejects(service.chatFast([{ role: 'user', content: 'three' }], 'alice', { route,
    shouldContinue: async () => false }), /cancelled/i);
});
