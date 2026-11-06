import { readableResearch } from '@shared/research-reading';
/** Arrival of research must not move someone who is reading earlier messages. */
export function isReadingLatest(element: { scrollHeight: number; clientHeight: number; scrollTop: number }): boolean {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= 64;
}

export function readableResearchText(value?: string | null): string {
  const text = value?.trim() || '';
  // Older daily reports embedded internal ledger objects in their body. Never
  // present serialized storage records as investment analysis.
  if (!text || /"(?:dailyLedgerFacts|portfolioSnapshot|holdingsFingerprint)"\s*:/u.test(text)
    ) return '';
  return readableResearch(text);
}

export function researchModelLabel(model: string | undefined, zh: boolean): string {
  return model && !['unreported', 'unknown', 'default', 'local-default'].includes(model.toLowerCase())
    ? model : zh ? '本地默认模型' : 'Local default model';
}
