import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { paperAccounts, paperOrders, paperSnapshots, paperTrades } from '../../database/schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { strategySignals } from '../../database/strategy.schema';
import { SimulationExperimentsService } from './simulation-experiments.service';
import type { StrategyMandateInput } from '../../../shared/strategy-mandate.interface';
import type { StrategyCandidate } from '../../../shared/strategy.interface';

test('review uses business dates, exact endpoints, observed drawdown and immutable strategy attribution', {
  skip: !process.env.STRATEGY_TEST_DATABASE_URL,
}, async t => {
  const namespace = 'simulation_review_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 4, onnotice: () => undefined, connection: { search_path: namespace } });
  try {
    await admin.unsafe('CREATE SCHEMA ' + namespace);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/28_simulation_experiments.sql', 'utf8'));
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T02:00:00Z') });
    const db = drizzle(client); const owner = randomUUID(); const profileId = randomUUID();
    const [account] = await db.insert(paperAccounts).values({ owner, initialCash: '1000', cashBalance: '1000', createdAt: new Date('2026-11-01T04:00:00Z') }).returning();
    const config = { title: 'Version one', timezone: 'America/New_York', startsAt: '2026-11-01T04:00:00Z', endsAt: '2026-11-07T05:00:00Z' } as StrategyMandateInput;
    const [first] = await db.insert(strategyMandates).values({ owner, accountId: account.id, profileId, profileVersion: 1, version: 1,
      config, status: 'superseded', publishedAt: new Date(config.startsAt), updatedAt: new Date('2026-11-03T05:00:00Z') }).returning();
    const [second] = await db.insert(strategyMandates).values({ owner, accountId: account.id, profileId, profileVersion: 2, version: 2, parentId: first.id,
      config: { ...config, title: 'Version two', startsAt: '2026-11-03T05:00:00Z' }, status: 'published', publishedAt: new Date('2026-11-03T05:00:00Z') }).returning();
    for (const [day, equity] of [['01', '1000'], ['02', '1100'], ['03', '990'], ['04', '1089'], ['05', '1089']]) {
      await db.insert(paperSnapshots).values({ owner, accountId: account.id, snapshotDate: `2026-11-${day}`, equity, cash: equity,
        benchmarkEquity: '1000', valuedAt: new Date(`2026-11-${String(Number(day) + 1).padStart(2, '0')}T05:00:00Z`) });
    }
    const [sell, buy] = await db.insert(paperOrders).values(['sell', 'buy'].map(side => ({ owner, accountId: account.id, ticker: 'AAPL', side,
      quantity: '1', source: 'agent', status: 'filled' }))).returning();
    const [trade] = await db.insert(paperTrades).values({ owner, accountId: account.id, orderId: sell.id, ticker: 'AAPL', side: 'sell',
      quantity: '1', price: '100', fee: '2', cashAfter: '1000', createdAt: new Date('2026-11-06T01:00:00Z') }).returning();
    await db.insert(paperTrades).values({ owner, accountId: account.id, orderId: buy.id, ticker: 'AAPL', side: 'buy',
      quantity: '1', price: '100', fee: '9', cashAfter: '1000', createdAt: new Date('2026-11-05T03:00:00Z') });
    await db.insert(strategySignals).values({ id: randomUUID(), owner, profileId, planId: randomUUID(), ruleId: 'protection', kind: 'stop', state: 'filled',
      reason: 'Old version protection', orderId: trade.orderId,
      candidate: { accountId: account.id, mandateId: first.id, mandateVersion: 1, protectiveStop: true } as StrategyCandidate });
    const service = new SimulationExperimentsService(db, {} as never, {} as never);
    const defaultReview = await service.review(owner, account.id);
    assert.equal(defaultReview.to, '2026-11-05', 'UTC next day is still the previous New York business day');
    const day = await service.review(owner, account.id, '2026-11-05', '2026-11-05');
    assert.equal(day.orders, 1);
    assert.equal(day.feesUsd, '2.00', 'fills and fees use the same account business day');
    const missing = await service.review(owner, account.id, '2026-11-01', '2026-11-06');
    assert.equal(missing.profitUsd, null); assert.equal(missing.returnPct, null); assert.equal(missing.excessReturnPct, null);
    t.mock.timers.setTime(new Date('2026-11-06T06:00:00Z').getTime());
    const whole = await service.review(owner, account.id, '2026-11-01', '2026-11-05');
    assert.equal(whole.observedMaxDrawdownPct, '10.0000');
    assert.equal(whole.drawdownSampleCount, 6);
    assert.equal(whole.drawdownCoverage, 'observed_snapshots_only');
    assert.equal(whole.strategyContributions.find(row => row.mandateId === first.id)?.profitUsd, '100.00');
    assert.equal(whole.strategyContributions.find(row => row.mandateId === second.id)?.profitUsd, '-11.00');
    assert.equal(whole.strategyContributions.find(row => row.mandateId === first.id)?.orders, 1, 'protection retains its authorizing version even after replacement');
    assert.equal(whole.strategyContributions.find(row => row.mandateId === first.id)?.feesUsd, '2.00');
    await db.update(strategyMandates).set({ publishedAt: new Date('2026-11-03T12:00:00Z'), config: { ...second.config, startsAt: '2026-11-03T12:00:00Z' } }).where(eq(strategyMandates.id, second.id));
    const intraday = await service.review(owner, account.id, '2026-11-01', '2026-11-05');
    assert.equal(intraday.strategyContributions.find(row => row.mandateId === second.id)?.profitUsd, null, 'a daily close cannot invent the NAV at an intraday version switch');
    assert.ok(intraday.strategyContributions.find(row => row.mandateId === second.id)?.gaps.includes('STRATEGY_BOUNDARY_VALUATION_MISSING'));
  } finally {
    t.mock.timers.reset(); await client.end(); await admin.unsafe('DROP SCHEMA IF EXISTS ' + namespace + ' CASCADE'); await admin.end();
  }
});
