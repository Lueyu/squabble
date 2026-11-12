import type { CouncilSession } from './council.interface';

export type ResearchContext = { kind: 'portfolio'; date?: string } | { kind: 'stock'; ticker: string }
  | { kind: 'report'; documentId: string } | { kind: 'decision'; orderId: string }
  | { kind: 'library'; sourceId: string; versionId: string };
export interface ActualExecutor { identity: string; connection: string; connectionId?: string; provider: string; model: string; memberId: string;
  /** A verified execution origin does not imply different underlying models or statistical independence. */
  identityVerified?: boolean; modelVerified?: boolean }
export interface PublicClaim { id: string; statement: string; evidenceIds: string[] }
export interface StanceChange { status: 'retained' | 'changed' | 'unconfirmed'; reason: string }
export interface DebateOutcome {
  summary?: string;
  confirmed: string[];
  disagreements: Array<{ claimId: string; positions: Array<{ memberId: string; view: string; evidenceIds: string[] }> }>;
  currentAction: 'observe' | 'research_more' | 'consider_action';
  nextEvidence: string[];
}
export interface CreateResearchConversationInput { message: string; context?: ResearchContext; requestKey: string; skillId?: string | null;
  agents?: import('./agent-roster.interface').AgentSelection[];
  /** Explicit per-conversation authorization; omission keeps web research disabled. */
  toolPolicy?: { webResearch: boolean } }
export interface ResearchConversationMessageInput { message: string; replyTo?: string; requestKey: string; skillId?: string | null }
/** Explicit paid continuation of saved daily work, fenced to the reviewed revision. */
export interface ResumeDailyReportInput { requestKey: string; expectedRevision: number }
export interface DailyReportInputCorrection {
  originalIndependentContextComplete: false;
  contextHash: string;
  sourceTaskIds: string[];
  revision: number;
  challengeTurn: number;
  revalidated: boolean;
}
export interface ResearchConversationView extends CouncilSession {
  runtimePending?: import('./research-runtime.interface').CouncilRuntimePending[];
  skills?: import('./research-skills.interface').ResearchSkillIdentity[];
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
