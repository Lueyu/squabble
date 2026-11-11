import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { AiSdkModelAdapter } from '../research-core/ai-sdk-model.adapter';
import { ModelStepService } from '../research-core/model-step.service';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { RuntimeDispatchService } from './runtime-dispatch.service';
import { RuntimeJournalService } from './runtime-journal.service';
import { RuntimeInvocationsService } from './runtime-invocations.service';
import { ModelCapabilityService } from './model-capability.service';

test('explicit tool compatibility probe costs two requests; lost-response replay and reads spend none', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'Disposable database required');
  const ns = `capability_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), requestKey = randomUUID();
  const admin = postgres(url, { max: 1, onnotice: () => {} }), client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
  let requests = 0;
  const transport: typeof fetch = async (_input, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    const nonce = JSON.stringify(body.messages).match(/nonce ([a-f0-9]{24})/u)?.[1];
    assert.ok(nonce);
    const message = requests === 1 ? { role: 'assistant', content: null,
      tool_calls: [{ id: 'echo-1', type: 'function', function: { name: 'capability_echo', arguments: JSON.stringify({ nonce }) } }] }
      : { role: 'assistant', content: nonce };
    return new Response(JSON.stringify({ id: `probe-${requests}`, model: 'fixture', created: 1,
      choices: [{ index: 0, message, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await admin.unsafe(`create schema ${ns}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/53_agent_tool_runtime.sql', 'utf8'));
    await client`insert into users(id,username,password_hash) values(${owner},${owner.slice(0,20)},'fixture')`;
    const db = drizzle(client), budget = new LlmBudgetService(db);
    const model = new ModelStepService({ getLlmConfig: async () => ({ source: 'user', baseUrl: 'https://fixture.example/api', fastModel: 'fixture', slowModel: 'fixture', apiKey: 'fake-test-key' }) }, new AiSdkModelAdapter(transport));
    const service = new ModelCapabilityService(db, model, new RuntimeJournalService(db, 'capability-test-secret-key'),
      new RuntimeDispatchService(budget, db), new RuntimeInvocationsService(db, 'capability-test-secret-key'));
    assert.equal(await service.enabled(owner, undefined, 'fast'), false);
    assert.equal((await service.list(owner)).length, 0); assert.equal(requests, 0);
    const first = await service.probe(owner, { requestKey, tier: 'fast', enable: true });
    assert.equal(first.supported, true); assert.equal(requests, 2);
    const replay = await service.probe(owner, { requestKey, tier: 'fast', enable: true });
    assert.equal(replay.runId, first.runId); assert.equal(requests, 2);
    assert.equal(await service.enabled(owner, undefined, 'fast'), true);
    await service.disable(owner, ''); assert.equal(await service.enabled(owner, undefined, 'fast'), false);
    assert.equal(await service.driver(owner, ''), 'controlled');
    await service.setDriver(owner, { connectionId: '', driver: 'deep_agents' });
    assert.equal(await service.driver(owner, ''), 'deep_agents');
    assert.equal(await service.driver(randomUUID(), ''), 'controlled');
    assert.equal(requests, 2, 'changing a driver preference never starts a model request');
    assert.equal((await budget.getUsage(owner)).dayCalls, 2);
  } finally { await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end(); }
});
