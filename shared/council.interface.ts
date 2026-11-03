import type { NativeAgentConfiguration } from './local-agents.interface';
import type { ResearchEvent } from './research-events.interface';
import type { ResearchCoverage, ResearchGoal, ResearchWorkflowView } from './research-workflow.interface';
import type { MemoryContextInventory, ThesisCandidateInput } from './research-memory.interface';
/** Public contracts for bounded, user-owned investment research. */
export interface LlmBudgetSettings {
  enabled: boolean;
  dailyTokenLimit: number;
  monthlyTokenLimit: number;
  perTaskTokenLimit: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCallsPerTask: number;
  dailyCallLimit: number;
  /** Optional user-supplied conservative rates; estimates, not provider billing. */
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
}

export interface LlmBudgetUsage {
  settings: LlmBudgetSettings;
  dayTokens: number;
  monthTokens: number;
  dayCalls: number;
  reservedTokens: number;
  estimatedCostUsd: number | null;
  recent: Array<{
    id: string; purpose: string; model: string; taskId: string;
    inputTokens: number; outputTokens: number; chargedTokens: number;
    status: string; createdAt: string;
  }>;
}

export type CouncilRole = 'researcher' | 'challenger' | 'manager';
export type CouncilSpeakingStyle = 'concise' | 'detailed' | 'socratic';
export type CouncilResearchKind = 'financials' | 'valuation' | 'news' | 'price' | 'web';
export type CouncilPhase = 'opening' | 'challenge' | 'response' | 'summary' | 'progress';
export interface ResearchAcquisition {
  source: string;
  status: 'started' | 'succeeded' | 'partial' | 'failed' | 'cache_hit' | 'skipped';
  detail: string;
  kind?: CouncilResearchKind;
}
export interface CouncilMember {
  /** Native CLI members reuse a connected local account; model members use application API settings. */
  executionMode?: 'model' | 'local';
  agentId?: string;
  agentSettings?: NativeAgentConfiguration;
  id: string;
  role: CouncilRole;
  name: string;
  instructions: string;
  model: 'fast' | 'slow';
  /** Empty uses the account's existing default connection; credentials never enter a profile. */
  connectionId?: string;
  roleTitle?: string;
  personality?: string;
  researchFocus?: CouncilResearchKind[];
  speakingStyle?: CouncilSpeakingStyle;
  avatar?: 'value' | 'growth' | 'risk' | 'technical' | 'news' | 'macro' | 'moderator';
}
export interface CouncilConfig { enabled: boolean; members: CouncilMember[]; webResearch?: boolean }
export interface CreateCouncilSession {
  goal?: ResearchGoal;
  peers?: string[];
  parallelism?: 1 | 2;
  recallEnabled?: boolean;
  profileId?: string;
  ticker: string;
  language?: 'zh-CN' | 'en';
  members?: CouncilMember[];
  webResearch?: boolean;
}
export interface TradingCadence {
  reviewEveryTradingDays: number;
  maxOrdersPerWeek: number;
  cooldownTradingDays: number;
  maxWeeklyTurnoverPct: number;
}
export interface CouncilCandidate {
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  reason: string;
}
/** Reader-facing findings and supporting reasons, never private model reasoning. */
export interface CouncilResponse {
  thesis: string;
  evidencePoints: string[];
  risks: string[];
  nextChecks: string[];
  /** Optional complete supporting analysis; displayed on demand without truncation. */
  details?: string;
}
export interface CouncilMessage {
  memory?: MemoryContextInventory;
  taskId?: string;
  cycleId?: string;
  /** Zero-based turn within a discussion cycle. Older messages may omit it. */
  turn?: number;
  response?: CouncilResponse;
  externalAgent?: boolean;
  externalUsageUnknown?: boolean;
  id: string;
  role: CouncilRole | 'user' | 'system';
  memberName: string;
  content: string;
  revision: number;
  tokensUsed: number;
  createdAt: string;
  memberId?: string | null;
  phase?: CouncilPhase;
  replyToMessageId?: string | null;
  evidenceIds?: string[];
  /** Short public rationale and evidence checks, never raw model reasoning_content. */
  reasoningSummary?: string[];
  questions?: string[];
  acquisition?: ResearchAcquisition | null;
  /** Identifies a progress message already represented by the public event stream. */
  researchEventId?: string;
}
export interface CouncilReport {
  thesisCandidates?: ThesisCandidateInput[] | null;
  coverage?: ResearchCoverage | null;
  id: string;
  version: number;
  revision: number;
  decision: 'approve' | 'wait' | 'reject';
  summary: string;
  dissent: string[];
  nextReviewCondition: string;
  evidence: Array<{ id: string; title: string; content: string; sourceUrl: string | null; fetchedAt: string }>;
  sourceRunId: string | null;
  candidate: CouncilCandidate | null;
  paperOrderId: string | null;
  tokensUsed: number;
  /** a2a is retained only for historical reports. */
  engine: 'basic' | 'llm' | 'local' | 'a2a' | 'mixed';
  externalUsageUnknown?: boolean;
  createdAt: string;
  researchStance?: 'positive' | 'balanced' | 'cautious' | null;
}
export interface CouncilSession {
  workflow?: ResearchWorkflowView;
  researchEvents?: ResearchEvent[];
  researchEventsTruncated?: boolean;
  id: string;
  profileId: string | null;
  profileVersion: number;
  ticker: string;
  language: 'zh-CN' | 'en';
  status: 'idle' | 'running' | 'completed' | 'paused' | 'failed';
  revision: number;
  messages: CouncilMessage[];
  reports: CouncilReport[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  members?: CouncilMember[];
  webResearch?: boolean;
  progress?: { phase: CouncilPhase; memberId: string | null; turn: number; totalTurns: number } | null;
}
export interface CouncilReviewResult {
  approved: boolean;
  reason: string;
  sessionId: string;
  reportId: string | null;
}
