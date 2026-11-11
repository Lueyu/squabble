import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { councilReports, councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { researchMemories, researchTheses } from '../../database/research-memory.schema';
import { teamCommissions, teamResearchLinks } from '../../database/teams.schema';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { ResearchMemoryService } from '../research-memory/research-memory.service';
import { QuoteService } from '../quote/quote.service';
import { TeamCommissionWorker } from './team-commission.worker';
import { makeTeamFixture } from './team-test.fixture';

test('owner thesis review survives the original research deadline and handover without reviving withdrawn evidence', async t => {
  const f = await makeTeamFixture();
  try {
    const original = await f.commission();
    await new TeamCommissionWorker(f.store, f.runtime, f.commissions).runOnce();
    const [commission] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, original.created.commissionId));
    assert.ok(commission.sessionId && commission.cycleId);
    const attemptId = randomUUID();
    const [task] = await f.db.insert(councilResearchTasks).values({ owner: f.owner, sessionId: commission.sessionId,
      cycleId: commission.cycleId, revision: 1, key: 'summary', position: 0, memberId: commission.members[0].memberId,
      dependencies: [], state: 'accepted', skills: [], workKey: commission.plan.work[0].workKey,
      acceptedAttemptId: attemptId, attempts: [{ id: attemptId, revision: 1, kind: 'work',
        startedAt: new Date().toISOString(), state: 'succeeded', dispatched: true, messageId: randomUUID() }] }).returning();
    await f.db.update(councilSessions).set({ status: 'completed' }).where(eq(councilSessions.id, commission.sessionId));
    await f.db.update(teamCommissions).set({ state: 'completed' }).where(eq(teamCommissions.id, commission.id));
    const [report] = await f.db.insert(councilReports).values({ owner: f.owner, sessionId: commission.sessionId,
      version: 1, revision: 1, decision: 'wait', summary: 'Fictional historical team judgment', dissent: [],
      nextReviewCondition: 'Review the next filing', evidence: [], engine: 'llm', publicationOutcome: 'succeeded',
      createdAt: new Date(Date.now() - 60000), coverage: { goal: 'comprehensive', cycleId: commission.cycleId,
        revision: 1, complete: true, tasks: [{ id: task.id, key: 'summary', state: 'accepted', acceptedAttemptId: attemptId }] } }).returning();
    const documents = new ResearchDocumentsService(f.db);
    const reportVersion = await f.db.transaction(tx => documents.importSourceInTransaction(tx, f.owner,
      { type: 'council', id: report.id }, { availableAt: report.createdAt.toISOString() }));
    await f.db.update(councilReports).set({ researchVersionId: reportVersion.id }).where(eq(councilReports.id, report.id));
    const [memory] = await f.db.insert(researchMemories).values({ owner: f.owner, ticker: 'PORTFOLIO', market: 'US',
      topic: 'Historical review', language: 'zh-CN', sessionId: commission.sessionId, reportId: report.id,
      reportVersion: 1, reportRevision: 1, reportCreatedAt: report.createdAt, summary: report.summary, decision: 'wait' }).returning();
    const content = { claim: 'Fictional cash conversion needs continued review', supportingEvidence: [], opposingEvidence: [],
      assumptions: [], indicators: [], invalidationConditions: [] };
    const [thesis] = await f.db.insert(researchTheses).values({ owner: f.owner, memoryId: memory.id, content }).returning();
    const service = new ResearchMemoryService(f.db, new QuoteService(f.db, undefined as never));
    t.mock.timers.enable({ apis: ['Date'], now: new Date(commission.plan.deadlineAt).getTime() + 86400000 });
    const edited = await service.updateThesis(f.owner, thesis.id, { expectedVersion: 1, action: 'edit',
      content: { ...content, claim: 'The owner revised this historical judgment after reviewing it' }, changeReason: 'Later owner review' });
    assert.equal(edited.version, 2);
    const currentTeam = await f.service.detail(f.owner, original.team.id);
    const preview = await f.versions.bindingPreview(f.owner, original.team.id, { requestKey: randomUUID(), action: 'release',
      accountId: original.account.id, teamVersionId: original.version.id, expectedBindingRevision: currentTeam.bindingRevision,
      expectedAccountBindingId: currentTeam.binding!.id, executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
    await f.versions.binding(f.owner, original.team.id, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
    const afterHandover = await service.updateThesis(f.owner, thesis.id, { expectedVersion: 2, action: 'edit',
      content, changeReason: 'Historical correction after explicit release' });
    assert.equal(afterHandover.version, 3);
    await documents.revoke(f.owner, reportVersion.id, 'Fictional evidence withdrawn');
    await assert.rejects(service.updateThesis(f.owner, thesis.id, { expectedVersion: 3, action: 'edit', content,
      changeReason: 'Cannot reassert withdrawn evidence' }), /REPORT_REVOKED/);
    const dismissed = await service.updateThesis(f.owner, thesis.id, { expectedVersion: 3, action: 'dismiss' });
    assert.equal(dismissed.status, 'dismissed');
    const expired = await service.updateThesis(f.owner, thesis.id, { expectedVersion: 4, action: 'expire' });
    assert.equal(expired.status, 'expired');
    const excluded = await service.updateThesis(f.owner, thesis.id, { expectedVersion: 5, action: 'exclude', excluded: true });
    assert.equal(excluded.excluded, true);
    await assert.rejects(service.updateThesis(f.owner, thesis.id, { expectedVersion: 6, action: 'exclude', excluded: false }), /REPORT_REVOKED/);
    const links = await f.db.select().from(teamResearchLinks).where(eq(teamResearchLinks.kind, 'thesis_version'));
    assert.equal(links.length, 5);
    assert.ok(links.every(link => link.teamId === original.team.id && link.commissionId === commission.id
      && link.attemptId === attemptId && link.metadata.actor === 'user'));
    await assert.rejects(service.updateThesis(f.stranger, thesis.id, { expectedVersion: 6, action: 'dismiss' }), /MEMORY_THESIS_NOT_FOUND/);
  } finally { await f.dispose(); }
});
