/**
 * council.types.ts — 委员会模块的内部类型定义。
 *
 * 职责边界：
 *  - 讨论轮次（DialogueTurn）、研究请求（ResearchRequest）、断点状态（CouncilCheckpoint）与消息元数据。
 *  - 对外共享类型（CouncilMessage 等）来自 @shared/council.interface，本文件不重复定义。
 * 上下游：
 *  - 上游：council.service/dialogue/context/native 共用。
 *  - 下游：无。
 */
import type { CouncilMessage, CouncilPhase, CouncilResearchKind } from '@shared/council.interface';
import type { CouncilEvidence } from './council.rules';
import type { ResearchEvent } from '../../../shared/research-events.interface';

/** 一次讨论轮次：成员 id 与发言阶段（开场/质疑/回应/总结）。 */
export interface DialogueTurn {
  memberId: string;
  phase: Exclude<CouncilPhase, 'progress'>;
}
/** 成员提出的研究请求：类别 + 可选查询词。 */
export interface ResearchRequest {
  kind: CouncilResearchKind;
  query?: string;
}
/** 会话断点：轮次计划与游标、已用研究类别、待研究队列、证据归档、进行中认领与远端任务引用。 */
export interface CouncilCheckpoint {
  cycleId: string;
  turns: DialogueTurn[];
  nextTurn: number;
  toolKindsUsed: CouncilResearchKind[];
  pendingResearch: ResearchRequest[];
  evidenceArchive?: CouncilEvidence[];
  inflight?: { id: string; turn: number; revision: number };
  remote?: {
    agentId: string;
    taskId?: string;
    contextId?: string;
    messageId: string;
    turn: number;
    revision: number;
    dispatchStarted: boolean;
    awaitingInput?: boolean;
    lastUserMessageId?: string;
  };
}
/** 委员会消息元数据：任务/成员/轮次/证据引用/研究事件与外部智能体用量标记。 */
export interface CouncilMessageMetadata extends Pick<
  CouncilMessage,
  | 'taskId'
  | 'memberId'
  | 'phase'
  | 'replyToMessageId'
  | 'evidenceIds'
  | 'reasoningSummary'
  | 'questions'
  | 'acquisition'
  | 'externalAgent'
  | 'externalUsageUnknown'
> {
  cycleId?: string;
  researchEvent?: ResearchEvent;
  turn?: number;
}
