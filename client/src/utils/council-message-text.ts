import type { CouncilMessage } from '@shared/council.interface';
import { councilMessageDisplayContent } from './council-state';

/** Copy public response content, including sections folded in the UI. */
export function councilCopyText(message: CouncilMessage): string {
  const response = message.response;
  const parts = [councilMessageDisplayContent(message), ...(response
    ? [response.thesis, ...response.evidencePoints, ...response.risks, ...response.nextChecks, response.details]
    : []), ...(message.reasoningSummary ?? [])];
  return [...new Set(parts.filter((part): part is string => Boolean(part?.trim())))].join('\n\n');
}

export function councilReplyExcerpt(message: CouncilMessage): string {
  const text = (message.response?.thesis || councilMessageDisplayContent(message)).replace(/\s+/gu, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}
