import { ConflictException } from '@nestjs/common';
import type { ResearchSourceRef, TeamCommissionPlan, TeamRole } from '../../shared/team-workspace.interface';

export interface TeamGrantIdentity { id: string; sourceKind: string; sourceId: string; sourceRevision: string }
export function teamSourceIdentity(ref: Pick<ResearchSourceRef, 'kind' | 'id' | 'revision'>): string {
  return JSON.stringify([ref.kind, ref.id, ref.revision]);
}
export function teamWorkClosure(plan: Pick<TeamCommissionPlan, 'work'>, workKey: string): Set<string> {
  const result = new Set<string>();
  const active = new Set<string>();
  function visit(key: string): void {
    if (active.has(key)) throw new ConflictException('TEAM_PLAN_INVALID');
    if (result.has(key)) return;
    const item = plan.work.find(work => work.workKey === key);
    if (!item) throw new ConflictException('TEAM_PLAN_INVALID');
    active.add(key);
    for (const dependency of item.dependencyWorkKeys) visit(dependency);
    active.delete(key);
    result.add(key);
  }
  visit(workKey);
  return result;
}
/** A dependency carries its sources as well as its conclusion; receiving it grants no extra permissions. */
export function teamWorkInputs(plan: Pick<TeamCommissionPlan, 'work'>, workKey: string,
  globalRefs: ResearchSourceRef[]): ResearchSourceRef[] {
  const keys = teamWorkClosure(plan, workKey);
  const refs = [...globalRefs, ...plan.work.filter(work => keys.has(work.workKey)).flatMap(work => work.inputRefs)];
  return [...new Map(refs.map(ref => [teamSourceIdentity(ref), ref])).values()];
}
/** Published role grants are an upper bound. A commission selects a subset, never a union across colleagues. */
export function freezeTeamMemberGrants(roles: TeamRole[], plan: Pick<TeamCommissionPlan, 'work'>,
  globalRefs: ResearchSourceRef[], grants: TeamGrantIdentity[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const role of roles) {
    const refs = [...globalRefs, ...plan.work.filter(work => work.roleId === role.id || work.reviewerRoleId === role.id)
      .flatMap(work => teamWorkInputs(plan, work.workKey, globalRefs))];
    const selected = new Set<string>();
    for (const ref of refs) {
      const grant = grants.find(item => item.sourceKind === ref.kind && item.sourceId === ref.id && item.sourceRevision === ref.revision);
      if (!grant || !role.sourceGrantIds.includes(grant.id)) {
        throw new ConflictException({ code: 'TEAM_SCOPE_REVOKED', message: 'A work recipient lacks its published source permission',
          roleId: role.id, field: 'sourceGrantIds', fieldErrors: { sourceGrantIds: [
            `Missing published permission for ${ref.kind} ${ref.id} revision ${ref.revision}`,
          ] } });
      }
      selected.add(grant.id);
    }
    result.set(role.id, [...selected]);
  }
  return result;
}
export function commonTeamGrantIds(members: Array<{ sourceGrantIds: string[] }>): Set<string> {
  return new Set((members[0]?.sourceGrantIds ?? []).filter(id => members.every(member => member.sourceGrantIds.includes(id))));
}
interface EvidenceScope {
  commissionId: string;
  plan: Pick<TeamCommissionPlan, 'work'>;
  inputSnapshot: { inputRefs?: unknown };
}
interface EvidenceTask { workKey?: string | null; attempts: Array<{ id: string }> }
/** Shared session snapshots cannot make an unrelated colleague's private evidence visible. */
export function teamVisibleEvidence<T extends { id: string; teamWorkKey?: string; libraryReferences?: Array<{ versionId: string }> }>(
  context: EvidenceScope, workKey: string, tasks: EvidenceTask[], evidence: T[]): T[] {
  const keys = teamWorkClosure(context.plan, workKey);
  const refs = teamWorkInputs(context.plan, workKey, (context.inputSnapshot.inputRefs ?? []) as ResearchSourceRef[]);
  const sourceIds = new Set(refs.map(ref => ref.id));
  const attempts = tasks.filter(task => task.workKey && keys.has(task.workKey)).flatMap(task => task.attempts.map(attempt => attempt.id));
  return evidence.filter(item => {
    if (item.id === `team-account:${context.commissionId}` || sourceIds.has(item.id)) return true;
    if (item.libraryReferences?.length) return item.libraryReferences.every(ref => sourceIds.has(ref.versionId));
    if (item.id.startsWith('native:')) return attempts.some(id => item.id.startsWith(`native:${id}:`));
    if (item.teamWorkKey && keys.has(item.teamWorkKey)) return true;
    // Only explicit owner facts, selected source versions and attributed task evidence are shared.
    return false;
  });
}
