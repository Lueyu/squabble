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
