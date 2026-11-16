import type { AgentRunDetail } from '@shared/api.interface';

export type PipelineStepKey = 'fetching' | 'debating' | 'critiquing' | 'risk_check' | 'completed';
export type PipelineStepState = 'done' | 'active' | 'pending' | 'skipped' | 'partial';
type PipelineProgress = Pick<
  AgentRunDetail,
  'status' | 'evidence' | 'arguments' | 'debate' | 'riskGate' | 'rating'
>;

/** Persisted outputs prove completed work; a terminal run alone does not prove an AI phase ran. */
export function getPipelineStepState(
  step: PipelineStepKey,
  run: PipelineProgress,
): PipelineStepState {
  if (step === run.status && step !== 'completed') return 'active';
  const finished = run.status === 'completed' || run.status === 'awaiting_human';
  const modelPhasesPassed = finished || run.status === 'risk_check';
  const hasModelRecords = run.arguments.length > 0 || run.debate.length > 0;

  if (step === 'fetching' && run.evidence.length > 0) {
    return run.evidence.some((item) => item.sourceName === 'Data Unavailable') ? 'partial' : 'done';
  }
  if (step === 'debating') {
    const sides = new Set([
      ...run.arguments.map((item) => item.side),
      ...run.debate
        .filter((item) => item.speaker === 'bull' || item.speaker === 'bear')
        .filter((item) => item.content.trim())
        .map((item) => item.speaker),
    ]);
    if (sides.has('bull') && sides.has('bear')) return 'done';
    if (sides.size > 0) return 'partial';
  }
  if (step === 'critiquing') {
    const critics = run.debate.filter((item) => item.speaker === 'critic');
    if (critics.some((item) => item.content.trim())) return 'done';
    if (critics.length > 0) return 'partial';
  }
  if ((step === 'debating' || step === 'critiquing') && modelPhasesPassed) {
    return hasModelRecords ? 'partial' : 'skipped';
  }
  if (step === 'risk_check' && run.riskGate.length > 0) return 'done';
  if (step === 'completed' && run.rating) return 'done';
  return finished ? 'partial' : 'pending';
}
