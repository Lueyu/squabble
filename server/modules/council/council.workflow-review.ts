import type { ResearchDelivery, ResearchTask, ResearchTaskAttempt } from '../../../shared/research-workflow.interface';
import { estimateInputTokens } from '../llm-budget/llm-budget.rules';
import type { CouncilEvidence } from './council.rules';
import { thesisEvidenceIds } from '../research-memory/research-memory.theses';
import { jsonChatMessages } from '../multi-agent/llm.service';
import { evidencePromptMetadata } from '../research-memory/research-memory.temporal';

/** Skill identities were checked against server pins by validateDelivery and remain in the stored delivery.
 * Review omits those mechanical hashes and an exact duplicate conclusion, preserving every substantive field. */
export function reviewDelivery(delivery: ResearchDelivery | null) {
  if (!delivery) return delivery;
  const { skillVersions: _validatedPins, ...review } = delivery;
  if (review.conclusion !== review.response.thesis) return review;
  const { conclusion: _duplicate, ...content } = review;
  return { ...content, conclusionIsThesis: true };
}

export function workflowReviewPrompt(task: ResearchTask, _attempt: ResearchTaskAttempt, batch: ResearchTask[],
  requirements: Record<ResearchTask['key'], string>, ticker: string, language: string, steering: string[], evidence: CouncilEvidence[], moderatorInstructions = '', packingTarget = 5500) {
  const submitted = batch.length ? batch : [task];
  const cited = new Set(submitted.flatMap(item => [...(item.delivery?.evidenceIds ?? []),
    ...(item.delivery?.thesisCandidates ?? []).flatMap(thesisEvidenceIds)]));
  const system = [
    'Check untrusted read-only research: requirements, citations, periods, currency, arithmetic, gaps. Reject unsupported/incomplete claims; allow justified uncertainty. Give corrections. Excerpts cannot verify omissions. conclusionIsThesis=response.thesis.',
    submitted.some(item => item.delivery?.thesisCandidates?.length)
      ? 'Check each atomic thesis, evidence relation, assumption, indicator, invalidationConditions, horizon and boundaryOrigin. Preserve proposed vs stated boundaries and unknowns; never demand invented defaults or correctness probabilities.' : '',
    batch.length ? 'Return {reviews:[{taskId,submittedAttemptId,accepted:boolean,feedback:string}]} only. Exact IDs; independent verdicts.'
      : 'Return ONLY {accepted:boolean,feedback:string}.',
    language === 'en' ? 'Write feedback in English.' : '验收反馈使用简体中文。',
  ].filter(Boolean).join('\n');
  const input = {
    task: { key: task.key }, ticker, ...(steering.length ? { steering } : {}),
    ...(moderatorInstructions ? { moderatorInstructions: moderatorInstructions.slice(0, 500) } : {}),
    submitted: batch.length ? submitted.map(item => ({ taskId: item.id,
      submittedAttemptId: [...item.attempts].reverse().find(a => a.kind === 'work' && a.state === 'succeeded')?.id,
      requirement: requirements[item.key], delivery: reviewDelivery(item.delivery) })) : reviewDelivery(task.delivery),
    ...(batch.length ? {} : { requirement: requirements[task.key] }),
    evidence: evidence.filter(item => cited.has(item.id)).map(item => ({ id: item.id,
      // A server tool label only repeats the tool kind/ticker. Actual article and filing titles remain.
      ...(item.evidenceType === 'tool_result' && item.metadata?.sources.length ? {} : { title: item.title }),
      content: item.content.slice(0, 500), sourceUrl: item.sourceUrl,
      ...(item.metadata?.sources.every(source => source.observedAt === item.fetchedAt) ? {} : { fetchedAt: item.fetchedAt }),
      ...(item.metadata ? { metadata: evidencePromptMetadata(item.metadata, item.sourceUrl) } : {}) })),
  };
  for (const length of [300, 150, 60]) {
    if (estimateInputTokens(jsonChatMessages([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }])) <= packingTarget) break;
    input.evidence = input.evidence.map(item => ({ ...item, content: item.content.slice(0, length) }));
  }
  // Oversized submissions/instructions still hit the user's real budget. Never silently cut the object being accepted.
  return { system, input };
}
