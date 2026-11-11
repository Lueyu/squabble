import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TeamStore } from './team-store';
import { teamCommissions, teamDecisions, teamResearchLinks, teamAccountBindings } from '../../database/teams.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchTheses, researchThesisVersions, researchMemories } from '../../database/research-memory.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { sourceFingerprint } from '../../database/team-source-context';
import { parseTeam, requestKeySchema, revisionSchema, sourceRefSchema, teamError, uuidSchema, pageFields, decodeTeamCursor, encodeTeamCursor } from './team-contract';
import type { TeamDecisionBasis, ResearchSourceRef } from '../../../shared/team-workspace.interface';
import type { TeamDatabase } from '../../database/team-context';
import { deriveTeamDecisionLineage } from '../../database/team-decision-lineage';
const basisSchema = z.object({ teamVersionId: uuidSchema, bindingId: uuidSchema, bindingRevision: revisionSchema, commissionId: uuidSchema,
    sessionId: uuidSchema, cycleId: uuidSchema, workKey: z.string().min(1).max(128), acceptedAttemptId: uuidSchema, reportVersionId: uuidSchema.nullable(),
    thesisVersions: z.array(z.object({ thesisId: uuidSchema, versionId: uuidSchema }).strict()).max(100), sourceRefs: z.array(sourceRefSchema).max(100) }).strict();
@Injectable()
export class TeamDecisionService {
    constructor(private readonly store: TeamStore) { }
    async list(owner: string, id: string, query: unknown) {
        await this.store.detail(owner, id);
        const request = parseTeam(z.object({ ...pageFields, accountId: uuidSchema.optional(), proposalId: uuidSchema.optional() }).strict(), query), cursor = decodeTeamCursor(request.cursor);
        const rows = await this.store.db.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.teamId, id), request.accountId ? eq(teamDecisions.accountId, request.accountId) : undefined, request.proposalId ? eq(teamDecisions.proposalId, request.proposalId) : undefined, cursor ? sql `(${teamDecisions.createdAt},${teamDecisions.id})<(${cursor.at}::timestamptz,${cursor.id}::uuid)` : undefined)).orderBy(desc(teamDecisions.createdAt), desc(teamDecisions.id)).limit(request.limit + 1);
        return { items: rows.slice(0, request.limit).map(row => ({ ...row, createdAt: row.createdAt.toISOString() })), nextCursor: rows.length > request.limit ? encodeTeamCursor(rows[request.limit - 1]) : null };
    }
    private async verify(tx: TeamDatabase, owner: string, id: string, basis: TeamDecisionBasis, event: string) {
        const [commission] = await tx.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, owner), eq(teamCommissions.teamId, id), eq(teamCommissions.id, basis.commissionId)));
        if (!commission || commission.sessionId !== basis.sessionId || commission.cycleId !== basis.cycleId || commission.teamVersionId !== basis.teamVersionId || commission.bindingId !== basis.bindingId || commission.bindingRevision !== basis.bindingRevision)
            teamError('TEAM_REFERENCE_NOT_FOUND');
        const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, basis.sessionId)));
        if (!session || session.deletedAt)
            teamError('TEAM_SOURCE_UNAVAILABLE');
        const [task] = await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner), eq(councilResearchTasks.sessionId, basis.sessionId), eq(councilResearchTasks.cycleId, basis.cycleId), eq(councilResearchTasks.workKey, basis.workKey)));
        const accepted = task?.attempts.find(a => a.id === basis.acceptedAttemptId);
        if (!task || task.state !== 'accepted' || task.acceptedAttemptId !== basis.acceptedAttemptId || accepted?.kind !== 'work' || accepted.state !== 'succeeded')
            teamError('TEAM_REFERENCE_NOT_FOUND', 'Decision must cite the accepted work attempt');
        const inputRefs = await deriveTeamDecisionLineage(tx, owner, commission, basis);
        if (basis.reportVersionId) {
            const [report] = await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.sessionId, basis.sessionId), eq(councilReports.researchVersionId, basis.reportVersionId)));
            const input = inputRefs.find(r => r.kind === 'report_version' && r.id === basis.reportVersionId);
            if (!report && !input)
                teamError('TEAM_REFERENCE_NOT_FOUND', 'Report is outside this delivery and input lineage');
            if (report && report.publicationOutcome !== 'succeeded')
                teamError('TEAM_SOURCE_UNAVAILABLE');
            if (report && !input && (report.coverage?.cycleId !== basis.cycleId || !report.coverage.tasks.some(ref => ref.id === task.id && ref.acceptedAttemptId === basis.acceptedAttemptId && ref.state === 'accepted')))
                teamError('TEAM_REFERENCE_NOT_FOUND', 'Report does not cite this accepted work attempt');
            const [version] = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, basis.reportVersionId)));
            if (!version)
                teamError('TEAM_SOURCE_UNAVAILABLE');
            await sourceFingerprint(tx, owner, { kind: 'report_version', id: version.id, revision: String(version.version), availability: 'available' });
        }
        for (const ref of basis.thesisVersions) {
            const [version] = await tx.select().from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.id, ref.versionId), eq(researchThesisVersions.thesisId, ref.thesisId)));
            if (!version)
                teamError('TEAM_REFERENCE_NOT_FOUND');
            const [thesis] = await tx.select().from(researchTheses).where(and(eq(researchTheses.owner, owner), eq(researchTheses.id, ref.thesisId)));
            const [memory] = thesis ? await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, thesis.memoryId))) : [];
            const input = inputRefs.find(r => r.kind === 'thesis_version' && r.id === version.id && r.revision === String(version.version));
            if (!input && memory?.sessionId !== basis.sessionId)
                teamError('TEAM_REFERENCE_NOT_FOUND', 'Thesis is outside this delivery and input lineage');
            if (!input) {
                const [report] = memory ? await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.id, memory.reportId))) : [];
                if (report?.coverage?.cycleId !== basis.cycleId || !report.coverage.tasks.some(ref => ref.id === task.id && ref.acceptedAttemptId === basis.acceptedAttemptId && ref.state === 'accepted'))
                    teamError('TEAM_REFERENCE_NOT_FOUND', 'Thesis source does not cite this accepted work attempt');
            }
            if (event === 'adopt' && version.status !== 'confirmed')
                teamError('TEAM_REAPPROVAL_REQUIRED', 'Thesis version needs explicit confirmation');
            await sourceFingerprint(tx, owner, { kind: 'thesis_version', id: version.id, revision: String(version.version), availability: 'available' }, input ? commission.plan.dataCutoffAt : undefined);
        }
        for (const ref of basis.sourceRefs) {
            if (!inputRefs.some(r => r.kind === ref.kind && r.id === ref.id && r.revision === ref.revision))
                teamError('TEAM_REFERENCE_NOT_FOUND');
            await sourceFingerprint(tx, owner, ref, commission.plan.dataCutoffAt);
        }
        if (event === 'adopt') {
            const [binding] = await tx.select().from(teamAccountBindings).where(and(eq(teamAccountBindings.ownerId, owner), eq(teamAccountBindings.id, basis.bindingId), eq(teamAccountBindings.state, 'active')));
            if (!binding || binding.teamId !== id || binding.accountId !== commission.accountId)
                teamError('TEAM_REAPPROVAL_REQUIRED');
        }
        return { commission, basis: { ...basis, sourceRefs: inputRefs } };
    }
    async create(owner: string, id: string, input: unknown) {
        const request = parseTeam(z.object({ requestKey: requestKeySchema, proposalId: uuidSchema.optional(), expectedProposalRevision: revisionSchema, commissionId: uuidSchema,
            event: z.enum(['propose', 'observe', 'defer', 'reject', 'adopt']), basis: basisSchema, reason: z.string().trim().min(1).max(4000), proposedPolicyDraftId: z.string().max(128).optional() }).strict(), input);
        return this.store.mutate(owner, id, 'decision', request, async (tx) => {
            await this.store.team(tx, owner, id, true);
            const basis = request.basis as TeamDecisionBasis;
            if (basis.commissionId !== request.commissionId)
                teamError('TEAM_INVALID_INPUT');
            const verified = await this.verify(tx, owner, id, basis, request.event), commission = verified.commission, proposalId = request.proposalId ?? randomUUID();
            const [last] = await tx.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.teamId, id), eq(teamDecisions.proposalId, proposalId))).orderBy(desc(teamDecisions.proposalRevision)).limit(1);
            if (request.proposalId && !last)
                teamError('TEAM_REFERENCE_NOT_FOUND');
            this.store.revision(last?.proposalRevision ?? 0, request.expectedProposalRevision);
            const [decision] = await tx.insert(teamDecisions).values({ ownerId: owner, teamId: id, accountId: commission.accountId, commissionId: commission.id, proposalId, proposalRevision: (last?.proposalRevision ?? 0) + 1,
                event: request.event, actorType: 'user', actorId: owner, basis: verified.basis, reason: request.reason, policyContext: request.proposedPolicyDraftId ? { proposedPolicyDraftId: request.proposedPolicyDraftId } : null, requestKey: request.requestKey }).returning();
            await tx.insert(teamResearchLinks).values({ ownerId: owner, teamId: id, commissionId: commission.id, kind: 'attempt', targetId: basis.acceptedAttemptId, targetRevision: null, relation: 'used', workKey: basis.workKey, attemptId: basis.acceptedAttemptId, metadata: { decisionId: decision.id } }).onConflictDoNothing();
            return { ...decision, createdAt: decision.createdAt.toISOString(), requestKey: request.requestKey };
        });
    }
}
