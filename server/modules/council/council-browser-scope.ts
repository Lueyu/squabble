import type { CouncilEvidence } from './council.rules';

/** Freeze public provenance only; model text and owner/library context never grant a navigation target. */
export function frozenPublicBrowserStartUrls(evidence: CouncilEvidence[]): string[] {
  const urls = new Set<string>();
  for (const item of evidence) {
    if (item.sourceName === 'Frozen owner context' || item.libraryReferences?.length || !item.sourceUrl || item.sourceUrl.length > 2000) continue;
    try {
      const url = new URL(item.sourceUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) continue;
      urls.add(url.href);
      if (urls.size >= 20) break;
    } catch { /* Non-web citations remain evidence but cannot authorize browser navigation. */ }
  }
  return [...urls].sort();
}
