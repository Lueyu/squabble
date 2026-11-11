import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ToolBudgetService } from './tool-budget.service';

test('concurrent tool reservations subtract all in-flight quantities and unknown never refunds', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'Disposable database required');
  const ns = `tool_budget_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), runId = randomUUID(), stepId = randomUUID();
  const admin = postgres(url, { max: 1, onnotice: () => {} }), client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
  try {
    await admin.unsafe(`create schema ${ns}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/53_agent_tool_runtime.sql', 'utf8'));
    await client`insert into agent_runtime_runs(id,owner,identity_hash,identity,driver,frozen_input_hash,frozen_input_enc,policy)
      values(${runId},${owner},'identity','{}','controlled','hash','private',${JSON.stringify({ maxTools: 2 })}::jsonb)`;
    await client`insert into agent_runtime_steps(id,owner,run_id,step_index,dispatch_key,request_hash,request_enc,model)
      values(${stepId},${owner},${runId},0,'dispatch','hash','private','fake')`;
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) await client`insert into agent_tool_invocations(id,owner,run_id,step_id,tool_call_id,tool_id,catalog_version_id,arguments_hash,arguments_enc)
      values(${id},${owner},${runId},${stepId},${id},'fake','v1','hash','private')`;
    const budgets = new ToolBudgetService(drizzle(client));
    const attempts = await Promise.allSettled(ids.map(id => budgets.reserve(owner, runId, id, { quantity: 2, unit: 'calls', priceVersion: 'unpriced' })));
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
    const index = attempts.findIndex(item => item.status === 'fulfilled'), invocationId = ids[index];
    const one = await budgets.reserve(owner, runId, invocationId, { quantity: 2, unit: 'calls', priceVersion: 'unpriced' });
    await budgets.markUnknown(owner, invocationId);
    await assert.rejects(budgets.reserve(owner, runId, ids[1 - index], { quantity: 1, unit: 'calls', priceVersion: 'unpriced' }), /BUDGET_EXHAUSTED/);
    await assert.rejects(budgets.reserve(owner, runId, invocationId, { quantity: 1, unit: 'calls', priceVersion: 'unpriced' }), /RESERVATION_CONFLICT/);
    await assert.rejects(budgets.settle(randomUUID(), invocationId, 1), /NOT_FOUND/);
    await budgets.settle(owner, invocationId, 1);
    const two = await budgets.reserve(owner, runId, ids[1 - index], { quantity: 1, unit: 'calls', priceVersion: 'unpriced' });
    assert.notEqual(one.id, two.id);
    await budgets.settle(owner, invocationId, 1);
    const rows = await client`select * from agent_tool_budget_reservations where owner=${owner}`;
    assert.equal(rows.length, 2);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.actual_amount ?? row.amount), 0), 2);
  } finally { await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end(); }
});
