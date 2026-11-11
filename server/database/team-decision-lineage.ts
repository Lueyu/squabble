import { and, eq } from 'drizzle-orm';
import { ConflictException } from '@nestjs/common';
import { teams, teamSourceGrants, teamCommissions } from './teams.schema';
import { councilResearchTasks } from './research-workflow.schema';
import { councilReports, councilSessions } from './council.schema';
import { dataLibraryVersions } from './data-library.schema';
import { researchTheses, researchThesisVersions, researchMemories } from './research-memory.schema';
import { researchDocumentVersions } from './research-documents.schema';
import { sourceFingerprint, fixedOutputLibraryReferences } from './team-source-context';
import type { TeamDatabase } from './team-context';
import type { ResearchSourceRef, TeamDecisionBasis } from '../../shared/team-workspace.interface';
/** Source authority is reconstructed from persisted inputs and accepted attempts, never from an optional client subset. */
export async function deriveTeamDecisionLineage(tx: TeamDatabase, owner: string, commission: typeof teamCommissions.$inferSelect, basis: TeamDecisionBasis): Promise<ResearchSourceRef[]> {
    const [team] = await tx.select().from(teams).where(and(eq(teams.ownerId, owner), eq(teams.id, commission.teamId)));
    if (!team || team.scopeRevision !== commission.scopeRevision)
        throw new ConflictException('TEAM_SCOPE_REVOKED');
    const refs: ResearchSourceRef[] = [...((commission.inputSnapshot.inputRefs ?? []) as ResearchSourceRef[])];
    const frozenGrants = [];
    for (const grantId of new Set(commission.members.flatMap(member => member.sourceGrantIds))) {
        const [grant] = await tx.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, commission.teamId), eq(teamSourceGrants.id, grantId), eq(teamSourceGrants.state, 'active')));
        if (!grant)
            throw new ConflictException('TEAM_SCOPE_REVOKED');
        frozenGrants.push(grant);
    }
    const tasks = await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner), eq(councilResearchTasks.sessionId, basis.sessionId), eq(councilResearchTasks.cycleId, basis.cycleId)));
    const required = new Set<string>();
    function visit(key: string): void { if (required.has(key))
        return; required.add(key); for (const dependency of commission.plan.work.find(work => work.workKey === key)?.dependencyWorkKeys ?? [])
        visit(dependency); }
    visit(basis.workKey);
    refs.push(...commission.plan.work.filter(work => required.has(work.workKey)).flatMap(work => work.inputRefs));
    const indirectlyAuthorized = new Set<string>();
    const inspectedOutputs = new Set<string>();
    async function includeOutputProvenance(ref: ResearchSourceRef): Promise<void> {
        if (!frozenGrants.some(grant => grant.sourceKind === ref.kind && grant.sourceId === ref.id && grant.sourceRevision === ref.revision))
            return;
        const key = [ref.kind, ref.id, ref.revision].join(':');
        if (inspectedOutputs.has(key))
            return;
        inspectedOutputs.add(key);
        if (ref.kind !== 'report_version' && ref.kind !== 'thesis_version')
            return;
        for (const library of await fixedOutputLibraryReferences(tx, owner, ref, commission.plan.dataCutoffAt))
            indirectlyAuthorized.add(`${library.sourceId}:${library.versionId}`);
    }
    for (const ref of refs)
        await includeOutputProvenance(ref);
    const submittedLibraries: Array<{ sourceId: string; versionId: string }> = [];
    for (const task of tasks.filter(task => required.has(task.workKey ?? ''))) {
        const attempt = task.attempts.find(item => item.id === task.acceptedAttemptId);
        if (!attempt || attempt.kind !== 'work' || attempt.state !== 'succeeded')
            throw new ConflictException('TEAM_REFERENCE_NOT_FOUND');
        submittedLibraries.push(...(attempt.libraryReferences ?? []));
        for (const memory of attempt.memory?.submitted ?? []) {
            if (memory.kind === 'thesis') {
                const [version] = await tx.select().from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.thesisId, memory.id), eq(researchThesisVersions.version, memory.version)));
                if (!version)
                    throw new ConflictException('TEAM_SOURCE_UNAVAILABLE');
                const ref = { kind: 'thesis_version' as const, id: version.id, revision: String(version.version), availability: 'available' as const };
                refs.push(ref);
                await includeOutputProvenance(ref);
            }
            else {
                const [entry] = await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, memory.id), eq(researchMemories.reportVersion, memory.version)));
                const [report] = entry ? await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.id, entry.reportId))) : [];
                if (!report?.researchVersionId)
                    throw new ConflictException('TEAM_SOURCE_UNAVAILABLE');
                const [version] = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, report.researchVersionId)));
                if (!version)
                    throw new ConflictException('TEAM_SOURCE_UNAVAILABLE');
                const ref = { kind: 'report_version' as const, id: version.id, revision: String(version.version), availability: 'available' as const };
                refs.push(ref);
                await includeOutputProvenance(ref);
            }
        }
    }
    for (const library of submittedLibraries) {
        const [version] = await tx.select().from(dataLibraryVersions).where(and(eq(dataLibraryVersions.owner, owner), eq(dataLibraryVersions.id, library.versionId), eq(dataLibraryVersions.sourceId, library.sourceId)));
        if (!version)
            throw new ConflictException('TEAM_SOURCE_UNAVAILABLE');
        const ref = { kind: 'document_version' as const, id: version.id, revision: String(version.version), availability: 'available' as const };
        // Reading a fixed output does not grant direct access to its raw inputs.
        // Keep submitted provenance intact and revalidate it, while the basis names the authorized output.
        if (indirectlyAuthorized.has(`${library.sourceId}:${library.versionId}`))
            await sourceFingerprint(tx, owner, ref, commission.plan.dataCutoffAt);
        else
            refs.push(ref);
    }
    const unique = [...new Map(refs.map(ref => [[ref.kind, ref.id, ref.revision].join(':'), ref])).values()];
    for (const ref of unique) {
        if (!frozenGrants.some(grant => grant.sourceKind === ref.kind && grant.sourceId === ref.id && grant.sourceRevision === ref.revision)) {
            // Team-owned report/thesis outputs may be recalled without granting the owner's entire library.
            let reportId: string | null = null;
            if (ref.kind === 'report_version')
                reportId = (await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.researchVersionId, ref.id))))[0]?.id ?? null;
            if (ref.kind === 'thesis_version') {
                const [version] = await tx.select().from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.id, ref.id)));
                if (version) {
                    const [thesis] = await tx.select().from(researchTheses).where(and(eq(researchTheses.owner, owner), eq(researchTheses.id, version.thesisId)));
                    const [memory] = thesis ? await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, thesis.memoryId))) : [];
                    reportId = memory?.reportId ?? null;
                }
            }
            const [report] = reportId ? await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.id, reportId))) : [];
            const [session] = report ? await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, report.sessionId))) : [];
            if (session?.teamContext?.teamId !== commission.teamId)
                throw new ConflictException('TEAM_SCOPE_REVOKED');
        }
        await sourceFingerprint(tx, owner, ref, commission.plan.dataCutoffAt);
    }
    return unique.sort((a, b) => (a.kind + a.id + a.revision).localeCompare(b.kind + b.id + b.revision));
}
