import type { TelemetryDimensions, TelemetryFilters, TelemetrySpan } from '../../../shared/telemetry.interface';
import type { TelemetryFacts, TelemetryProjection } from './telemetry.rules';

export const TELEMETRY_DIMENSION_KEYS = ['rosterAgentId', 'rosterAgentVersionId', 'memberId', 'teamId', 'teamVersionId',
  'commissionId', 'workKey', 'attemptId', 'configuredModel'] as const;
export function safeTelemetryIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 250 && /^[\w.:/+-]+$/u.test(value) ? value : null;
}
/** Only metadata with a fixed purpose crosses capture/query boundaries. */
export function telemetryDimensions(input: TelemetryDimensions): Required<TelemetryDimensions> {
  return Object.fromEntries(TELEMETRY_DIMENSION_KEYS.map(key => [key, safeTelemetryIdentifier(input[key])])) as Required<TelemetryDimensions>;
}
export function matchesExecutionFilters(span: TelemetrySpan, filters: TelemetryFilters): boolean {
  const workMatches = !filters.workKey && !filters.attemptId || (span.relatedWorkRefs?.length ? span.relatedWorkRefs : [span])
    .some(ref => (!filters.workKey || ref.workKey === filters.workKey) && (!filters.attemptId || ref.attemptId === filters.attemptId));
  return workMatches && TELEMETRY_DIMENSION_KEYS.filter(key => key !== 'workKey' && key !== 'attemptId')
    .every(key => !(key in filters) || !filters[key as keyof TelemetryFilters] || span[key] === filters[key as keyof TelemetryFilters]);
}

/** Read frozen owned session/commission facts only; a current roster must never rewrite a trajectory. */
export function enrichTelemetryDimensions(projection: TelemetryProjection, facts: TelemetryFacts): void {
  const session = facts.sessions.find(item => item.id === projection.run.sessionId);
  const linkedCycles = [...new Set([
    ...facts.attempts.filter(item => item.sessionId === session?.id && item.taskId === projection.run.sourceId).map(item => item.cycleId),
    ...facts.tasks.filter(item => item.sessionId === session?.id && item.attempts.some(attempt => attempt.remoteTaskId === projection.run.sourceId)).map(item => item.cycleId),
  ])];
  const cycle = projection.run.id.startsWith('research:') ? projection.run.id.split(':').at(-1) : linkedCycles.length === 1 ? linkedCycles[0] : null;
  const team = session?.team && session.team.cycleId === cycle ? session.team : null;
  const byId = new Map(projection.spans.map(span => [span.id, span]));
  const capturedById = new Map(facts.captured.map(item => [item.id, item]));
  const receiptBySpan = new Map<string, TelemetryFacts['attempts'][number]>(), receiptBySource = new Map<string, TelemetryFacts['attempts'][number] | null>();
  for (const receipt of facts.attempts.filter(item => item.sessionId === session?.id)) {
    receiptBySpan.set(`attempt:${receipt.id}`, receipt);
    if (receipt.taskId) receiptBySource.set(receipt.taskId, receiptBySource.has(receipt.taskId) ? null : receipt);
  }
  type Work = { task: TelemetryFacts['tasks'][number]; attempt: TelemetryFacts['tasks'][number]['attempts'][number] };
  const workBySpan = new Map<string, Work>(), workBySource = new Map<string, Work | null>();
  const reviewGroups = new Map<string, Array<{ workKey: string; attemptId: string }>>();
  for (const task of facts.tasks.filter(item => item.sessionId === session?.id)) for (const attempt of task.attempts) {
    const work = { task, attempt }; workBySpan.set(`workflow:${attempt.id}`, work);
    if (attempt.remoteTaskId) workBySource.set(attempt.remoteTaskId, workBySource.has(attempt.remoteTaskId) ? null : work);
    if (attempt.kind === 'review' && attempt.reviewGroupId) {
      const refs = reviewGroups.get(attempt.reviewGroupId) ?? [];
      refs.push({ workKey: task.key, attemptId: attempt.id }); reviewGroups.set(attempt.reviewGroupId, refs);
    }
  }
  const done = new Set<string>(), visiting = new Set<string>();
  const enrich = (span: TelemetrySpan, depth = 0): void => {
    if (done.has(span.id) || visiting.has(span.id)) return;
    visiting.add(span.id);
    const parent = span.parentId && depth < 64 ? byId.get(span.parentId) : undefined;
    if (parent) enrich(parent, depth + 1);
    const captured = capturedById.get(span.id);
    const receipt = receiptBySpan.get(span.id) ?? (captured?.sourceId ? receiptBySource.get(captured.sourceId) : undefined);
    const work = workBySpan.get(span.id) ?? (captured?.sourceId ? workBySource.get(captured.sourceId) : undefined);
    const memberId = receipt?.memberId ?? span.memberId ?? span.agentId ?? parent?.memberId;
    const member = team ? team.members.find(item => item.memberId === memberId) : session?.members.find(item => item.id === memberId);
    const identityParent = memberId && memberId === parent?.memberId ? parent : undefined;
    const inherited = parent ? telemetryDimensions(parent) : {};
    const references = telemetryDimensions({ ...inherited, ...Object.fromEntries(TELEMETRY_DIMENSION_KEYS.filter(key => span[key] != null).map(key => [key, span[key]])),
      memberId, teamId: team?.teamId ?? span.teamId ?? parent?.teamId,
      teamVersionId: team?.teamVersionId ?? span.teamVersionId ?? parent?.teamVersionId,
      commissionId: team?.commissionId ?? span.commissionId ?? parent?.commissionId,
      rosterAgentId: member?.rosterAgentId ?? span.rosterAgentId ?? identityParent?.rosterAgentId,
      rosterAgentVersionId: member?.rosterAgentVersionId ?? span.rosterAgentVersionId ?? identityParent?.rosterAgentVersionId,
      configuredModel: member?.configuredModel ?? span.configuredModel ?? identityParent?.configuredModel,
      workKey: work?.task.key ?? span.workKey ?? parent?.workKey,
      attemptId: receipt?.id ?? work?.attempt.id ?? span.attemptId ?? parent?.attemptId });
    // An identity without its exact immutable version is legacy/unknown, not a merged version group.
    if (!references.rosterAgentId || !references.rosterAgentVersionId) {
      references.rosterAgentId = null; references.rosterAgentVersionId = null;
    }
    Object.assign(span, references);
    const related = work?.attempt.reviewGroupId ? reviewGroups.get(work.attempt.reviewGroupId) : parent?.relatedWorkRefs;
    if (related) span.relatedWorkRefs = related.map(ref => ({ workKey: safeTelemetryIdentifier(ref.workKey), attemptId: safeTelemetryIdentifier(ref.attemptId) }))
      .filter((ref): ref is { workKey: string; attemptId: string } => ref.workKey !== null && ref.attemptId !== null);
    if (member && 'label' in member && member.label) span.agentName = member.label;
    visiting.delete(span.id); done.add(span.id);
  };
  for (const span of projection.spans) enrich(span);
  const single = (key: 'teamId' | 'teamVersionId' | 'commissionId') => {
    const values = [...new Set(projection.spans.map(span => span[key]).filter(Boolean))];
    return values.length === 1 ? values[0] : null;
  };
  Object.assign(projection.run, { teamId: single('teamId'), teamVersionId: single('teamVersionId'), commissionId: single('commissionId') });
}
