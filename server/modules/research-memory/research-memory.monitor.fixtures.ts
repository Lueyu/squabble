import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from '../../common/platform';
import { DEFAULT_STRATEGY_AUTOMATION } from '@shared/strategy.interface';
import { createDatabase } from '../../common/platform/database.provider';
import { councilReports, councilSessions } from '../../database/council.schema';
import { builderProfiles, paperAccounts } from '../../database/schema';
import { ResearchMemoryService } from './research-memory.service';
import { ResearchMonitorService } from './research-memory.monitor.service';
import { QuoteService } from '../quote/quote.service';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';
import { captureStrategyMemory, strategyMemoryBlock } from './research-memory.dependencies';
import { lockMemoryOwner } from './research-memory.fence';
import type { TradingMarketSnapshot } from '@shared/trading-market.interface';
import type { MonitorCondition } from '@shared/research-monitor.interface';

export async function seedMonitor(db: PostgresJsDatabase, owner: string) {
  const now = new Date();
  const condition: MonitorCondition = { conditionIndex: 0, metric: 'price', unit: 'USD', operator: 'lt', threshold: 90,
    validFrom: new Date(now.getTime() - 86400000).toISOString(), validUntil: new Date(now.getTime() + 86400000).toISOString(),
    evidenceIds: ['quote'], rationale: 'Support below USD90 invalidates the claim' };
  const content = { claim: 'Price support holds', supportingEvidence: [{ evidenceId: 'quote' }], opposingEvidence: [], assumptions: [],
    indicators: [], invalidationConditions: ['Price below USD90'], monitorConditions: [condition] };
  const [session] = await db.insert(councilSessions).values({ owner, ticker: 'AAPL', profileVersion: 1, profileSnapshot: {} as never,
    status: 'completed', language: 'en' }).returning();
  const [report] = await db.insert(councilReports).values({ owner, sessionId: session.id, version: 1, revision: 1,
    createdAt: now,
    publicationOutcome: 'succeeded', decision: 'wait', summary: 'Support fixture', dissent: [], nextReviewCondition: '', engine: 'llm',
    thesisCandidates: [content], evidence: [{ id: 'quote', title: 'Price source', sourceUrl: 'https://example.test/quote',
      content: 'USD100', fetchedAt: now.toISOString() }] }).returning();
  const memory = new ResearchMemoryService(db, new QuoteService(db, undefined as never));
  const archived = await memory.archiveReport(owner, { sessionId: session.id, ticker: 'AAPL', language: 'en',
    report: { ...report, createdAt: report.createdAt.toISOString() } });
  const candidate = (await memory.list(owner, { ticker: 'AAPL' })).theses[0];
  const thesis = await memory.updateThesis(owner, candidate.id, { expectedVersion: 1, action: 'confirm' });
  const config = normalizeBuilderConfig({ name: 'Fixture', template: 'balanced', tickers: ['AAPL'], language: 'en', minimumRating: 'Buy',
    customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 20, maxOrdersPerDay: 20,
    notifyOnProposal: true, council: { enabled: true, members: [
      { id: 'researcher', role: 'researcher', name: 'R', instructions: '', model: 'fast' },
      { id: 'manager', role: 'manager', name: 'M', instructions: '', model: 'slow' },
    ] }, automation: { ...DEFAULT_STRATEGY_AUTOMATION, enabled: true } });
  const [profile] = await db.insert(builderProfiles).values({ owner, config, status: 'active' }).returning();
  const [account] = await db.insert(paperAccounts).values({ owner, botEnabled: true }).returning();
  const inventory = await db.transaction(async tx => { await lockMemoryOwner(tx, owner); return captureStrategyMemory(tx, owner, [report.id]); });
  const snapshot = (price: number): TradingMarketSnapshot => ({ ticker: 'AAPL', providerSymbol: 'AAPL', market: 'US', currency: 'USD',
    quoteUsable: true, quoteReason: null, usable: true, reason: null, source: 'yahoo-chart', sourceUrl: 'https://example.test/quote',
    fetchedAt: now.toISOString(), quoteTimestamp: now.toISOString(), price, delay: 'possibly-delayed', maxQuoteAgeSeconds: 1200,
    timeframe: '1d', candles: [], indicators: { sma20: 100, sma50: 101, rsi14: 40, atr14: 2, volumeRatio: 1,
      asOf: new Date(now.getTime() - 86400000).toISOString(), sampleSize: 60, timeframe: '1d' }, schedule: null });
  const gate = () => db.transaction(async tx => { await lockMemoryOwner(tx, owner); return strategyMemoryBlock(tx, owner, inventory); });
  return { memory, monitor: new ResearchMonitorService(db), thesis, report, session, profile, account, inventory, snapshot, gate, condition, memoryId: archived!.id };
}

export async function monitorFixture(run: (db: PostgresJsDatabase, client: postgres.Sql, owner: string) => Promise<void>) {
  const namespace = `monitor_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.MEMORY_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const client = postgres(process.env.MEMORY_TEST_DATABASE_URL!, { max: 10, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    const url = new URL(process.env.MEMORY_TEST_DATABASE_URL!); url.searchParams.set('search_path', namespace);
    url.searchParams.set('client_min_messages', 'error');
    const started = await createDatabase(url.toString());
    await (started as typeof started & { $client: postgres.Sql }).$client.end();
    await run(drizzle(client), client, randomUUID());
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
}
