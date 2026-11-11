import type { ResearchSourceRef, TeamDecision, TeamSourceGrant } from '@shared/team-workspace.interface';

export interface ComparedAccount { accountId: string; name: string; createdAt: string | null; strategyCount: number }
export interface TeamComparisonRead {
  scopeKey: string;
  decisionStatus: 'pending' | 'success' | 'error'; sourceStatus: 'pending' | 'success' | 'error';
  decisions: TeamDecision[]; grants: TeamSourceGrant[];
  decisionsHaveMore: boolean; sourcesHaveMore: boolean;
  decisionError?: string; sourceError?: string;
}
const JUDGMENTS = new Set(['propose', 'observe', 'defer', 'reject', 'adopt']);
const ACTIONS = new Set(['applied', 'continue_policy', 'requires_reapproval']);
function decisionTime(value: TeamDecision): number { const time = Date.parse(value.createdAt); return Number.isFinite(time) ? time : -Infinity; }
function sortedRecords(values: TeamDecision[]): TeamDecision[] {
  return [...new Map(values.map(value => [value.id, value])).values()].sort((a, b) => decisionTime(b) - decisionTime(a) || b.proposalRevision - a.proposalRevision || a.id.localeCompare(b.id));
}
/** Historic attribution is the decision's immutable account/team identity, never today's binding. */
export function accountDecisionRecords(values: TeamDecision[], accountId: string): TeamDecision[] {
  return sortedRecords(values.filter(value => value.accountId === accountId));
}
export function decisionComparisonSummary(values: TeamDecision[]): { judgment: TeamDecision | null; action: TeamDecision | null; latest: TeamDecision | null } {
  const sorted = sortedRecords(values);
  return { judgment: sorted.find(value => JUDGMENTS.has(value.event)) ?? null, action: sorted.find(value => ACTIONS.has(value.event)) ?? null, latest: sorted[0] ?? null };
}
export interface SharedDecisionInput {
  key: string; sourceRef: ResearchSourceRef;
  members: { accountId: string; judgment: TeamDecision | null; action: TeamDecision | null; latest: TeamDecision | null }[];
}
export function sourceIdentity(ref: ResearchSourceRef): string { return JSON.stringify([ref.kind, ref.id, ref.revision]); }
/** Only sourceRefs actually cited in each decision basis qualify as shared information. */
export function sharedDecisionInputs(accountIds: string[], values: TeamDecision[]): SharedDecisionInput[] {
  const groups = new Map<string, { ref: ResearchSourceRef; accounts: Map<string, TeamDecision[]> }>();
  for (const value of values) {
    if (!accountIds.includes(value.accountId)) continue;
    for (const ref of value.basis?.sourceRefs ?? []) {
      const key = sourceIdentity(ref); const group = groups.get(key) ?? { ref, accounts: new Map<string, TeamDecision[]>() };
      group.accounts.set(value.accountId, [...(group.accounts.get(value.accountId) ?? []), value]); groups.set(key, group);
    }
  }
  return [...groups].filter(([, group]) => group.accounts.size > 1).map(([key, group]) => ({ key, sourceRef: group.ref, members: accountIds.filter(accountId => group.accounts.has(accountId)).map(accountId => ({ accountId, ...decisionComparisonSummary(group.accounts.get(accountId)!) })) }))
    .sort((a, b) => Math.max(...b.members.map(member => member.latest ? decisionTime(member.latest) : -Infinity)) - Math.max(...a.members.map(member => member.latest ? decisionTime(member.latest) : -Infinity)) || a.key.localeCompare(b.key));
}
export function decisionSourceAvailability(decision: TeamDecision, ref: ResearchSourceRef, read: Pick<TeamComparisonRead, 'sourceStatus' | 'grants'> | undefined): 'available' | 'revoked' | 'unavailable' | 'unknown' {
  if (!read || read.sourceStatus !== 'success') return 'unknown';
  const matches = read.grants.filter(grant => grant.teamId === decision.teamId && sourceIdentity(grant.sourceRef) === sourceIdentity(ref));
  if (matches.some(grant => grant.state === 'active' && grant.sourceRef.availability === 'available')) return 'available';
  if (matches.some(grant => grant.state === 'active' && ['deleted', 'missing', 'revoked'].includes(grant.sourceRef.availability))) return 'unavailable';
  if (matches.some(grant => grant.state === 'revoked')) return 'revoked';
  return 'unknown';
}
export function comparisonDecisionLabel(event: string, zh: boolean): string {
  return ({ propose: zh ? '提出建议' : 'Proposed', observe: zh ? '继续观察' : 'Observe', defer: zh ? '暂缓判断' : 'Deferred', reject: zh ? '用户拒绝' : 'Rejected', adopt: zh ? '用户采用，未等同策略应用' : 'Adopted; not policy application', applied: zh ? '策略已应用，未等同成交' : 'Policy applied; not a fill', continue_policy: zh ? '继续原已确认规则' : 'Continue confirmed policy', requires_reapproval: zh ? '待重新核准' : 'Reapproval required' } as Record<string, string>)[event] ?? (zh ? '状态未识别' : 'Unrecognized state');
}
export function teamResearchStatus(count: number | null | undefined, zh: boolean): string {
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return zh ? '研究状态未知' : 'Research status unknown';
  return count > 0 ? (zh ? `研究中 ${count} 项` : `${count} active research commissions`) : (zh ? '当前无进行中委托' : 'No currently active research commissions');
}
