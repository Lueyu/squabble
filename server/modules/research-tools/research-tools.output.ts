import type { ResearchSource, ResearchToolResult } from '@shared/research-tools.interface';
import { RESULT_LIMIT_BYTES, validOutput } from './research-tools.registry';

export function clipped(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, ' ').slice(0, maximum) : '';
}

export function isoDate(value: unknown): string | null {
  const date: Date = value instanceof Date ? value : new Date(typeof value === 'string' || typeof value === 'number' ? value : NaN);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Source links are citations, never fetch destinations or credential containers. */
export function citationUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    const url: URL = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    if ([...url.searchParams.keys()].some((key: string) => /token|api[_-]?key|authorization|secret|password|signature/i.test(key))) return undefined;
    url.hash = '';
    return url.toString();
  } catch { return undefined; }
}

export function researchSource(title: unknown, url: unknown, fetchedAt: string): ResearchSource {
  const link: string | undefined = citationUrl(url);
  return { title: clipped(title, 160) || 'Source not reported', fetchedAt, ...(link ? { url: link } : {}) };
}

export function researchFailure(status: ResearchToolResult['status'], errorCode: string, started = false): ResearchToolResult {
  return { status, errorCode, data: { message: errorCode,
    ...(started ? { completion: 'The upstream request may still continue; its completion and any provider charge are unknown.' } : {}) },
  sources: [], asOf: new Date().toISOString(), truncated: false };
}

/** Results stay valid structured JSON after clipping; byte limits include CJK text. */
export function boundedResult(result: ResearchToolResult): ResearchToolResult {
  let shortened: boolean = result.truncated;
  const clean = (value: unknown, depth = 0, stringLimit = 3000): unknown => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (value.length > stringLimit) shortened = true;
      return clipped(value, stringLimit);
    }
    if (Array.isArray(value)) {
      if (value.length > 12) shortened = true;
      return value.slice(0, 12).map((item: unknown) => clean(item, depth + 1, stringLimit));
    }
    if (value && typeof value === 'object' && depth < 8) {
      const entries: [string, unknown][] = Object.entries(value);
      if (entries.length > 32) shortened = true;
      return Object.fromEntries(entries.slice(0, 32).map(([key, item]: [string, unknown]) => [key, clean(item, depth + 1, stringLimit)]));
    }
    shortened = true;
    return null;
  };
  let data: unknown = clean(result.data);
  const sources: ResearchSource[] = result.sources.slice(0, 12);
  if (sources.length < result.sources.length) shortened = true;
  let bounded: ResearchToolResult = { ...result, data, sources, truncated: shortened };
  for (const maximum of [1500, 700, 300, 100]) {
    if (Buffer.byteLength(JSON.stringify(bounded)) <= RESULT_LIMIT_BYTES) break;
    data = clean(data, 0, maximum);
    bounded = { ...bounded, data, truncated: true };
  }
  if (Buffer.byteLength(JSON.stringify(bounded)) > RESULT_LIMIT_BYTES) {
    return { ...researchFailure('partial', 'RESEARCH_RESULT_LIMIT'), truncated: true };
  }
  return validOutput(bounded) ? bounded : researchFailure('failed', 'RESEARCH_INVALID_RESULT');
}
