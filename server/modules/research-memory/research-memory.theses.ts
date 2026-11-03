import type { ThesisContent } from '../../../shared/research-memory.interface';
import { createHash } from 'node:crypto';

/** Old records retain unknown boundaries and legacy authorship instead of inferred assertions. */
export function normalizeThesisContent(content: ThesisContent, origin = content.provenance?.origin ?? 'legacy'): ThesisContent {
  return { ...content, boundaryOrigin: content.boundaryOrigin ?? 'unknown', evidenceRelations: content.evidenceRelations ?? [],
    provenance: { ...content.provenance, origin } };
}

export function thesisEvidenceIds(content: ThesisContent): string[] {
  return [...new Set([...content.supportingEvidence.map(ref => ref.evidenceId), ...(content.evidenceRelations ?? []).map(ref => ref.evidenceId)])];
}

export function validateThesisReferences(content: ThesisContent, validIds: Set<string>): boolean {
  const supporting = content.supportingEvidence.map(ref => ref.evidenceId);
  const relations = (content.evidenceRelations ?? []).map(ref => `${ref.evidenceId}:${ref.role}`);
  return new Set(supporting).size === supporting.length && new Set(relations).size === relations.length
    && thesisEvidenceIds(content).every(id => validIds.has(id));
}

export function isUnverifiedCitation(citation: { title: string; sourceUrl: string | null; fetchedAt: string }): boolean {
  if (/unverified|未(?:独立)?核验|未经核实/iu.test(citation.title) || !Number.isFinite(Date.parse(citation.fetchedAt))
    || Date.parse(citation.fetchedAt) > Date.now() + 300_000) return true;
  try { const url = new URL(citation.sourceUrl ?? ''); return !['http:', 'https:'].includes(url.protocol) || Boolean(url.username || url.password); }
  catch { return true; }
}

/** Exact content only: no embeddings, fuzzy matching or probabilistic merging. */
export function thesisFingerprint(content: ThesisContent): string {
  const { provenance: _provenance, ...value } = content;
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stable(entry)])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
