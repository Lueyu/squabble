import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { TeamRunService, type AgreementRow, type RunCycleRow } from './team-run.service';
import { teamResearchLinks, teamDecisions, teamCommissions } from '../../database/teams.schema';
import { teamRunCycles } from '../../database/team-run.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { assertTeamRunAuthority } from '../../database/team-run-authority';
import { lockTeamOwner } from '../../database/team-context';
import { TeamDecisionService } from '../teams/team-decision.service';
import { UserInvestmentStrategyService } from '../paper-trading/user-investment-strategy.service';
import { PortfolioWorkspaceService } from '../paper-trading/portfolio-workspace.service';
import { parseReportExecutionPlan, REPORT_EXECUTION_SECTION_ID } from '../paper-trading/report-execution-plan';
import type { TeamDecisionBasis } from '../../../shared/team-workspace.interface';

/** Convert one exact accepted delivery into an auditable system decision and the existing paper-bot application path. */
@Injectable()
export class TeamRunDelivery {
  constructor(private readonly runs: TeamRunService, private readonly decisions: TeamDecisionService,
    private readonly strategies: UserInvestmentStrategyService, private readonly workspace: PortfolioWorkspaceService) {}
  async process(agreement: AgreementRow, cycle: RunCycleRow, commission: typeof teamCommissions.$inferSelect): Promise<void> {
    const owner = agreement.ownerId, authority = { agreementId: agreement.id, revision: cycle.agreementRevision, cycleId: cycle.id };
    await this.runs.store.db.transaction(async tx => {
      await lockTeamOwner(tx, owner); await assertTeamRunAuthority(tx, owner, authority, agreement.accountId);
      await tx.update(teamRunCycles).set({ state: 'processing', updatedAt: new Date() }).where(eq(teamRunCycles.id, cycle.id));
    });
    const links = await this.runs.store.db.select().from(teamResearchLinks).where(and(eq(teamResearchLinks.ownerId, owner), eq(teamResearchLinks.commissionId, commission.id),
      eq(teamResearchLinks.kind, 'report_version'), eq(teamResearchLinks.relation, 'produced')));
    const link = cycle.reportVersionId ? links.find(item => item.targetId === cycle.reportVersionId) : links.find(item => item.workKey && item.attemptId);
    if (!link?.workKey || !link.attemptId || !commission.sessionId || !commission.cycleId) throw new Error('TEAM_ACCEPTED_REPORT_REQUIRED');
    const [report] = await this.runs.store.db.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, link.targetId)));
    if (!report || report.revokedAt || report.deletedAt) throw new Error('TEAM_SOURCE_UNAVAILABLE');
    const evidence = Array.isArray(report.snapshot?.evidence) ? report.snapshot.evidence : [];
    const ids = new Set<string>(evidence.flatMap(item => item && typeof item === 'object' && typeof item.id === 'string' ? [item.id] : []));
    let ready = false;
    try { ready = report.sections.some(section => section.id === REPORT_EXECUTION_SECTION_ID)
      && !report.snapshot?.executionPlanError && parseReportExecutionPlan(report.snapshot?.executionPlan, ids).readiness === 'ready'; }
    catch { /* An unstructured or incomplete delivery is observation, never an invented strategy. */ }
    const basis: TeamDecisionBasis = { teamVersionId: commission.teamVersionId, bindingId: commission.bindingId, bindingRevision: commission.bindingRevision,
      commissionId: commission.id, sessionId: commission.sessionId, cycleId: commission.cycleId, workKey: link.workKey, acceptedAttemptId: link.attemptId,
      reportVersionId: report.id, thesisVersions: [], sourceRefs: [] };
    const [savedDecision] = cycle.decisionId ? await this.runs.store.db.select().from(teamDecisions).where(and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.id, cycle.decisionId))) : [];
    const decision = savedDecision ?? await this.decisions.create(owner, agreement.teamId, { requestKey: 'run-decision:' + cycle.id, expectedProposalRevision: 0,
      commissionId: commission.id, event: ready ? 'adopt' : 'observe', basis,
      reason: ready ? 'System accepted the exact executable report under the confirmed paper-team agreement' : 'No executable validated report plan is available; remain in observation' }, authority);
    await this.runs.store.db.update(teamRunCycles).set({ reportVersionId: report.id, decisionId: decision.id, updatedAt: new Date() }).where(eq(teamRunCycles.id, cycle.id));
    if (decision.event !== 'adopt') {
      await this.runs.store.db.update(teamRunCycles).set({ state: 'observed', updatedAt: new Date() }).where(eq(teamRunCycles.id, cycle.id));
      return;
    }
    // Import only the exact immutable typed section. This never edits an existing user draft or global strategy pointer.
    const strategy = await this.strategies.importSource(owner, { kind: 'report', versionId: report.id, sectionId: REPORT_EXECUTION_SECTION_ID }, true);
    if (!strategy.preview?.canConfirm || !strategy.sources.some(source => source.versionId === report.id && source.executionPlan?.readiness === 'ready') || !strategy.preview.directives.length)
      throw new Error('TEAM_EXECUTABLE_STRATEGY_REQUIRED');
    await this.runs.store.db.update(teamRunCycles).set({ strategyId: strategy.id }).where(eq(teamRunCycles.id, cycle.id));
    const combination = await this.workspace.combination(owner, agreement.accountId);
    const allocations = [{ strategyId: strategy.id, strategyRevision: strategy.revision, allocationPct: agreement.configuration.replacementPolicy.allocationPct, enabled: true }];
    const teamDecisionRefs = [{ proposalId: decision.proposalId, proposalRevision: decision.proposalRevision, decisionId: decision.id }];
    const previewInput = { requestKey: 'run-combination-preview-' + cycle.id, expectedPolicyRevision: combination.policyRevision, allocations, teamDecisionRefs };
    const preview = await this.workspace.preview(owner, agreement.accountId, previewInput);
    if (!preview.canApply) throw new Error('TEAM_COMBINATION_CONFLICT');
    await this.workspace.apply(owner, agreement.accountId, { ...previewInput, requestKey: 'run-combination-apply-' + cycle.id,
      expectedPolicyRevision: preview.expectedPolicyRevision, previewHash: preview.previewHash }, authority);
  }
}
