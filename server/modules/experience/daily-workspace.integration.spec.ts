import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { paperAccounts, paperOrders, paperSnapshots, paperTrades } from '../../database/schema';
import { DailyWorkspaceService } from './daily-workspace.service';
import type { CurrentResearchService } from './current-research.service';

test('daily workspace isolates owners, uses actual fill time, retains all fills and performs no writes', {
  skip: !process.env.EXPERIENCE_TEST_DATABASE_URL,
}, async () => {
  const url = process.env.EXPERIENCE_TEST_DATABASE_URL!;
  const namespace = `daily_workspace_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const name of readdirSync('scripts/db').filter(name => /^\d\d_.*\.sql$/u.test(name) && !name.startsWith('02_') && ((Number(name.slice(0, 2)) <= 45 || name.startsWith('49_')) || name.startsWith('47_'))).sort()) {
      await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    }
    const db = drizzle(client), owner = randomUUID(), other = randomUUID();
    const createdAt = new Date('2026-11-09T01:00:00Z');
    const [account, foreign] = await db.insert(paperAccounts).values([
      { owner, name: 'Fictional A', createdAt }, { owner: other, name: 'Foreign account', createdAt },
    ]).returning();
    const [order, foreignOrder] = await db.insert(paperOrders).values([
      { owner, accountId: account.id, ticker: 'TEST', side: 'buy', quantity: '1', status: 'filled', currency: 'CNY', createdAt },
      { owner: other, accountId: foreign.id, ticker: 'PRIVATE', side: 'buy', quantity: '1', status: 'filled', createdAt },
    ]).returning();
    const fillAt = new Date('2026-11-10T02:00:00Z');
    await db.insert(paperTrades).values([
      ...Array.from({ length: 25 }, () => ({ owner, accountId: account.id, orderId: order.id, ticker: 'TEST', side: 'buy', quantity: '1', price: '10', fee: '0.1', cashAfter: '100', createdAt: fillAt })),
      { owner: other, accountId: foreign.id, orderId: foreignOrder.id, ticker: 'PRIVATE', side: 'buy', quantity: '1', price: '10', fee: '0.1', cashAfter: '100', createdAt: fillAt },
    ]);
    await db.insert(paperSnapshots).values({ owner, accountId: account.id, snapshotDate: '2026-11-10', equity: '100', cash: '50', dailyPl: '5', valuedAt: new Date('2026-11-10T01:00:00Z') });
    const research = { getDailyReports: async () => ({ initial: null, latestDiscussion: null, history: [] }) } as unknown as CurrentResearchService;
    const service = new DailyWorkspaceService(db, research);
    const before = await client`select count(*)::int as count from paper_trades`;
    const result = await service.read(owner, '2026-11-10');
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].id, account.id);
    assert.equal(result.accounts[0].trades.length, 25, 'no recent-feed truncation');
    assert.equal(result.accounts[0].trades[0].currency, 'CNY');
    assert.equal(result.accounts[0].trades[0].feeCurrency, 'USD');
    assert.equal(result.accounts[0].dailyPnlUsd, null, 'fill after valuation is incomplete');
    assert.equal(result.accounts[0].notExecuted.length, 0);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal((await service.read(randomUUID(), '2026-11-10')).accounts.length, 0);
    assert.equal((await service.read(owner, '2026-11-09')).accounts[0].trades.length, 0, 'order creation is not execution');
    assert.deepEqual(await client`select count(*)::int as count from paper_trades`, before);
  } finally {
    await client.end();
    await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
