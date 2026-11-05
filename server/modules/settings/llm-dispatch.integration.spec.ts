import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import axios from 'axios';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { LlmService, jsonChatMessages } from '../multi-agent/llm.service';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { estimateInputTokens } from '../llm-budget/llm-budget.rules';
import type { SettingsService } from './settings.service';

test('dispatch follows reservation; failed callback cancels only unsubmitted usage and transport failure remains charged', {
  skip: !process.env.BUDGET_TEST_DATABASE_URL,
}, async () => {
  const namespace = `dispatch_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.BUDGET_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.BUDGET_TEST_DATABASE_URL!, { max: 2, onnotice: () => {}, connection: { search_path: namespace } });
  const original = axios.defaults.adapter;
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const file of ['01_schema.sql', '07_llm_budget.sql', '13_budget_toggle.sql']) await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    const owner = randomUUID();
    await client`INSERT INTO users(id, username, password_hash) VALUES (${owner}, 'dispatch-fixture', 'fixture')`;
    const budget = new LlmBudgetService(drizzle(client));
    const llm = new LlmService({ getLlmConfig: async () => ({ source: 'server', baseUrl: 'https://fixture.invalid',
      apiKey: 'fixture', fastModel: 'fixture', slowModel: 'fixture' }) } as unknown as SettingsService, budget);
    let calls = 0, dispatched = 0;
    const messages = [{ role: 'user' as const, content: 'Return JSON' }];
    axios.defaults.adapter = async config => {
      calls++; assert.equal(dispatched, 1);
      assert.deepEqual(JSON.parse(String(config.data)).messages, jsonChatMessages(messages));
      throw new Error('offline transport failure');
    };
    const onDispatch = async () => { assert.equal((await budget.getUsage(owner)).dayCalls, 1); dispatched++; };
    await assert.rejects(llm.chatFastJSON([{ role: 'user', content: 'x'.repeat(7000) }], owner,
      { onDispatch, retryPolicy: 'none' }), /budget/i);
    assert.equal(dispatched, 0); assert.equal(calls, 0);
    await assert.rejects(llm.chatFastJSON(messages, owner, { retryPolicy: 'none', onDispatch: async () => {
      assert.equal((await budget.getUsage(owner)).dayCalls, 1); throw new Error('revision changed');
    } }), /revision changed/);
    assert.equal(calls, 0); assert.equal((await budget.getUsage(owner)).dayCalls, 0);
    assert.equal((await budget.getUsage(owner)).dayTokens, 0);
    await assert.rejects(llm.chatFastJSON(messages, owner, { onDispatch, retryPolicy: 'none' }), /request failed/);
    assert.equal(dispatched, 1); assert.equal(calls, 1);
    const usage = await budget.getUsage(owner);
    assert.equal(usage.dayCalls, 1); assert.equal(usage.recent[0].status, 'failed_unknown');
    assert.equal(usage.recent[0].inputTokens, estimateInputTokens(jsonChatMessages(messages)));
    assert.ok(usage.dayTokens > 0);
  } finally { axios.defaults.adapter = original; await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});
