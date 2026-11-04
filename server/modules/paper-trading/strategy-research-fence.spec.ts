import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { builderProfiles, paperAccounts, paperPositions } from '../../database/schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { strategyPlans, strategyProtections, strategyTasks } from '../../database/strategy.schema';
import type { BuilderConfig } from '../../../shared/api.interface';
import type { ResearchCoverage, ResearchTaskKind } from '../../../shared/research-workflow.interface';
import type { StrategyRule } from '../../../shared/strategy.interface';
import { StrategyStore, type StrategyResearchFence } from './strategy.store';

test('publication keeps the active plan and position protection when accepted research changes', {
  skip: !process.env.STRATEGY_TEST_DATABASE_URL,
}, async (t) => {
  const uri = process.env.STRATEGY_TEST_DATABASE_URL!;
  const namespace = `strategy_fence_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(uri, { max: 1, onnotice: () => undefined });
  const client = postgres(uri, { max: 2, onnotice: () => undefined, connection: { search_path: namespace } });
  const owner = randomUUID();
  let initialized = false;
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    initialized = true;
    for (const name of ['01_schema', '03_agent_builder', '07_llm_budget', '08_investment_council',
      '12_council_dialogue', '14_a2a_agents', '16_daily_strategy', '18_research_workflow', '19_atomic_research_theses', '21_research_archive_jobs']) {
      await client.unsafe(readFileSync(`scripts/db/${name}.sql`, 'utf8'));
    }
    await client`INSERT INTO users(id, username, password_hash) VALUES(${owner}, 'strategy-fence-test', 'test-only')`;
    const db = drizzle(client);
    const store = new StrategyStore(db);
    const config: BuilderConfig = {
      name: 'Research-fenced paper strategy', template: 'balanced', tickers: ['AAPL'], minimumRating: 'Buy',
      customPrompt: '', language: 'en', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 10,
      notifyOnProposal: false, automation: { enabled: true, preOpenMinutes: 60, monitorSeconds: 60,
        maxEventReplansPerDay: 1, eventReplanCooldownMinutes: 120, notifyClosingSummary: false },
    };
    const [profile] = await db.insert(builderProfiles).values({ owner, config, status: 'active' }).returning();
    const [account] = await db.insert(paperAccounts).values({ owner, botEnabled: true }).returning();
    await db.insert(paperPositions).values({ owner, accountId: account.id, ticker: 'AAPL', shares: '10', avgCost: '100' });
    const cycleId = randomUUID();
    const [session] = await db.insert(councilSessions).values({
      owner, profileId: profile.id, profileVersion: profile.version, profileSnapshot: config, ticker: 'AAPL',
      language: 'en', status: 'completed', revision: 1,
      checkpoint: { cycleId, turns: [], nextTurn: 0, toolKindsUsed: [], pendingResearch: [],
        workflow: { goal: 'comprehensive', peers: [], parallelism: 1, recallEnabled: false } },
    }).returning();
    const taskKinds: ResearchTaskKind[] = ['financials', 'business', 'valuation', 'challenge', 'summary'];
    const researchTasks = await db.insert(councilResearchTasks).values(taskKinds.map((key: ResearchTaskKind, position: number) => {
      const acceptedAttemptId = randomUUID();
      return { owner, sessionId: session.id, cycleId, revision: 1, key, position, memberId: key,
        dependencies: [], state: 'accepted' as const, skills: [], acceptedAttemptId,
        attempts: [{ id: acceptedAttemptId, revision: 1, kind: 'work' as const, state: 'succeeded' as const,
          messageId: randomUUID(), startedAt: '2026-11-03T12:00:00.000Z', finishedAt: '2026-11-03T12:01:00.000Z' }] };
    })).returning();
    const coverage: ResearchCoverage = { goal: 'comprehensive', cycleId, revision: 1, complete: true,
      tasks: researchTasks.map((task: typeof councilResearchTasks.$inferSelect) => ({
        id: task.id, key: task.key, state: task.state, acceptedAttemptId: task.acceptedAttemptId,
      })) };
    const [report] = await db.insert(councilReports).values({
      owner, sessionId: session.id, version: 1, revision: 1, decision: 'approve', summary: 'Accepted research',
      dissent: [], nextReviewCondition: 'New evidence', evidence: [], engine: 'llm', coverage,
    }).returning();
    const [initialTask, replacementTask] = await db.insert(strategyTasks).values([0, 1].map((attempt: number) => ({
      owner, profileId: profile.id, profileVersion: profile.version, market: 'US', marketDate: '2026-11-03',
      attempt, state: 'extracting', sessionIds: [session.id],
    }))).returning();
    const rule: StrategyRule = {
      id: 'accepted-entry', ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_below', value: 100 },
      referencePrice: 100, minPrice: 95, maxPrice: 105, maxPositionPct: 5, stopLossPrice: 90,
      expiresAt: '2026-11-03T21:00:00.000Z', evidenceIds: [], rationale: 'Accepted comprehensive research',
    };
    const fence: StrategyResearchFence[] = [{ sessionId: session.id, reportId: report.id, revision: 1, cycleId }];
    const published = await store.publish(initialTask, [rule], [report.id], 'Original plan', new Date(rule.expiresAt), fence);
    assert.equal(published.status, 'active');
    assert.deepEqual(published.reportIds, [report.id]);
    const originalPlans = await db.select().from(strategyPlans);
    const originalProtections = await db.select().from(strategyProtections);
    assert.equal(originalPlans.length, 1);
    assert.equal(originalProtections.length, 1);
    assert.equal(originalProtections[0].planId, published.id);
    assert.equal(Number(originalProtections[0].stopLossPrice), 90);

    // A stale replacement would supersede the active plan and tighten its position stop if committed.
    const publishReplacement = () => store.publish(replacementTask, [{ ...rule, id: 'replacement-entry', stopLossPrice: 95 }],
      [report.id], 'Replacement plan', new Date(rule.expiresAt), fence);
    const assertPublicationUnchanged = async () => {
      assert.deepEqual(await db.select().from(strategyPlans), originalPlans);
      assert.deepEqual(await db.select().from(strategyProtections), originalProtections);
      const [pending] = await db.select().from(strategyTasks).where(eq(strategyTasks.id, replacementTask.id));
      assert.equal(pending.state, 'extracting');
    };

    await t.test('a later session revision rejects the extracted plan', async () => {
      await db.update(councilSessions).set({ revision: 2 }).where(eq(councilSessions.id, session.id));
      await assert.rejects(publishReplacement, /Research changed; plan discarded/u);
      await assertPublicationUnchanged();
      await db.update(councilSessions).set({ revision: 1 }).where(eq(councilSessions.id, session.id));
    });
    await t.test('a paused session rejects the extracted plan', async () => {
      await db.update(councilSessions).set({ status: 'paused' }).where(eq(councilSessions.id, session.id));
      await assert.rejects(publishReplacement, /Research changed; plan discarded/u);
      await assertPublicationUnchanged();
      await db.update(councilSessions).set({ status: 'completed' }).where(eq(councilSessions.id, session.id));
    });
    await t.test('a replaced accepted attempt invalidates the older report', async () => {
      const researchTask = researchTasks[0];
      await db.update(councilResearchTasks).set({ acceptedAttemptId: randomUUID() })
        .where(eq(councilResearchTasks.id, researchTask.id));
      await assert.rejects(publishReplacement, /Research is not accepted; plan discarded/u);
      await assertPublicationUnchanged();
      await db.update(councilResearchTasks).set({ acceptedAttemptId: researchTask.acceptedAttemptId })
        .where(eq(councilResearchTasks.id, researchTask.id));
    });
    await t.test('incomplete report coverage cannot replace the active plan', async () => {
      await db.update(councilReports).set({ coverage: { ...coverage, complete: false } })
        .where(eq(councilReports.id, report.id));
      await assert.rejects(publishReplacement, /Research is not accepted; plan discarded/u);
      await assertPublicationUnchanged();
      await db.update(councilReports).set({ coverage }).where(eq(councilReports.id, report.id));
    });
    await t.test('another owner cannot supply the research session', async () => {
      await db.update(councilSessions).set({ owner: randomUUID() }).where(eq(councilSessions.id, session.id));
      await assert.rejects(publishReplacement, /Research changed; plan discarded/u);
      await assertPublicationUnchanged();
    });
  } finally {
    await client.end();
    if (initialized) await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
