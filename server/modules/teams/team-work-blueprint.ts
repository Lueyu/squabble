/**
 * Pure structural compiler for the publishable research-division blueprint.
 * No database, HTTP client, LLM, worker, React or model SDK is imported here;
 * callers hold ownership/revision boundaries and freeze account facts separately.
 */
import type { TeamSemanticConfig } from '../../../shared/team-workspace.interface';
import type { BlueprintDiagnostic, CompiledBlueprint, CompiledBlueprintWork, TeamBlueprintWork, TeamWorkBlueprint } from '../../../shared/team-work-blueprint.interface';
import { canonicalHash, teamError } from './team-contract';
import { validateTeamGraph } from './team-graph';

export const TEAM_WORK_BLUEPRINT_COMPILER_VERSION = 'team-work-blueprint-v1';
export const SUMMARY_WORK_ID = 'summary';
const WORK_ID = /^[a-z][a-z0-9_-]{0,63}$/;

export interface CompileBlueprintContext { objective: string; expectedSummaryOutput: string }

/** Findings that still allow a draft to be stored or a preview to be drawn. */
export const WARNING_CODES = new Set(['ROLE_NOT_READY', 'REVIEW_RELATION_UNUSED']);

export function diagnoseWorkBlueprint(config: TeamSemanticConfig): BlueprintDiagnostic[] {
  const issues: BlueprintDiagnostic[] = [];
  const add = (code: string, field: string, message: string, extra: Partial<BlueprintDiagnostic> = {}): void => {
    if (issues.length < 24) issues.push({ code, field, message, ...extra });
  };
  const blueprint = config.workBlueprint;
  if (!blueprint) {
    add('BLUEPRINT_MISSING', 'workBlueprint', 'No work blueprint is stored; the legacy division of labour applies.');
    return issues;
  }
  const roleById = new Map(config.roles.map(r => [r.id, r]));
  const lead = config.defaults.leadRoleId ? roleById.get(config.defaults.leadRoleId) : undefined;
  if (!lead) add('LEAD_REQUIRED', 'defaults.leadRoleId', 'Choose the team lead who owns the summary.');
  const works = blueprint.works;
  const workIds = new Set<string>();
  const seenRoles = new Set<string>();
  works.forEach(work => {
    if (!WORK_ID.test(work.workId)) add('INVALID_WORK_ID', 'workId', 'Work ids use lowercase letters, digits, dash or underscore and start with a letter.', { workId: work.workId });
    else if (work.workId === SUMMARY_WORK_ID) add('RESERVED_WORK_ID', 'workId', `"${SUMMARY_WORK_ID}" is reserved for the lead summary.`, { workId: work.workId });
    else if (workIds.has(work.workId)) add('DUPLICATE_WORK_ID', 'workId', 'Each research item needs a unique id.', { workId: work.workId });
    workIds.add(work.workId);
    if (!roleById.has(work.roleId)) add('UNKNOWN_ROLE', 'roleId', 'The work references a seat that does not exist.', { workId: work.workId, roleId: work.roleId });
    if (lead && work.roleId === lead.id) add('LEAD_WORK_NOT_ALLOWED', 'roleId', 'The lead only owns the summary; research belongs to other seats.', { workId: work.workId, roleId: work.roleId });
    if (!roleById.has(work.reviewerRoleId)) add('UNKNOWN_REVIEWER', 'reviewerRoleId', 'The reviewer seat does not exist.', { workId: work.workId, roleId: work.reviewerRoleId });
    if (seenRoles.has(work.roleId)) add('DUPLICATE_WORK_ROLE', 'roleId', 'One seat owns at most one research item.', { workId: work.workId, roleId: work.roleId });
    seenRoles.add(work.roleId);
  });
  if (works.length > 5) add('TOO_MANY_WORKS', 'works', 'A blueprint holds at most five research items plus the lead summary.');
  works.forEach(work => work.dependencyWorkIds.forEach(dep => {
    if (dep === work.workId) add('SELF_DEPENDENCY', 'dependencyWorkIds', 'An item cannot depend on itself.', { workId: work.workId });
    else if (!workIds.has(dep)) add('UNKNOWN_DEPENDENCY', 'dependencyWorkIds', 'The dependency does not exist.', { workId: work.workId });
  }));
  const byWorkId = new Map(works.map(w => [w.workId, w]));
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const current = state.get(id) ?? 0;
    if (current === 1) return true;
    if (current === 2) return false;
    state.set(id, 1);
    const cycle = (byWorkId.get(id)?.dependencyWorkIds ?? []).some(dep => visit(dep));
    state.set(id, 2);
    return cycle;
  };
  works.forEach(w => { if (visit(w.workId)) add('WORK_CYCLE', 'dependencyWorkIds', 'Research dependencies must stay acyclic.', { workId: w.workId }); });
  const reviews = config.relations.filter(r => r.kind === 'reviews');
  works.forEach(work => {
    if (work.reviewMode === 'self_check') {
      if (work.reviewerRoleId !== work.roleId) add('REVIEW_MODE_MISMATCH', 'reviewMode', 'Self check must review the same seat that executes the work.', { workId: work.workId });
    } else {
      if (work.reviewerRoleId === work.roleId) add('REVIEW_MODE_MISMATCH', 'reviewMode', 'Independent review needs a different seat than the executor.', { workId: work.workId });
      if (!reviews.some(r => r.fromRoleId === work.reviewerRoleId && r.toRoleId === work.roleId)) add('REVIEW_RELATION_REQUIRED', 'reviewerRoleId', 'Draw a review relation from the reviewer to this seat, or switch to self check.', { workId: work.workId });
      const executor = roleById.get(work.roleId), reviewer = roleById.get(work.reviewerRoleId);
      if (executor?.agentId && reviewer?.agentId && executor.agentId === reviewer.agentId) add('INDEPENDENT_REVIEW_SAME_FRIEND', 'reviewerRoleId', 'Independent review requires a different persistent friend.', { workId: work.workId, roleId: work.reviewerRoleId });
    }
  });
  const summary = blueprint.summary;
  if (!roleById.has(summary.reviewerRoleId)) add('UNKNOWN_REVIEWER', 'summary.reviewerRoleId', 'The summary reviewer seat does not exist.', { roleId: summary.reviewerRoleId });
  if (lead) {
    if (summary.reviewMode === 'self_check') {
      if (summary.reviewerRoleId !== lead.id) add('REVIEW_MODE_MISMATCH', 'summary.reviewMode', 'Summary self check must be performed by the lead.', { roleId: summary.reviewerRoleId });
    } else {
      if (summary.reviewerRoleId === lead.id) add('REVIEW_MODE_MISMATCH', 'summary.reviewMode', 'Independent summary review needs another seat.', { roleId: summary.reviewerRoleId });
      if (!reviews.some(r => r.fromRoleId === summary.reviewerRoleId && r.toRoleId === lead.id)) add('REVIEW_RELATION_REQUIRED', 'summary.reviewerRoleId', 'Draw a review relation from the summary reviewer to the lead, or switch to self check.', { roleId: summary.reviewerRoleId });
      const leadAgent = lead.agentId, reviewer = roleById.get(summary.reviewerRoleId);
      if (leadAgent && reviewer?.agentId && leadAgent === reviewer.agentId) add('INDEPENDENT_REVIEW_SAME_FRIEND', 'summary.reviewerRoleId', 'Independent summary review requires a different persistent friend.', { roleId: summary.reviewerRoleId });
    }
  }
  const participants = new Set<string>();
  works.forEach(w => { participants.add(w.roleId); participants.add(w.reviewerRoleId); });
  participants.add(summary.reviewerRoleId);
  if (lead) participants.add(lead.id);
  if (participants.size > 6) add('TOO_MANY_PARTICIPANTS', 'works', 'One bounded study covers at most six distinct seats including review-only seats.');
  reviews.forEach(r => {
    if (r.toRoleId === lead?.id) {
      if (summary.reviewerRoleId !== r.fromRoleId) add('REVIEW_RELATION_UNUSED', 'relations', 'This review edge is not used by the current division.', { relationId: r.id, roleId: r.fromRoleId });
    } else if (!works.some(w => w.roleId === r.toRoleId && w.reviewMode === 'independent' && w.reviewerRoleId === r.fromRoleId))
      add('REVIEW_RELATION_UNUSED', 'relations', 'This review edge is not used by the current division.', { relationId: r.id, roleId: r.fromRoleId });
  });
  participants.forEach(id => {
    const role = roleById.get(id);
    if (!role || role.participation !== 'enabled' || !role.executor || !role.responsibility.trim() || !role.expectedOutput.trim())
      add('ROLE_NOT_READY', 'roles', 'This seat is not ready to run yet; the draft can still store the division.', { roleId: id });
  });
  return issues;
}

export function compileWorkBlueprint(config: TeamSemanticConfig, context: CompileBlueprintContext): CompiledBlueprint {
  validateTeamGraph(config);
  const blueprint = config.workBlueprint;
  if (!blueprint) teamError('TEAM_PLAN_INVALID', 'A work blueprint is required for this plan mode');
  const issues = diagnoseWorkBlueprint(config);
  const blocking = issues.filter(issue => !WARNING_CODES.has(issue.code));
  if (blocking.length > 0) {
    const first = blocking[0];
    teamError('TEAM_PLAN_INVALID', first.message, {
      field: first.field,
      issues: blocking.slice(0, 5).map(issue => ({ code: issue.code, field: issue.field, workId: issue.workId ?? null, roleId: issue.roleId ?? null, relationId: issue.relationId ?? null })),
    });
  }
  const roleById = new Map(config.roles.map(r => [r.id, r]));
  const lead = roleById.get(config.defaults.leadRoleId!)!;
  const delegates = config.relations.filter(r => r.kind === 'delegates_to');
  const reviews = config.relations.filter(r => r.kind === 'reviews');
  const requestedBy = (roleId: string): string[] => {
    const ids = [...new Set(delegates.filter(r => r.toRoleId === roleId).map(r => r.fromRoleId))].sort();
    return ids.length ? ids : [lead.id];
  };
  // Stable topological order; ties break by workId so array order never decides the plan.
  const remaining = new Map(blueprint.works.map(w => [w.workId, w]));
  const ready = [...remaining.keys()].filter(id => remaining.get(id)!.dependencyWorkIds.length === 0).sort();
  const ordered: TeamBlueprintWork[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    const work = remaining.get(id)!;
    remaining.delete(id);
    ordered.push(work);
    [...remaining.keys()].filter(other => remaining.get(other)!.dependencyWorkIds.includes(id))
      .forEach(other => { if (remaining.get(other)!.dependencyWorkIds.every(dep => !remaining.has(dep))) { ready.push(other); ready.sort(); } });
  }
  const compiled: CompiledBlueprintWork[] = ordered.map(work => ({
    workKey: work.workId, roleId: work.roleId, taskKind: work.taskKind,
    objective: [context.objective.trim(), roleById.get(work.roleId)?.responsibility.trim(), work.objective.trim()].filter(Boolean).join('\n'),
    expectedOutput: work.expectedOutput,
    dependencyWorkKeys: [...new Set(work.dependencyWorkIds)].sort(),
    reviewerRoleId: work.reviewerRoleId, reviewMode: work.reviewMode, inputRefs: [], requestedByRoleIds: requestedBy(work.roleId),
  }));
  const summary: CompiledBlueprintWork = {
    workKey: SUMMARY_WORK_ID, roleId: lead.id, taskKind: 'summary', objective: context.objective.trim(),
    expectedOutput: [blueprint.summary.expectedOutput.trim(), context.expectedSummaryOutput.trim()].filter(Boolean).join('\n'),
    dependencyWorkKeys: ordered.map(w => w.workId).sort(), reviewerRoleId: blueprint.summary.reviewerRoleId,
    reviewMode: blueprint.summary.reviewMode, inputRefs: [], requestedByRoleIds: [lead.id],
  };
  const participantRoleIds = [...new Set([...compiled.map(w => w.roleId), ...compiled.map(w => w.reviewerRoleId), lead.id])].sort();
  const nonParticipatingRoleIds = config.roles.map(r => r.id).filter(id => !participantRoleIds.includes(id)).sort();
  const unusedReviewRelationIds = issues.filter(issue => issue.code === 'REVIEW_RELATION_UNUSED' && issue.relationId).map(issue => issue.relationId!);
  const blueprintHash = canonicalHash({
    blueprint: normalizeBlueprint(blueprint), leadRoleId: lead.id,
    requestedBy: compiled.map(w => [w.workKey, w.requestedByRoleIds]),
    reviews: reviews.map(r => [r.fromRoleId, r.toRoleId]).sort(),
  });
  return { participantRoleIds, leadRoleId: lead.id, work: [...compiled, summary], minimumCallCount: (compiled.length + 1) * 2, unusedReviewRelationIds, nonParticipatingRoleIds, blueprintHash };
}

function normalizeBlueprint(blueprint: TeamWorkBlueprint): TeamWorkBlueprint {
  return { ...blueprint, works: [...blueprint.works].sort((a, b) => a.workId.localeCompare(b.workId)).map(work => ({ ...work, dependencyWorkIds: [...work.dependencyWorkIds].sort() })) };
}
