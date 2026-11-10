import type {
  StrategyInterviewField,
  StrategyInterviewView,
} from '@shared/strategy-interview.interface';
import type { UserInvestmentStrategy } from '@shared/user-investment-strategy.interface';
import type { PortfolioAllocationInput } from '@shared/portfolio-workspace.interface';

export const interviewFieldLabels: Record<
  StrategyInterviewField,
  [string, string]
> = {
  idea: ['投资想法', 'Your idea'],
  security: ['标的与方向', 'Security & direction'],
  condition: ['触发条件', 'Entry condition'],
  amount: ['目标仓位或数量', 'Position or quantity'],
  frequency: ['执行频率', 'Frequency'],
  period: ['生效区间', 'Effective period'],
};

export function interviewDate(
  value: string,
  timezone: string,
  zh: boolean,
): string {
  try {
    return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function isInterviewReviewCurrent(
  interview: Pick<StrategyInterviewView, 'review' | 'revision'>,
  strategy:
    | Pick<UserInvestmentStrategy, 'id' | 'revision' | 'preview'>
    | null
    | undefined,
): boolean {
  const review = interview.review;
  return (
    !!review &&
    !!strategy &&
    review.interviewRevision === interview.revision &&
    review.strategyId === strategy.id &&
    review.strategyRevision === strategy.revision &&
    review.previewHash === strategy.preview?.contentHash
  );
}
export function readComposer(key: string): string {
  try {
    return (
      window.sessionStorage.getItem('squabble.interview-composer.' + key) ?? ''
    );
  } catch {
    return '';
  }
}
export function readComposerField(key: string): StrategyInterviewField | null {
  try {
    const value = window.sessionStorage.getItem(
      'squabble.interview-field.' + key,
    );
    return value &&
      Object.prototype.hasOwnProperty.call(interviewFieldLabels, value)
      ? (value as StrategyInterviewField)
      : null;
  } catch {
    return null;
  }
}
export function saveComposer(
  key: string,
  text: string,
  field?: StrategyInterviewField,
) {
  try {
    if (text) {
      window.sessionStorage.setItem('squabble.interview-composer.' + key, text);
      if (field)
        window.sessionStorage.setItem('squabble.interview-field.' + key, field);
    } else {
      window.sessionStorage.removeItem('squabble.interview-composer.' + key);
      window.sessionStorage.removeItem('squabble.interview-field.' + key);
    }
  } catch {
    /* Sending to the server remains available when browser storage is disabled. */
  }
}

/** Reloading after an uncertain response must retain the same server receipt key. */
export function createInterviewIntent(scope: string, generate: () => string) {
  const key = 'squabble.interview-intent.' + scope;
  let saved: { payload: string; requestKey: string } | null = null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (
      typeof value?.payload === 'string' &&
      typeof value?.requestKey === 'string'
    )
      saved = value;
  } catch {
    /* Browser storage is optional. */
  }
  return {
    prepare<T extends { expectedRevision: number }>(
      kind: string,
      input: T,
    ): { input: T; requestKey: string } {
      const identity = (value: { kind: string; input: T }) =>
        JSON.stringify({
          ...value,
          input: { ...value.input, expectedRevision: undefined },
        });
      const previous = saved ? JSON.parse(saved.payload) : null;
      if (
        previous?.kind === kind &&
        previous?.input &&
        identity(previous) === identity({ kind, input })
      ) {
        return { input: previous.input, requestKey: saved!.requestKey };
      }
      const requestKey = this.keyFor({ kind, input });
      return { input, requestKey };
    },
    keyFor(payload: unknown) {
      const serialized = JSON.stringify(payload);
      if (!saved || saved.payload !== serialized)
        saved = { payload: serialized, requestKey: generate() };
      try {
        window.sessionStorage.setItem(key, JSON.stringify(saved));
      } catch {
        /* Keep the in-memory receipt. */
      }
      return saved.requestKey;
    },
    complete() {
      saved = null;
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        /* Optional storage. */
      }
    },
  };
}

/** A revised interview replaces its base only in this account's draft, initially disabled. */
export function stageInterviewAllocation(
  allocations: PortfolioAllocationInput[],
  strategyId: string,
  revision: number,
  baseStrategyId: string | null,
): PortfolioAllocationInput[] {
  const existing = allocations.find((item) => item.strategyId === strategyId);
  const base =
    baseStrategyId && baseStrategyId !== strategyId
      ? allocations.find((item) => item.strategyId === baseStrategyId)
      : undefined;
  return [
    ...allocations.filter(
      (item) =>
        item.strategyId !== strategyId && item.strategyId !== base?.strategyId,
    ),
    {
      strategyId,
      strategyRevision: revision,
      allocationPct: existing?.allocationPct ?? base?.allocationPct ?? 0,
      enabled: false,
    },
  ];
}
