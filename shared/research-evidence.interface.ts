/** Exact source fields only. Unknown values remain null, never extracted from model prose. */
export interface TypedEvidenceFact {
  entity: string | null; metric: string | null; value: number | null;
  unit: string | null; currency: string | null; basis: string | null;
  actuality: 'actual' | 'forecast' | null;
  periodStart: string | null; periodEnd: string | null; instant: string | null;
}
export interface EvidenceSourceMetadata {
  origin: 'provider' | 'agent' | 'legacy'; verification: 'server-verified' | 'unverified' | 'unknown';
  provider: string | null; kind: 'financial' | 'price' | 'news' | 'other'; sourceUrl: string | null;
  sourceRevision: string | null; supersedesSourceRevision: string | null; revisionReason: string | null;
  /** A date-only filing stays YYYY-MM-DD. It is never converted to a claimed exact release timestamp. */
  publishedAt: string | null; publicationPrecision: 'day' | 'instant' | null;
  observedAt: string | null; observationBasis: 'server' | 'legacy_fetched_at' | 'unknown';
  facts: TypedEvidenceFact[];
}
/** Aggregate tool results retain each component's own source and dates. */
export interface EvidenceMetadata { sources: EvidenceSourceMetadata[] }
export type CompactEvidenceMetadata = { sources: Array<Omit<EvidenceSourceMetadata,
  'facts' | 'sourceRevision' | 'supersedesSourceRevision' | 'revisionReason'> & {
  revision?: { source: string | null; supersedes: string | null; reason: string | null };
  contexts: Array<Omit<TypedEvidenceFact, 'entity' | 'metric' | 'value'>>;
}> };
export type ThesisFreshness = 'current' | 'unknown' | 'needs_review' | 'expired' | 'not_yet_valid';
export type EvidenceComparisonKind = 'same' | 'conflict' | 'different_period' | 'not_comparable' | 'unknown' | 'superseded';
