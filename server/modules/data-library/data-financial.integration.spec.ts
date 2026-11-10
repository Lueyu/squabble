import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { DataFinancialService } from './data-financial.service';
import { SettingsService } from '../settings/settings.service';
import type { QuoteService } from '../quote/quote.service';
import { FinnhubEvidenceService } from '../research-core/finnhub-evidence.service';
import { SecEvidenceService } from '../research-core/sec-evidence.service';
import { EvidenceService } from '../research-core/evidence.service';
import { financialDataConnections } from '../../database/data-library.schema';
import { userApiSettings } from '../../database/schema';
const databaseUrl = process.env.DATA_LIBRARY_TEST_DATABASE_URL ?? process.env.RESEARCH_TEST_DATABASE_URL;
test('financial connections preserve Finnhub credentials and consume owner-scoped Alpha settings in real query path', {
  skip: !databaseUrl,
}, async () => {
  const namespace = `data_financial_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
  const client = postgres(databaseUrl!, { max: 3, onnotice: () => {}, connection: { search_path: namespace } });
  const owner = randomUUID(), other = randomUUID(), previousKey = process.env.SETTINGS_ENCRYPTION_KEY, originalFetch = global.fetch;
  process.env.SETTINGS_ENCRYPTION_KEY = 'test-only-financial-secret-123456';
  try {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    await client.unsafe(readFileSync('scripts/db/50_data_library.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/04_user_api_settings.sql', 'utf8'));
    await client.unsafe('ALTER TABLE user_api_settings ADD COLUMN llm_route jsonb');
    const db = drizzle(client), quotes = { getQuote: async () => ({ price: '150', currency: 'USD', source: 'fixture', quoteAt: '2026-11-09T20:00:00.000Z' }) } as unknown as QuoteService;
    const settings = new SettingsService(db, quotes);
    const service = new DataFinancialService(db, settings, quotes, new FinnhubEvidenceService(settings), new SecEvidenceService());
    await settings.saveFinancial(owner, { provider: 'finnhub', apiKey: 'test-only-legacy-finnhub' });
    const [before] = await db.select().from(userApiSettings).where(eq(userApiSettings.owner, owner));
    assert.equal((await service.list(owner)).providers.find(p => p.provider === 'finnhub')?.configured, true);
    assert.equal((await service.list(other)).providers.find(p => p.provider === 'finnhub')?.configured, false);
    await service.save(owner, 'alpha-vantage', { apiKey: 'test-only-alpha-personal' });
    const list = await service.list(owner); assert.ok(!JSON.stringify(list).includes('test-only-alpha-personal'));
    const [stored] = await db.select().from(financialDataConnections).where(and(eq(financialDataConnections.owner, owner), eq(financialDataConnections.provider, 'alpha-vantage')));
    assert.ok(stored.secretEnc && !stored.secretEnc.includes('test-only-alpha-personal'));
    let requests = 0;
    global.fetch = async input => {
      requests++; const url = new URL(String(input));
      assert.equal(url.hostname, 'www.alphavantage.co'); assert.equal(url.searchParams.get('apikey'), 'test-only-alpha-personal');
      return new Response(JSON.stringify({ 'Global Quote': { '01. symbol': 'AAPL', '05. price': '150', '07. latest trading day': '2026-11-09' } }), { status: 200 });
    };
    const query = { provider: 'alpha-vantage' as const, symbol: 'AAPL', operation: 'quote' as const };
    const output = await service.query(owner, query);
    assert.equal(output.status, 'succeeded'); assert.equal(output.freshness, 'end-of-day'); assert.equal(output.asOf, '2026-11-09');
    assert.ok(!JSON.stringify(output).includes('test-only-alpha-personal')); assert.equal(requests, 1);
    assert.equal((await service.query(other, query)).errorCode, 'KEY_REQUIRED'); assert.equal(requests, 1);
    assert.equal((await service.query(owner, { ...query, operation: 'financials' })).errorCode, 'UNSUPPORTED_CAPABILITY');
    assert.equal((await service.test(owner, 'alpha-vantage')).ok, true);
    await service.save(owner, 'alpha-vantage', { enabled: false });
    assert.equal((await service.query(owner, query)).errorCode, 'PROVIDER_DISABLED');
    const [after] = await db.select().from(userApiSettings).where(eq(userApiSettings.owner, owner));
    assert.equal(after.finnhubApiKeyEnc, before.finnhubApiKeyEnc, 'new provider must not rewrite legacy Finnhub key');
    await service.save(owner, 'finnhub', { enabled: false });
    const legacyAdapter = new FinnhubEvidenceService(settings), callsBeforeDisable = requests;
    await assert.rejects(legacyAdapter.getFinancials(owner, 'AAPL'), /disabled/u);
    await assert.rejects(legacyAdapter.getNews(owner, 'AAPL'), /disabled/u);
    assert.equal(requests, callsBeforeDisable, 'legacy research cannot dispatch disabled provider requests');
    await service.save(owner, 'sec', { enabled: false });
    let secRequests = 0;
    const legacyEvidence = new EvidenceService(db, quotes, legacyAdapter, { getFinancials: async () => {
      secRequests++; throw new Error('Disabled SEC should never be called');
    } } as never, {} as never);
    const gaps = await legacyEvidence.collectResearch('AAPL', owner, 'financials', 'en', {});
    assert.equal(secRequests, 0); assert.ok(gaps.some(gap => /disabled/iu.test(gap.content)));
    await service.save(owner, 'finnhub', { enabled: true });
    assert.equal(await settings.getFinnhubKey(owner), 'test-only-legacy-finnhub');
    process.env.SETTINGS_ENCRYPTION_KEY = 'other-test-only-financial-secret';
    assert.equal((await service.list(owner)).providers.find(p => p.provider === 'alpha-vantage')?.needsReentry, true);
    assert.equal((await service.list(owner)).providers.find(p => p.provider === 'finnhub')?.needsReentry, true);
    process.env.SETTINGS_ENCRYPTION_KEY = 'test-only-financial-secret-123456';
    await service.remove(owner, 'alpha-vantage'); assert.equal((await service.query(owner, query)).errorCode, 'KEY_REQUIRED');
    const rates = new DataFinancialService(db, settings, quotes, new FinnhubEvidenceService(settings), new SecEvidenceService());
    for (let i = 0; i < 30; i++) assert.equal((await rates.query(owner, { provider: 'public', symbol: 'AAPL', operation: 'quote' })).status, 'succeeded');
    assert.equal((await rates.query(owner, { provider: 'public', symbol: 'AAPL', operation: 'quote' })).errorCode, 'QUERY_RATE_LIMITED');
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end();
  }
});
