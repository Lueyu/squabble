import type { CouncilMessage, CouncilPhase, CouncilResearchKind } from '@shared/council.interface';
import type { CouncilEvidence } from './council.rules';
import type { ResearchEvent } from '../../../shared/research-events.interface';

export interface DialogueTurn { memberId: string; phase: Exclude<CouncilPhase, 'progress'> }
export interface ResearchRequest { kind: CouncilResearchKind; query?: string }
export interface CouncilCheckpoint {
  cycleId: string;
  turns: DialogueTurn[];
  nextTurn: number;
  toolKindsUsed: CouncilResearchKind[];
  pendingResearch: ResearchRequest[];
  evidenceArchive?: CouncilEvidence[];
  inflight?: { id: string; turn: number; revision: number };
  remote?: { agentId: string; taskId?: string; contextId?: string; messageId: string;
    turn: number; revision: number; dispatchStarted: boolean; awaitingInput?: boolean; lastUserMessageId?: string };
}
export interface CouncilMessageMetadata extends Pick<CouncilMessage,
  'taskId' | 'memberId' | 'phase' | 'replyToMessageId' | 'evidenceIds' | 'reasoningSummary' | 'questions' | 'acquisition' | 'externalAgent' | 'externalUsageUnknown'> {
  cycleId?: string;
  researchEvent?: ResearchEvent;
  turn?: number;
}
