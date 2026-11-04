import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { monitorFixture, seedMonitor } from './research-memory.monitor.fixtures';
import { paperOrders, paperPositions } from '../../database/schema';
import { strategyPlans, strategyProtections, strategySignals, strategyTasks } from '../../database/strategy.schema';
import { PaperTradingService } from '../paper-trading/paper-trading.service';
import { AgentBuilderService } from '../paper-trading/agent-builder.service';
import { BuilderCadenceService } from '../paper-trading/builder-cadence.service';
import { tradingMarketSchedule } from '../paper-trading/trading-market.calendar';
import type { StrategyCandidate, StrategyRule } from '@shared/strategy.interface';
import type postgres from 'postgres';

async function waitForLock(client: postgres.Sql, pattern: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const rows = await client`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${pattern}`;
    if (rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Expected real PostgreSQL lock wait: ${pattern}`);
}

test('actual ledger serializes revocation and physical source deletion in both orderings; protective exits remain independent', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL, timeout: 60000,
}, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-03T15:00:00Z') });
  for (const mutation of ['exclude', 'source-delete', 'thesis-edit', 'recall-off'] as const) for (const first of ['revocation', 'fill'] as const) {
    await t.test(`${mutation}, ${first} wins transaction`, async () => monitorFixture(async (db, client, owner) => {
      const f = await seedMonitor(db, owner);
      if (mutation === 'recall-off') f.inventory.dependencies.forEach(ref => { ref.origin = 'recalled-memory'; });
      const [task] = await db.insert(strategyTasks).values({ owner, profileId: f.profile.id, profileVersion: 1,
        market: 'US', marketDate: '2026-11-03', state: 'completed' }).returning();
      const rule: StrategyRule = { id: 'entry', ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_below', value: 110 },
        referencePrice: 100, minPrice: 70, maxPrice: 110, maxPositionPct: 5, stopLossPrice: 90,
        expiresAt: '2026-11-03T21:00:00Z', evidenceIds: ['quote'], rationale: 'Fixture entry' };
      const [plan] = await db.insert(strategyPlans).values({ owner, profileId: f.profile.id, profileVersion: 1, version: 1,
        taskId: task.id, market: 'US', marketDate: '2026-11-03', rules: [rule], sessionIds: [f.session.id], reportIds: [f.report.id],
        summary: 'Fixture', expiresAt: new Date(rule.expiresAt), memoryInventory: f.inventory }).returning();
      const candidate: StrategyCandidate = { signalId: randomUUID(), planId: plan.id, planVersion: 1, ruleId: rule.id,
        ticker: 'AAPL', market: 'US', side: 'buy', quantity: 1, price: 100, quoteAt: new Date().toISOString(), protectiveStop: false, reason: 'Fixture' };
      await db.insert(strategySignals).values({ id: candidate.signalId, owner, profileId: f.profile.id, planId: plan.id, ruleId: rule.id,
        kind: 'entry:1', state: 'approved', candidate, reason: 'Fixture' });
      let price = 100;
      const builder = new AgentBuilderService(db, {} as never);
      const profile = await builder.getProfile(owner, f.profile.id);
      const paper = new PaperTradingService(db, { getQuote: async () => ({ symbol: 'AAPL', price: String(price), market: 'US', currency: 'USD', timestamp: Date.now() }) } as never,
        { convert: async (value: number) => value } as never, {} as never, builder, new BuilderCadenceService(db), {} as never,
        { getSnapshot: async () => ({ ...f.snapshot(price), schedule: tradingMarketSchedule('US', new Date()) }) } as never);
      const fill = () => paper.placeOrder(owner, { ticker: 'AAPL', side: 'buy', quantity: 1 }, 'agent', undefined, true, true, profile, undefined, candidate.signalId);
      const revoke = () => mutation === 'exclude' ? f.memory.updateMemory(owner, f.memoryId, { excluded: true })
        : mutation === 'source-delete' ? client`DELETE FROM council_reports WHERE id = ${f.report.id}`
          : mutation === 'recall-off' ? f.memory.updatePreferences(owner, { autoArchive: true, recallEnabled: false })
            : f.memory.updateThesis(owner, f.thesis.id, { expectedVersion: f.thesis.version, action: 'confirm', changeReason: 'New personal assessment' });
      if (mutation === 'exclude' && first === 'revocation') {
        await db.update(strategyPlans).set({ memoryInventory: null }).where(eq(strategyPlans.id, plan.id));
        await assert.rejects(fill(), /MEMORY_UNKNOWN/, 'old structured plans cannot become trusted empty inventories');
        await db.update(strategyPlans).set({ memoryInventory: f.inventory }).where(eq(strategyPlans.id, plan.id));
        await db.update(strategySignals).set({ state: 'approved' }).where(eq(strategySignals.id, candidate.signalId));
      }
      if (first === 'revocation') {
        let pending!: Promise<unknown>;
        await client.begin(async tx => {
          if (mutation !== 'source-delete') {
            await tx`SELECT owner FROM research_memory_preferences WHERE owner = ${owner} FOR UPDATE`;
            if (mutation === 'exclude') await tx`UPDATE research_memories SET excluded = true WHERE id = ${f.memoryId}`;
            else if (mutation === 'recall-off') await tx`UPDATE research_memory_preferences SET recall_enabled = false WHERE owner = ${owner}`;
            else await tx`UPDATE research_theses SET version = version + 1 WHERE id = ${f.thesis.id}`;
          } else await tx`DELETE FROM council_reports WHERE id = ${f.report.id}`;
          pending = fill().then(() => 'filled', error => error.message);
          await waitForLock(client, mutation !== 'source-delete' ? '%research_memory_preferences%' : '%council_reports%');
        });
        assert.match(String(await pending), /MEMORY_DEPENDENCY_REVOKED|MEMORY_RECALL_DISABLED/);
        assert.equal((await db.select().from(paperOrders)).length, 0);
        await db.insert(paperPositions).values({ owner, accountId: f.account.id, ticker: 'AAPL', shares: '1', avgCost: '100' });
      } else {
        const key = randomInt(100000, 2000000000);
        await client.unsafe(`CREATE FUNCTION hold_fill() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`);
        await client.unsafe('CREATE TRIGGER hold_fill BEFORE INSERT ON paper_orders FOR EACH ROW EXECUTE FUNCTION hold_fill()');
        let pendingFill!: ReturnType<typeof fill>; let pendingRevoke!: Promise<unknown>;
        await client.begin(async tx => {
          await tx`SELECT pg_advisory_xact_lock(${key})`;
          pendingFill = fill();
          await waitForLock(client, '%insert into "paper_orders"%');
          pendingRevoke = Promise.resolve(revoke());
          await waitForLock(client, mutation !== 'source-delete' ? '%research_memory_preferences%' : '%DELETE FROM council_reports%');
        });
        assert.equal((await pendingFill).status, 'filled');
        await pendingRevoke;
        await client.unsafe('DROP TRIGGER hold_fill ON paper_orders');
      }
      // Source/privacy invalidation must not disable a saved protective exit.
      price = 80;
      const [protection] = await db.insert(strategyProtections).values({ owner, accountId: f.account.id, ticker: 'AAPL', market: 'US',
        stopLossPrice: '90', planId: plan.id, ruleId: rule.id }).onConflictDoUpdate({ target: [strategyProtections.owner, strategyProtections.accountId, strategyProtections.ticker],
        set: { stopLossPrice: '90' } }).returning();
      const stop: StrategyCandidate = { ...candidate, signalId: randomUUID(), side: 'sell', price: 80,
        protectiveStop: true, protectionId: protection.id, protectionVersion: protection.version };
      await db.insert(strategySignals).values({ id: stop.signalId, owner, profileId: f.profile.id, planId: plan.id, ruleId: rule.id,
        kind: 'stop:fixture', state: 'approved', candidate: stop, reason: 'Protective exit' });
      const order = await paper.placeOrder(owner, { ticker: 'AAPL', side: 'sell', quantity: 1 }, 'agent', undefined, true, true, profile, undefined, stop.signalId);
      assert.equal(order.status, 'filled');
      assert.equal((await db.select().from(paperPositions).where(eq(paperPositions.accountId, f.account.id))).length, 0);
    }));
  }
});
