import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { builderProfiles, paperAccounts, paperOrders, paperPositions } from '../../database/schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import { BuilderCadenceService } from './builder-cadence.service';
import { PaperTradingService } from './paper-trading.service';
import { normalizeBuilderConfig } from './agent-builder.rules';
import type { BuilderProfile } from '../../../shared/api.interface';

test('persisted scans and final execution enforce cadence and consume only current council approvals', {
  skip: !process.env.COUNCIL_TEST_DATABASE_URL,
}, async (t) => {
  const client = postgres(process.env.COUNCIL_TEST_DATABASE_URL!, { max: 8, onnotice: () => {} });
  const db = drizzle(client);
  const owner = randomUUID();
  const owners = [owner];
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-30T14:00:00Z') });
  try {
    for (const file of ['03_agent_builder.sql', '08_investment_council.sql', '09_builder_cadence.sql', '12_council_dialogue.sql', '21_research_archive_jobs.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    }
    const config = normalizeBuilderConfig({ name: 'Execution test', template: 'balanced', tickers: [],
      minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3,
      maxOrdersPerDay: 5, notifyOnProposal: false });
    const [profileRow] = await db.insert(builderProfiles).values({ owner, config, status: 'active' }).returning();
    const profile: BuilderProfile = { ...profileRow, status: 'active', config,
      createdAt: profileRow.createdAt.toISOString(), updatedAt: profileRow.updatedAt.toISOString() };
    const [account] = await db.insert(paperAccounts).values({ owner, initialCash: '10000', cashBalance: '10000',
      botEnabled: true, guardrails: config }).returning();
    const cadence = new BuilderCadenceService(db);
    const replica = new BuilderCadenceService(db);
    const leases = await Promise.all([cadence.claimScan(owner), replica.claimScan(owner)]);
    assert.equal(leases.filter(Boolean).length, 1, 'only one server can scan an account');
    await cadence.releaseScan(owner, leases.find(Boolean)!);
    const reservations = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      (i % 2 ? cadence : replica).claimReview(owner, profile, 'AAPL', 'US', 'unchanged')));
    assert.equal(reservations.filter(Boolean).length, 1, 'declined and pending ideas also reserve the review slot');
    await cadence.finishReview(owner, profile.id, 'AAPL', 'wait', 'Not enough evidence');
    assert.equal(await replica.claimReview(owner, profile, 'AAPL', 'US', 'new-data'), false);

    const service = new PaperTradingService(db, { getQuote: async () => ({ price: '10', market: 'US', currency: 'USD', timestamp: Date.now() }) } as never,
      { convert: async () => 1 } as never, { notifyUser: async () => {} } as never, {} as never, cadence, {} as never);
    Reflect.set(service, 'equityOf', async () => 10000);
    Reflect.set(service, 'dayStartEquity', async () => 10000);
    await assert.rejects(service.placeOrder(owner, { ticker: 'AAPL', side: 'buy', quantity: 1 },
      'agent', undefined, true, true), /active Builder scan/, 'external agents cannot bypass the configured team');
    const orders = await Promise.all(['AAPL', 'MSFT', 'NVDA'].map((ticker) => service.placeOrder(owner,
      { ticker, side: 'buy', quantity: 1 }, 'agent', undefined, true, true, profile)));
    assert.equal(orders.filter((order) => order.status === 'filled').length, 2);
    assert.equal(orders.filter((order) => order.status === 'rejected_risk').length, 1);
    const [balance] = await db.select().from(paperAccounts).where(eq(paperAccounts.id, account.id));
    assert.equal(Number(balance.cashBalance), 9980);
    assert.equal((await db.select().from(paperPositions).where(eq(paperPositions.owner, owner))).length, 2);

    // A separate investor's fresh council account isolates approval behavior from weekly limits.
    const councilOwner = randomUUID(); owners.push(councilOwner);
    const councilConfig = { ...config, council: { ...config.council!, enabled: true } };
    const [row] = await db.insert(builderProfiles).values({ owner: councilOwner, config: councilConfig, status: 'active' }).returning();
    const team: BuilderProfile = { ...profile, ...row, config: councilConfig, status: 'active',
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
    await db.insert(paperAccounts).values({ owner: councilOwner, initialCash: '10000', cashBalance: '10000', botEnabled: true, guardrails: config });
    const candidate = { ticker: 'AAPL', side: 'buy' as const, quantity: 1, price: 10, reason: 'Verified candidate' };
    const [session] = await db.insert(councilSessions).values({ owner: councilOwner, profileId: team.id, profileVersion: team.version,
      profileSnapshot: councilConfig, ticker: 'AAPL', status: 'completed', revision: 2, candidate }).returning();
    const [report] = await db.insert(councilReports).values({ owner: councilOwner, sessionId: session.id, version: 1,
      revision: 1, decision: 'approve', summary: 'Reviewed', dissent: [], nextReviewCondition: 'New evidence',
      evidence: [], candidate, tokensUsed: 100, engine: 'llm', createdAt: new Date() }).returning();
    const authorization = { sessionId: session.id, reportId: report.id, candidate };
    await assert.rejects(service.placeOrder(councilOwner, candidate, 'agent', undefined, true, true, team, authorization), /obsolete/);
    await db.update(councilReports).set({ revision: 2 }).where(eq(councilReports.id, report.id));
    const simultaneous = await Promise.allSettled([1, 2].map(() =>
      service.placeOrder(councilOwner, candidate, 'agent', undefined, true, true, team, authorization)));
    assert.equal(simultaneous.filter((result) => result.status === 'fulfilled').length, 1);
    const succeeded = simultaneous.find((result) => result.status === 'fulfilled');
    assert.ok(succeeded?.status === 'fulfilled');
    const filled = succeeded.value;
    assert.equal(filled.status, 'filled');
    assert.equal((await db.select().from(councilReports).where(eq(councilReports.id, report.id)))[0].paperOrderId, filled.id);
    await assert.rejects(service.placeOrder(councilOwner, candidate, 'agent', undefined, true, true, team, authorization), /already used/);
    assert.equal((await db.select().from(paperOrders).where(eq(paperOrders.owner, councilOwner))).length, 1);
    const pendingOwner = randomUUID(); owners.push(pendingOwner);
    const [pendingAccount] = await db.insert(paperAccounts).values({ owner: pendingOwner, initialCash: '10000', cashBalance: '10000',
      botEnabled: true, guardrails: config }).returning();
    await db.insert(paperOrders).values(['MSFT', 'NVDA'].map((ticker) => ({ owner: pendingOwner, accountId: pendingAccount.id,
      ticker, side: 'buy', quantity: '1', source: 'agent', status: 'pending_approval',
      createdAt: new Date('2025-01-01'), riskCheck: { notionalUsd: 10 } })));
    const blocked = await service.placeOrder(pendingOwner, candidate, 'agent', undefined, true, true);
    assert.equal(blocked.status, 'rejected_risk', 'old pending orders still reserve automatic capacity');
    assert.match(blocked.reason ?? '', /weekly_order_cap/);
  } finally {
    for (const id of owners) {
      for (const table of ['council_reports', 'council_messages', 'council_sessions', 'builder_review_checks', 'builder_scan_leases',
        'builder_proposals', 'paper_trades', 'paper_orders', 'paper_positions', 'paper_events', 'paper_snapshots', 'paper_accounts', 'builder_profiles']) {
        await client.unsafe(`DELETE FROM ${table} WHERE owner = $1`, [id]);
      }
    }
    t.mock.timers.reset();
    await client.end();
  }
});
