import { BadRequestException } from '@nestjs/common';
import type { Market } from '@shared/api.interface';
import type { ResearchMemoryPreferences, ResearchMemoryRecall, ResearchMemoryRecallItem } from '@shared/research-memory.interface';
import { packMemoryContext } from './research-memory.context';
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
  const terms = topic.toLowerCase().split(/\s+/u).filter(Boolean);
  const relevance = (item: ResearchMemoryRecallItem): number => (terms.length && item.topic === normalizedTopic(topic) ? 100 : 0) + terms.reduce((score, term) =>
    score + (item.summary.toLowerCase().includes(term) ? 1 : 0), 0);
  const selected = [...items].sort((a, b) => Number(b.kind === 'thesis') - Number(a.kind === 'thesis') || relevance(b) - relevance(a)
    || Date.parse(b.source.reportCreatedAt) - Date.parse(a.source.reportCreatedAt)
    || a.id.localeCompare(b.id)).slice(0, 3);
  return { items: selected, context: packMemoryContext(selected, MEMORY_CONTEXT_LIMIT).context, preferences };
}
