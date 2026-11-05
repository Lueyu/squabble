import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { monitorFixture, seedMonitor } from './research-memory.monitor.fixtures';
import { councilReports, councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { researchThesisReplacements } from '../../database/research-monitor.schema';
import { captureStrategyMemory, carryPlanBreaches, strategyMemoryBlock } from './research-memory.dependencies';
import { lockMemoryOwner } from './research-memory.fence';
import type { ResearchDelivery } from '@shared/research-workflow.interface';
import type { MemoryContextInventory, ThesisCandidateInput } from '@shared/research-memory.interface';
import type { StrategyMemoryInventory } from '@shared/research-monitor.interface';
import type { PostgresJsDatabase } from '../../common/platform';
import { StrategyStore } from '../paper-trading/strategy.store';
import { StrategyService } from '../paper-trading/strategy.service';
import { AgentBuilderService } from '../paper-trading/agent-builder.service';
import { strategyPlans, strategyRuntime, strategyTasks } from '../../database/strategy.schema';

test('reviewed exact submitted replacement preserves old endorsement/latch and rejects late user edits or missing dispatch proof', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL,
}, async t => {
  for (const scenario of ['valid', 'edited', 'missing-inventory', 'prepared-only', 'tampered-supersedes', 'budget-omitted'] as const) await t.test(scenario, async () => monitorFixture(async (db, _client, owner) => {
    const f = await seedMonitor(db, owner);
    await f.monitor.observe(owner, f.inventory, f.snapshot(80), f.profile.id);
    const cycleId = randomUUID(), taskId = randomUUID(), attemptId = randomUUID();
    const candidate: ThesisCandidateInput = { claim: 'New evidence supports a lower boundary', supportingEvidence: [{ evidenceId: 'new-source' }],
      opposingEvidence: ['The old USD90 boundary failed'], assumptions: ['The new evidence holds'], indicators: [], invalidationConditions: [],
      ...(scenario === 'budget-omitted' ? {} : { supersedes: { thesisId: f.thesis.id, version: f.thesis.version, reason: 'Reviewed the price breach against new evidence' } }) };
    const [session] = await db.insert(councilSessions).values({ owner, ticker: 'AAPL', profileVersion: 1, profileSnapshot: {} as never,
      status: 'completed', language: 'en', checkpoint: { cycleId, turns: [], nextTurn: 0, toolKindsUsed: [], pendingResearch: [] } }).returning();
    const delivery: ResearchDelivery = { conclusion: 'Reviewed replacement', evidenceIds: ['new-source'], asOf: new Date().toISOString(),
      currency: 'USD', units: 'USD', assumptions: [], gaps: [], skillVersions: [], response: {} as never, thesisCandidates: [candidate] };
    const ref = { kind: 'thesis' as const, id: f.thesis.id, version: f.thesis.version };
    const omitted = scenario === 'prepared-only' || scenario === 'budget-omitted';
    const inventory: MemoryContextInventory = { requested: [ref], selected: [ref], prepared: [ref], submitted: omitted ? [] : [ref],
      counts: { requested: 1, selected: 1, prepared: 1, submitted: omitted ? 0 : 1 }, budgetTokens: 1000, usedTokens: 500,
      basis: 'conservative-utf8', submission: 'api' };
    await db.insert(councilResearchTasks).values({ id: taskId, owner, sessionId: session.id, cycleId, revision: 1, key: 'summary',
      position: 0, memberId: 'manager', dependencies: [], state: 'accepted', skills: [], acceptedAttemptId: attemptId, delivery,
      attempts: [{ id: attemptId, revision: 1, kind: 'work', state: 'succeeded', startedAt: new Date().toISOString(),
        messageId: randomUUID(), dispatched: true, delivery, ...(scenario === 'missing-inventory' ? {} : { memory: inventory }) }] });
    const [report] = await db.insert(councilReports).values({ owner, sessionId: session.id, version: 1, revision: 1, decision: 'wait',
      publicationOutcome: 'succeeded', summary: 'Reviewed replacement', dissent: [], nextReviewCondition: '', engine: 'llm',
      thesisCandidates: [scenario === 'tampered-supersedes' ? { ...candidate, supersedes: { ...candidate.supersedes!, reason: 'Unreviewed rewritten reason' } } : candidate],
      coverage: { goal: 'comprehensive', cycleId, revision: 1, complete: true, tasks: [{ id: taskId, key: 'summary', state: 'accepted', acceptedAttemptId: attemptId }] },
      evidence: [{ id: 'new-source', title: 'New verified filing', sourceUrl: 'https://example.test/new', fetchedAt: new Date().toISOString(), content: 'Fixture' }] }).returning();
    if (scenario === 'edited') await f.memory.updateThesis(owner, f.thesis.id, { expectedVersion: f.thesis.version, action: 'confirm', changeReason: 'My new assessment while research was running' });
    if (scenario === 'missing-inventory') {
      const state = await db.transaction(async tx => { await lockMemoryOwner(tx, owner); return captureStrategyMemory(tx, owner, [report.id]); });
      assert.equal(state.state, 'unknown');
      assert.equal(state.reason, 'MEMORY_SUBMISSION_UNKNOWN');
      return;
    }
    await f.memory.archiveReport(owner, { sessionId: session.id, ticker: 'AAPL', language: 'en', report: { ...report, createdAt: report.createdAt.toISOString() } });
    const next = await db.transaction(async tx => { await lockMemoryOwner(tx, owner); return captureStrategyMemory(tx, owner, [report.id]); });
    const gate = () => db.transaction(async tx => { await lockMemoryOwner(tx, owner); return strategyMemoryBlock(tx, owner, next); });
    if (scenario === 'budget-omitted') {
      assert.equal(next.dependencies.length, 1, 'only the new unrelated accepted claim was supplied in this cycle');
      const carry = () => db.transaction(async tx => { await lockMemoryOwner(tx, owner);
        return carryPlanBreaches(tx, owner, next, [{ id: 'previous-plan', memoryInventory: f.inventory }], ['AAPL']); });
      const carried = await carry();
      assert.equal(carried.dependencies.find(item => item.thesisId === f.thesis.id)?.origin, 'previous-plan');
      assert.equal(await db.transaction(async tx => { await lockMemoryOwner(tx, owner); return strategyMemoryBlock(tx, owner, carried); }), 'MEMORY_CONDITION_BREACHED');
      await f.memory.updateThesis(owner, f.thesis.id, { expectedVersion: f.thesis.version, action: 'confirm', changeReason: 'Explicit personal review of the failed boundary' });
      const revised = await carry();
      assert.equal(await db.transaction(async tx => { await lockMemoryOwner(tx, owner); return strategyMemoryBlock(tx, owner, revised); }), null);
      return;
    }
    if (scenario === 'valid') {
      assert.equal(await gate(), null);
      const tick = await monitorTick(db, owner, f, next, 79);
      const oldEvents = (await f.monitor.view(owner, f.thesis.id)).events;
      await tick.run();
      assert.equal(tick.starts(), 0, 'a reviewed replacement must not trigger research from the old breached condition');
      assert.deepEqual((await f.monitor.view(owner, f.thesis.id)).events, oldEvents, 'resolved old conditions retain their immutable audit without new actionable observations');
      assert.equal(next.dependencies.length, 2, 'new report and actual submitted old version are both retained');
      assert.ok(next.dependencies.find(ref => ref.origin === 'recalled-memory')?.replacementId);
      assert.equal((await f.memory.getThesis(owner, f.thesis.id)).status, 'confirmed', 'Agent replacement never rewrites user belief');
      assert.equal((await f.monitor.view(owner, f.thesis.id)).breached, true, 'old version audit stays breached');
      assert.equal((await db.select().from(researchThesisReplacements)).length, 1);
      const replacement = next.dependencies.find(ref => ref.origin === 'current-report')!;
      assert.equal((await f.memory.getThesis(owner, replacement.thesisId)).status, 'accepted');
      await f.memory.updateThesis(owner, f.thesis.id, { expectedVersion: f.thesis.version, action: 'confirm', changeReason: 'Later personal review' });
      assert.equal(await gate(), 'MEMORY_DEPENDENCY_REVOKED', 'replacement proof is checked again at execution');
    } else {
      assert.notEqual(await gate(), null);
      assert.equal((await db.select().from(researchThesisReplacements)).length, 0);
    }
    await db.update(councilReports).set({ thesisCandidates: null }).where(eq(councilReports.id, report.id));
  }));
});

test('unresolved persisted breaches after restart still block and replan within cooldown and daily quota', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL,
}, async () => monitorFixture(async (db, _client, owner) => {
  const f = await seedMonitor(db, owner);
  await f.monitor.observe(owner, f.inventory, f.snapshot(80), f.profile.id);
  const tick = await monitorTick(db, owner, f, f.inventory);
  await db.update(strategyTasks).set({ createdAt: new Date() }).where(eq(strategyTasks.id, tick.task.id));
  await tick.run();
  assert.equal(tick.starts(), 0, 'cooldown applies to unresolved persisted breaches');
  assert.equal((await tick.store.runtime(owner, tick.profile)).markets[0].state, 'blocked');
  await db.update(strategyTasks).set({ createdAt: new Date(Date.now() - 86400000) }).where(eq(strategyTasks.id, tick.task.id));
  await tick.run();
  assert.equal(tick.starts(), 1, 'an identical persisted observation still triggers a bounded review after restart');
  const [replan] = await tick.store.tasks(owner, tick.profile, 'US', tick.day);
  assert.equal(replan.attempt, 1);
  await db.update(strategyTasks).set({ state: 'completed', createdAt: new Date(Date.now() - 86400000) }).where(eq(strategyTasks.id, replan.id));
  await tick.run();
  assert.equal(tick.starts(), 1, 'the daily event replan quota prevents another research session');
  assert.equal(await f.gate(), 'MEMORY_CONDITION_BREACHED');
}));

async function monitorTick(db: PostgresJsDatabase, owner: string, f: Awaited<ReturnType<typeof seedMonitor>>, inventory: StrategyMemoryInventory, price = 80) {
  const store = new StrategyStore(db), builder = new AgentBuilderService(db, {} as never);
  const profile = await builder.getProfile(owner, f.profile.id);
  const day = new Date().toISOString().slice(0, 10), end = new Date(Date.now() + 3600000).toISOString();
  const [task] = await db.insert(strategyTasks).values({ owner, profileId: profile.id, profileVersion: profile.version,
    market: 'US', marketDate: day, state: 'completed', createdAt: new Date(Date.now() - 86400000), sessionIds: [f.session.id] }).returning();
  const rule = { id: 'entry', ticker: 'AAPL', side: 'buy' as const, trigger: { kind: 'price_below' as const, value: 1 },
    referencePrice: 100, minPrice: 1, maxPrice: 200, maxPositionPct: 5, stopLossPrice: 70, expiresAt: end,
    evidenceIds: ['quote'], rationale: 'Price is inside all plan bands and cannot trigger an entry' };
  await db.insert(strategyPlans).values({ owner, profileId: profile.id, profileVersion: profile.version, taskId: task.id,
    market: 'US', marketDate: day, version: 1, rules: [rule], sessionIds: [f.session.id], reportIds: [f.report.id],
    expiresAt: new Date(end), memoryInventory: inventory, summary: 'Replacement monitoring regression' });
  let starts = 0;
  const council = { createSession: async () => { starts++; return { id: randomUUID() }; },
    addMessage: async () => {}, runSession: async () => {}, pauseSession: async () => {} };
  const market = { getSchedule: async () => ({ market: 'US', calendarVerified: true, isTradingDay: true,
    isOpen: true, tradingDate: day, opensAt: new Date(Date.now() - 3600000).toISOString(), closesAt: end }),
    getSnapshot: async () => f.snapshot(price) };
  return { store, profile, task, day, starts: () => starts, run: async () => {
    await db.delete(strategyRuntime).where(eq(strategyRuntime.owner, owner));
    // A fresh service has no in-process observation state. The ledger and task receipts remain authoritative.
    const strategy = new StrategyService(db, builder, {} as never, council as never, market as never, {} as never, store, {} as never);
    await Reflect.get(strategy, 'tickMarket').call(strategy, owner, profile, 'US', ['AAPL']);
  } };
}
