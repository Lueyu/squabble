import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { RuntimeDispatchService } from './runtime-dispatch.service';

test('paid dispatch keys reserve once, reject changed requests and keep ambiguous charges', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'Disposable database required');
  const ns = `dispatch_${randomUUID().replaceAll('-', '')}`, owner = randomUUID();
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 6, onnotice: () => {}, connection: { search_path: ns } });
  try {
    await admin.unsafe(`create schema ${ns}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/53_agent_tool_runtime.sql', 'utf8'));
    await client`insert into users(id,username,password_hash) values(${owner},${owner.slice(0, 20)},'fixture')`;
    const service = new LlmBudgetService(drizzle(client));
    const request = { taskId: 'research', model: 'fake', dispatchKey: 'run:step:0', requestHash: 'exact-hash',
      messages: [{ role: 'user', content: 'facts' }], maxOutputTokens: 20 };
    const reservations = await Promise.all([service.reserve(owner, request), service.reserve(owner, request)]);
    assert.equal(reservations[0].id, reservations[1].id);
    assert.equal((await service.getUsage(owner)).dayCalls, 1);
    await assert.rejects(service.reserve(owner, { ...request, requestHash: 'changed' }), /DISPATCH_CONFLICT/);
    await service.settle(owner, reservations[0].id, undefined, true);
    const oldCharge = (await service.getUsage(owner)).dayTokens;
    assert.ok(oldCharge > 0);
    await service.reserve(owner, { ...request, dispatchKey: 'run:step:1' });
    assert.equal((await service.getUsage(owner)).dayCalls, 2);
    await service.saveSettings(owner, { ...await service.getSettings(owner), maxOutputTokens: 10 });
    await assert.rejects(service.reserve(owner, { ...request, dispatchKey: 'run:step:2' }), /OUTPUT_LIMIT_CHANGED/);
    assert.equal((await service.getUsage(owner)).dayCalls, 2);
    assert.ok((await service.getUsage(owner)).dayTokens > oldCharge);
    await service.reconcileDispatchUsage(owner, reservations[0].id, 'provider-fact-1', { prompt_tokens: 2, completion_tokens: 3 });
    await service.reconcileDispatchUsage(owner, reservations[0].id, 'provider-fact-1', { prompt_tokens: 2, completion_tokens: 3 });
    const facts = await client`select * from agent_model_usage_corrections where owner=${owner}`;
    assert.equal(facts.length, 1);
    assert.equal(facts[0].prior_status, 'failed_unknown');
    assert.equal((await service.getUsage(owner)).dayCalls, 2);
    const totalReceipt = await service.reserve(owner, { ...request, dispatchKey: 'reasoning-total', maxOutputTokens: 10 });
    await new RuntimeDispatchService(service, drizzle(client)).settle(owner, totalReceipt.id,
      { inputTokens: 100, outputTokens: 100, totalTokens: 1000 });
    const [totalUsage] = await client`select charged_tokens from llm_budget_usage where id=${totalReceipt.id}`;
    assert.equal(totalUsage.charged_tokens, 1000, 'reasoning tokens reported only in total remain charged');
  } finally {
    await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end();
  }
});
