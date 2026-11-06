import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { DailyChannelResearchService } from './daily-channel-research.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { UserInvestmentStrategyService } from '../paper-trading/user-investment-strategy.service';
import { councilReports, councilSessions } from '../../database/council.schema';
import { businessDate } from './simple-experience.rules';

test('daily handoff imports only typed exact plans and remains idempotent after explicit confirmation', { skip: !process.env.STRATEGY_TEST_DATABASE_URL }, async () => {
  const namespace = 'daily_plan_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 6, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  try {
    for (const file of readdirSync('scripts/db').filter(name => /^\d\d_.*\.sql$/u.test(name) && !name.startsWith('02_')).sort())
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    const db = drizzle(client), documents = new ResearchDocumentsService(db); let modelCalls = 0;
    const strategies = new UserInvestmentStrategyService(db, documents, { json: async () => { modelCalls++; throw new Error('No model calls'); } } as never);
    const archived: string[] = [];
    const channel = { ingestReport: async (owner: string) => { archived.push(owner); } };
    const daily = new DailyChannelResearchService({} as never, db, channel as never, strategies);
    const now = new Date(), day = businessDate(now, 'Asia/Shanghai');
    const text = 'AI proposal: AAPL at 100 buy 10 shares.';
    const plan = { schemaVersion: 1, parameterOrigin: 'ai_proposed', evidenceIds: ['filing'], gaps: [], strategy: {
      title: 'Fictional daily plan', body: 'Proposed plan only.', timezone: 'Asia/Shanghai', startsAt: new Date(now.getTime() - 3600000).toISOString(), endsAt: new Date(now.getTime() + 86400000).toISOString(),
      limits: { maxPositionPct: 30, maxDailyIncreasePct: 10, maxDailyTurnoverPct: 30 },
      entries: [{ id: 'aapl', text, sourceKeys: [], directive: { ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_lte', price: 100 }, quantity: 10,
        reviewedText: text, numericEvidence: [{ field: 'trigger.price', value: 100, quote: '100' }, { field: 'quantity', value: 10, quote: '10' }] } }],
    } };
    async function publish(executionPlan: unknown, exactSection = true) {
      const owner = randomUUID();
      const [session] = await db.insert(councilSessions).values({ owner, ticker: 'PORTFOLIO', scene: 'portfolio_daily', status: 'completed', profileVersion: 1,
        profileSnapshot: {} as never, checkpoint: { simple: { researchOnly: true, contextDate: day } } as never }).returning();
      const [report] = await db.insert(councilReports).values({ owner, sessionId: session.id, version: 1, revision: 1, decision: 'wait', engine: 'basic',
        summary: 'Legacy daily strategy: observe the report prose.', dissent: [], nextReviewCondition: 'Review evidence', evidence: [], publicationOutcome: 'succeeded' }).returning();
      const version = await documents.submit(owner, { idempotencyKey: report.id, title: 'Fictional report', kind: 'council', source: { type: 'council', id: report.id },
        content: report.summary, sections: [{ id: exactSection ? 'execution-strategy' : 'legacy-strategy', title: 'Daily Strategy', content: report.summary }], availableAt: now.toISOString(),
        snapshot: { evidence: [{ id: 'filing' }], ...(executionPlan ? { executionPlan } : {}) } });
      await db.update(councilReports).set({ researchVersionId: version.id }).where(eq(councilReports.id, report.id));
      return { owner, version };
    }
    const ready = await publish(plan);
    const legacy = await publish(undefined, false);
    const wrongSection = await publish(plan, false);
    const missing = await publish({ ...plan, gaps: ['The next customer filing is unavailable.'] });
    const noTrade = await publish({ ...plan, noTradeReason: 'Evidence does not justify adding risk.', strategy: { ...plan.strategy, entries: [] } });
    const invalid = await publish({ ...plan, evidenceIds: ['invented'] });
    const expired = await publish({ ...plan, strategy: { ...plan.strategy, startsAt: new Date(now.getTime() - 86400000).toISOString(), endsAt: new Date(now.getTime() - 3600000).toISOString() } });
    await daily.syncPublished(); await daily.syncPublished();
    const workspace = await strategies.workspace(ready.owner);
    assert.equal(workspace.drafts.length, 1); assert.equal(workspace.current, null);
    const draft = workspace.drafts[0];
    assert.equal(draft.sources[0].sectionId, 'execution-strategy');
    assert.equal(draft.content.entries[0].text, text); assert.equal(draft.preview?.directives[0].quantity, 10);
    const confirmed = await db.transaction(tx => strategies.confirmInTransaction(tx, ready.owner, draft.id, draft.revision, draft.preview!.contentHash, null, async () => undefined));
    await daily.syncPublished();
    assert.equal((await strategies.workspace(ready.owner)).drafts.length, 0);
    assert.equal((await strategies.workspace(ready.owner)).current?.id, confirmed.id);
    assert.equal((await strategies.workspace(missing.owner)).drafts[0].preview?.entries[0].state, 'needs_review');
    for (const fixture of [legacy, wrongSection, noTrade, invalid, expired])
      assert.equal((await strategies.workspace(fixture.owner)).drafts.length, 0, 'unavailable, untyped, no-trade and expired plans create no automatic drafts');
    assert.ok(archived.includes(legacy.owner), 'legacy reports remain archived and readable');
    assert.equal(modelCalls, 0, 'automatic handoff does not prepare or apply a strategy');
  } finally { await client.end(); await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE'); await admin.end(); }
});
