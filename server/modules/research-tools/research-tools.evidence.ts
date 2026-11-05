import type { EvidenceMetadata } from '@shared/research-evidence.interface';
import { evidencePromptMetadata } from '../research-memory/research-memory.temporal';

function metadata(value: unknown): value is EvidenceMetadata {
  return Boolean(value && typeof value === 'object' && 'sources' in value && Array.isArray(value.sources)
    && value.sources.every(source => source && typeof source === 'object' && Array.isArray(source.facts)));
}
/** Inspect only the adapter projection, never arbitrary nested JSON or saved report/model bodies. */
export function toolEvidenceMetadata(value: unknown, tool: string): EvidenceMetadata {
  const record = (entry: unknown): Record<string, unknown> => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? entry as Record<string, unknown> : {};
  const projected = (entry: unknown): EvidenceMetadata['sources'] => {
    const evidence = record(entry).evidence;
    return Array.isArray(evidence) ? evidence.flatMap(item => {
      const candidate = record(item).metadata;
      return metadata(candidate) ? candidate.sources : [];
    }) : [];
  };
  if (['get_financials', 'get_valuation', 'get_news', 'search_research_web'].includes(tool)) return { sources: projected(value) };
  const companies = record(value).companies;
  return { sources: tool === 'get_peer_comparison' && Array.isArray(companies)
    ? companies.flatMap(company => projected(record(record(company).financials).data)) : [] };
}
export function compactToolEvidence(value: unknown): unknown {
  if (metadata(value)) return evidencePromptMetadata(value);
  if (Array.isArray(value)) return value.map(compactToolEvidence);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactToolEvidence(item)]));
  return value;
}
