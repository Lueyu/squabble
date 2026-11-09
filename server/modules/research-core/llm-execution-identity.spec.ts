import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { LlmService } from './llm.service';

test('actual execution identity is emitted only for a successful completed provider response', async () => {
  const original = axios.post; const executions: unknown[] = [];
  const service = new LlmService({ getLlmConfig: async () => ({ source: 'environment', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', fastModel: 'shared-alias', slowModel: 'review-model' }) } as never,
    { reserve: async () => ({ id: 'reservation', maxOutputTokens: 100 }), settle: async () => ({ inputTokens: 1, outputTokens: 1, chargedTokens: 2 }) } as never);
  try {
    axios.post = (async () => ({ data: { model: ' actual-returned-model ', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] } })) as never;
    await service.chatFastJSON([{ role: 'user', content: 'fixture' }], 'owner', { retryPolicy: 'none', route: { mode: 'api' }, onExecuted: metadata => { executions.push(metadata); } });
    assert.deepEqual(executions, [{ provider: 'https://fixture.invalid', model: 'actual-returned-model', identityVerified: true }]);
    axios.post = (async () => ({ data: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] } })) as never;
    await service.chatFastJSON([{ role: 'user', content: 'fixture' }], 'owner', { route: { mode: 'api' }, connectionId: 'alias-one', onExecuted: metadata => { executions.push(metadata); } });
    await service.chatFastJSON([{ role: 'user', content: 'fixture' }], 'owner', { route: { mode: 'api' }, connectionId: 'alias-two', onExecuted: metadata => { executions.push(metadata); } });
    assert.deepEqual(executions.slice(1), [{ provider: 'https://fixture.invalid', model: 'unreported', identityVerified: false }, { provider: 'https://fixture.invalid', model: 'unreported', identityVerified: false }], 'missing actual model cannot credit configured aliases as independent identities');
    const verified = executions as Array<{ provider: string; model: string; identityVerified: boolean }>;
    assert.equal(new Set(verified.filter(execution => execution.identityVerified).map(execution => `${execution.provider}:${execution.model}`)).size, 1, 'mixed known and unknown models at one endpoint supply only one verified executor');
    axios.post = (async () => ({ data: { choices: [{ message: { content: '{}' }, finish_reason: 'length' }] } })) as never;
    await assert.rejects(service.chatFastJSON([{ role: 'user', content: 'fixture' }], 'owner', { retryPolicy: 'none', route: { mode: 'api' }, onExecuted: metadata => { executions.push(metadata); } }), /LLM_OUTPUT_LIMIT/);
    assert.equal(executions.length, 3, 'failed or incomplete selected routes are not counted as executed reviews');
  } finally { axios.post = original; }
});
