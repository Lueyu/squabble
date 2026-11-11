import type { CouncilMessage, CouncilPhase, CouncilResearchKind } from '@shared/council.interface';
import type { CouncilEvidence } from './council.rules';
import type { ResearchEvent } from '../../../shared/research-events.interface';
import type { ResearchWorkflowConfig } from '../../../shared/research-workflow.interface';

export interface DialogueTurn { memberId: string; phase: Exclude<CouncilPhase, 'progress'> }
export interface ResearchRequest { kind: CouncilResearchKind; query?: string }
export interface CouncilCheckpoint {
  /** New cycles opt in; saved pre-upgrade cycles keep their original execution path. */
  toolRuntimeVersion?: 1;
  runtimePending?: import('../../../shared/research-runtime.interface').CouncilRuntimePending[];
  automaticTaskId?: string;
  simple?: {
    skills?: import('../../../shared/research-workflow.interface').ResearchSkillPin[];
    /** Hidden daily research: sealed independent work, one reverse-check gate, then report. */
    researchOnly?: boolean;
    overallDaily?: { date: string; timezone: 'Asia/Shanghai'; readAt: string; factsHash: string };
    inputCorrection?: import('../../../shared/simple-conversation.interface').DailyReportInputCorrection;
    initializing?: boolean;
    stopped?: boolean;
    stage: 'independent' | 'discussion' | 'supplement' | 'completed' | 'waiting';
    supplementRounds: number;
    executors: import('../../../shared/simple-conversation.interface').ActualExecutor[];
    unavailable: Array<{ memberId: string; reason: string }>;
    outcome?: import('../../../shared/simple-conversation.interface').DebateOutcome;
    contextLabel?: string;
    contextDate?: string;
    /** Frozen common facts: private member sources are only added after release. */
    commonEvidence?: CouncilEvidence[];
    commonMessageIds?: string[];
    stockFactsPrepared?: boolean;
    privateEvidence?: Record<string, CouncilEvidence[]>;
    startedAt?: string;
    calls?: number;
    automaticTaskId?: string;
    steeringRevision?: number;
  };
  workflow?: ResearchWorkflowConfig;
  cycleId: string;
  turns: DialogueTurn[];
  nextTurn: number;
  toolKindsUsed: CouncilResearchKind[];
  pendingResearch: ResearchRequest[];
  evidenceArchive?: CouncilEvidence[];
  inflight?: { id: string; turn: number; revision: number };
  remote?: { agentId: string; taskId?: string; contextId?: string; messageId: string;
    turn: number; revision: number; dispatchStarted: boolean; awaitingInput?: boolean; lastUserMessageId?: string;
    /** Explicit local acceptance of a terminal result; never permission to dispatch the task again. */
    reparseExisting?: { promptHash: string; resultHash: string; contextHash: string } };
}
export interface CouncilMessageMetadata extends Pick<CouncilMessage,
  'reverseCheck' | 'actualExecutor' | 'claims' | 'respondsToClaims' | 'stanceChange' | 'evidenceCheckStatus' | 'references' | 'memory' | 'taskId' | 'memberId' | 'phase' | 'replyToMessageId' | 'evidenceIds' | 'reasoningSummary' | 'questions' | 'acquisition' | 'externalAgent' | 'externalUsageUnknown' | 'response'> {
  cycleId?: string;
  researchEvent?: ResearchEvent;
  turn?: number;
  referenceSnapshot?: import('../../../shared/research-document.interface').ReportReference[];
}
