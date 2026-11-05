import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModelRoute } from './model-route.rules';
import { SettingsService } from './settings.service';

test('model routes accept only strict Basic, API and validated local shapes', () => {
  assert.deepEqual(parseModelRoute({ mode: 'basic' }), { mode: 'basic' });
  assert.deepEqual(parseModelRoute({ mode: 'api' }), { mode: 'api' });
  assert.deepEqual(parseModelRoute({ mode: 'local', agentId: 'native-codex', agentSettings: { model: 'gpt-5', reasoningEffort: 'high' } }),
    { mode: 'local', agentId: 'native-codex', agentSettings: { model: 'gpt-5', reasoningEffort: 'high' } });
  for (const bad of [null, {}, { mode: 'basic', agentId: 'x' }, { mode: 'api', apiKey: 'secret' },
    { mode: 'local', agentId: '' }, { mode: 'local', agentId: 'native-codex', agentSettings: { model: '\n' } }]) {
    assert.throws(() => parseModelRoute(bad), /INVALID_MODEL_ROUTE|LOCAL_INVALID_CONFIGURATION/);
  }
});

test('settings persist a validated local default and report its availability', async () => {
  let row: Record<string, unknown> = {};
  const db = {
    select: () => ({ from: () => ({ where: async () => [row] }) }),
    insert: () => ({ values: (value: Record<string, unknown>) => ({ onConflictDoUpdate: async () => { row = { ...row, ...value }; } }) }),
  };
  const agents = { validate: async () => {}, status: async () => ({ items: [{ id: 'native-codex', connected: true, available: true }] }) };
  const service = new SettingsService(db as never, {} as never, undefined, { get: () => agents } as never);
  const route = { mode: 'local' as const, agentId: 'native-codex', agentSettings: { model: 'gpt-5' } };
  await service.saveLlmRoute('alice', route);
  assert.deepEqual(await service.getDefaultModelRoute('alice'), route);
  const settings = await service.getSettings('alice');
  assert.deepEqual(settings.llm.route, route);
  assert.equal(settings.llm.source, 'local');
  assert.equal(settings.llm.available, true);
});

test('selecting a local route retains the underlying API connection fields', async () => {
  const previous = { key: process.env.DOUBAO_API_KEY, fast: process.env.DOUBAO_MODEL_FAST, slow: process.env.DOUBAO_MODEL_SLOW };
  process.env.DOUBAO_API_KEY = 'server-test-key';
  process.env.DOUBAO_MODEL_FAST = 'api-fast';
  process.env.DOUBAO_MODEL_SLOW = 'api-slow';
  try {
    const row = { llmRoute: { mode: 'local', agentId: 'native-codex', agentSettings: { model: 'native-model' } } };
    const service = new SettingsService({ select: () => ({ from: () => ({ where: async () => [row] }) }) } as never,
      {} as never, undefined, { get: () => ({ validate: async () => {} }) } as never);
    const llm = (await service.getSettings('alice')).llm;
    assert.equal(llm.source, 'local');
    assert.equal(llm.fastModel, 'api-fast');
    assert.equal(llm.slowModel, 'api-slow');
    assert.equal(llm.hasApiKey, true);
  } finally {
    if (previous.key === undefined) delete process.env.DOUBAO_API_KEY; else process.env.DOUBAO_API_KEY = previous.key;
    if (previous.fast === undefined) delete process.env.DOUBAO_MODEL_FAST; else process.env.DOUBAO_MODEL_FAST = previous.fast;
    if (previous.slow === undefined) delete process.env.DOUBAO_MODEL_SLOW; else process.env.DOUBAO_MODEL_SLOW = previous.slow;
  }
});

test('API default cannot be saved without a readable API connection', async () => {
  const previous = process.env.DOUBAO_API_KEY;
  delete process.env.DOUBAO_API_KEY;
  let wrote = false;
  try {
    const service = new SettingsService({
      select: () => ({ from: () => ({ where: async () => [{}] }) }),
      insert: () => { wrote = true; throw new Error('Unexpected settings write'); },
    } as never, {} as never);
    await assert.rejects(() => service.saveLlmRoute('alice', { mode: 'api' }), /No LLM API key configured/);
    assert.equal(wrote, false);
  } finally {
    if (previous === undefined) delete process.env.DOUBAO_API_KEY;
    else process.env.DOUBAO_API_KEY = previous;
  }
});
