import { and, eq } from 'drizzle-orm';
import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { researchDocumentVersions } from './research-documents.schema';
import { researchThesisVersions, researchTheses, researchMemories } from './research-memory.schema';
import { dataLibraryVersions, dataLibrarySources } from './data-library.schema';
import { researchDatasetVersions, researchSourcePolicies } from './research-artifacts.schema';
import type { TeamDatabase } from './team-context';
import type { ResearchSourceRef } from '../../shared/team-workspace.interface';
import { teamSourceGrants } from './teams.schema';
import { assertReportVersionSources } from './report-source-fence';
import { councilReports, councilSessions } from './council.schema';
import { libraryEvidenceAvailable, libraryEvidenceReferences } from './data-library-visibility';
import type { DataLibraryReference } from '../../shared/data-library.interface';
function teamError(code: string, message: string = code): never { throw new HttpException({ code, message }, 422); }
function canonicalHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export async function sourceFingerprint(tx: TeamDatabase, owner: string, ref: ResearchSourceRef, cutoff?: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/i.test(ref.id))
        teamError('TEAM_SOURCE_UNAVAILABLE');
    if (ref.availability !== 'available')
        teamError('TEAM_SOURCE_UNAVAILABLE');
    let identity: Record<string, unknown> | null = null, availableAt: Date | null = null;
    if (ref.kind === 'report_version') {
        const [v] = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, ref.id)));
        if (v && !v.deletedAt && !v.revokedAt && String(v.version) === ref.revision) {
            try {
                const dependencies = await assertReportVersionSources(tx, owner, [{ versionId: v.id }], new Date(cutoff ?? Date.now()));
                identity = { id: v.id, revision: v.version, hash: v.contentHash, dependencies };
                availableAt = v.availableAt;
            }
            catch {
                teamError('TEAM_SOURCE_UNAVAILABLE', 'Report dependency chain is no longer available');
            }
        }
    }
    else if (ref.kind === 'thesis_version') {
        const [v] = await tx.select().from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.id, ref.id)));
        if (v && String(v.version) === ref.revision && !v.excluded) {
            const [t] = await tx.select().from(researchTheses).where(and(eq(researchTheses.owner, owner), eq(researchTheses.id, v.thesisId)));
            const [m] = t ? await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, t.memoryId))) : [];
            if (t && !t.deletedAt && !t.excluded && !['dismissed', 'expired'].includes(t.status) && m && !m.deletedAt && !m.excluded) {
                const [report] = await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.id, m.reportId)));
                const [session] = report ? await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, report.sessionId))) : [];
                if (report && session && !session.deletedAt && report.publicationOutcome !== 'failed' && await libraryEvidenceAvailable(tx, owner, report.evidence, true)) {
                    try {
                        const dependencies = report.researchVersionId ? await assertReportVersionSources(tx, owner, [{ versionId: report.researchVersionId }], new Date(cutoff ?? Date.now())) : [];
                        identity = { id: v.id, revision: v.version, status: v.status, dependencies };
                        availableAt = v.createdAt;
                    }
                    catch {
                        teamError('TEAM_SOURCE_UNAVAILABLE', 'Thesis source chain is no longer available');
                    }
                }
            }
        }
    }
    else {
        const [dataset] = ref.kind === 'data_snapshot' ? await tx.select().from(researchDatasetVersions).where(and(eq(researchDatasetVersions.owner, owner), eq(researchDatasetVersions.id, ref.id))) : [];
        const versionId = dataset?.sourceVersionId ?? ref.id;
        const [v] = await tx.select().from(dataLibraryVersions).where(and(eq(dataLibraryVersions.owner, owner), eq(dataLibraryVersions.id, versionId)));
        const [s] = v ? await tx.select().from(dataLibrarySources).where(and(eq(dataLibrarySources.owner, owner), eq(dataLibrarySources.id, v.sourceId))) : [];
        const [policy] = v ? await tx.select().from(researchSourcePolicies).where(and(eq(researchSourcePolicies.owner, owner), eq(researchSourcePolicies.sourceVersionId, v.id))) : [];
        if (v && s && s.enabled && !s.deletedAt && !policy?.revokedAt && (!policy?.retentionUntil || policy.retentionUntil > new Date()) && (dataset ? dataset.status === 'active' && dataset.contentHash === ref.revision : String(v.version) === ref.revision)) {
            identity = { id: ref.id, revision: ref.revision, hash: dataset?.contentHash ?? v.contentHash, sourceRevision: s.revision };
            availableAt = dataset?.createdAt ?? v.observedAt;
        }
    }
    if (!identity)
        teamError('TEAM_SOURCE_UNAVAILABLE', 'Exact source version is unavailable');
    if (cutoff && availableAt && availableAt.getTime() > new Date(cutoff).getTime())
        teamError('TEAM_SOURCE_UNAVAILABLE', 'Source became available after the data cutoff');
    return canonicalHash(identity);
}
/** Resolve only explicit, live grants. Returned text belongs in the current prompt, never a parallel cache. */
export async function readTeamSourceContents(tx: TeamDatabase, owner: string, teamId: string, refs: ResearchSourceRef[], cutoff: string) {
    const result: {
        ref: ResearchSourceRef;
        content: string;
        fingerprint: string;
    }[] = [];
    for (const ref of refs) {
        const [grant] = await tx.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, teamId), eq(teamSourceGrants.sourceKind, ref.kind), eq(teamSourceGrants.sourceId, ref.id), eq(teamSourceGrants.sourceRevision, ref.revision), eq(teamSourceGrants.state, 'active')));
        if (!grant)
            teamError('TEAM_SCOPE_REVOKED');
        const fingerprint = await sourceFingerprint(tx, owner, ref, cutoff);
        let content = '';
        if (ref.kind === 'report_version')
            content = (await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, ref.id))))[0].content;
        else if (ref.kind === 'thesis_version')
            content = JSON.stringify((await tx.select().from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.id, ref.id))))[0].content);
        else if (ref.kind === 'data_snapshot')
            content = JSON.stringify((await tx.select().from(researchDatasetVersions).where(and(eq(researchDatasetVersions.owner, owner), eq(researchDatasetVersions.id, ref.id))))[0].rows);
        else
            content = (await tx.select().from(dataLibraryVersions).where(and(eq(dataLibraryVersions.owner, owner), eq(dataLibraryVersions.id, ref.id))))[0].extractedText;
        result.push({ ref, content, fingerprint });
    }
    return result;
}

/** Output provenance does not authorize tools to read its underlying raw material. */
export async function fixedOutputLibraryReferences(tx: TeamDatabase, owner: string, ref: ResearchSourceRef, cutoff: string): Promise<DataLibraryReference[]> {
    if (ref.kind !== 'report_version' && ref.kind !== 'thesis_version')
        return [];
    await sourceFingerprint(tx, owner, ref, cutoff);
    const result: DataLibraryReference[] = [];
    let reportId: string | null = null;
    if (ref.kind === 'report_version') {
        const [version] = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, ref.id)));
        if (version) {
            result.push(...libraryEvidenceReferences(version.snapshot));
            if (version.source?.type === 'council')
                reportId = version.source.id;
        }
    }
    else {
        const [version] = await tx.select().from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.id, ref.id)));
        const [thesis] = version ? await tx.select().from(researchTheses).where(and(eq(researchTheses.owner, owner), eq(researchTheses.id, version.thesisId))) : [];
        const [memory] = thesis ? await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, thesis.memoryId))) : [];
        reportId = memory?.reportId ?? null;
    }
    const [report] = reportId ? await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.id, reportId))) : [];
    result.push(...libraryEvidenceReferences(report?.evidence));
    return [...new Map(result.map(library => [`${library.sourceId}:${library.versionId}`, library])).values()];
}
