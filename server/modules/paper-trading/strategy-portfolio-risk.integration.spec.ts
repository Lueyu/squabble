import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { paperAccounts, paperPositions } from '../../database/schema';
import { simulationCash } from '../../database/simulation-experiments.schema';
import { preparePortfolioRiskInputs, readPortfolioRiskSnapshot, evaluatePortfolioRisk } from './strategy-portfolio-risk';
import { simulationMarketFixture } from './simulation-market.fixture';
import type { StrategyMandateInput } from '../../../shared/strategy-mandate.interface';

test('final portfolio risk revalues current locked currency cash and positions, never the prepared ledger', {
  skip: !process.env.STRATEGY_TEST_DATABASE_URL,
}, async t => {
  const namespace = 'portfolio_risk_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 4, onnotice: () => undefined, connection: { search_path: namespace } });
  try {
    await admin.unsafe('CREATE SCHEMA ' + namespace);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T15:30:00Z') });
    const db = drizzle(client); const owner = randomUUID();
    const [account] = await db.insert(paperAccounts).values({ owner, ledgerMode: 'native_currency', initialCash: '1200', cashBalance: '1000' }).returning();
    await db.insert(simulationCash).values({ owner, accountId: account.id, currency: 'USD', available: '1000', availabilityKnown: true });
    const [position] = await db.insert(paperPositions).values({ owner, accountId: account.id, ticker: 'MSFT', shares: '2', avgCost: '100' }).returning();
    let calls = 0;
    const market = { getSnapshot: async (ticker: string) => { calls++; return { ...simulationMarketFixture({ price: '100', currency: 'USD', market: 'US', timestamp: Date.now() }), ticker }; } };
    const fx = { convert: async (amount: number) => amount };
    const inputs = await preparePortfolioRiskInputs(db, owner, account.id, market, fx, new Date(), ['AAPL']);
    const preparedCalls = calls;
    await db.update(simulationCash).set({ available: '500' }).where(eq(simulationCash.accountId, account.id));
    await db.update(paperPositions).set({ shares: '7' }).where(eq(paperPositions.id, position.id));
    const latest = await db.transaction(async tx => {
      await tx.select().from(paperAccounts).where(eq(paperAccounts.id, account.id)).for('update');
      return readPortfolioRiskSnapshot(tx, owner, account.id, market, fx, new Date(), inputs);
    });
    assert.equal(calls, preparedCalls, 'account lock must not hold a network request');
    assert.equal(latest.equityUsd, 1200);
    assert.equal(latest.availableCashUsd, 500);
    assert.equal(latest.grossExposureUsd, 700);
    const config = { limits: { minCashPct: 40 }, routePolicy: { councilPositionCapRatio: 0.8 } } as StrategyMandateInput;
    assert.match(evaluatePortfolioRisk(latest, config, { signalId: 'candidate', ticker: 'AAPL', quantity: 1, side: 'buy' }, 100).hardBlock ?? '', /cash/);
    await db.insert(paperPositions).values({ owner, accountId: account.id, ticker: 'NEW', shares: '1', avgCost: '100' });
    const changed = await readPortfolioRiskSnapshot(db, owner, account.id, market, fx, new Date(), inputs);
    assert.equal(changed.equityUsd, null, 'a newly held instrument needs a new quote, not the cached equity');
    assert.ok(changed.gaps.some(gap => gap.includes('NEW')));
  } finally {
    t.mock.timers.reset(); await client.end(); await admin.unsafe('DROP SCHEMA IF EXISTS ' + namespace + ' CASCADE'); await admin.end();
  }
});
