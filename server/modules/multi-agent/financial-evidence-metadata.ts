import type { EvidenceMetadata, TypedEvidenceFact } from '@shared/research-evidence.interface';

/** Called only with values already validated by the deterministic financial adapters. */
export function financialMetadata(input: { ticker: string; provider: string; sourceUrl: string; accession: string;
  filed: string; end: string; amended?: boolean; facts: Array<{ value: number; unit?: string; start: string | null; concept: string }> }): EvidenceMetadata {
  return { sources: [{ origin: 'provider', verification: 'server-verified', provider: input.provider, kind: 'financial',
    sourceUrl: input.sourceUrl, sourceRevision: input.accession, supersedesSourceRevision: null,
    revisionReason: input.amended ? 'Amended filing; superseded accession not supplied' : null,
    publishedAt: input.filed, publicationPrecision: 'day', observedAt: null, observationBasis: 'unknown',
    facts: input.facts.map((fact): TypedEvidenceFact => ({ entity: input.ticker.toUpperCase(),
      metric: `us-gaap:${fact.concept.replace(/^us-gaap[:_]/u, '')}`, value: fact.value,
      unit: fact.unit ? 'currency' : null, currency: fact.unit ?? null, basis: 'us-gaap', actuality: 'actual',
      periodStart: fact.start || null, periodEnd: fact.start === '' ? null : input.end, instant: fact.start === '' ? input.end : null })) }] };
}
