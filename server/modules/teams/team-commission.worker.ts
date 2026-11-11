import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { and, eq, sql, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { teamCommissions, teamCommissionJobs, teamResearchLinks } from '../../database/teams.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { sourceFingerprint } from '../../database/team-source-context';
import { assertTeamExecutionInTransaction, lockTeamOwner } from '../../database/team-context';
import { TeamStore } from './team-store';
import { TeamRuntimeAdapter } from './team-runtime-adapter';
import { TeamCommissionService, commissionContext } from './team-commission.service';
import { teamCapabilities } from './team-config';
import type { RecoveryInput } from '../../../shared/team-workspace.interface';
/** Durable bridge only: research tasks, attempts and external handles remain owned by Council. */
@Injectable()
export class TeamCommissionWorker implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(TeamCommissionWorker.name);
    private readonly leaseOwner = randomUUID();
    private timer?: ReturnType<typeof setInterval>;
    private busy = false;
    private closed = false;
    constructor(private readonly store: TeamStore, private readonly runtime: TeamRuntimeAdapter, private readonly commissions: TeamCommissionService) { }
    onModuleInit(): void {
        this.timer = setInterval(() => { void this.tick(); }, 2000);
        this.timer.unref();
        void this.tick();
    }
    onModuleDestroy(): void { this.closed = true; if (this.timer)
        clearInterval(this.timer); }
    private async tick(): Promise<void> {
        if (this.busy || this.closed)
            return;
        this.busy = true;
        try {
            await this.runOnce();
            await this.projectActive();
        }
        catch (error) {
            this.logger.error(error instanceof Error ? error.message : 'Team worker failed');
        }
        finally {
            this.busy = false;
        }
    }
    async runOnce(): Promise<void> {
        const expired = await this.store.db.select().from(teamCommissionJobs).where(and(eq(teamCommissionJobs.state, 'claimed'), sql `${teamCommissionJobs.leaseUntil}<now()`, inArray(teamCommissionJobs.kind, ['start', 'recover', 'cancel'])));
        for (const stale of expired)
            await this.store.db.update(teamCommissions).set({ state: 'uncertain', lastError: { code: 'TEAM_EXECUTION_UNCERTAIN' }, updatedAt: new Date() }).where(and(eq(teamCommissions.id, stale.commissionId), sql `${teamCommissions.state} NOT IN ('completed','cancelled')`));
        // Recovered send-adjacent commands remain uncertain. Only local prepare/project jobs may be reclaimed.
        await this.store.db.update(teamCommissionJobs).set({ state: 'uncertain', lastError: { code: 'TEAM_EXECUTION_UNCERTAIN' }, updatedAt: new Date() })
            .where(and(eq(teamCommissionJobs.state, 'claimed'), sql `${teamCommissionJobs.leaseUntil}<now()`, inArray(teamCommissionJobs.kind, ['start', 'recover', 'cancel'])));
        await this.store.db.update(teamCommissionJobs).set({ state: 'pending', leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
            .where(and(eq(teamCommissionJobs.state, 'claimed'), sql `${teamCommissionJobs.leaseUntil}<now()`, inArray(teamCommissionJobs.kind, ['prepare', 'project'])));
        const job = await this.store.db.transaction(async (tx) => {
            const [candidate] = await tx.select().from(teamCommissionJobs).where(and(eq(teamCommissionJobs.state, 'pending'), sql `${teamCommissionJobs.nextAttemptAt}<=now()`))
                .orderBy(teamCommissionJobs.createdAt).limit(1).for('update', { skipLocked: true });
            if (!candidate)
                return null;
            const [claimed] = await tx.update(teamCommissionJobs).set({ state: 'claimed', attempts: candidate.attempts + 1, leaseOwner: this.leaseOwner, leaseUntil: new Date(Date.now() + 30000), updatedAt: new Date() }).where(eq(teamCommissionJobs.id, candidate.id)).returning();
            return claimed;
        });
        if (!job)
            return;
        let enteredExternal = false;
        const heartbeat = setInterval(() => { void this.store.db.update(teamCommissionJobs).set({ leaseUntil: new Date(Date.now() + 30000) }).where(and(eq(teamCommissionJobs.id, job.id), eq(teamCommissionJobs.state, 'claimed'), eq(teamCommissionJobs.leaseOwner, this.leaseOwner))).catch(() => undefined); }, 10000);
        heartbeat.unref();
        try {
            if (job.kind === 'prepare') {
                await this.store.db.transaction(async (tx) => {
                    await lockTeamOwner(tx, job.ownerId);
                    const [leased] = await tx.select().from(teamCommissionJobs).where(and(eq(teamCommissionJobs.id, job.id), eq(teamCommissionJobs.state, 'claimed'), eq(teamCommissionJobs.leaseOwner, this.leaseOwner))).for('update');
                    if (!leased || !leased.leaseUntil || leased.leaseUntil.getTime() <= Date.now())
                        throw new Error('TEAM_LEASE_LOST');
                    const [commission] = await tx.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, job.ownerId), eq(teamCommissions.id, job.commissionId))).for('update');
                    if (!commission)
                        throw new Error('TEAM_REFERENCE_NOT_FOUND');
                    await assertTeamExecutionInTransaction(tx, job.ownerId, commissionContext(commission));
                    const prepared = commission.sessionId ? { sessionId: commission.sessionId, cycleId: commission.cycleId, rootBudgetTaskId: commission.rootBudgetTaskId } : await this.runtime.prepare(tx, commissionContext(commission));
                    await tx.update(teamCommissions).set({ ...prepared, updatedAt: new Date() }).where(eq(teamCommissions.id, commission.id));
                    await tx.insert(teamCommissionJobs).values({ ownerId: job.ownerId, commissionId: commission.id, kind: 'start', commandKey: 'start:v1', payload: {} }).onConflictDoNothing();
                    await tx.update(teamCommissionJobs).set({ state: 'done', leaseUntil: null, updatedAt: new Date() }).where(eq(teamCommissionJobs.id, job.id));
                });
                return;
            }
            const [commission] = await this.store.db.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, job.ownerId), eq(teamCommissions.id, job.commissionId)));
            if (!commission)
                throw new Error('TEAM_REFERENCE_NOT_FOUND');
            if (job.kind === 'start') {
                if (!teamCapabilities().researchEnabled)
                    throw new Error('TEAM_CAPABILITY_UNAVAILABLE');
                if (!commission.sessionId)
                    throw new Error('TEAM_REFERENCE_NOT_FOUND');
                await this.store.db.transaction(async (tx) => { await lockTeamOwner(tx, job.ownerId); await assertTeamExecutionInTransaction(tx, job.ownerId, commissionContext(commission)); });
                // The durable Council command accepts job.id once before entering its original executor.
                enteredExternal = true;
                await this.runtime.start(job.ownerId, job.id, commission.sessionId);
                await this.store.db.update(teamCommissions).set({ state: 'running', updatedAt: new Date() }).where(and(eq(teamCommissions.id, commission.id), eq(teamCommissions.state, 'queued')));
            }
            else if (job.kind === 'cancel') {
                if (commission.sessionId) {
                    enteredExternal = true;
                    await this.runtime.cancel(job.ownerId, commission.sessionId);
                }
                const tasks = commission.sessionId ? await this.store.db.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, job.ownerId), eq(councilResearchTasks.sessionId, commission.sessionId))) : [];
                const uncertain = tasks.some(t => t.attempts.some(a => a.state === 'uncertain' || a.state === 'running'));
                await this.store.db.update(teamCommissions).set({ state: uncertain ? 'uncertain' : 'cancelled', completedAt: uncertain ? null : new Date(), updatedAt: new Date() }).where(eq(teamCommissions.id, commission.id));
            }
            else if (job.kind === 'recover') {
                if (commission.sessionId) {
                    enteredExternal = job.payload.action !== 'check_existing' && job.payload.action !== 'reparse_existing';
                    await this.runtime.recover(job.ownerId, commission.sessionId, job.payload as unknown as RecoveryInput);
                }
                // No session/remote handle means there is no execution to re-send. Check remains read-only.
                await this.project(commission.id);
            }
            else if (job.kind === 'project')
                await this.project(commission.id);
            await this.store.db.update(teamCommissionJobs).set({ state: 'done', leaseUntil: null, updatedAt: new Date() }).where(and(eq(teamCommissionJobs.id, job.id), eq(teamCommissionJobs.state, 'claimed'), eq(teamCommissionJobs.leaseOwner, this.leaseOwner)));
        }
        catch (error) {
            const text = error instanceof Error ? error.message : 'TEAM_DEPENDENCY_UNAVAILABLE';
            const safety = /TEAM_(SCOPE_REVOKED|BINDING_CONFLICT|BUDGET_BLOCKED|CAPABILITY_UNAVAILABLE|PREVIEW_STALE|REFERENCE_NOT_FOUND)/u.test(text);
            const unsafe = enteredExternal && !safety;
            const state = unsafe ? 'uncertain' : safety || job.attempts >= 3 ? 'blocked' : 'pending';
            const fenced = await this.store.db.update(teamCommissionJobs).set({ state, leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.min(30000, 1000 * 2 ** job.attempts)), lastError: { code: unsafe ? 'TEAM_EXECUTION_UNCERTAIN' : 'TEAM_DEPENDENCY_UNAVAILABLE', message: text }, updatedAt: new Date() }).where(and(eq(teamCommissionJobs.id, job.id), eq(teamCommissionJobs.state, 'claimed'), eq(teamCommissionJobs.leaseOwner, this.leaseOwner))).returning({ id: teamCommissionJobs.id });
            if (fenced.length && (unsafe || state === 'blocked'))
                await this.store.db.update(teamCommissions).set({ state: unsafe ? 'uncertain' : 'blocked', lastError: { code: unsafe ? 'TEAM_EXECUTION_UNCERTAIN' : 'TEAM_DEPENDENCY_UNAVAILABLE', message: text }, updatedAt: new Date() }).where(and(eq(teamCommissions.id, job.commissionId), sql `${teamCommissions.state} NOT IN ('completed','cancelled')`));
        }
        finally {
            clearInterval(heartbeat);
        }
    }
    async projectActive(): Promise<void> {
        const rows = await this.store.db.select({ id: teamCommissions.id }).from(teamCommissions).where(and(sql `${teamCommissions.sessionId} IS NOT NULL`, inArray(teamCommissions.state, ['running', 'awaiting_review', 'uncertain', 'cancelling']))).limit(100);
        for (const row of rows)
            await this.project(row.id);
    }
    async project(id: string): Promise<void> {
        const [hint] = await this.store.db.select({ ownerId: teamCommissions.ownerId }).from(teamCommissions).where(eq(teamCommissions.id, id));
        if (!hint)
            return;
        await this.store.db.transaction(async (tx) => {
            await lockTeamOwner(tx, hint.ownerId);
            const [commission] = await tx.select().from(teamCommissions).where(eq(teamCommissions.id, id)).for('update');
            if (!commission?.sessionId)
                return;
            const tasks = await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, commission.ownerId), eq(councilResearchTasks.sessionId, commission.sessionId), commission.cycleId ? eq(councilResearchTasks.cycleId, commission.cycleId) : undefined));
            for (const task of tasks) {
                await tx.insert(teamResearchLinks).values({ ownerId: commission.ownerId, teamId: commission.teamId, commissionId: id, kind: 'task', targetId: task.id, targetRevision: String(task.revision), relation: 'produced', workKey: task.workKey ?? task.key, metadata: { state: task.state } }).onConflictDoUpdate({ target: [teamResearchLinks.commissionId, teamResearchLinks.kind, teamResearchLinks.targetId, teamResearchLinks.targetRevision, teamResearchLinks.relation], set: { metadata: { state: task.state } } });
                for (const attempt of task.attempts)
                    await tx.insert(teamResearchLinks).values({ ownerId: commission.ownerId, teamId: commission.teamId, commissionId: id, kind: 'attempt', targetId: attempt.id, targetRevision: String(attempt.revision), relation: attempt.kind === 'review' ? 'reviewed' : 'produced', workKey: task.workKey ?? task.key, attemptId: attempt.id, metadata: { state: attempt.state, accepted: task.acceptedAttemptId === attempt.id } }).onConflictDoUpdate({ target: [teamResearchLinks.commissionId, teamResearchLinks.kind, teamResearchLinks.targetId, teamResearchLinks.targetRevision, teamResearchLinks.relation], set: { metadata: { state: attempt.state, accepted: task.acceptedAttemptId === attempt.id } } });
            }
            const reports = await tx.select().from(councilReports).where(and(eq(councilReports.owner, commission.ownerId), eq(councilReports.sessionId, commission.sessionId)));
            const linkedReports = new Set<string>();
            for (const report of reports) {
                if (!report.researchVersionId || report.publicationOutcome !== 'succeeded' || report.coverage?.cycleId !== commission.cycleId)
                    continue;
                const acceptedSummary = report.coverage.tasks.find(task => task.key === 'summary' && task.state === 'accepted' && task.acceptedAttemptId);
                const summary = acceptedSummary ? tasks.find(task => task.id === acceptedSummary.id && task.cycleId === report.coverage!.cycleId && task.revision === report.revision && task.workKey && task.attempts.some(attempt => attempt.id === acceptedSummary.acceptedAttemptId && attempt.kind === 'work' && attempt.state === 'succeeded')) : undefined;
                if (!summary || !acceptedSummary)
                    continue;
                const [version] = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, commission.ownerId), eq(researchDocumentVersions.id, report.researchVersionId)));
                if (!version)
                    continue;
                linkedReports.add(report.id);
                const metadata = { reportId: report.id, reportVersion: report.version, cycleId: report.coverage.cycleId, summaryTaskId: summary.id };
                await tx.insert(teamResearchLinks).values({ ownerId: commission.ownerId, teamId: commission.teamId, commissionId: id, kind: 'report_version', targetId: version.id, targetRevision: String(version.version), relation: 'produced', workKey: summary.workKey, attemptId: acceptedSummary.acceptedAttemptId, metadata })
                    .onConflictDoUpdate({ target: [teamResearchLinks.commissionId, teamResearchLinks.kind, teamResearchLinks.targetId, teamResearchLinks.targetRevision, teamResearchLinks.relation], set: { workKey: summary.workKey, attemptId: acceptedSummary.acceptedAttemptId, metadata } });
            }
            if (['completed', 'cancelled'].includes(commission.state))
                return;
            // A missing task or a text response is never sufficient completion evidence.
            const unknown = tasks.some(t => t.state === 'uncertain' || t.attempts.some(a => a.state === 'uncertain' || a.externalUsageUnknown && a.state === 'running'));
            const accepted = tasks.filter(t => t.state === 'accepted' && t.acceptedAttemptId);
            const complete = commission.plan.work.every(w => tasks.some(t => t.workKey === w.workKey && t.state === 'accepted' && t.acceptedAttemptId));
            let state = commission.state;
            if (unknown)
                state = 'uncertain';
            else if (complete)
                state = 'completed';
            else if (tasks.some(t => t.state === 'submitted' || t.state === 'needs_revision'))
                state = 'awaiting_review';
            else if (tasks.length && tasks.every(t => ['accepted', 'failed', 'cancelled', 'blocked'].includes(t.state)))
                state = accepted.length ? 'partial' : tasks.some(t => t.state === 'blocked') ? 'blocked' : 'failed';
            else if (tasks.some(t => t.state === 'running'))
                state = 'running';
            const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, commission.ownerId), eq(councilSessions.id, commission.sessionId)));
            if (!session || session.deletedAt)
                state = 'blocked';
            const published = reports.filter(report => linkedReports.has(report.id) && report.revision === session?.revision && report.coverage?.cycleId === commission.cycleId
                && report.coverage.tasks.every(snapshot => tasks.some(task => task.id === snapshot.id && task.state === snapshot.state && task.acceptedAttemptId === snapshot.acceptedAttemptId)))
                .sort((a, b) => b.version - a.version)[0];
            if (complete && !published)
                state = session?.status === 'failed' ? 'partial' : 'awaiting_review';
            if (complete && published?.coverage?.complete !== true && published)
                state = 'partial';
            if (session?.status === 'failed' && !published)
                state = accepted.length ? 'partial' : 'failed';
            if (tasks.length) {
                try {
                    await assertTeamExecutionInTransaction(tx, commission.ownerId, commissionContext(commission), { publication: true });
                    if (published?.researchVersionId) {
                        const [version] = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, commission.ownerId), eq(researchDocumentVersions.id, published.researchVersionId)));
                        if (!version)
                            throw new Error('TEAM_SOURCE_UNAVAILABLE');
                        await sourceFingerprint(tx, commission.ownerId, { kind: 'report_version', id: version.id, revision: String(version.version), availability: 'available' });
                    }
                }
                catch {
                    state = 'blocked';
                }
            }
            if (state !== commission.state)
                await tx.update(teamCommissions).set({ state, commissionRevision: commission.commissionRevision + 1, completedAt: ['completed', 'partial', 'failed', 'cancelled'].includes(state) ? new Date() : null, updatedAt: new Date() }).where(eq(teamCommissions.id, id));
        });
    }
}
