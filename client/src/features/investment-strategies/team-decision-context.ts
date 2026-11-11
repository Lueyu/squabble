import type { TeamDecision, TeamDecisionRef } from '@shared/team-workspace.interface';

export interface TeamDecisionContext { teamId: string | null; ref: TeamDecisionRef | null; invalid: boolean }

export function teamDecisionContextFromSearch(params: URLSearchParams): TeamDecisionContext {
  const fields = ['teamId', 'teamDecisionId', 'proposalId', 'proposalRevision'];
  if (!fields.some(field => params.has(field))) return { teamId: null, ref: null, invalid: false };
  if (fields.some(field => params.getAll(field).length !== 1 || !params.get(field)?.trim()))
    return { teamId: params.get('teamId'), ref: null, invalid: true };
  const revision = Number(params.get('proposalRevision'));
  if (!Number.isSafeInteger(revision) || revision < 1) return { teamId: params.get('teamId'), ref: null, invalid: true };
  return { teamId: params.get('teamId'), invalid: false, ref: {
    decisionId: params.get('teamDecisionId')!, proposalId: params.get('proposalId')!, proposalRevision: revision,
  } };
}

export function canonicalTeamDecisionRefs(refs: TeamDecisionRef[] = []): TeamDecisionRef[] {
  const unique = new Map(refs.map(ref => [`${ref.proposalId}:${ref.proposalRevision}:${ref.decisionId}`, {
    proposalId: ref.proposalId, proposalRevision: ref.proposalRevision, decisionId: ref.decisionId,
  }]));
  return [...unique.values()].sort((a, b) => a.proposalId.localeCompare(b.proposalId) || a.proposalRevision - b.proposalRevision || a.decisionId.localeCompare(b.decisionId));
}

/** Replace a revised proposal only in the candidate; other immutable sources remain pinned. */
export function withRequestedTeamDecision(refs: TeamDecisionRef[], requested: TeamDecisionRef | null): TeamDecisionRef[] {
  return canonicalTeamDecisionRefs(requested ? [...refs.filter(ref => ref.proposalId !== requested.proposalId), requested] : refs);
}

/** Readability and exact identity checks only; the server repeats authority checks on preview and final apply. */
export function matchTeamDecision(items: TeamDecision[], context: TeamDecisionContext, accountId: string): TeamDecision | null {
  if (!context.ref || !context.teamId || context.invalid) return null;
  return items.find(item => item.id === context.ref!.decisionId && item.proposalId === context.ref!.proposalId &&
    item.proposalRevision === context.ref!.proposalRevision && item.accountId === accountId &&
    item.teamId === context.teamId && item.event === 'adopt') ?? null;
}
