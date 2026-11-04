import { BadRequestException } from '@nestjs/common';
import type { Market } from '@shared/api.interface';
import type { ResearchMemoryPreferences, ResearchMemoryRecall, ResearchMemoryRecallItem } from '@shared/research-memory.interface';
import { memoryReference, packMemoryContext } from './research-memory.context';
import { boundedMemoryPins, memoryRelevance, relatedCounterclaim } from './research-memory.ranking';
export { compareEvidence, evidenceVisibleAt, thesisFreshness } from './research-memory.temporal';

export function canonicalMemorySymbol(ticker: string, market: Market | undefined,
  detect: (ticker: string) => { market: Market; displaySymbol: string; symbolNative: string }): { ticker: string; market: Market } {
  const symbol = String(ticker ?? '').trim().toUpperCase();
  if (!/^(?:[A-Z][A-Z0-9.^-]{0,19}|\d{4,6}|\d{1,5}\.HK|\d{6}\.(?:SH|SS|SZ|BJ))$/u.test(symbol)) {
    throw new BadRequestException('MEMORY_INVALID_SYMBOL');
  }
  const resolved = detect(symbol);
  if (market && market !== resolved.market) throw new BadRequestException('MEMORY_MARKET_MISMATCH');
  if (resolved.market === 'HK') {
    if (!/^(?:\d{4,5}|\d{1,5}\.HK)$/u.test(symbol)) throw new BadRequestException('MEMORY_INVALID_SYMBOL');
    return { market: 'HK', ticker: `${resolved.symbolNative.padStart(5, '0')}.HK` };
  }
  if (resolved.market === 'CN') return { market: 'CN', ticker: resolved.displaySymbol.replace(/\.SS$/u, '.SH') };
  if (!/^[A-Z][A-Z0-9.^-]{0,19}$/u.test(symbol) || /\.(?:HK|SH|SS|SZ|BJ)$/u.test(symbol)) {
    throw new BadRequestException('MEMORY_INVALID_SYMBOL');
  }
  return { market: 'US', ticker: resolved.displaySymbol };
}

export const MEMORY_CONTEXT_LIMIT = 6000;
export function normalizedTopic(topic?: string): string { return (topic?.trim().toLowerCase() || 'general').slice(0, 120); }

export function rankMemoryRecall(items: ResearchMemoryRecallItem[], topic: string,
  preferences: ResearchMemoryPreferences): ResearchMemoryRecall {
  if (!preferences.recallEnabled) return { items: [], context: '', preferences };
  const scores = new Map(items.map(item => [item, memoryRelevance(item, topic) + (topic && item.topic === normalizedTopic(topic) ? 100 : 0)]));
  const anchors = items.filter(item => scores.get(item)! > 0);
  const links = new Map(anchors.map(anchor => [anchor, items.filter(item => item !== anchor && relatedCounterclaim(anchor, item))]));
  const relatedScores = new Map(items.map(item => [item, Math.max(scores.get(item)!,
    ...anchors.filter(anchor => links.get(anchor)!.includes(item)).map(anchor => scores.get(anchor)! - 0.5))]));
  const relevance = (item: ResearchMemoryRecallItem): number => relatedScores.get(item)!;
  const sorted = [...items].sort((a, b) => relevance(b) - relevance(a)
    || Number(Boolean(links.get(b)?.length)) - Number(Boolean(links.get(a)?.length))
    || Number(b.kind === 'thesis') - Number(a.kind === 'thesis')
    || Date.parse(b.source.reportCreatedAt) - Date.parse(a.source.reportCreatedAt)
    || a.id.localeCompare(b.id));
  // Reserve ordering for authoritative counterevidence beside its anchor, ahead of equally topical unrelated claims.
  // Packing still omits an entire unit with an explicit budget reason if the pair cannot fit.
  const pool = boundedMemoryPins(sorted.flatMap(item => [item, ...sorted.filter(peer => links.get(item)?.includes(peer))]));
  const represented = new Set(pool.filter(item => item.kind === 'thesis' && item.content && item.status).map(item => item.memoryId));
  const selected = pool.filter(item => item.kind !== 'history' || !represented.has(item.memoryId));
  return { items: selected, context: packMemoryContext(selected, MEMORY_CONTEXT_LIMIT).context, preferences,
    requested: pool.map(memoryReference), omissions: pool.filter(item => !selected.includes(item)).map(item => ({
      ...memoryReference(item), reason: 'redundant-history' as const })) };
}
