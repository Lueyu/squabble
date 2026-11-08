import assert from 'node:assert/strict';
import { test } from 'node:test';
import axios from 'axios';
import { LlmService } from '../research-core/llm.service';
import type { SettingsService } from './settings.service';
import type { LlmBudgetService } from '../llm-budget/llm-budget.service';

// These tests isolate credential routing; budget enforcement has its own DB/HTTP suites.
function budgetStub(): LlmBudgetService {
  return {
    reserve: async () => ({ id: 'test-reservation', taskId: 'test-task',
      inputTokens: 100, maxOutputTokens: 1000, reservedTokens: 1100 }),
    settle: async () => ({ inputTokens: 100, outputTokens: 1000, chargedTokens: 1100, known: false }),
  } as unknown as LlmBudgetService;
}

test('LLM calls use each authenticated user configuration', async () => {
  const settings = {
    getLlmConfig: async (userId: string) => ({
      source: 'user',
      baseUrl: 'https://api.openai.com/v1',
      fastModel: `fast-${userId}`,
      slowModel: `slow-${userId}`,
      apiKey: `secret-${userId}`,
    }),
  };
  const service = new LlmService(settings as SettingsService, budgetStub());
  const originalAdapter = axios.defaults.adapter;
  const calls: Array<{ url: string; authorization: string; model: string }> = [];
  axios.defaults.adapter = async (config) => {
    calls.push({
      url: String(config.url),
      authorization: String(config.headers?.Authorization),
      model: String(JSON.parse(String(config.data)).model),
    });
    return {
      data: { choices: [{ message: { content: 'OK' } }] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
  try {
    await service.chatFast([{ role: 'user', content: 'hi' }], 'alice');
    await service.chatFast([{ role: 'user', content: 'hi' }], 'bob');
  } finally {
    axios.defaults.adapter = originalAdapter;
  }
  assert.deepEqual(calls, [
    {
      url: 'https://api.openai.com/v1/chat/completions',
      authorization: 'Bearer secret-alice',
      model: 'fast-alice',
    },
    {
      url: 'https://api.openai.com/v1/chat/completions',
      authorization: 'Bearer secret-bob',
      model: 'fast-bob',
    },
  ]);
});

test('disabled budget sends no implicit output cap, but honors an explicit request cap', async () => {
  const settings = { getLlmConfig: async () => ({ source: 'user',
    baseUrl: 'https://api.openai.com/v1', fastModel: 'test-model',
    slowModel: 'test-model', apiKey: 'fixture' }) };
  const budget = budgetStub();
  budget.reserve = async (_owner, input) => ({ id: 'test-reservation', taskId: 'test-task',
    inputTokens: 100, maxOutputTokens: input.maxOutputTokens ?? 4096,
    reservedTokens: 100 + (input.maxOutputTokens ?? 4096),
    omitOutputLimit: input.maxOutputTokens === undefined });
  const service = new LlmService(settings as SettingsService, budget);
  const originalAdapter = axios.defaults.adapter;
  const bodies: Array<Record<string, unknown>> = [];
  axios.defaults.adapter = async (config) => {
    bodies.push(JSON.parse(String(config.data)) as Record<string, unknown>);
    return { data: { choices: [{ message: { content: 'OK' } }] },
      status: 200, statusText: 'OK', headers: {}, config };
  };
  try {
    await service.chatFast([{ role: 'user', content: 'hi' }], 'alice');
    await service.chatFast([{ role: 'user', content: 'hi' }], 'alice', { maxOutputTokens: 900 });
  } finally { axios.defaults.adapter = originalAdapter; }
  assert.equal(Object.hasOwn(bodies[0], 'max_tokens'), false);
  assert.equal(Object.hasOwn(bodies[0], 'max_completion_tokens'), false);
  assert.equal(bodies[1].max_tokens, 900);
});

test('LLM provider errors do not return an echoed API key', async () => {
  const settings = {
    getLlmConfig: async () => ({
      source: 'user',
      baseUrl: 'https://api.openai.com/v1',
      fastModel: 'test-model',
      slowModel: 'test-model',
      apiKey: 'sensitive-token',
    }),
  };
  const service = new LlmService(settings as SettingsService, budgetStub());
  const originalAdapter = axios.defaults.adapter;
  let calls = 0;
  axios.defaults.adapter = async (config) => {
    calls += 1;
    return {
      data: 'sensitive-token is invalid',
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config,
    };
  };
  try {
    await assert.rejects(
      () => service.chatFast([{ role: 'user', content: 'hi' }], 'alice'),
      (error: Error) => !error.message.includes('sensitive-token')
        && error.message.includes('401'),
    );
  } finally {
    axios.defaults.adapter = originalAdapter;
  }
  assert.equal(calls, 1);
});

test('each team member routes through its selected connection and keeps the same budget task', async () => {
  const selected: string[][] = [];
  const settings = {
    getLlmConfig: async (owner: string, connectionId?: string) => {
      selected.push([owner, connectionId ?? 'default']);
      return { source: 'user', baseUrl: 'https://api.openai.com/v1',
        fastModel: `fast-${connectionId}`, slowModel: `slow-${connectionId}`, apiKey: `key-${connectionId}` };
    },
  };
  const budget = budgetStub();
  const reserved: unknown[] = [];
  const reserve = budget.reserve.bind(budget);
  budget.reserve = async (...args) => { reserved.push(args); return reserve(...args); };
  const service = new LlmService(settings as SettingsService, budget);
  const originalAdapter = axios.defaults.adapter;
  const sent: Array<{ model: string; key: string }> = [];
  axios.defaults.adapter = async config => {
    sent.push({ model: JSON.parse(String(config.data)).model, key: String(config.headers.Authorization) });
    return { data: { choices: [{ message: { content: 'OK' } }] }, status: 200, statusText: 'OK', headers: {}, config };
  };
  try {
    await service.chatFast([{ role: 'user', content: 'Research' }], 'alice',
      { connectionId: 'value-model', taskId: 'shared-room' });
    await service.chatSlow([{ role: 'user', content: 'Challenge' }], 'alice',
      { connectionId: 'risk-model', taskId: 'shared-room' });
  } finally { axios.defaults.adapter = originalAdapter; }
  assert.deepEqual(selected, [['alice', 'value-model'], ['alice', 'risk-model']]);
  assert.deepEqual(sent, [{ model: 'fast-value-model', key: 'Bearer key-value-model' },
    { model: 'slow-risk-model', key: 'Bearer key-risk-model' }]);
  assert.equal(reserved.length, 2);
  assert.ok(reserved.every(args => JSON.stringify(args).includes('shared-room')));
});

test('a missing or foreign member connection stops before reservation or paid transport', async () => {
  const budget = budgetStub();
  let reservations = 0;
  budget.reserve = async () => { reservations++; throw new Error('must not reserve'); };
  const service = new LlmService({ getLlmConfig: async () => { throw new Error('Model connection not found'); } } as unknown as SettingsService, budget);
  await assert.rejects(() => service.chatFast([{ role: 'user', content: 'Research' }], 'alice',
    { connectionId: 'foreign-connection' }), /connection not found/);
  assert.equal(reservations, 0);
});

test('interactive research waits up to its bounded timeout but never retries an ambiguous billed failure', async () => {
  const settings = { getLlmConfig: async () => ({ source: 'user', baseUrl: 'https://api.openai.com/v1',
    fastModel: 'test', slowModel: 'test', apiKey: 'fixture' }) };
  const budget = budgetStub();
  let settlements = 0;
  budget.settle = async (...args) => { assert.equal(args[3], true); settlements++;
    return { inputTokens: 100, outputTokens: 900, chargedTokens: 1000, known: false }; };
  const service = new LlmService(settings as SettingsService, budget);
  const originalAdapter = axios.defaults.adapter;
  let calls = 0;
  axios.defaults.adapter = async config => {
    calls++; assert.equal(config.timeout, 120_000);
    throw new axios.AxiosError('fixture timeout must not be returned', 'ECONNABORTED', config);
  };
  try {
    await assert.rejects(() => service.chatFast([{ role: 'user', content: 'Research' }], 'alice',
      { retryPolicy: 'none', timeoutMs: 120_000, maxOutputTokens: 900 }), /LLM_REQUEST_TIMEOUT/);
  } finally { axios.defaults.adapter = originalAdapter; }
  assert.equal(calls, 1); assert.equal(settlements, 1);
});
