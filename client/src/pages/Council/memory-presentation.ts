import type { ResearchThesis, ThesisContent, UpdateResearchThesis } from '@shared/research-memory.interface';
import type { ResearchMonitorRule } from '@shared/research-monitor.interface';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';
import type { MemoryCopy } from './memory-copy';

export const thesisListFields = ['opposingEvidence', 'assumptions', 'indicators', 'invalidationConditions'] as const;
export function formatMemoryDate(value: string | null | undefined, locale: string, unknown = '—'): string {
  if (!value) return unknown;
  // A calendar date is not a midnight instant in the viewer's time zone.
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale) : unknown;
}
export function safeMemoryUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}
/** Server-owned provenance and materialized fields must never enter strict write requests. */
export function editableThesisContent(thesis: ThesisContent): ThesisContent {
  return { claim: thesis.claim, supportingEvidence: thesis.supportingEvidence, opposingEvidence: thesis.opposingEvidence,
    assumptions: thesis.assumptions, indicators: thesis.indicators, invalidationConditions: thesis.invalidationConditions,
    ...(thesis.horizon !== undefined ? { horizon: thesis.horizon } : {}),
    ...(thesis.boundaryOrigin !== undefined ? { boundaryOrigin: thesis.boundaryOrigin } : {}),
    ...(thesis.evidenceRelations !== undefined ? { evidenceRelations: thesis.evidenceRelations } : {}),
    ...(thesis.monitorConditions !== undefined ? { monitorConditions: thesis.monitorConditions } : {}),
    ...(thesis.supersedes !== undefined ? { supersedes: thesis.supersedes } : {}) };
}
export function thesisEditRequest(thesis: ResearchThesis, content: ThesisContent, reason: string, expiry: string): UpdateResearchThesis {
  return { action: 'edit', expectedVersion: thesis.version, content: editableThesisContent(content),
    changeReason: reason.trim() || null, expiresAt: expiry.trim() || null };
}
export function latestMonitorRules(rules: ResearchMonitorRule[]): { latest: ResearchMonitorRule[]; history: ResearchMonitorRule[] } {
  const roots = new Map<string, ResearchMonitorRule>();
  for (const rule of rules) {
    const root = rule.rootId ?? rule.id;
    if (!roots.has(root) || roots.get(root)!.version < rule.version) roots.set(root, rule);
  }
  const ids = new Set([...roots.values()].map(rule => rule.id));
  return { latest: rules.filter(rule => ids.has(rule.id)), history: rules.filter(rule => !ids.has(rule.id)) };
}
export function memoryErrorCode(error: unknown): string {
  return errorMessage(error, '');
}
export function memoryErrorText(error: unknown, copy: MemoryCopy): string {
  const code = typeof error === 'string' ? error : memoryErrorCode(error);
  if (code.includes('MONITOR_VERSION_CONFLICT')) return copy.monitorConflict;
  if (code.includes('VERSION_CONFLICT')) return copy.draftConflict;
  if (code.includes('AUTO_ARCHIVE_DISABLED')) return copy.autoDisabled;
  if (code.includes('SOURCE_NOT_FOUND') || code.includes('MEMORY_DELETED')) return copy.archiveGone;
  if (code.includes('SOURCE_NOT_COMPLETED')) return copy.archiveNotCompleted;
  if (code.includes('ARCHIVE_LEASE_EXPIRED')) return copy.archiveLease;
  if (code.includes('ARCHIVE_RUNNING')) return copy.archiveRunning;
  if (code.includes('ARCHIVE_')) return copy.archiveFailure;
  if (code.includes('INVALID_MONITOR_SOURCE')) return copy.monitorSource;
  if (code.includes('MONITOR_LIMIT')) return copy.monitorLimit;
  if (code.includes('MONITOR')) return copy.monitorInvalid;
  if (code.includes('SOURCE_REQUIRED') || code.includes('INVALID_EVIDENCE')) return copy.sourceRequired;
  if (code.includes('NOT_FOUND')) return copy.sourceUnavailable;
  if (code.includes('BREACH_REVIEW_REASON')) return copy.latched;
  if (code.includes('INVALID_THESIS')) return copy.invalid;
  return copy.failed;
}
