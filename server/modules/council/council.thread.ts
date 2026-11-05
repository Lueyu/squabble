import { BadRequestException } from '@nestjs/common';
import { COUNCIL_SCENES, type CouncilScene, type CouncilPeriod, type CouncilThreadMessage, type CouncilContinuationSummary } from '../../../shared/council.interface';
import type { ResolvedReportReference } from '../../../shared/research-document.interface';
import { normalizeTicker } from './council.rules';

export function normalizeThread(input: { scene?: unknown; ticker?: unknown; title?: unknown; subject?: unknown; period?: unknown }) {
  const scene = input.scene ?? 'stock';
  if (!(COUNCIL_SCENES as readonly unknown[]).includes(scene)) throw new BadRequestException('Invalid discussion scene');
  const requiresTicker = scene === 'stock' || scene === 'trade_pre_review';
  let ticker = 'PORTFOLIO';
  if (requiresTicker || input.ticker && input.ticker !== 'PORTFOLIO') {
    try { ticker = normalizeTicker(input.ticker); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid ticker'); }
  }
  const text = (value: unknown, fallback: string, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new BadRequestException('Invalid discussion title or subject');
    return value.trim();
  };
  const subject = text(input.subject, ticker, 240);
  const title = text(input.title, subject, 160);
  let period: CouncilPeriod | null = null;
  if (input.period !== undefined && input.period !== null) {
    const value = input.period as CouncilPeriod;
    const validDate = (date: unknown): date is string => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date)
      && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
    if (!validDate(value.start) || !validDate(value.end) || value.start > value.end) throw new BadRequestException('Invalid discussion period');
    period = { start: value.start, end: value.end };
  }
  return { scene: scene as CouncilScene, ticker, title, subject, period };
}

export function freezeThreadContext(messages: CouncilThreadMessage[], messageId: string): CouncilThreadMessage[] {
  const index = messages.findIndex(message => message.id === messageId);
  if (index < 0) throw new BadRequestException('Fork message must belong to the parent discussion');
  return messages.slice(0, index + 1).map(({ id, role, memberName, content }) => ({ id, role, memberName, content }));
}

/** Archive navigation is not recursively copied into the next prompt; explicit pinned report bodies remain whole. */
function reportSnapshotContext(snapshot: ResolvedReportReference['snapshot']) {
  if (!snapshot) return snapshot;
  const { inheritedContext, resolvedReferences, continuationSummary, ...facts } = snapshot;
  return { ...facts,
    ...(Array.isArray(inheritedContext) ? { archivedTranscript: { messageCount: inheritedContext.length, instruction: 'Use the source discussion to search original messages; archived transcript is not repeated here.' } } : {}),
    ...(Array.isArray(resolvedReferences) ? { sourceReportProvenance: resolvedReferences.map((ref: ResolvedReportReference) => ({ versionId: ref.versionId,
      sectionId: ref.sectionId, title: ref.title, version: ref.version, status: ref.status, sourceStatus: ref.sourceStatus,
      instruction: 'Nested source body is not an explicit pinned report in this discussion. Select its exact version if needed.' })) } : {}),
    ...(continuationSummary && typeof continuationSummary === 'object' ? { archivedContinuation: {
      content: (continuationSummary as CouncilContinuationSummary).content, sourceSessionId: (continuationSummary as CouncilContinuationSummary).sourceSessionId,
      instruction: 'User-reviewed context, not factual evidence.' } } : {}),
  };
}

/** Required report bodies stay whole. The budget gate rejects oversized requests rather than clipping evidence. */
export function threadPromptContext(row: { scene?: CouncilScene; title?: string; subject?: string; period?: CouncilPeriod | null;
  resolvedReferences?: ResolvedReportReference[]; inheritedContext?: CouncilThreadMessage[]; continuationSummary?: CouncilContinuationSummary | null }) {
  return { scene: row.scene ?? 'stock', title: row.title, subject: row.subject, period: row.period ?? null,
    pinnedReports: (row.resolvedReferences ?? []).map(ref => ref.snapshot ? { ...ref, snapshot: reportSnapshotContext(ref.snapshot) } : ref),
    parentDiscussion: row.continuationSummary ? [] : row.inheritedContext ?? [],
    continuationSummary: row.continuationSummary ? { content: row.continuationSummary.content, sourceSessionId: row.continuationSummary.sourceSessionId,
      sourceMessageCount: row.continuationSummary.sourceMessageIds.length, firstMessageId: row.continuationSummary.sourceMessageIds[0],
      lastMessageId: row.continuationSummary.sourceMessageIds.at(-1), reportId: row.continuationSummary.reportId, references: row.continuationSummary.references } : null,
    summaryPolicy: 'A user-reviewed continuation summary is a hypothesis and navigation aid, not factual evidence. Verify claims against pinned reports. Source message IDs link to the frozen parent transcript.',
    referencePolicy: 'Revoked reports or missing sources are historical material to challenge, never valid factual evidence or trading authorization. Preserve their status in every conclusion.' };
}

export function isPortfolioThread(row: { scene?: CouncilScene; ticker: string }): boolean {
  return row.scene === 'portfolio_daily' || row.scene === 'period_strategy' || row.ticker === 'PORTFOLIO';
}

export function hasThreadContext(row: { scene?: CouncilScene; ticker: string; title?: string; subject?: string;
  period?: CouncilPeriod | null; references?: unknown[]; inheritedContext?: unknown[] }): boolean {
  return Boolean(row.scene && row.scene !== 'stock' || row.title && row.title !== row.ticker || row.subject && row.subject !== row.ticker
    || row.period || row.references?.length || row.inheritedContext?.length);
}

export function hasDeliberation(engine: string | undefined, cycleId: string | undefined,
  messages: Array<{ memberId?: string | null; role: string; cycleId?: string }>): boolean {
  if (!engine || engine === 'basic' || !cycleId) return false;
  const current = messages.filter(message => message.cycleId === cycleId && message.memberId);
  return current.some(message => message.role === 'manager') && current.some(message => ['researcher', 'challenger'].includes(message.role))
    && new Set(current.map(message => message.memberId)).size >= 2;
}
