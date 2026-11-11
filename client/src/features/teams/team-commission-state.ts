import type { TeamBudget, TeamCostSummary, TeamSemanticConfig, TeamWorkItem, ResearchSourceRef } from '@shared/team-workspace.interface';

export interface CommissionForm {
  objective: string; expectedOutput: string; leadRoleId: string; participantRoleIds: string[];
  dataCutoffAt: string; deadlineAt: string; budgetMode: TeamBudget['budgetMode']; amount: string;
  currency: string; callLimit: string; paidRevisionLimit: string; parallelism: 1 | 2;
}
export interface CommissionFieldIssue { field: string; message: string }
export function teamLeadSuggestion(config: TeamSemanticConfig | undefined): string {
  const suggested = config?.roles.find(role => role.id === config.defaults.leadRoleId);
  return suggested?.participation === 'enabled' && suggested.executor ? suggested.id : '';
}
export function validateCommissionForm(form: CommissionForm, now = new Date().toISOString()): CommissionFieldIssue[] {
  const issues: CommissionFieldIssue[] = []; const add = (field: string, message: string): void => { issues.push({ field, message }); };
  if (!form.objective.trim() || form.objective.trim().length > 2000) add('objective', 'Enter a research question (1–2000 characters).');
  if (!form.expectedOutput.trim()) add('expectedOutput', 'Specify the expected delivery.');
  if (!form.leadRoleId || !form.participantRoleIds.includes(form.leadRoleId)) add('leadRoleId', 'Select exactly one lead from participating roles.');
  if (!form.participantRoleIds.length || new Set(form.participantRoleIds).size > 6 || new Set(form.participantRoleIds).size !== form.participantRoleIds.length) add('participantRoleIds', 'Select 1–6 distinct executing roles.');
  if (!Number.isFinite(Date.parse(form.deadlineAt)) || Date.parse(form.deadlineAt) <= Date.parse(now)) add('deadlineAt', 'The research deadline must be in the future.');
  if (form.dataCutoffAt && (!Number.isFinite(Date.parse(form.dataCutoffAt)) || Date.parse(form.dataCutoffAt) > Date.parse(now))) add('dataCutoffAt', 'The data cutoff cannot be in the future.');
  if (form.budgetMode === 'cost_and_calls' && (!/^\d+(?:\.\d+)?$/.test(form.amount) || Number(form.amount) < 0)) add('amount', 'Enter a non-negative cost ceiling.');
  if (!/^[1-9]\d*$/.test(form.callLimit)) add('callLimit', 'Enter a positive integer call limit.');
  if (!/^\d+$/.test(form.paidRevisionLimit)) add('paidRevisionLimit', 'Enter a non-negative paid revision limit.');
  return issues;
}
/** Suggestions are editable and bounded; reporting lines do not create duplicate work. */
export function suggestedTeamWork(config: TeamSemanticConfig, form: CommissionForm, refs: ResearchSourceRef[]): TeamWorkItem[] {
  const ids = [...new Set(form.participantRoleIds)]; const otherKeys = ids.filter(id => id !== form.leadRoleId).map(id => `role-${id}`);
  return ids.map(id => { const role = config.roles.find(r => r.id === id); const reviewRelation = config.relations.find(r => r.kind === 'reviews' && r.toRoleId === id && ids.includes(r.fromRoleId)); const reviewer = reviewRelation?.fromRoleId ?? form.leadRoleId;
    return { workKey: `role-${id}`, roleId: id, taskKind: id === form.leadRoleId ? 'summary' : 'specialist', objective: id === form.leadRoleId ? form.objective : (role?.responsibility || form.objective), expectedOutput: role?.expectedOutput || form.expectedOutput,
      dependencyWorkKeys: id === form.leadRoleId ? otherKeys : [], reviewerRoleId: reviewer, reviewMode: reviewer === id ? 'self_check' : 'independent', inputRefs: refs, requestedByRoleIds: [...new Set(config.relations.filter(r => r.kind === 'reports_to' && r.fromRoleId === id && ids.includes(r.toRoleId)).map(r => r.toRoleId))] };
  });
}
export function teamCostLabel(cost: TeamCostSummary, zh: boolean): string {
  const known = cost.confirmed.amount === null ? (zh ? '已知费用未记录' : 'Known cost unrecorded') : `${cost.confirmed.amount} ${cost.confirmed.currency}`;
  return `${known}${cost.externalUsageUnknown || cost.unknownAttemptIds.length ? (zh ? ` + 外部费用未知${cost.unknownAttemptIds.length ? `（${cost.unknownAttemptIds.length} 次）` : ''}` : ` + external cost unknown${cost.unknownAttemptIds.length ? ` (${cost.unknownAttemptIds.length} attempts)` : ''}`) : ''}`;
}
export function commissionStateLabel(state: string, zh: boolean): string {
  return ({ queued: zh ? '已排队' : 'Queued', running: zh ? '研究中' : 'Running', awaiting_review: zh ? '交付待复核' : 'Awaiting review', completed: zh ? '研究完成' : 'Completed', partial: zh ? '部分交付' : 'Partial delivery', blocked: zh ? '已阻断' : 'Blocked', failed: zh ? '确定失败' : 'Failed', cancelling: zh ? '取消请求处理中' : 'Cancellation requested', cancelled: zh ? '已确认取消' : 'Cancelled', uncertain: zh ? '结果未知，需核对' : 'Outcome unknown — check existing task' } as Record<string, string>)[state] ?? state;
}
