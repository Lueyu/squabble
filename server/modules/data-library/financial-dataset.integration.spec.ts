import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DataFinancialService } from './data-financial.service';
import { FinancialDatasetService } from './providers/financial-dataset.service';
import { DataDatasetService } from './data-dataset.service';
import { financialDataConnections } from '../../database/data-library.schema';
import { SettingsService } from '../settings/settings.service';
import type { QuoteService } from '../quote/quote.service';
import { FinnhubEvidenceService } from '../research-core/finnhub-evidence.service';
import { SecEvidenceService } from '../research-core/sec-evidence.service';

test('financial facade saves all provider rows with a bounded preview and rechecks disabled connections before publication', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'A disposable test database is required');
  const ns = `financial_dataset_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
  const beforeKey = process.env.SETTINGS_ENCRYPTION_KEY, beforeFetch = global.fetch;
  process.env.SETTINGS_ENCRYPTION_KEY = 'fictional-dataset-key-123456789';
  try {
    await admin.unsafe(`create schema ${ns}`);
    for (const name of ['50_data_library.sql', '51_browser_sources.sql', '54_research_artifacts.sql', '04_user_api_settings.sql']) await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    await client.unsafe('ALTER TABLE user_api_settings ADD COLUMN llm_route jsonb');
    const db = drizzle(client), owner = randomUUID(), quotes = { getQuote: async () => {
      throw new Error('Legacy quote provider must not run for dataset queries');
    } } as unknown as QuoteService;
    const settings = new SettingsService(db, quotes);
    const datasets = new DataDatasetService(db), advanced = new FinancialDatasetService(db);
    const facade = new DataFinancialService(db, settings, quotes, new FinnhubEvidenceService(settings), new SecEvidenceService(), advanced);
    await facade.save(owner, 'tushare', { apiKey: 'fictional-token' });
    let calls = 0, disableDuringFetch = false;
    global.fetch = async (_url, init) => {
      calls++; const payload = JSON.parse(String(init?.body));
      if (disableDuringFetch) await client`update financial_data_connections set enabled=false,updated_at=now() where owner=${owner} and provider='tushare'`;
      const rows = payload.params.offset === 0 ? Array.from({ length: 1000 }, (_, i) => ['000001.SZ', '20260101', String(i)]) : [['000001.SZ', '20260102', '1000']];
      return new Response(JSON.stringify({ code: 0, data: { fields: ['ts_code', 'trade_date', 'close'], items: rows } }));
    };
    const input = { provider: 'tushare' as const, operation: 'daily-history' as const, market: 'CN' as const, exchange: 'SZSE',
      symbol: '000001', from: '2026-01-01', to: '2026-02-01' };
    const result = await facade.query(owner, input);
    assert.equal(result.status, 'succeeded'); assert.equal(calls, 2);
    assert.equal(result.dataset?.rowCount, 1001); assert.equal(result.dataset?.sampleSize, 12);
    assert.equal(result.dataset?.truncated, true); assert.ok(result.libraryReference);
    assert.equal((await datasets.rows(owner, result.dataset!.datasetVersionId)).length, 1001);
    assert.ok(!JSON.stringify(result).includes('fictional-token'));
    const sourceCount = (await client`select count(*) n from data_library_sources`)[0].n;
    disableDuringFetch = true;
    const late = await facade.query(owner, input); assert.equal(late.status, 'failed');
    assert.equal((await client`select count(*) n from data_library_sources`)[0].n, sourceCount);
    assert.equal((await db.select().from(financialDataConnections))[0].enabled, false);
  } finally { global.fetch = beforeFetch; if (beforeKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = beforeKey;
    await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end(); }
});
