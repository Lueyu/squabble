import { createHash } from 'node:crypto';
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function channelHash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function graphemeCount(value: string): number {
  const Segmenter = (Intl as unknown as { Segmenter?: new (...args: unknown[]) => { segment(value: string): Iterable<unknown> } }).Segmenter;
  return Segmenter ? [...new Segmenter('zh', { granularity: 'grapheme' }).segment(value)].length : [...value].length;
}
