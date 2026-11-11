import type { TeamResearchLink } from '@shared/team-workspace.interface';

export function teamLedgerHref(accountId: string, link: Pick<TeamResearchLink, 'kind' | 'targetId' | 'metadata'>): string {
  const params = new URLSearchParams({ accountId });
  if (link.kind === 'order') params.set('orderId', link.targetId);
  else if (link.metadata.sourceKind === 'order' && typeof link.metadata.sourceId === 'string' && link.metadata.sourceId.trim()) {
    params.set('orderId', link.metadata.sourceId);
  } else params.set('tradeId', link.targetId);
  return `/transactions?${params}`;
}
