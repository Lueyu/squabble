import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import axios from 'axios';
import { eq } from 'drizzle-orm';
import { councilReports, councilSessions } from '../../database/council.schema';
import { modelConnections } from '../../database/model-connections.schema';
import { researchCurrentViews } from '../../database/simple-experience.schema';
import { researchDocuments, researchDocumentVersions } from '../../database/research-documents.schema';
import { CouncilService } from '../council/council.service';
import { CurrentResearchService } from '../experience/current-research.service';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { LlmService } from '../research-core/llm.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { ModelConnectionsService } from '../settings/model-connections.service';
import { SettingsService } from '../settings/settings.service';
import { encryptSecret } from '../settings/settings-security';
import { TeamCommissionService } from './team-commission.service';
import { TeamCommissionWorker } from './team-commission.worker';
import { TeamRuntimeAdapter } from './team-runtime-adapter';
import { makeTeamFixture } from './team-test.fixture';

test('real team Council reports remain in owner history but never replace real-account daily research', {
  skip: !process.env.TEAM_TEST_DATABASE_URL,
}, async t => {
  const f = await makeTeamFixture();
  const encryptionBefore = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = 'fictional-current-research-team-key';
  try {
    const [clock] = await f.client<{ milliseconds: string }[]>`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS milliseconds`;
    t.mock.timers.enable({ apis: ['Date'], now: Math.ceil(Number(clock.milliseconds)) + 3600000 });
    await f.db.update(modelConnections).set({ baseUrl: 'https://8.8.8.8/v1',
      apiKeyEnc: encryptSecret('fixture-key', process.env.SETTINGS_ENCRYPTION_KEY) }).where(eq(modelConnections.id, f.connection.id));
    const budget = new LlmBudgetService(f.db);
    const settings = new SettingsService(f.db, undefined, new ModelConnectionsService(f.db));
    const llm = new LlmService(settings, budget);
    let calls = 0;
    t.mock.method(axios, 'post', async (url: string, body: { messages: Array<{ role: string; content: string }> }) => {
      assert.equal(url, 'https://8.8.8.8/v1/chat/completions');
      calls++;
      const input = JSON.parse(body.messages.find(message => message.role === 'user')!.content);
      return { status: 200, data: { model: 'fixture', usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ conclusion: 'Team-only fixture conclusion',
          evidenceIds: input.evidence.slice(0, 1).map((item: { id: string }) => item.id), asOf: '2020-01-01T00:00:00.000Z',
          currency: 'USD', units: 'USD', assumptions: [], gaps: [], skillVersions: input.skills,
          response: { thesis: 'Team-only fixture conclusion', evidencePoints: ['Fictional team evidence'],
            risks: ['Fictional uncertainty'], nextChecks: ['Next fixture'] } }) } }] } };
    });
    const documents = new ResearchDocumentsService(f.db);
    const council = new CouncilService(f.db, llm, undefined, undefined, undefined, undefined, budget,
      undefined, undefined, documents);
    const runtime = new TeamRuntimeAdapter(council);
    const commissions = new TeamCommissionService(f.store, runtime);
    const worker = new TeamCommissionWorker(f.store, runtime, commissions);
    const created = await f.commission();
    await worker.runOnce();
    await worker.runOnce();
    const detail = await commissions.detail(f.owner, created.team.id, created.created.commissionId);
    assert.ok(detail.sessionId);
    await (council as unknown as { jobs: Map<string, Promise<void>> }).jobs.get(`${f.owner}:${detail.sessionId}`);
    await worker.project(detail.id);
    assert.equal((await commissions.detail(f.owner, created.team.id, detail.id)).state, 'completed');
    assert.equal(calls, 1);
    const [report] = await f.db.select().from(councilReports).where(eq(councilReports.sessionId, detail.sessionId));
    assert.ok(report.researchVersionId);
    const version = await documents.getVersion(f.owner, report.researchVersionId);
    assert.ok(version.snapshot?.teamExecutionContext);
    const day = String(version.snapshot?.businessDate);
    const current = new CurrentResearchService(f.db, documents, {} as never, {} as never);

    await t.test('real daily history excludes the actual published team report', async () => {
      assert.equal((await current.getDailyReports(f.owner, day)).history.length, 0);
      assert.equal((await current.get(f.owner, 'portfolio', day)).documentId, null);
      assert.equal((await documents.getVersion(f.owner, version.id)).id, version.id, 'Owner report reading remains available');
    });
    await t.test('source session markers still exclude old versions without a snapshot team marker', async () => {
      const snapshot = { ...version.snapshot };
      delete snapshot.teamExecutionContext;
      const [legacyDocument] = await f.db.insert(researchDocuments).values({ owner: f.owner, title: 'Legacy team fixture', kind: 'council' }).returning();
      await f.db.insert(researchDocumentVersions).values({ owner: f.owner, reportId: legacyDocument.id,
        version: 1, idempotencyKey: randomUUID(), contentHash: 'd'.repeat(64), title: 'Legacy team fixture', kind: 'council',
        content: version.content, sections: version.sections, source: version.source, snapshot,
        createdAt: new Date('2020-01-01T00:00:00Z'), availableAt: new Date('2020-01-01T00:00:00Z') });
      assert.equal((await current.getDailyReports(f.owner, day)).history.length, 0);
    });
    await t.test('saved pointers and derived snapshots cannot promote team material into the personal current view', async () => {
      const [derivedDocument] = await f.db.insert(researchDocuments).values({ owner: f.owner, title: 'Derived team fixture', kind: 'portfolio' }).returning();
      const [derived] = await f.db.insert(researchDocumentVersions).values({ owner: f.owner, reportId: derivedDocument.id,
        version: 1, idempotencyKey: randomUUID(), contentHash: 'c'.repeat(64), title: 'Derived team fixture', kind: 'portfolio',
        content: version.content, sections: version.sections, source: { type: 'portfolio', id: randomUUID() },
        snapshot: version.snapshot, createdAt: new Date('2020-01-01T00:00:00Z'), availableAt: new Date('2020-01-01T00:00:00Z') }).returning();
      await f.db.insert(researchCurrentViews).values({ owner: f.owner, topicKey: 'portfolio', dateKey: day,
        currentDocumentId: derived.id, state: 'ready' });
      assert.equal((await current.get(f.owner, 'portfolio', day)).documentId, null);
      assert.equal((await current.get(f.owner, 'portfolio', 'current')).documentId, null);
    });
    await t.test('an ordinary same-owner daily discussion remains visible', async () => {
      const [session] = await f.db.select().from(councilSessions).where(eq(councilSessions.id, detail.sessionId!));
      const [personal] = await f.db.insert(councilSessions).values({ owner: f.owner, profileSnapshot: session.profileSnapshot,
        profileVersion: 1, ticker: 'PORTFOLIO', scene: 'portfolio_daily', status: 'completed', language: 'zh-CN' }).returning();
      const [personalReport] = await f.db.insert(councilReports).values({ owner: f.owner, sessionId: personal.id, version: 1,
        revision: 1, decision: 'wait', summary: 'Personal fixture report', dissent: [], nextReviewCondition: 'Next personal fixture',
        evidence: [], engine: 'llm', publicationOutcome: 'succeeded' }).returning();
      const personalVersion = await documents.importSource(f.owner, { type: 'council', id: personalReport.id });
      assert.deepEqual((await current.getDailyReports(f.owner, day)).history.map(item => item.documentId), [personalVersion.id]);
    });
    assert.equal(calls, 1, 'All projections are read-only');
  } finally {
    if (encryptionBefore === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = encryptionBefore;
    await f.dispose();
  }
});
