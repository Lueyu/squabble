import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { councilReports, councilSessions } from '../../database/council.schema';
import { dataLibrarySources, dataLibraryVersions } from '../../database/data-library.schema';
import { researchSourcePolicies } from '../../database/research-artifacts.schema';
import { sourceFingerprint } from '../../database/team-source-context';
import { assertReportVersionSources } from '../../database/report-source-fence';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { makeTeamFixture, teamErrorIs } from './team-test.fixture';

test('a granted report cannot launder revoked or expired library policies through generic snapshot or Council evidence', async () => {
  const f = await makeTeamFixture();
  try {
    const past = new Date('2020-01-01T00:00:00.000Z');
    const [source] = await f.db.insert(dataLibrarySources).values({ owner: f.owner, kind: 'text',
      title: 'Fictional policy-controlled filing', format: 'text' }).returning();
    const [version] = await f.db.insert(dataLibraryVersions).values({ owner: f.owner, sourceId: source.id,
      version: 1, contentHash: 'fixture', rawContent: 'Fictional facts', extractedText: 'Fictional facts',
      sections: [], byteLength: 15, extractionState: 'ready', observedAt: past }).returning();
    await f.db.insert(researchSourcePolicies).values({ owner: f.owner, sourceVersionId: version.id,
      dataClasses: [], permittedUses: ['research'] });
    const libraryReferences = [{ sourceId: source.id, versionId: version.id }];
    const documents = new ResearchDocumentsService(f.db);
    const generic = await documents.submit(f.owner, { idempotencyKey: randomUUID(), title: 'Generic sourced interpretation',
      kind: 'deep', content: 'Fictional interpretation', sections: [{ id: 'summary', title: 'Summary', content: 'Fictional interpretation' }],
      availableAt: past.toISOString(), snapshot: { libraryReferences } });
    const [session] = await f.db.insert(councilSessions).values({ owner: f.owner, ticker: 'ACME', profileVersion: 1,
      profileSnapshot: {} as never, status: 'completed' }).returning();
    const [report] = await f.db.insert(councilReports).values({ owner: f.owner, sessionId: session.id,
      revision: 1, version: 1, decision: 'wait', summary: 'Fictional original Council finding', dissent: [],
      nextReviewCondition: '', publicationOutcome: 'succeeded', engine: 'llm', evidence: [
        { id: 'e1', title: 'Filing', content: 'Fictional facts', sourceUrl: null, fetchedAt: past.toISOString(), libraryReferences },
      ] }).returning();
    const council = await f.db.transaction(tx => documents.importSourceInTransaction(tx, f.owner,
      { type: 'council', id: report.id }, { availableAt: past.toISOString(), snapshot: null }));
    const outputs = [generic, council].map(output => ({ kind: 'report_version' as const, id: output.id,
      revision: String(output.version), availability: 'available' as const }));
    const parentOnly = await documents.submit(f.owner, { idempotencyKey: randomUUID(), title: 'Persisted parent only',
      kind: 'deep', content: 'Fictional derived output', sections: [{ id: 'summary', title: 'Summary', content: 'Derived output' }],
      reportId: generic.reportId, parentVersionId: generic.id, availableAt: past.toISOString(), snapshot: null });
    const parentRef = { kind: 'report_version' as const, id: parentOnly.id, revision: String(parentOnly.version), availability: 'available' as const };
    for (const output of outputs) assert.ok(await sourceFingerprint(f.db, f.owner, output));
    assert.ok(await sourceFingerprint(f.db, f.owner, parentRef));
    await f.db.update(researchSourcePolicies).set({ revokedAt: past }).where(eq(researchSourcePolicies.sourceVersionId, version.id));
    for (const output of outputs) {
      await assert.rejects(assertReportVersionSources(f.db, f.owner, [{ versionId: output.id }], new Date()), /REPORT_LIBRARY_SOURCE_UNAVAILABLE/);
      await assert.rejects(sourceFingerprint(f.db, f.owner, output), teamErrorIs('TEAM_SOURCE_UNAVAILABLE'));
    }
    await assert.rejects(sourceFingerprint(f.db, f.owner, parentRef), teamErrorIs('TEAM_SOURCE_UNAVAILABLE'));
    await f.db.update(researchSourcePolicies).set({ revokedAt: null, retentionUntil: past }).where(eq(researchSourcePolicies.sourceVersionId, version.id));
    for (const output of outputs) {
      await assert.rejects(assertReportVersionSources(f.db, f.owner, [{ versionId: output.id }], new Date()), /REPORT_LIBRARY_SOURCE_UNAVAILABLE/);
      await assert.rejects(sourceFingerprint(f.db, f.owner, output), teamErrorIs('TEAM_SOURCE_UNAVAILABLE'));
    }
    await f.db.update(researchSourcePolicies).set({ retentionUntil: new Date(Date.now() + 86400000) })
      .where(eq(researchSourcePolicies.sourceVersionId, version.id));
    for (const output of outputs) assert.ok(await sourceFingerprint(f.db, f.owner, output));
    const [future] = await f.db.insert(dataLibraryVersions).values({ owner: f.owner, sourceId: source.id,
      version: 2, contentHash: 'future-fixture', rawContent: 'Not known yet', extractedText: 'Not known yet',
      sections: [], byteLength: 13, extractionState: 'ready', observedAt: new Date(Date.now() + 86400000) }).returning();
    const futureReport = await documents.submit(f.owner, { idempotencyKey: randomUUID(), title: 'Cannot backdate new input',
      kind: 'deep', content: 'Future input', sections: [{ id: 'summary', title: 'Summary', content: 'Future input' }],
      availableAt: past.toISOString(), snapshot: { libraryReferences: [{ sourceId: source.id, versionId: future.id }] } });
    await assert.rejects(sourceFingerprint(f.db, f.owner, { kind: 'report_version', id: futureReport.id,
      revision: '1', availability: 'available' }), teamErrorIs('TEAM_SOURCE_UNAVAILABLE'));
  } finally { await f.dispose(); }
});
