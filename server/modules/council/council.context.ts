import type { BuilderConfig } from '@shared/api.interface';
import type { CouncilCandidate, CouncilMember, CouncilMessage } from '@shared/council.interface';
import { estimateInputTokens } from '../llm-budget/llm-budget.rules';
import { byteExcerpt, criticalEvidenceGaps, evidenceExcerpts, isRuleCandidate, type CouncilEvidence } from './council.rules';
import { conversationExcerpt } from './council.dialogue';
import type { DialogueTurn } from './council.types';
import type { threadPromptContext } from './council.thread';

interface ContextMessage {
  id: string; memberName: string; role: string; content: string;
  metadata?: Pick<CouncilMessage, 'questions' | 'reasoningSummary'> | null;
}
interface ContextInput {
  thread?: ReturnType<typeof threadPromptContext>;
  ticker: string; candidate: CouncilCandidate | null; config: BuilderConfig; member: CouncilMember;
  turn: DialogueTurn; evidence: CouncilEvidence[]; userMessages: string[];
  currentDiscussion: ContextMessage[]; previousDiscussion: ContextMessage[]; systemPrompt: string;
}

/** Latest user text is never silently truncated; older context is explicitly excerpted. */
export function packDiscussionContext(input: ContextInput) {
  const profiles = [
    { evidence: 2100, dialogue: 1100, history: 3, custom: 360, personality: 120, gaps: 160 },
    { evidence: 1700, dialogue: 950, history: 2, custom: 220, personality: 90, gaps: 140 },
    { evidence: 1300, dialogue: 800, history: 1, custom: 140, personality: 60, gaps: 120 },
    { evidence: 1100, dialogue: 650, history: 0, custom: 80, personality: 50, gaps: 100 },
    { evidence: 900, dialogue: 550, history: 0, custom: 60, personality: 0, gaps: 80 },
    { evidence: 900, dialogue: 350, history: 0, custom: 0, personality: 0, gaps: 60, evidenceText: 160 },
  ];
  const make = (limits: typeof profiles[number]) => {
    const evidence = evidenceExcerpts(input.evidence, limits.evidence).map(item => ({ ...item,
      content: limits.evidenceText && item.metadata ? byteExcerpt(item.content, limits.evidenceText) : item.content }));
    const included = new Set(evidence.map(item => item.id));
    return {
    ...(input.thread ? { thread: input.thread } : {}),
    ticker: input.ticker, candidate: input.candidate, phase: input.turn.phase,
    ruleOnly: isRuleCandidate(input.config, input.candidate),
    criticalEvidenceMissing: criticalEvidenceGaps(input.evidence.filter(item => included.has(item.id) || item.sourceName === 'Data Unavailable')),
    member: { name: input.member.name, role: input.member.roleTitle ?? input.member.role,
      personality: byteExcerpt(input.member.personality ?? '', limits.personality), focus: input.member.researchFocus,
      style: input.member.speakingStyle, instructions: byteExcerpt(input.member.instructions, limits.custom) },
    investorInstructions: byteExcerpt(input.config.customPrompt, limits.custom),
    steering: [...input.userMessages.slice(0, -1).slice(-limits.history || input.userMessages.length)
      .map((message) => byteExcerpt(message, 140)), ...input.userMessages.slice(-1)],
    previousDiscussion: input.previousDiscussion.slice(-limits.history || input.previousDiscussion.length)
      .map((message) => ({ role: message.role, content: byteExcerpt(message.content, 140) })),
    conversation: conversationExcerpt(input.currentDiscussion, limits.dialogue),
    contextWindow: { olderContentIsExcerpted: true, previousUserMessages: Math.max(0, input.userMessages.length - 1) },
    availableResearch: ['financials', 'valuation', 'news', 'price', ...(input.config.council?.webResearch ? ['web'] : [])],
    evidenceExcerpts: true, evidence,
    gaps: input.evidence.filter((item) => item.sourceName === 'Data Unavailable').slice(0, 3)
      .map((item) => ({ title: byteExcerpt(item.title, 50), detail: byteExcerpt(item.content, limits.gaps) })),
    };
  };
  let data = make(profiles[0]);
  for (const profile of profiles) {
    data = make(profile);
    // Leave space for LlmService's strict-JSON instruction and provider framing.
    if (estimateInputTokens([{ role: 'system', content: input.systemPrompt },
      { role: 'user', content: JSON.stringify(data) }]) <= 4900) break;
  }
  // Truly oversized latest user text still fails at the central, configurable budget gate.
  return data;
}
