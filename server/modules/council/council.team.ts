import type { CouncilMember } from '../../../shared/council.interface';
import type { TeamExecutionContext } from '../../../shared/team-workspace.interface';
import type { TaskPlan } from './council.tasks';

/** An upstream retry invalidates its transitive dependents, including an old accepted summary. */
export function dependentTeamWorkKeys(tasks: Array<{ workKey?: string | null; dependencyWorkKeys?: string[] }>, selected: string): Set<string> {
  const result = new Set([selected]);
  for (let pass = 0; pass < tasks.length; pass++) {
    const size = result.size;
    for (const task of tasks) if (task.workKey && task.dependencyWorkKeys?.some(key => result.has(key))) result.add(task.workKey);
    if (result.size === size) break;
  }
  return result;
}

export function parseSavedTeamResponse(saved: { data?: unknown; text?: string }): unknown {
  if (saved.data !== undefined && saved.data !== null) return saved.data;
  const text = (saved.text ?? '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  try { return JSON.parse(text); }
  catch {
    const match = text.match(/\{[\s\S]*\}/u);
    try { if (match) return JSON.parse(match[0]); } catch { /* Keep provider text out of errors. */ }
    throw new Error('LLM_INVALID_JSON');
  }
}

/** Organization roles are preserved; the retained manager role is only an execution adapter. */
export function teamCouncilMembers(context: TeamExecutionContext): CouncilMember[] {
  return context.members.map(member => ({
    id: member.memberId, name: member.label, roleTitle: member.label,
    role: member.roleId === context.plan.leadRoleId ? 'manager' : 'researcher',
    instructions: member.responsibility,
    model: member.executor.executionMode === 'model' && member.executor.tier === 'fast' ? 'fast' : 'slow',
    ...(member.executor.executionMode === 'model'
      ? { executionMode: 'model' as const, connectionId: member.executor.connectionId }
      : { executionMode: 'local' as const, agentId: member.executor.localAgentId,
        agentSettings: member.executor.settings }),
  }));
}

export function teamTaskPlan(context: TeamExecutionContext): TaskPlan[] {
  const members = new Map(context.members.map(member => [member.roleId, member.memberId]));
  return context.plan.work.map((work, position) => {
    const memberId = members.get(work.roleId), reviewerMemberId = members.get(work.reviewerRoleId);
    if (!memberId || !reviewerMemberId) throw new Error('TEAM_PLAN_INVALID');
    return { key: work.taskKind, dependencies: [], memberId, position,
      workKey: work.workKey, dependencyWorkKeys: work.dependencyWorkKeys, reviewerMemberId, assignment: work };
  });
}
