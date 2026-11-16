/**
 * RunProgressBar - horizontal stepper showing progress through the multi-agent
 * analysis pipeline (fetch evidence -> bull/bear debate -> critic review ->
 * risk-gate check -> final rating).
 *
 * Each step is a circle whose visual state is derived from the run's current
 * status via getStepState():
 *   done     -> emerald circle with check icon
 *   active   -> primary-colored pulsing circle (the stage currently running)
 *   failed   -> rose circle with X icon (run failed/cancelled)
 *   awaiting -> amber circle (pipeline finished, waiting on human decision)
 *   pending  -> muted gray circle (not reached yet)
 */
import { Check, X } from 'lucide-react';
import type { AgentRunStatus } from '@shared/api.interface';
import { useTranslation } from 'react-i18next';

interface RunProgressBarProps {
  /** Current pipeline status of the agent run being visualized */
  status: AgentRunStatus;
}

/** A single pipeline step shown in the stepper */
interface StepDef {
  /** Unique step key */
  key: string;
  /** Short label rendered under the circle */
  labelKey: string;
  /** AgentRunStatus value that means "this step is the active one" */
  statusKey: AgentRunStatus;
}

/** Ordered pipeline stages (left to right) rendered as stepper circles */
const steps: StepDef[] = [
  { key: 'fetching', labelKey: 'ui.agent.stepEvidence', statusKey: 'fetching' },
  { key: 'debating', labelKey: 'ui.agent.stepDebate', statusKey: 'debating' },
  { key: 'critiquing', labelKey: 'ui.agent.stepCritic', statusKey: 'critiquing' },
  { key: 'risk_check', labelKey: 'ui.agent.stepRisk', statusKey: 'risk_check' },
  { key: 'completed', labelKey: 'ui.agent.stepRating', statusKey: 'completed' },
];

/**
 * Canonical ordering of statuses along the pipeline. A step is "done" once the
 * run's status has advanced past that step's own statusKey in this list.
 * Note: 'failed'/'cancelled' are terminal and handled specially below.
 */
const statusOrder: AgentRunStatus[] = [
  'pending',
  'fetching',
  'debating',
  'critiquing',
  'risk_check',
  'awaiting_human',
  'completed',
];

/**
 * Derives the visual state of one stepper circle from the current run status.
 * 'awaiting_human' means all analytical stages finished but a human must approve
 * the rating before it can be published.
 */
function getStepState(
  stepIndex: number,
  status: AgentRunStatus,
): 'done' | 'active' | 'pending' | 'failed' | 'awaiting' {
  const currentIdx = statusOrder.indexOf(status);
  const stepStatusIdx = statusOrder.indexOf(steps[stepIndex].statusKey);

  if (status === 'failed' || status === 'cancelled') {
    // all steps up to current are done-ish, the failing step shows failed
    // find which step was running when it failed — approximate: use prior step index
    const stepKeys: AgentRunStatus[] = [
      'fetching',
      'debating',
      'critiquing',
      'risk_check',
      'completed',
    ];
    // Without a failed-step field, show first step as failed approximation
    if (stepIndex === 0) return 'failed';
    return 'pending';
  }

  if (status === 'pending') return 'pending';

  if (stepStatusIdx < currentIdx) return 'done';
  if (stepStatusIdx === currentIdx) return 'active';

  // awaiting_human: all 5 steps done, but awaiting human decision
  if (status === 'awaiting_human' && stepIndex === steps.length - 1) {
    return 'awaiting';
  }

  return 'pending';
}

/** Renders the 5-step stepper circles plus the connector lines between them. */
function RunProgressBar({ status }: RunProgressBarProps) {
  const { t } = useTranslation();
  return (
    <div className="w-full">
      <div className="flex items-center justify-between">
        {steps.map((step, idx) => {
          const state = getStepState(idx, status);
          return (
            <div key={step.key} className="flex flex-1 flex-col items-center last:flex-none">
              <div
                className={[
                  'relative z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 text-[10px] font-semibold transition-colors',
                  state === 'done'
                    ? 'border-emerald-500 bg-emerald-500 text-white'
                    : state === 'active'
                      ? 'border-primary bg-primary text-primary-foreground animate-pulse'
                      : state === 'failed'
                        ? 'border-rose-500 bg-rose-500 text-white'
                        : state === 'awaiting'
                          ? 'border-amber-500 bg-amber-500 text-white'
                          : 'border-slate-300 bg-white text-slate-400 dark:border-slate-600 dark:bg-slate-800',
                ].join(' ')}
              >
                {state === 'done' ? (
                  <Check size={12} strokeWidth={3} />
                ) : state === 'failed' ? (
                  <X size={12} strokeWidth={3} />
                ) : state === 'awaiting' ? (
                  <span className="text-[9px]">{t('ui.agent.stepAwaiting')}</span>
                ) : (
                  <span>{idx + 1}</span>
                )}
              </div>
              <span
                className={[
                  'mt-1 text-[10px] font-medium',
                  state === 'done'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : state === 'active'
                      ? 'text-primary'
                      : state === 'failed'
                        ? 'text-rose-600 dark:text-rose-400'
                        : state === 'awaiting'
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-slate-400',
                ].join(' ')}
              >
                {t(step.labelKey)}
              </span>
              {idx < steps.length - 1 && (
                <div className="absolute top-3 left-full h-0.5 w-full -translate-y-1/2">
                  {/* connector handled by parent flex */}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* Connector lines row: pulled up with -mt-9 to sit between the circles;
          a line is emerald once the transition from step idx to idx+1 is underway/done */}
      <div className="-mt-9 flex">
        {steps.slice(0, -1).map((_step, idx) => {
          const state = getStepState(idx, status);
          const nextState = getStepState(idx + 1, status);
          const done =
            state === 'done' &&
            (nextState === 'done' || nextState === 'active' || nextState === 'awaiting');
          return (
            <div
              key={`line-${idx}`}
              className={[
                'mt-0 flex-1 border-t-2',
                done ? 'border-emerald-500' : 'border-slate-200 dark:border-slate-700',
              ].join(' ')}
              style={{ marginLeft: '1.25rem', marginRight: '1.25rem' }}
            />
          );
        })}
      </div>
    </div>
  );
}

export default RunProgressBar;
