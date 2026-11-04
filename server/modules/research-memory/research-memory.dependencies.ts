import { and, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { councilReports, councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { researchArchiveJobs, researchMemories, researchMemoryPreferences, researchMemoryEvidence, researchTheses, researchThesisVersions } from '../../database/research-memory.schema';
import { researchMonitorEvents, researchMonitorRules, researchThesisReplacements } from '../../database/research-monitor.schema';
import { desc } from 'drizzle-orm';
import type { StrategyMemoryInventory, StrategyThesisDependency } from '@shared/research-monitor.interface';
import type { ThesisContent } from '@shared/research-memory.interface';
import type { MemoryFenceTransaction } from './research-memory.fence';
import { sameMonitorSymbol } from './research-memory.monitor.rules';
import { evidenceVisibleAt, normalizeEvidenceMetadata, thesisFreshness } from './research-memory.temporal';
import { evidenceComparisons } from './research-memory.evidence';
import { isUnverifiedCitation, thesisEvidenceIds } from './research-memory.theses';

/** Caller owns the owner fence. Source row locks also serialize physical SQL deletion. */
export async function lockedThesis(tx: MemoryFenceTransaction, owner: string, id: string, requireEligible = true) {
  const [pin] = await tx.select().from(researchTheses).where(and(eq(researchTheses.owner, owner), eq(researchTheses.id, id)));
  const [parent] = pin ? await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, pin.memoryId))) : [];
  if (!parent) return null;
  const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, parent.sessionId))).for('share');
  const [report] = await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.id, parent.reportId))).for('share');
  const [memory] = await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, parent.id))).for('share');
  const [thesis] = await tx.select().from(researchTheses).where(and(eq(researchTheses.owner, owner), eq(researchTheses.id, id))).for('share');
  if (!session || !report || !memory || !thesis || memory.deletedAt || thesis.deletedAt
    || report.sessionId !== session.id || report.version !== memory.reportVersion || report.revision !== memory.reportRevision
    || report.publicationOutcome === 'failed') return null;
  if (!sameMonitorSymbol(session.ticker, memory.ticker)) return null;
  const records = await tx.select().from(researchMemoryEvidence).where(and(eq(researchMemoryEvidence.owner, owner), eq(researchMemoryEvidence.memoryId, memory.id)));
  const asOf = new Date().toISOString();
  const known = memory.createdAt.getTime() <= Date.parse(asOf) && memory.reportCreatedAt.getTime() <= Date.parse(asOf)
    && thesis.createdAt.getTime() <= Date.parse(asOf) && thesis.updatedAt.getTime() <= Date.parse(asOf)
    && report.evidence.every(item => {
      const record = records.find(row => row.evidenceId === item.id);
      return evidenceVisibleAt(normalizeEvidenceMetadata({ ...item, metadata: record?.metadata ?? item.metadata }),
        (record?.ingestedAt ?? memory.createdAt).toISOString(), asOf);
    });
  if (!known) return null;
  const refs = thesisEvidenceIds(thesis.content);
  const executionEligible = !memory.excluded && !thesis.excluded && ['accepted', 'confirmed'].includes(thesis.status)
    && refs.length > 0 && refs.every(ref => { const evidence = report.evidence.find(item => item.id === ref); return evidence && !isUnverifiedCitation(evidence); });
  if (requireEligible && !executionEligible) return null;
  const comparisons = await evidenceComparisons(tx, owner, memory, records, asOf, ticker => sameMonitorSymbol(ticker, memory.ticker));
  const conflicted = comparisons.some(item => item.kind === 'conflict' && records.some(record => record.id === item.left && refs.includes(record.evidenceId)));
  return { thesis, memory, report, executionEligible, conflicted };
}

export async function acceptedSubmitted(tx: MemoryFenceTransaction, owner: string, report: typeof councilReports.$inferSelect) {
  if (!report.coverage) return [];
  const coverage = report.coverage;
  const tasks = await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner),
    eq(councilResearchTasks.sessionId, report.sessionId), eq(councilResearchTasks.cycleId, coverage.cycleId)));
  if (!coverage.complete || coverage.revision !== report.revision || tasks.length !== coverage.tasks.length
    || tasks.some(task => task.state !== 'accepted' || task.revision !== report.revision || !task.acceptedAttemptId
      || !coverage.tasks.some(ref => ref.id === task.id && ref.acceptedAttemptId === task.acceptedAttemptId && ref.state === 'accepted'))) {
    throw new Error('MEMORY_RESEARCH_NOT_ACCEPTED');
  }
  return tasks.flatMap(task => {
    const attempt = task.attempts.find(item => item.id === task.acceptedAttemptId && item.kind === 'work' && item.state === 'succeeded');
    if (!attempt?.dispatched || !attempt.memory || !Array.isArray(attempt.memory.submitted)) throw new Error('MEMORY_SUBMISSION_UNKNOWN');
    return attempt.memory.submitted.filter(ref => ref.kind === 'thesis');
  });
}

/** Called only for server-proven accepted candidates, while the source and owner fence are locked. */
export async function recordReviewedReplacement(tx: MemoryFenceTransaction, owner: string,
  thesis: typeof researchTheses.$inferSelect, memory: typeof researchMemories.$inferSelect, report: typeof councilReports.$inferSelect,
  workflow: NonNullable<ThesisContent['provenance']>['workflow']): Promise<void> {
  const replacement = thesis.content.supersedes;
  if (!replacement || !workflow) return;
  const submitted = await acceptedSubmitted(tx, owner, report);
  const previous = await lockedThesis(tx, owner, replacement.thesisId);
  const [preferences] = await tx.select().from(researchMemoryPreferences).where(eq(researchMemoryPreferences.owner, owner));
  if (!preferences?.recallEnabled || !submitted.some(ref => ref.id === replacement.thesisId && ref.version === replacement.version)
    || !previous || previous.thesis.version !== replacement.version || previous.memory.market !== memory.market
    || !sameMonitorSymbol(previous.memory.ticker, memory.ticker)) return;
  await tx.insert(researchThesisReplacements).values({ owner, thesisId: thesis.id, thesisVersion: thesis.version,
    previousId: previous.thesis.id, previousVersion: previous.thesis.version, reason: replacement.reason,
    cycleId: workflow.cycleId, taskId: workflow.taskId, attemptId: workflow.attemptId }).onConflictDoNothing();
}

export async function captureStrategyMemory(tx: MemoryFenceTransaction, owner: string, reportIds: string[]): Promise<StrategyMemoryInventory> {
  if (!reportIds.length) return { state: 'unknown', dependencies: [], reason: 'MEMORY_REPORT_MISSING' };
  const reports = await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), inArray(councilReports.id, reportIds)))
    .orderBy(councilReports.id).for('share');
  if (reports.length !== new Set(reportIds).size) return { state: 'unknown', dependencies: [], reason: 'MEMORY_SOURCE_UNAVAILABLE' };
  const dependencies: StrategyThesisDependency[] = [];
  let structured = false;
  for (const report of reports) {
    const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, report.sessionId)));
    if (!session) return { state: 'unknown', dependencies, reason: 'MEMORY_SOURCE_UNAVAILABLE' };
    let submitted: Awaited<ReturnType<typeof acceptedSubmitted>>;
    try { submitted = await acceptedSubmitted(tx, owner, report); }
    catch { return { state: 'unknown', dependencies, reason: 'MEMORY_SUBMISSION_UNKNOWN' }; }
    for (const ref of submitted) {
      const current = await lockedThesis(tx, owner, ref.id);
      if (!current) return { state: 'unknown', dependencies, reason: 'MEMORY_DEPENDENCY_REVOKED' };
      if (sameMonitorSymbol(current.memory.ticker, session.ticker)) dependencies.push({ thesisId: ref.id, version: ref.version,
        ticker: current.memory.ticker, market: current.memory.market, origin: 'recalled-memory' });
    }
    if (!report.thesisCandidates?.length) continue;
    structured = true;
    const [memory] = await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner),
      eq(researchMemories.reportId, report.id), eq(researchMemories.reportVersion, report.version)));
    if (!memory) {
      const [preferences] = await tx.select().from(researchMemoryPreferences).where(eq(researchMemoryPreferences.owner, owner));
      const [job] = await tx.select().from(researchArchiveJobs).where(and(eq(researchArchiveJobs.owner, owner), eq(researchArchiveJobs.reportId, report.id)));
      return { state: preferences?.autoArchive === false ? 'archive-disabled' : job?.state === 'failed' ? 'archive-failed' : 'archive-pending',
        dependencies, reason: 'MEMORY_ARCHIVE_REQUIRED' };
    }
    if (memory.deletedAt || memory.excluded) return { state: 'unknown', dependencies, reason: 'MEMORY_DEPENDENCY_REVOKED' };
    const theses = await tx.select().from(researchTheses).where(and(eq(researchTheses.owner, owner), eq(researchTheses.memoryId, memory.id)));
    if (!theses.length) return { state: 'unknown', dependencies, reason: 'MEMORY_CLAIMS_MISSING' };
    for (const thesis of theses) dependencies.push({ thesisId: thesis.id, version: thesis.version, ticker: memory.ticker,
      market: memory.market, origin: 'current-report' });
  }
  // Only an authoritative new accepted replacement can replace a recalled dependency. The old pin is retained.
  for (const dependency of dependencies.filter(ref => ref.origin === 'current-report')) {
    const [replacement] = await tx.select().from(researchThesisReplacements).where(and(eq(researchThesisReplacements.owner, owner),
      eq(researchThesisReplacements.thesisId, dependency.thesisId), eq(researchThesisReplacements.thesisVersion, dependency.version)));
    if (replacement) for (const previous of dependencies) if (previous.thesisId === replacement.previousId
      && previous.version === replacement.previousVersion && previous.origin === 'recalled-memory') previous.replacementId = dependency.thesisId;
  }
  return { state: structured || dependencies.length ? 'ready' : 'legacy-no-structure',
    dependencies: [...new Map(dependencies.map(ref => [`${ref.thesisId}:${ref.version}:${ref.origin}`, ref])).values()] };
}

export async function strategyMemoryBlock(tx: MemoryFenceTransaction, owner: string, inventory: StrategyMemoryInventory,
  ticker?: string, now = new Date(), requireObserved = false): Promise<string | null> {
  return validateStrategyDependencies(tx, owner, inventory, ticker, now, requireObserved, false);
}

/** A replacement resolves the old condition, even if the new thesis has its own breach. Validate live
 * source/privacy/version lineage under the caller's owner fence, without treating condition state as authority. */
export async function resolvedThesisDependency(tx: MemoryFenceTransaction, owner: string, inventory: StrategyMemoryInventory,
  ref: StrategyThesisDependency, now = new Date()): Promise<boolean> {
  if (!ref.replacementId) return false;
  const next = inventory.dependencies.find(item => item.thesisId === ref.replacementId && item.origin === 'current-report');
  if (!next) return false;
  return await validateStrategyDependencies(tx, owner, { ...inventory, dependencies: [ref, next] },
    undefined, now, false, true) === null;
}

async function validateStrategyDependencies(tx: MemoryFenceTransaction, owner: string, inventory: StrategyMemoryInventory,
  ticker: string | undefined, now: Date, requireObserved: boolean, authorityOnly: boolean): Promise<string | null> {
  if (!['ready', 'legacy-no-structure'].includes(inventory.state)) return `MEMORY_${inventory.state.toUpperCase().replaceAll('-', '_')}`;
  const [preferences] = await tx.select().from(researchMemoryPreferences).where(eq(researchMemoryPreferences.owner, owner));
  const relevant = inventory.dependencies.filter(ref => !ticker || sameMonitorSymbol(ref.ticker, ticker));
  const check = async (ref: StrategyThesisDependency, visited = new Set<string>(), replaced = false): Promise<string | null> => {
    if (visited.has(ref.thesisId) || visited.size >= 10) return 'MEMORY_REPLACEMENT_INVALID';
    visited.add(ref.thesisId);
    if (ref.origin !== 'current-report' && preferences?.recallEnabled === false) return 'MEMORY_RECALL_DISABLED';
    const current = await lockedThesis(tx, owner, ref.thesisId);
    if (!current || current.thesis.version !== ref.version || current.memory.market !== ref.market
      || !sameMonitorSymbol(current.memory.ticker, ref.ticker)) return 'MEMORY_DEPENDENCY_REVOKED';
    if (ref.replacementId) {
      const next = inventory.dependencies.find(item => item.thesisId === ref.replacementId && item.origin === 'current-report');
      const [proof] = await tx.select().from(researchThesisReplacements).where(and(eq(researchThesisReplacements.owner, owner),
        eq(researchThesisReplacements.thesisId, ref.replacementId), eq(researchThesisReplacements.previousId, ref.thesisId),
        eq(researchThesisReplacements.previousVersion, ref.version)));
      if (!next || !proof || next.version !== proof.thesisVersion) return 'MEMORY_REPLACEMENT_INVALID';
      return check(next, new Set());
    }
    const [lineage] = await tx.select().from(researchThesisReplacements).where(and(eq(researchThesisReplacements.owner, owner),
      eq(researchThesisReplacements.thesisId, ref.thesisId), eq(researchThesisReplacements.thesisVersion, ref.version)));
    if (current.thesis.content.supersedes && !lineage && current.thesis.status !== 'confirmed') return 'MEMORY_REPLACEMENT_REVIEW_REQUIRED';
    if (lineage) {
      const failure = await check({ thesisId: lineage.previousId, version: lineage.previousVersion, ticker: ref.ticker,
        market: ref.market, origin: 'recalled-memory' }, new Set(visited), true);
      if (failure) return failure;
    }
    if (replaced || authorityOnly) return null;
    if (['expired', 'not_yet_valid', 'needs_review'].includes(thesisFreshness(current.thesis.content,
      current.thesis.expiresAt?.toISOString() ?? null, now.toISOString(), current.conflicted))) return 'MEMORY_DEPENDENCY_EXPIRED';
    const [breach] = await tx.select({ id: researchMonitorEvents.id }).from(researchMonitorEvents).where(and(
      eq(researchMonitorEvents.owner, owner), eq(researchMonitorEvents.thesisId, ref.thesisId),
      eq(researchMonitorEvents.thesisVersion, ref.version), eq(researchMonitorEvents.state, 'breached'))).limit(1);
    if (breach) return 'MEMORY_CONDITION_BREACHED';
    if (requireObserved) {
      const rules = await tx.select().from(researchMonitorRules).where(and(eq(researchMonitorRules.owner, owner),
        eq(researchMonitorRules.thesisId, ref.thesisId), eq(researchMonitorRules.thesisVersion, ref.version), eq(researchMonitorRules.enabled, true)));
      for (const rule of rules) {
        const [last] = await tx.select().from(researchMonitorEvents).where(and(eq(researchMonitorEvents.owner, owner),
          eq(researchMonitorEvents.ruleId, rule.id))).orderBy(desc(researchMonitorEvents.createdAt)).limit(1);
        if (!last || last.state !== 'clear' || Date.parse(rule.condition.validUntil) <= now.getTime()
          || Date.parse(rule.condition.validFrom) > now.getTime()
          || rule.condition.metric === 'price' && (!last.observation.observedAt || now.getTime() - Date.parse(last.observation.observedAt) > 20 * 60_000)) return 'MEMORY_MONITOR_UNKNOWN';
      }
    }
    return null;
  };
  for (const ref of relevant.sort((a, b) => a.thesisId.localeCompare(b.thesisId))) { const failure = await check(ref); if (failure) return failure; }
  return null;
}

/** Omitting a breached pin from a new prompt is not a review. Only the replaced plan's relevant unresolved pins carry forward. */
export async function carryPlanBreaches(tx: MemoryFenceTransaction, owner: string, inventory: StrategyMemoryInventory,
  previous: Array<{ id: string; memoryInventory: StrategyMemoryInventory | null }>, tickers: string[]): Promise<StrategyMemoryInventory> {
  const dependencies = [...inventory.dependencies];
  for (const plan of previous) for (const ref of plan.memoryInventory?.dependencies ?? []) {
    if (ref.replacementId || !tickers.some(ticker => sameMonitorSymbol(ticker, ref.ticker))) continue;
    const [breach] = await tx.select({ id: researchMonitorEvents.id }).from(researchMonitorEvents).where(and(
      eq(researchMonitorEvents.owner, owner), eq(researchMonitorEvents.thesisId, ref.thesisId),
      eq(researchMonitorEvents.thesisVersion, ref.version), eq(researchMonitorEvents.state, 'breached'))).limit(1);
    if (!breach) continue;
    const current = await lockedThesis(tx, owner, ref.thesisId);
    const [review] = current?.thesis.status === 'confirmed' && current.thesis.version > ref.version
      ? await tx.select({ id: researchThesisVersions.id }).from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner),
        eq(researchThesisVersions.thesisId, ref.thesisId), gt(researchThesisVersions.version, ref.version),
        inArray(researchThesisVersions.action, ['confirm', 'edit']), isNotNull(researchThesisVersions.changeReason))).limit(1) : [];
    const carried: StrategyThesisDependency = { ...ref, version: review ? current!.thesis.version : ref.version,
      origin: 'previous-plan', previousPlanId: plan.id };
    for (const next of dependencies.filter(item => item.origin === 'current-report')) {
      const [proof] = await tx.select({ id: researchThesisReplacements.id }).from(researchThesisReplacements).where(and(
        eq(researchThesisReplacements.owner, owner), eq(researchThesisReplacements.thesisId, next.thesisId),
        eq(researchThesisReplacements.thesisVersion, next.version), eq(researchThesisReplacements.previousId, carried.thesisId),
        eq(researchThesisReplacements.previousVersion, carried.version)));
      if (proof) carried.replacementId = next.thesisId;
    }
    const existing = dependencies.find(item => item.thesisId === carried.thesisId && item.version === carried.version);
    if (existing) { existing.replacementId ??= carried.replacementId; existing.previousPlanId = plan.id; }
    else dependencies.push(carried);
  }
  return { ...inventory, dependencies };
}
