import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { telemetrySpans } from '../../database/telemetry.schema';
import { TelemetryCaptureService } from './telemetry-capture.service';
import type { TelemetrySpanRecord } from '../../../shared/telemetry.interface';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { DEFAULT_LLM_BUDGET } from '../llm-budget/llm-budget.rules';

test('durable capture keeps owner-scoped idempotent terminal records across recreation', async () => {
  const url = process.env.TELEMETRY_TEST_DATABASE_URL ?? process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url, 'Disposable TELEMETRY_TEST_DATABASE_URL or RESEARCH_TEST_DATABASE_URL required');
  const namespace = `telemetry_capture_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  const client = postgres(url, { max: 2, onnotice: () => undefined, connection: { search_path: namespace } });
  const db = drizzle(client);
  const record: TelemetrySpanRecord = { id: 'attempt', runId: 'model:task', sourceId: 'task', parentId: null,
    kind: 'model', name: 'model-attempt', title: 'Model call', scene: 'analysis', status: 'running',
    agentId: null, agentName: null, provider: 'https://fixture.invalid', model: null, executionMode: 'api',
    startedAt: '2026-11-11T01:00:00.000Z', completedAt: null, durationMs: null,
    inputTokens: null, outputTokens: null, totalTokens: null, estimatedCostUsd: null, errorCode: null, attempt: 1, traceId: null };
  const capture = new TelemetryCaptureService(db, { export: () => undefined });
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    await client.unsafe(readFileSync('scripts/db/52_agent_telemetry.sql', 'utf8'));
    capture.recordSpan('owner-a', record);
    capture.recordSpan('owner-a', { ...record, status: 'completed', model: 'actual-model',
      completedAt: '2026-11-11T01:00:00.100Z', inputTokens: 2, outputTokens: 3, totalTokens: 5, estimatedCostUsd: 0.005 });
    await capture.flush();
    await capture.onModuleDestroy();
    const resumed = new TelemetryCaptureService(db, { export: () => undefined });
    resumed.recordSpan('owner-a', record);
    resumed.recordSpan('owner-b', record);
    await resumed.flush();
    const rows = await db.select().from(telemetrySpans);
    assert.equal(rows.length, 2);
    const completed = rows.find(row => row.owner === 'owner-a');
    assert.equal(completed?.status, 'completed', 'late running replay must not regress a durable terminal result');
    assert.equal(completed?.totalTokens, 5);
    assert.equal(Number(completed?.estimatedCostUsd), 0.005);
    assert.equal(completed?.model, 'actual-model');
    assert.equal(rows.find(row => row.owner === 'owner-b')?.totalTokens, null);
    assert.notEqual(completed?.traceId, rows.find(row => row.owner === 'owner-b')?.traceId);
    assert.equal(resumed.getCaptureHealth('owner-a').incomplete, false);
    await client.unsafe('CREATE TABLE users(id uuid PRIMARY KEY)');
    await client.unsafe(readFileSync('scripts/db/07_llm_budget.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/13_budget_toggle.sql', 'utf8'));
    const owner = randomUUID();
    await client`INSERT INTO users(id) VALUES(${owner})`;
    const budgets = new LlmBudgetService(db);
    await budgets.saveSettings(owner, { ...DEFAULT_LLM_BUDGET, inputUsdPerMillion: 2, outputUsdPerMillion: 5 });
    const reserved = await budgets.reserve(owner, { model: 'fixture', messages: [{ role: 'user', content: 'fictional' }] },
      async () => { await budgets.saveSettings(owner, { ...DEFAULT_LLM_BUDGET, inputUsdPerMillion: 20, outputUsdPerMillion: 50 }); });
    assert.deepEqual(reserved.estimateRates, { inputUsdPerMillion: 2, outputUsdPerMillion: 5 }, 'reservation retains pre-dispatch rate snapshot');
    const next = await budgets.reserve(owner, { model: 'fixture', messages: [{ role: 'user', content: 'fictional' }] });
    assert.deepEqual(next.estimateRates, { inputUsdPerMillion: 20, outputUsdPerMillion: 50 });
    await budgets.saveSettings(owner, { ...DEFAULT_LLM_BUDGET, enabled: false, inputUsdPerMillion: 20, outputUsdPerMillion: 50 });
    const disabled = await budgets.reserve(owner, { model: 'fixture', messages: [{ role: 'user', content: 'fictional' }] });
    assert.equal(disabled.estimateRates, undefined);
    await resumed.onModuleDestroy();
  } finally {
    await capture.onModuleDestroy();
    await client.end();
    await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
