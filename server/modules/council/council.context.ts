/**
 * council.context.ts — 委员会成员单轮调用的上下文打包。
 *
 * 职责边界：
 *  - 把 candidate、成员个性化、投资者指令、历史讨论与证据摘录打包成 JSON，按 token 预算分档降级。
 *  - 不做模型调用；打包结果交给 LlmService 发送。
 * 上下游：
 *  - 上游：council.service（runMember）。
 *  - 下游：council.rules（evidenceExcerpts/criticalEvidenceGaps）、council.dialogue（conversationExcerpt）、llm-budget.rules（estimateInputTokens）。
 * 关键约定：
 *  - 预算档位共 5 档（profiles），从高到低降级，直到估算输入 ≤4900 token；留出 LlmService 严格 JSON 指令的余量。
 */
import type { BuilderConfig } from '@shared/api.interface';
import type { CouncilCandidate, CouncilMember, CouncilMessage } from '@shared/council.interface';
import { estimateInputTokens } from '../llm-budget/llm-budget.rules';
import {
  byteExcerpt,
  criticalEvidenceGaps,
  evidenceExcerpts,
  isRuleCandidate,
  type CouncilEvidence,
} from './council.rules';
import { conversationExcerpt } from './council.dialogue';
import type { DialogueTurn } from './council.types';

interface ContextMessage {
  id: string;
  memberName: string;
  role: string;
  content: string;
  metadata?: Pick<CouncilMessage, 'questions' | 'reasoningSummary'> | null;
}
interface ContextInput {
  ticker: string;
  candidate: CouncilCandidate | null;
  config: BuilderConfig;
  member: CouncilMember;
  turn: DialogueTurn;
  evidence: CouncilEvidence[];
  userMessages: string[];
  currentDiscussion: ContextMessage[];
  previousDiscussion: ContextMessage[];
  systemPrompt: string;
}

/** 最新一条用户发言绝不静默截断；更早的上下文按档位显式摘录。 */
export function packDiscussionContext(input: ContextInput) {
  const profiles = [
    { evidence: 2100, dialogue: 1100, history: 3, custom: 360, personality: 120, gaps: 160 },
    { evidence: 1700, dialogue: 950, history: 2, custom: 220, personality: 90, gaps: 140 },
    { evidence: 1300, dialogue: 800, history: 1, custom: 140, personality: 60, gaps: 120 },
    { evidence: 1100, dialogue: 650, history: 0, custom: 80, personality: 50, gaps: 100 },
    { evidence: 900, dialogue: 550, history: 0, custom: 60, personality: 0, gaps: 80 },
  ];
  const make = (limits: (typeof profiles)[number]) => ({
    ticker: input.ticker,
    candidate: input.candidate,
    phase: input.turn.phase,
    ruleOnly: isRuleCandidate(input.config, input.candidate),
    criticalEvidenceMissing: criticalEvidenceGaps(input.evidence),
    member: {
      name: input.member.name,
      role: input.member.roleTitle ?? input.member.role,
      personality: byteExcerpt(input.member.personality ?? '', limits.personality),
      focus: input.member.researchFocus,
      style: input.member.speakingStyle,
      instructions: byteExcerpt(input.member.instructions, limits.custom),
    },
    investorInstructions: byteExcerpt(input.config.customPrompt, limits.custom),
    steering: [
      ...input.userMessages
        .slice(0, -1)
        .slice(-limits.history || input.userMessages.length)
        .map((message) => byteExcerpt(message, 140)),
      ...input.userMessages.slice(-1),
    ],
    previousDiscussion: input.previousDiscussion
      .slice(-limits.history || input.previousDiscussion.length)
      .map((message) => ({ role: message.role, content: byteExcerpt(message.content, 140) })),
    conversation: conversationExcerpt(input.currentDiscussion, limits.dialogue),
    contextWindow: {
      olderContentIsExcerpted: true,
      previousUserMessages: Math.max(0, input.userMessages.length - 1),
    },
    availableResearch: [
      'financials',
      'valuation',
      'news',
      'price',
      ...(input.config.council?.webResearch ? ['web'] : []),
    ],
    evidenceExcerpts: true,
    evidence: evidenceExcerpts(input.evidence, limits.evidence),
    gaps: input.evidence
      .filter((item) => item.sourceName === 'Data Unavailable')
      .slice(0, 3)
      .map((item) => ({
        title: byteExcerpt(item.title, 50),
        detail: byteExcerpt(item.content, limits.gaps),
      })),
  });
  let data = make(profiles[0]);
  for (const profile of profiles) {
    data = make(profile);
    // 为 LlmService 的严格 JSON 指令与 provider 包装预留 token 空间。
    if (
      estimateInputTokens([
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: JSON.stringify(data) },
      ]) <= 4900
    )
      break;
  }
  // 真正超长的最新用户发言仍会在中央可配置的预算闸门处失败。
  return data;
}
