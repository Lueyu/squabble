import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { teamDrafts } from '../../database/teams.schema';
import { TeamStore } from './team-store';
import { COMPILER_VERSION, parseTeam, requestKeySchema, revisionSchema, teamError } from './team-contract';
import { semanticHash, semanticSchema } from './team-graph';
import { compileWorkBlueprint, diagnoseWorkBlueprint, TEAM_WORK_BLUEPRINT_COMPILER_VERSION, WARNING_CODES } from './team-work-blueprint';
import type { BlueprintDiagnostic, CompiledBlueprint } from '../../../shared/team-work-blueprint.interface';
import type { TeamSemanticConfig, TeamWorkPlanPreviewResult } from '../../../shared/team-workspace.interface';

const workPlanPreviewInputSchema = z.object({
  requestKey: requestKeySchema,
  expectedSemanticRevision: revisionSchema,
  config: semanticSchema,
}).strict();

/**
 * Read-only structural preview of the current local draft. Pure structural preview:
 * no team_previews/team_requests/commission/job rows, no consumable preview id, no model
 * dispatch, no frozen account facts. The server owns the revision boundary; the compiler
 * is the single interpretation of the division of labour.
 */
@Injectable()
export class TeamWorkPlanPreviewService {
  constructor(private readonly store: TeamStore) { }

  async preview(owner: string, id: string, input: unknown): Promise<TeamWorkPlanPreviewResult> {
    const request = parseTeam(workPlanPreviewInputSchema, input);
    const team = await this.store.team(this.store.db, owner, id);
    const [draft] = await this.store.db.select().from(teamDrafts).where(eq(teamDrafts.teamId, id));
    if (!draft) teamError('TEAM_REFERENCE_NOT_FOUND');
    this.store.revision(draft.semanticRevision, request.expectedSemanticRevision);
    return this.compile(request.requestKey, draft.semanticRevision, request.config);
  }

  compile(requestKey: string, baseSemanticRevision: number, config: TeamSemanticConfig): TeamWorkPlanPreviewResult {
    const hash = semanticHash(config);
    if (!config.workBlueprint) {
      return {
        mode: 'legacy_v1',
        baseSemanticRevision,
        semanticHash: hash,
        blueprintHash: null,
        compilerVersion: COMPILER_VERSION,
        structurallyValid: true,
        dispatchable: false,
        leadRoleId: config.defaults.leadRoleId ?? null,
        participantRoleIds: config.roles.filter(role => role.participation === 'enabled').map(role => role.id).sort(),
        work: [],
        minimumCallCount: null,
        nonParticipatingRoleIds: [],
        unusedReviewRelationIds: [],
        issues: [],
        warnings: [{ code: 'BLUEPRINT_MISSING', field: 'workBlueprint', message: 'No work blueprint is stored; the legacy division of labour applies.' }],
        requestKey,
      };
    }
    const issues: BlueprintDiagnostic[] = diagnoseWorkBlueprint(config);
    const warnings = issues.filter(issue => WARNING_CODES.has(issue.code));
    const blocking = issues.filter(issue => !WARNING_CODES.has(issue.code));
    let compiled: CompiledBlueprint | null = null;
    if (blocking.length === 0) {
      try {
        compiled = compileWorkBlueprint(config, { objective: '', expectedSummaryOutput: '' });
      } catch (error) {
        issues.push({ code: 'TEAM_GRAPH_INVALID', field: 'graph', message: error instanceof Error ? error.message : 'Invalid organization graph' });
      }
    }
    return {
      mode: 'blueprint_v1',
      baseSemanticRevision,
      semanticHash: hash,
      blueprintHash: compiled?.blueprintHash ?? null,
      compilerVersion: TEAM_WORK_BLUEPRINT_COMPILER_VERSION,
      structurallyValid: compiled !== null,
      dispatchable: false,
      leadRoleId: config.defaults.leadRoleId ?? null,
      participantRoleIds: compiled?.participantRoleIds ?? [],
      work: compiled?.work ?? [],
      minimumCallCount: compiled?.minimumCallCount ?? null,
      nonParticipatingRoleIds: compiled?.nonParticipatingRoleIds ?? [],
      unusedReviewRelationIds: compiled?.unusedReviewRelationIds ?? [],
      issues,
      warnings,
      requestKey,
    };
  }
}
