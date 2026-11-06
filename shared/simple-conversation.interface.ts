import type { CouncilSession } from './council.interface';

export type ResearchContext = { kind: 'portfolio'; date?: string } | { kind: 'stock'; ticker: string }
  | { kind: 'report'; documentId: string } | { kind: 'decision'; orderId: string };
export interface ActualExecutor { identity: string; connection: string; connectionId?: string; provider: string; model: string; memberId: string;
  /** A verified execution origin does not imply different underlying models or statistical independence. */
  identityVerified?: boolean; modelVerified?: boolean }
export interface PublicClaim { id: string; statement: string; evidenceIds: string[] }
export interface StanceChange { status: 'retained' | 'changed' | 'unconfirmed'; reason: string }
export interface DebateOutcome {
  confirmed: string[];
  disagreements: Array<{ claimId: string; positions: Array<{ memberId: string; view: string; evidenceIds: string[] }> }>;
  currentAction: 'observe' | 'research_more' | 'consider_action';
  nextEvidence: string[];
}
export interface CreateResearchConversationInput { message: string; context?: ResearchContext; requestKey: string }
export interface ResearchConversationMessageInput { message: string; replyTo?: string; requestKey: string }
export interface ResearchConversationView extends CouncilSession {
  /** A durable question receipt exists; member configuration is being checked asynchronously. */
  initializing?: boolean;
  memberStates: import('./research-execution.interface').ResearchMemberState[];
  mode: 'unavailable' | 'single' | 'team';
  actualExecutors: ActualExecutor[];
  stage: 'independent' | 'discussion' | 'supplement' | 'completed' | 'waiting';
  supplementRounds: number;
  unavailableMembers: Array<{ memberId: string; reason: string }>;
  outcome: DebateOutcome | null;
  contextLabel?: string;
}
export interface ResearchConversationClarification {
  needsInput: { kind: 'stock_identity'; message: string; options: Array<{ ticker: string; label: string }> };
}
export type ResearchConversationResult = ResearchConversationView | ResearchConversationClarification;
