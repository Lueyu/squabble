import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { holdings, paperAccounts } from '../../database/schema';
import { portfolioValuePoints } from '../../database/portfolio-value-points.schema';
import { paperEquityObservations } from '../../database/portfolio-observations.schema';
import { PortfolioHistoryHoldings } from './portfolio-history.holdings';
import { PortfolioHistoryService } from './portfolio-history.service';
import { PortfolioIntradayReferenceService } from './portfolio-intraday-reference.service';
import type { PortfolioHistoryCache } from './portfolio-history.cache';

test('retained owned quote facts densify a partial current-holdings reference without changing NAV or importing foreign facts', async () => {
  assert.ok(process.env.HISTORY_TEST_DATABASE_URL, 'A verified disposable HISTORY_TEST_DATABASE_URL is required');
  const namespace = `intraday_reference_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.HISTORY_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.HISTORY_TEST_DATABASE_URL!, { max: 3, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    const db = drizzle(client), owner = randomUUID(), foreign = randomUUID();
    await db.insert(holdings).values([
      { owner, ticker: 'FICT', market: 'US', currency: 'USD', shares: '2', currentPrice: '99' },
      { owner, ticker: 'UNAVAILABLE', market: 'US', currency: 'USD', shares: '1', currentPrice: '99' },
    ]);
    const [ownAccount, foreignAccount] = await db.insert(paperAccounts).values([{ owner }, { owner: foreign }]).returning();
    const quote = (price: number, quoteAt: string) => ({ ticker: 'FICT', market: 'US', currency: 'USD', price, quoteAt, source: 'fictional:quote' });
    const facts = [quote(10, '2026-11-10T15:00:00Z'), quote(11, '2026-11-10T15:05:00Z'), quote(12, '2026-11-10T16:00:00Z')];
    for (const [index, fact] of facts.entries()) await db.insert(portfolioValuePoints).values({ owner, dateKey: '2026-11-10', slot: `sample:${index}`,
      capturedAt: new Date(fact.quoteAt), knownValueUsd: '999999', complete: false, estimated: true,
      marketQuotes: [fact], sourceFingerprint: `source:${index}` });
    await db.insert(portfolioValuePoints).values({ owner: foreign, dateKey: '2026-11-10', slot: 'sample:foreign',
      capturedAt: new Date('2026-11-10T15:10:00Z'), knownValueUsd: '999999', complete: false, estimated: true,
      marketQuotes: [quote(999, '2026-11-10T15:10:00Z')], sourceFingerprint: 'foreign' });
    for (const [account, price] of [[ownAccount, 50], [foreignAccount, 900]] as const) await db.insert(paperEquityObservations).values({
      owner: account.owner, accountId: account.id, slot: 'sample:paper', dateKey: '2026-11-10', capturedAt: new Date('2026-11-10T15:15:00Z'),
      knownValueUsd: '999999', complete: false, estimated: true, marketQuotes: [quote(price, '2026-11-10T15:15:00Z')], sourceFingerprint: 'paper',
    });
    const reader = new PortfolioIntradayReferenceService(db);
    const from = new Date('2026-11-10T00:00:00Z'), at = new Date('2026-11-10T16:20:00Z');
    const realQuotes = await reader.read(owner, ['real'], from, at);
    assert.deepEqual(realQuotes.map(item => item.price).sort((a, b) => Number(a) - Number(b)), [10, 11, 12]);
    const paperQuotes = await reader.read(owner, [ownAccount.id], from, at);
    assert.deepEqual(paperQuotes.map(item => item.price), [50]);
    assert.deepEqual(await reader.read(owner, [foreignAccount.id], from, at), [], 'foreign account facts remain excluded even with its ID');
    const before = await db.select().from(portfolioValuePoints).where(eq(portfolioValuePoints.owner, owner));
    const cache = { read: async () => ({ prices: [], fx: [], refreshing: false, gaps: [] }), prefetch: async () => {} } as unknown as PortfolioHistoryCache;
    const history = new PortfolioHistoryService(new PortfolioHistoryHoldings(db), cache, reader);
    const view = await history.read(owner, '1D', 'real', at);
    assert.equal(view.priceBasis, 'provider_quote');
    assert.equal(view.intradayGranularity, 'observations');
    assert.deepEqual(view.series[0].points.map(point => point.knownValueUsd), [20, 22, 24], 'uses current quantities and price facts, never the stored known-NAV total');
    assert.ok(view.series[0].points.every(point => point.timestamp && point.valueUsd === null && point.coveredPositions === 1));
    const month = await history.read(owner, '1M', 'real', at);
    const timed = month.series[0].points.filter(point => point.timestamp);
    assert.equal(month.intradayGranularity, 'hourly');
    assert.deepEqual(timed.map(point => point.knownValueUsd), [22, 24]);
    assert.deepEqual(await db.select().from(portfolioValuePoints).where(eq(portfolioValuePoints.owner, owner)), before, 'reference reads do not write NAV');
  } finally {
    await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end();
  }
});
