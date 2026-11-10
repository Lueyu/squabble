import type { ChannelQuestionInput, DeferredQuestion } from '@shared/channel.interface';

type QuestionPayload = Omit<ChannelQuestionInput, 'requestKey'>;

/** Choosing a deferred fact keeps its original account and research context after navigation. */
export function channelQuestionPayload(message: string, accountId?: string, context?: Record<string, unknown>, selected?: DeferredQuestion): QuestionPayload {
  const scope = selected ? { accountId: selected.accountId, context: selected.context } : { accountId, context };
  return { message, ...(selected ? { selectedQuestionId: selected.id } : {}),
    ...(scope.accountId ? { accountId: scope.accountId } : {}), ...(scope.context ? { context: scope.context } : {}) };
}

/** An uncertain submission keeps its key and scope. Switching accounts is not authorization to resubmit it there. */
export function createChannelQuestionIntent(createKey: () => string) {
  let pending: ChannelQuestionInput | null = null;
  return {
    request(payload: QuestionPayload): ChannelQuestionInput {
      const sameQuestion = pending?.message === payload.message && pending?.selectedQuestionId === payload.selectedQuestionId;
      if (sameQuestion && pending) {
        if (pending.accountId !== payload.accountId || JSON.stringify(pending.context) !== JSON.stringify(payload.context)) {
          throw new Error('CHANNEL_QUESTION_SCOPE_CHANGED');
        }
        return pending;
      }
      pending = { ...structuredClone(payload), requestKey: createKey() };
      return pending;
    },
    complete(): void { pending = null; },
  };
}
