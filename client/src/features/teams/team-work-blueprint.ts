import type { TeamSemanticConfig } from '@shared/team-workspace.interface';
import type { TeamWorkBlueprint, TeamBlueprintWork, TeamBlueprintTaskKind } from '@shared/team-work-blueprint.interface';

export interface ClientBlueprintIssue { code: string; field: string; message: string; workId?: string; roleId?: string }

export function workBlueprintOf(config: TeamSemanticConfig): TeamWorkBlueprint | null {
  return config.workBlueprint ?? null;
}

export function withBlueprintWork(config: TeamSemanticConfig, work: TeamBlueprintWork): TeamSemanticConfig {
  const blueprint = config.workBlueprint;
  if (!blueprint) return config;
  const existing = blueprint.works.some(item => item.workId === work.workId);
  const works = existing ? blueprint.works.map(item => item.workId === work.workId ? work : item) : blueprint.works.length >= 5 ? blueprint.works : [...blueprint.works, work];
  return { ...config, workBlueprint: { ...blueprint, works } };
}

export function removeBlueprintWork(config: TeamSemanticConfig, workId: string): TeamSemanticConfig {
  const blueprint = config.workBlueprint;
  if (!blueprint || workId === 'summary') return config;
  const works = blueprint.works.filter(item => item.workId !== workId).map(item => ({ ...item, dependencyWorkIds: item.dependencyWorkIds.filter(dep => dep !== workId) }));
  return { ...config, workBlueprint: { ...blueprint, works } };
}

export function patchBlueprintWork(config: TeamSemanticConfig, workId: string, patch: Partial<TeamBlueprintWork>): TeamSemanticConfig {
  const blueprint = config.workBlueprint;
  if (!blueprint) return config;
  return { ...config, workBlueprint: { ...blueprint, works: blueprint.works.map(item => item.workId === workId ? { ...item, ...patch } : item) } };
}

export function patchBlueprintSummary(config: TeamSemanticConfig, patch: Partial<TeamWorkBlueprint['summary']>): TeamSemanticConfig {
  const blueprint = config.workBlueprint;
  if (!blueprint) return config;
  return { ...config, workBlueprint: { ...blueprint, summary: { ...blueprint.summary, ...patch } } };
}

/** Lightweight structural mirror of the server diagnose; the server compiler remains authoritative. */
export function blueprintStructuralIssues(config: TeamSemanticConfig): ClientBlueprintIssue[] {
  const blueprint = config.workBlueprint;
  const issues: ClientBlueprintIssue[] = [];
  if (!blueprint) return [{ code: 'BLUEPRINT_MISSING', field: 'workBlueprint', message: 'No work blueprint is stored; the legacy division of labour applies.' }];
  const roles = config.roles; const roleIds = new Set(roles.map(role => role.id));
  const lead = config.defaults.leadRoleId;
  const reviews = new Set(config.relations.filter(relation => relation.kind === 'reviews').map(relation => `${relation.fromRoleId}>${relation.toRoleId}`));
  const participants = new Set<string>();
  const seen = new Set<string>();
  const add = (issue: ClientBlueprintIssue): void => { if (issues.length < 24) issues.push(issue); };
  const invalidWorkId = /^[a-z][a-z0-9_-]{0,63}$/;
  for (const work of blueprint.works) {
    if (!invalidWorkId.test(work.workId)) add({ code: 'INVALID_WORK_ID', field: 'workBlueprint.works', workId: work.workId, message: 'Work ids must match ^[a-z][a-z0-9_-]{0,63}$' });
    if (work.workId === 'summary') add({ code: 'RESERVED_WORK_ID', field: 'workBlueprint.works', workId: work.workId, message: 'summary is reserved for the lead' });
    if (seen.has(work.workId)) add({ code: 'DUPLICATE_WORK_ID', field: 'workBlueprint.works', workId: work.workId, message: 'Duplicate work id' });
    seen.add(work.workId);
    if (!roleIds.has(work.roleId)) add({ code: 'UNKNOWN_ROLE', field: 'workBlueprint.works.roleId', workId: work.workId, roleId: work.roleId, message: 'Work role does not exist in this organization' });
    if (work.roleId === lead) add({ code: 'LEAD_WORK_NOT_ALLOWED', field: 'workBlueprint.works.roleId', workId: work.workId, message: 'The lead only owns the summary work' });
    if (!roleIds.has(work.reviewerRoleId)) add({ code: 'UNKNOWN_REVIEWER', field: 'workBlueprint.works.reviewerRoleId', workId: work.workId, roleId: work.reviewerRoleId, message: 'Reviewer does not exist in this organization' });
    if (work.dependencyWorkIds.includes(work.workId)) add({ code: 'SELF_DEPENDENCY', field: 'workBlueprint.works.dependencyWorkIds', workId: work.workId, message: 'A work cannot depend on itself' });
    for (const dep of work.dependencyWorkIds) if (!blueprint.works.some(item => item.workId === dep)) add({ code: 'UNKNOWN_DEPENDENCY', field: 'workBlueprint.works.dependencyWorkIds', workId: work.workId, message: `Unknown dependency ${dep}` });
    if (work.reviewMode === 'self_check' && work.reviewerRoleId !== work.roleId) add({ code: 'REVIEW_MODE_MISMATCH', field: 'workBlueprint.works.reviewMode', workId: work.workId, message: 'self_check requires the reviewer to be the executing role' });
    if (work.reviewMode === 'independent') {
      if (!reviews.has(`${work.reviewerRoleId}>${work.roleId}`)) add({ code: 'REVIEW_RELATION_REQUIRED', field: 'workBlueprint.works', workId: work.workId, message: 'An independent reviewer needs a reviews relation to the executing role' });
      const executor = roles.find(role => role.id === work.roleId); const reviewer = roles.find(role => role.id === work.reviewerRoleId);
      if (executor?.agentId && reviewer?.agentId && executor.agentId === reviewer.agentId) add({ code: 'INDEPENDENT_REVIEW_SAME_FRIEND', field: 'workBlueprint.works', workId: work.workId, message: 'Independent review must be performed by a different persistent friend' });
    }
    participants.add(work.roleId); participants.add(work.reviewerRoleId);
  }
  const seenRole = new Set<string>();
  for (const work of blueprint.works) {
    if (!roleIds.has(work.roleId)) continue;
    if (seenRole.has(work.roleId)) { add({ code: 'DUPLICATE_WORK_ROLE', field: 'workBlueprint.works', workId: work.workId, roleId: work.roleId, message: 'Each participating role owns at most one work item' }); }
    seenRole.add(work.roleId);
  }
  if (blueprint.works.length > 5) add({ code: 'TOO_MANY_WORKS', field: 'workBlueprint.works', message: 'At most 5 work items are allowed' });
  // dependency cycle via DFS
  const byId = new Map<string, TeamBlueprintWork>(blueprint.works.map(work => [work.workId, work] as [string, TeamBlueprintWork]));
  const visiting = new Set<string>(); const done = new Set<string>();
  const visit = (workId: string): boolean => {
    if (done.has(workId)) return false; if (visiting.has(workId)) return true;
    visiting.add(workId);
    const work = byId.get(workId);
    if (work) for (const dep of work.dependencyWorkIds) if (visit(dep)) return true;
    visiting.delete(workId); done.add(workId);
    return false;
  };
  for (const work of blueprint.works) if (visit(work.workId)) { add({ code: 'WORK_CYCLE', field: 'workBlueprint.works.dependencyWorkIds', workId: work.workId, message: 'Work dependencies must be acyclic' }); break; }
  // summary checks
  const summary = blueprint.summary;
  if (!roleIds.has(summary.reviewerRoleId)) add({ code: 'UNKNOWN_REVIEWER', field: 'workBlueprint.summary.reviewerRoleId', roleId: summary.reviewerRoleId, message: 'Summary reviewer does not exist in this organization' });
  if (summary.reviewMode === 'self_check' && lead && summary.reviewerRoleId !== lead) add({ code: 'REVIEW_MODE_MISMATCH', field: 'workBlueprint.summary.reviewMode', message: 'Summary self_check requires the lead as reviewer' });
  if (summary.reviewMode === 'independent') {
    if (!lead || !reviews.has(`${summary.reviewerRoleId}>${lead}`)) add({ code: 'REVIEW_RELATION_REQUIRED', field: 'workBlueprint.summary', message: 'Independent summary review needs a reviews relation from the reviewer to the lead' });
    const executor = roles.find(role => role.id === lead); const reviewer = roles.find(role => role.id === summary.reviewerRoleId);
    if (executor?.agentId && reviewer?.agentId && executor.agentId === reviewer.agentId) add({ code: 'INDEPENDENT_REVIEW_SAME_FRIEND', field: 'workBlueprint.summary', message: 'Independent summary review must be a different persistent friend' });
  }
  participants.add(summary.reviewerRoleId); if (lead) participants.add(lead);
  if (participants.size > 6) add({ code: 'TOO_MANY_PARTICIPANTS', field: 'workBlueprint', message: 'Executors, reviewers and the lead must be at most 6 distinct roles' });
  return issues;
}

export interface BlueprintWorkDelta { workId: string; fields: string[] }
export interface BlueprintDiffResult { added: string[]; removed: string[]; changed: BlueprintWorkDelta[]; summary: 'unchanged' | 'changed' }

const WORK_FIELDS: (keyof TeamBlueprintWork)[] = ['roleId', 'taskKind', 'objective', 'expectedOutput', 'dependencyWorkIds', 'reviewerRoleId', 'reviewMode'];

export function blueprintDiff(before: TeamWorkBlueprint | null | undefined, after: TeamWorkBlueprint | null | undefined): BlueprintDiffResult {
  const result: BlueprintDiffResult = { added: [], removed: [], changed: [], summary: 'unchanged' };
  const beforeWorks = before?.works ?? []; const afterWorks = after?.works ?? [];
  const beforeById = new Map(beforeWorks.map(work => [work.workId, work]));
  const afterById = new Map(afterWorks.map(work => [work.workId, work]));
  for (const work of afterWorks) if (!beforeById.has(work.workId)) result.added.push(work.workId);
  for (const work of beforeWorks) if (!afterById.has(work.workId)) result.removed.push(work.workId);
  for (const work of afterWorks) {
    const previous = beforeById.get(work.workId);
    if (!previous) continue;
    const changed = WORK_FIELDS.filter(field => JSON.stringify(previous[field]) !== JSON.stringify(work[field]));
    if (changed.length) result.changed.push({ workId: work.workId, fields: changed });
  }
  const summaryBefore = before?.summary; const summaryAfter = after?.summary;
  if (JSON.stringify(summaryBefore) !== JSON.stringify(summaryAfter)) result.summary = 'changed';
  return result;
}

export function suggestBlueprintFromOrganization(config: TeamSemanticConfig): TeamWorkBlueprint | null {
  if (config.workBlueprint) return null;
  const lead = config.defaults.leadRoleId;
  const enabled = config.roles.filter(role => role.participation === 'enabled' && role.id !== lead);
  if (!lead || !enabled.length) return null;
  const slug = (value: string, fallback: string): string => {
    const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    const candidate = cleaned || fallback;
    return (candidate.length > 63 ? candidate.slice(0, 63) : candidate).replace(/^-+/, '') || fallback;
  };
  const used = new Set<string>();
  const works: TeamBlueprintWork[] = enabled.map((role, index) => {
    let workId = slug(stateLabel(config, role.id), `work${index + 1}`);
    if (!/^[a-z]/.test(workId)) workId = `work-${workId}`.slice(0, 63);
    while (used.has(workId)) workId = `${workId}-${index + 1}`;
    used.add(workId);
    const taskKind: TeamBlueprintTaskKind = role.allowedToolIds.some(tool => tool === 'get_financials' || tool === 'get_financial_source_data') ? 'financials' : role.allowedToolIds.some(tool => tool === 'get_valuation' || tool === 'get_peer_comparison') ? 'valuation' : 'specialist';
    return { workId, roleId: role.id, taskKind, objective: '', expectedOutput: role.expectedOutput, dependencyWorkIds: [], reviewerRoleId: lead, reviewMode: 'independent' };
  });
  return { schemaVersion: 1, works, summary: { reviewerRoleId: lead, reviewMode: 'self_check', expectedOutput: '' } };
}

function stateLabel(config: TeamSemanticConfig, roleId: string): string {
  return roleId;
}
