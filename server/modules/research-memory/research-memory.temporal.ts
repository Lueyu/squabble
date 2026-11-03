import type { CompactEvidenceMetadata, EvidenceMetadata, EvidenceSourceMetadata, EvidenceComparisonKind,
  ThesisFreshness, TypedEvidenceFact } from '@shared/research-evidence.interface';
import type { ThesisContent } from '@shared/research-memory.interface';

type Evidence = { metadata?: EvidenceMetadata | null; title?: string; sourceName?: string | null;
  sourceUrl?: string | null; fetchedAt?: string; evidenceType?: string };
const stamp = (value: string | null | undefined): number => value ? Date.parse(value) : NaN;
export function unverifiedAgentMetadata(sourceUrl: string, observedAt: string): EvidenceMetadata {
  const metadata = normalizeEvidenceMetadata({ title: 'Agent source unverified', sourceUrl, fetchedAt: observedAt });
  metadata.sources[0].observationBasis = 'server';
  return metadata;
}
/** Date-only publication has day precision, so historical reads conservatively wait until that day has ended. */
function latestInstant(value: string, precision?: 'day' | 'instant' | null): number {
  return stamp(precision === 'day' || /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T23:59:59.999Z` : value);
}

export function normalizeEvidenceMetadata(evidence: Evidence): EvidenceMetadata {
  if (evidence.metadata?.sources?.length) return evidence.metadata;
  const agent = /unverified|未(?:独立)?核验|未经核实/iu.test(`${evidence.title ?? ''} ${evidence.sourceName ?? ''}`);
  return { sources: [{ origin: agent ? 'agent' : 'legacy', verification: agent ? 'unverified' : 'unknown',
    provider: null, kind: ['financial', 'price', 'news'].includes(evidence.evidenceType ?? '')
      ? evidence.evidenceType as EvidenceSourceMetadata['kind'] : 'other', sourceUrl: evidence.sourceUrl ?? null,
    sourceRevision: null, supersedesSourceRevision: null, revisionReason: null,
    publishedAt: null, publicationPrecision: null, observedAt: Number.isFinite(stamp(evidence.fetchedAt)) ? evidence.fetchedAt! : null,
    observationBasis: Number.isFinite(stamp(evidence.fetchedAt)) ? 'legacy_fetched_at' : 'unknown', facts: [] }] };
}

/** No values or report bodies in prompt citations. Full typed facts resolve through durable evidence IDs. */
export function compactEvidenceMetadata(metadata: EvidenceMetadata): CompactEvidenceMetadata {
  return { sources: metadata.sources.map(({ facts, sourceRevision, supersedesSourceRevision, revisionReason, ...source }) => {
    const contexts = facts.map(({ entity: _entity, metric: _metric, value: _value, ...context }) => context);
    return { ...source, ...(supersedesSourceRevision || revisionReason ? { revision: {
      source: sourceRevision, supersedes: supersedesSourceRevision, reason: revisionReason } } : {}),
    contexts: [...new Map(contexts.map(context => [JSON.stringify(context), context])).values()] };
  }) };
}

/** Current-source prompts use a keyed synopsis. Historical memory keeps its full structured contexts. */
export function evidencePromptMetadata(metadata: EvidenceMetadata, outerUrl?: string | null) {
  return metadata.sources.map(source => {
    const groups = new Map<string, Set<string>>();
    for (const fact of source.facts) {
      const measurement = `${fact.actuality ?? 'unknown actual/forecast'}; unit=${fact.unit ?? 'unknown'}; currency=${fact.currency ?? 'unknown'}; basis=${fact.basis ?? 'unknown'}`;
      const periods = groups.get(measurement) ?? new Set<string>();
      periods.add(fact.instant ? `instant ${fact.instant}` : `${fact.periodStart ?? 'unknown start'}/${fact.periodEnd ?? 'unknown end'}`);
      groups.set(measurement, periods);
    }
    return { provenance: `${source.origin}/${source.verification}/${source.provider ?? 'unknown provider'}`, kind: source.kind,
      ...(source.sourceUrl !== outerUrl ? { sourceUrl: source.sourceUrl } : {}),
      publication: source.publishedAt ? `${source.publishedAt} (${source.publicationPrecision ?? 'unknown precision'})` : 'unknown',
      observation: `${source.observedAt ?? 'unknown'} (${source.observationBasis})`,
      ...(source.supersedesSourceRevision || source.revisionReason ? { revision: {
        source: source.sourceRevision, supersedes: source.supersedesSourceRevision, reason: source.revisionReason } } : {}),
      contexts: [...groups].map(([measurement, periods]) => ({ measurement, periods: [...periods] })) };
  });
}

export function evidenceVisibleAt(metadata: EvidenceMetadata, ingestedAt: string, asOf: string): boolean {
  const cutoff = stamp(asOf);
  if (!Number.isFinite(cutoff) || !Number.isFinite(stamp(ingestedAt)) || stamp(ingestedAt) > cutoff) return false;
  const publicationKnown = (source: EvidenceSourceMetadata): boolean => {
    if (!source.publishedAt) return true;
    const latest = latestInstant(source.publishedAt, source.publicationPrecision);
    const observed = stamp(source.observedAt), dayStart = stamp(source.publishedAt);
    return Number.isFinite(latest) && (latest <= cutoff || source.publicationPrecision === 'day'
      && source.observationBasis !== 'unknown' && Number.isFinite(observed) && observed >= dayStart && observed <= cutoff);
  };
  return metadata.sources.every(source => publicationKnown(source)
    && (!source.observedAt || Number.isFinite(stamp(source.observedAt)) && stamp(source.observedAt) <= cutoff)
    && source.facts.every(fact => fact.actuality !== 'actual' || [fact.periodEnd, fact.instant].every(value =>
      !value || Number.isFinite(stamp(value)) && stamp(value) <= cutoff)));
}

export function thesisFreshness(content: Pick<ThesisContent, 'horizon'>, expiresAt: string | null,
  asOf: string, conflict = false): ThesisFreshness {
  const now = stamp(asOf), horizon = content.horizon;
  if ([expiresAt, horizon?.endAt].some(value => value && stamp(value) <= now)) return 'expired';
  if (horizon?.startAt && stamp(horizon.startAt) > now) return 'not_yet_valid';
  if (conflict || horizon?.reviewAt && stamp(horizon.reviewAt) <= now) return 'needs_review';
  return expiresAt || horizon?.startAt || horizon?.endAt || horizon?.reviewAt ? 'current' : 'unknown';
}

export interface ComparableEvidence { source: EvidenceSourceMetadata; fact: TypedEvidenceFact }
export function compareEvidence(left: ComparableEvidence, right: ComparableEvidence): { kind: EvidenceComparisonKind } {
  const trusted = (item: ComparableEvidence) => item.source.origin === 'provider' && item.source.verification === 'server-verified'
    && Number.isFinite(item.fact.value) && item.fact.value !== null
    && ['entity', 'metric', 'unit', 'currency', 'basis', 'actuality'].every(key => Boolean(item.fact[key as keyof TypedEvidenceFact]))
    && Boolean(item.fact.instant || item.fact.periodStart && item.fact.periodEnd);
  if (!trusted(left) || !trusted(right)) return { kind: 'unknown' };
  if (['entity', 'metric', 'unit', 'currency', 'basis', 'actuality'].some(key =>
    left.fact[key as keyof TypedEvidenceFact] !== right.fact[key as keyof TypedEvidenceFact])) return { kind: 'not_comparable' };
  if (['periodStart', 'periodEnd', 'instant'].some(key =>
    left.fact[key as keyof TypedEvidenceFact] !== right.fact[key as keyof TypedEvidenceFact])) return { kind: 'different_period' };
  if (left.fact.value === right.fact.value) return { kind: 'same' };
  const replaces = (newer: EvidenceSourceMetadata, older: EvidenceSourceMetadata) => newer.provider === older.provider
    && Boolean(older.sourceRevision && newer.supersedesSourceRevision === older.sourceRevision && newer.revisionReason);
  return { kind: replaces(left.source, right.source) || replaces(right.source, left.source) ? 'superseded' : 'conflict' };
}
