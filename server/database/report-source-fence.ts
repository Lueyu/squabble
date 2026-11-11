import { and, eq, inArray, isNull } from 'drizzle-orm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { researchDocumentVersions } from './research-documents.schema';
import { analysis, deepReport, portfolioAnalysisRuns } from './schema';
import { councilReports, councilSessions } from './council.schema';
import { libraryEvidenceAvailable, libraryEvidenceReferences } from './data-library-visibility';
import type { TeamDatabase } from './team-context';
import type { ReportReference, ResearchInputSnapshot } from '../../shared/research-document.interface';
import type { TeamExecutionContext, ResearchSourceRef } from '../../shared/team-workspace.interface';
import { teamSourceGrants } from './teams.schema';
import { dataLibrarySources, dataLibraryVersions } from './data-library.schema';
import { researchDatasetVersions, researchSourcePolicies } from './research-artifacts.schema';
import { researchTheses, researchThesisVersions, researchMemories } from './research-memory.schema';
function dependencies(snapshot: ResearchInputSnapshot | null): ReportReference[] {
    const result: ReportReference[] = [];
    function collect(record: Record<string, unknown>): void {
        for (const key of ['references', 'resolvedReferences', 'reportReferences']) {
            if (record[key] === null || record[key] === undefined)
                continue;
            if (!Array.isArray(record[key]) || record[key].length > 100)
                throw new ConflictException('REPORT_REFERENCE_CHAIN_INVALID');
            for (const item of record[key]) {
                if (!item || typeof item !== 'object' || !('versionId' in item) || typeof item.versionId !== 'string')
                    throw new ConflictException('REPORT_REFERENCE_CHAIN_INVALID');
                result.push(item as ReportReference);
            }
        }
        if (record.sourceReportVersionId !== null && record.sourceReportVersionId !== undefined) {
            if (typeof record.sourceReportVersionId !== 'string')
                throw new ConflictException('REPORT_REFERENCE_CHAIN_INVALID');
            result.push({ versionId: record.sourceReportVersionId });
        }
    }
    if (snapshot) {
        collect(snapshot);
        if (snapshot.continuationSummary && typeof snapshot.continuationSummary === 'object')
            collect(snapshot.continuationSummary as Record<string, unknown>);
    }
    return result;
}
/** Shared recursive database fence for research inputs and execution. Every ancestor remains live and available as of the decision cutoff. */
export async function assertReportVersionSources(tx: Pick<TeamDatabase, 'select'>, owner: string, references: ReportReference[], decisionAt: Date) {
    if (!Number.isFinite(decisionAt.getTime()))
        throw new ConflictException('REPORT_INVALID_DECISION_TIME');
    const active = new Set<string>(), complete = new Map<string, {
        id: string;
        contentHash: string;
    }>();
    const checkedLibrary = new Set<string>();
    async function assertLibraryPolicies(value: unknown): Promise<void> {
        const refs = libraryEvidenceReferences(value).filter(ref => !checkedLibrary.has(`${ref.sourceId}:${ref.versionId}`));
        if (!refs.length) return;
        const ids = [...new Set(refs.map(ref => ref.versionId))];
        const versions = await tx.select({ id: dataLibraryVersions.id, sourceId: dataLibraryVersions.sourceId,
            observedAt: dataLibraryVersions.observedAt }).from(dataLibraryVersions)
            .where(and(eq(dataLibraryVersions.owner, owner), inArray(dataLibraryVersions.id, ids))).for('share');
        const policies = await tx.select({ sourceVersionId: researchSourcePolicies.sourceVersionId,
            revokedAt: researchSourcePolicies.revokedAt, retentionUntil: researchSourcePolicies.retentionUntil })
            .from(researchSourcePolicies).where(and(eq(researchSourcePolicies.owner, owner),
                inArray(researchSourcePolicies.sourceVersionId, ids))).for('share');
        for (const ref of refs) {
            const version = versions.find(row => row.id === ref.versionId && row.sourceId === ref.sourceId);
            const policy = policies.find(row => row.sourceVersionId === ref.versionId);
            if (!version || !Number.isFinite(version.observedAt.getTime()) || version.observedAt > decisionAt
                || policy?.revokedAt || policy?.retentionUntil && policy.retentionUntil <= new Date())
                throw new ConflictException('REPORT_LIBRARY_SOURCE_UNAVAILABLE');
            checkedLibrary.add(`${ref.sourceId}:${ref.versionId}`);
        }
    }
    async function inspect(ref: ReportReference, depth: number): Promise<void> {
        if (active.has(ref.versionId) || depth > 50 || active.size + complete.size >= 100)
            throw new ConflictException('REPORT_REFERENCE_CHAIN_INVALID');
        const [v] = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, ref.versionId))).for('share');
        if (!v || v.deletedAt)
            throw new NotFoundException('REPORT_NOT_FOUND');
        if (v.revokedAt)
            throw new ConflictException('REPORT_REVOKED');
        const section = ref.sectionId ? v.sections.find(s => s.id === ref.sectionId) : null;
        if (ref.sectionId && !section)
            throw new NotFoundException('REPORT_SECTION_NOT_FOUND');
        if (ref.excerpt && !(section?.content ?? v.content).includes(ref.excerpt))
            throw new BadRequestException('REPORT_EXCERPT_MISMATCH');
        if (complete.has(v.id))
            return;
        active.add(v.id);
        if (!await libraryEvidenceAvailable(tx, owner, v.snapshot, true))
            throw new ConflictException('REPORT_LIBRARY_SOURCE_UNAVAILABLE');
        await assertLibraryPolicies(v.snapshot);
        const teamContext = v.snapshot?.teamExecutionContext as TeamExecutionContext | undefined;
        if (teamContext) {
            if (teamContext.ownerId !== owner || teamContext.audience !== 'team' || !Array.isArray(teamContext.members))
                throw new ConflictException('REPORT_REFERENCE_CHAIN_INVALID');
            for (const grantId of new Set(teamContext.members.flatMap(member => member.sourceGrantIds))) {
                const [grant] = await tx.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, teamContext.teamId), eq(teamSourceGrants.id, grantId), eq(teamSourceGrants.state, 'active'))).for('share');
                if (!grant)
                    throw new ConflictException('REPORT_LIBRARY_SOURCE_UNAVAILABLE');
            }
        }
        const explicitInputs = v.snapshot?.inputRefs;
        if (explicitInputs !== undefined && !Array.isArray(explicitInputs))
            throw new ConflictException('REPORT_REFERENCE_CHAIN_INVALID');
        const sourceRefs = [...((explicitInputs ?? []) as ResearchSourceRef[]), ...((teamContext?.inputSnapshot?.inputRefs ?? []) as ResearchSourceRef[]), ...(teamContext?.plan.work.flatMap(work => work.inputRefs) ?? [])];
        for (const ref of sourceRefs) {
            if (!ref || typeof ref.id !== 'string' || typeof ref.revision !== 'string')
                throw new ConflictException('REPORT_REFERENCE_CHAIN_INVALID');
            if (ref.kind === 'report_version') {
                await inspect({ versionId: ref.id }, depth + 1);
                continue;
            }
            if (ref.kind === 'thesis_version') {
                const [version] = await tx.select().from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.id, ref.id)));
                const [thesis] = version ? await tx.select().from(researchTheses).where(and(eq(researchTheses.owner, owner), eq(researchTheses.id, version.thesisId))) : [];
                const [memory] = thesis ? await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, thesis.memoryId))) : [];
                if (!version || String(version.version) !== ref.revision || version.excluded || !thesis || thesis.deletedAt || thesis.excluded || !memory || memory.deletedAt || memory.excluded || version.createdAt > decisionAt)
                    throw new ConflictException('REPORT_LIBRARY_SOURCE_UNAVAILABLE');
                const [report] = await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.id, memory.reportId)));
                if (!report?.researchVersionId)
                    throw new ConflictException('REPORT_SOURCE_MISSING');
                await inspect({ versionId: report.researchVersionId }, depth + 1);
                continue;
            }
            const [dataset] = ref.kind === 'data_snapshot' ? await tx.select().from(researchDatasetVersions).where(and(eq(researchDatasetVersions.owner, owner), eq(researchDatasetVersions.id, ref.id))) : [];
            const [version] = await tx.select().from(dataLibraryVersions).where(and(eq(dataLibraryVersions.owner, owner), eq(dataLibraryVersions.id, dataset?.sourceVersionId ?? ref.id)));
            const [source] = version ? await tx.select().from(dataLibrarySources).where(and(eq(dataLibrarySources.owner, owner), eq(dataLibrarySources.id, version.sourceId))).for('share') : [];
            const [policy] = version ? await tx.select().from(researchSourcePolicies).where(and(eq(researchSourcePolicies.owner, owner), eq(researchSourcePolicies.sourceVersionId, version.id))) : [];
            if (!version || !source || !source.enabled || source.deletedAt || version.observedAt > decisionAt || policy?.revokedAt || policy?.retentionUntil && policy.retentionUntil <= new Date() ||
                (dataset ? dataset.status !== 'active' || dataset.contentHash !== ref.revision : String(version.version) !== ref.revision))
                throw new ConflictException('REPORT_LIBRARY_SOURCE_UNAVAILABLE');
        }
        if (v.source) {
            let exists = false;
            if (v.source.type === 'daily')
                exists = (await tx.select({ id: analysis.id }).from(analysis).where(and(eq(analysis.owner, owner), eq(analysis.id, v.source.id))).for('share')).length > 0;
            else if (v.source.type === 'deep')
                exists = (await tx.select({ id: deepReport.id }).from(deepReport).where(and(eq(deepReport.owner, owner), eq(deepReport.id, v.source.id))).for('share')).length > 0;
            else if (v.source.type === 'portfolio') {
                const [source] = await tx.select().from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner, owner), eq(portfolioAnalysisRuns.id, v.source.id))).for('share');
                exists = source?.status === 'completed' && Boolean(source.report);
            }
            else {
                const [source] = await tx.select({ report: councilReports }).from(councilReports).innerJoin(councilSessions, and(eq(councilSessions.owner, owner), eq(councilSessions.id, councilReports.sessionId), isNull(councilSessions.deletedAt))).where(and(eq(councilReports.owner, owner), eq(councilReports.id, v.source.id))).for('share');
                exists = Boolean(source && source.report.publicationOutcome !== 'failed' && await libraryEvidenceAvailable(tx, owner, source.report.evidence, true));
                if (exists) await assertLibraryPolicies(source.report.evidence);
            }
            if (!exists)
                throw new ConflictException('REPORT_SOURCE_MISSING');
        }
        // Preserve the public report API's missing/unknown/future distinctions.
        if (!v.availableAt)
            throw new ConflictException('REPORT_AVAILABILITY_UNKNOWN');
        if (v.availableAt > decisionAt)
            throw new ConflictException('REPORT_NOT_YET_AVAILABLE');
        if (v.dataAsOf && v.dataAsOf > decisionAt)
            throw new ConflictException('REPORT_FUTURE_DATA');
        try {
            const parents = dependencies(v.snapshot);
            if (v.parentVersionId) parents.push({ versionId: v.parentVersionId });
            for (const dependency of parents)
                await inspect(dependency, depth + 1);
        }
        catch {
            throw new ConflictException('REPORT_TRANSITIVE_SOURCE_INVALID');
        }
        active.delete(v.id);
        complete.set(v.id, { id: v.id, contentHash: v.contentHash });
    }
    for (const ref of references)
        await inspect(ref, 0);
    return [...complete.values()].sort((a, b) => a.id.localeCompare(b.id));
}
