import type { TeamResearchLink } from '@shared/team-workspace.interface';

export function teamLedgerHref(accountId: string, link: Pick<TeamResearchLink, 'kind' | 'targetId'>): string {
  const params = new URLSearchParams({ accountId });
  params.set(link.kind === 'order' ? 'orderId' : 'tradeId', link.targetId);
  return `/transactions?${params}`;
}
