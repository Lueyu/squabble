import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import axios from 'axios';
import { users } from '../../database/schema';
import { ModelConnectionsService } from './model-connections.service';
import { ModelConnectionsController } from './model-connections.controller';
import { SettingsService } from './settings.service';
import { LlmService } from '../research-core/llm.service';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';

const url = process.env.BUDGET_TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;
const client = url ? postgres(url, { max: 3, onnotice: () => undefined }) : null;
const db = client ? drizzle(client) : null;
const owner = randomUUID();
const other = randomUUID();
const beforeSecret = process.env.SETTINGS_ENCRYPTION_KEY;
const draft = { name: 'Research model', baseUrl: 'https://api.deepseek.com',
  fastModel: 'deepseek-flash', slowModel: 'deepseek-v4-pro', apiKey: 'fixture-secret-never-exposed' };
let service: ModelConnectionsService;
before(async () => {
  if (!client) return;
  process.env.SETTINGS_ENCRYPTION_KEY = 'test-model-connections-master-key-2026';
  await client.unsafe(readFileSync('scripts/db/10_model_connections.sql', 'utf8'));
  await client.unsafe(readFileSync('scripts/db/70_model_connection_tests.sql', 'utf8'));
  await db.insert(users).values([{ id: owner, username: owner.slice(0, 32), passwordHash: 'test' },
    { id: other, username: other.slice(0, 32), passwordHash: 'test' }]);
  service = new ModelConnectionsService(db);
});
after(async () => {
  if (!client) return;
  await db.delete(users).where(eq(users.id, owner));
  await db.delete(users).where(eq(users.id, other));
  await client.end();
  if (beforeSecret === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
  else process.env.SETTINGS_ENCRYPTION_KEY = beforeSecret;
});

dbTest('named model connections encrypt credentials and isolate all CRUD/resolution by owner', async () => {
  const created = await service.save(owner, draft);
  assert.equal(created.name, draft.name);
  assert.equal(created.available, true);
  assert.ok(!JSON.stringify(created).includes(draft.apiKey));
  assert.deepEqual(await service.list(other), []);
  assert.equal((await service.resolve(owner, created.id)).apiKey, draft.apiKey);
  for (const operation of [() => service.resolve(other, created.id),
    () => service.save(other, draft, created.id), () => service.remove(other, created.id)]) {
    await assert.rejects(operation, /not found/i);
  }
  const [stored] = await client`select api_key_enc from model_connections where id=${created.id}`;
  assert.ok(stored.api_key_enc.startsWith('v1:'));
  assert.ok(!stored.api_key_enc.includes(draft.apiKey));
  await service.remove(owner, created.id);
  await assert.rejects(() => service.resolve(owner, created.id), /not found/i);
});

dbTest('editing a model keeps its key on the same endpoint, but cannot forward it to a changed endpoint', async () => {
  const created = await service.save(owner, draft);
  await service.save(owner, { ...draft, apiKey: '', name: 'Updated model' }, created.id);
  assert.equal((await service.resolve(owner, created.id)).apiKey, draft.apiKey);
  await assert.rejects(() => service.save(owner, { ...draft, apiKey: '', baseUrl: 'https://api.openai.com/v1' }, created.id), /new API key/i);
  await assert.rejects(() => service.save(owner, { ...draft, baseUrl: 'http://127.0.0.1:3000' }), /HTTPS|public/i);
  await service.remove(owner, created.id);
});

dbTest('lost encryption keys produce explicit re-entry state and never fallback to another connection', async () => {
  const created = await service.save(owner, draft);
  const old = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = 'different-model-connection-master-key';
  try {
    const found = (await service.list(owner)).find(item => item.id === created.id);
    assert.equal(found.available, false);
    assert.equal(found.needsReentry, true);
    await assert.rejects(() => service.resolve(owner, created.id), /re-enter/i);
  } finally { process.env.SETTINGS_ENCRYPTION_KEY = old; }
  await service.remove(owner, created.id);
});

dbTest('concurrent connection creation cannot exceed the per-user limit', async () => {
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
    service.save(owner, { ...draft, name: `Connection ${index + 1}` })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 8);
  assert.equal((await service.list(owner)).length, 8);
  assert.equal((await service.list(other)).length, 0);
  for (const result of results) {
    if (result.status === 'fulfilled') await service.remove(owner, result.value.id);
    else assert.match(result.reason.message, /eight/i);
  }
});

dbTest('the budgeted provider response persists current test evidence across re-reads and rejects an edited attempt', async () => {
  const created = await service.save(owner, { ...draft, baseUrl: 'https://8.8.8.8/v1' });
  const controller = new ModelConnectionsController(service, new LlmService(
    new SettingsService(db, {} as never, service), new LlmBudgetService(db),
  ));
  const request = { userContext: { userId: owner } } as never;
  const original = axios.defaults.adapter;
  let calls = 0;
  let status = 503;
  let editDuringTest = false;
  axios.defaults.adapter = async config => {
    calls++;
    assert.equal(config.url, 'https://8.8.8.8/v1/chat/completions');
    assert.equal(JSON.parse(String(config.data)).model, draft.fastModel);
    if (editDuringTest) await service.save(owner, { ...draft, baseUrl: created.baseUrl, fastModel: 'updated', apiKey: '' }, created.id);
    return { status, statusText: '', headers: {}, config, data: status === 200 ? {
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    } : {} };
  };
  const current = async () => (await new ModelConnectionsService(db).list(owner)).find(row => row.id === created.id);
  try {
    assert.equal((await current())?.testState, undefined);
    await assert.rejects(controller.test({ userContext: { userId: other } } as never, created.id), /not found/i);
    assert.equal(calls, 0);
    assert.equal((await controller.test(request, created.id, { language: 'zh-CN' })).ok, false);
    assert.equal(calls, 1);
    assert.equal((await current())?.testState, 'failed');
    assert.equal((await current())?.testedAt, undefined);
    status = 200;
    assert.equal((await controller.test(request, created.id)).ok, true);
    assert.equal(calls, 2);
    const tested = await current();
    assert.equal(tested?.testState, 'passed');
    assert.ok(tested?.testedAt);
    assert.ok(!JSON.stringify(tested).includes(draft.apiKey));
    await service.save(owner, { ...draft, baseUrl: created.baseUrl, name: 'Renamed', apiKey: '' }, created.id);
    assert.equal((await current())?.testedAt, tested.testedAt);

    editDuringTest = true;
    assert.equal((await controller.test(request, created.id)).ok, false);
    assert.equal(calls, 3);
    assert.equal((await current())?.testState, undefined);
  } finally {
    axios.defaults.adapter = original;
    await service.remove(owner, created.id);
  }
});

dbTest('malformed key values cannot be treated as a request to retain a credential', async () => {
  const created = await service.save(owner, draft);
  try {
    for (const value of [0, false, null, {}, []]) {
      await assert.rejects(() => service.save(owner, { ...draft, apiKey: value as unknown as string }, created.id), /API key/i);
    }
    assert.equal((await service.resolve(owner, created.id)).apiKey, draft.apiKey);
  } finally { await service.remove(owner, created.id); }
});
