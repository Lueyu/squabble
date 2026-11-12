import type { CouncilMember, CouncilRole } from './council.interface';
import type { NativeAgentConfiguration } from './local-agents.interface';
import type { ResearchSourceRef } from './team-workspace.interface';

/** Stable people are independent of the reusable execution connection. */
export type AgentTemplateId = 'financials' | 'valuation' | 'bear' | 'risk' | 'moderator';
export type AgentExecutor =
  | { executionMode: 'model'; connectionId?: string; model: 'fast' | 'slow' }
  | { executionMode: 'local'; localAgentId: string; settings?: NativeAgentConfiguration }
  /** Owned enabled A2A v1 connection; runtime freezes its exact card and connection revision. */
  | { executionMode: 'a2a'; connectionId: string };
export interface AgentPreferences {
  language: 'zh-CN' | 'en'; responseStyle: 'concise' | 'detailed'; userPreferences: string;
}
export interface AgentVersionConfig {
  schemaVersion: 1; templateId: AgentTemplateId; instructions: string; executor: AgentExecutor;
  /** Ceilings only: neither these declarations nor a template grant live access. */
  allowedToolIds: string[]; allowedSources: ResearchSourceRef[]; preferences: AgentPreferences;
}
export interface AgentVersion {
  id: string; agentId: string; version: number; config: AgentVersionConfig; createdAt: string;
}
export interface AgentProfile {
  id: string; name: string; specialty: string; description: string; status: 'active' | 'archived';
  revision: number; currentVersionId: string; currentVersion: AgentVersion;
  availability: 'configured' | 'unavailable'; createdAt: string; updatedAt: string;
}
export interface AgentTemplate {
  id: AgentTemplateId; name: string; specialty: string; description: string; delivery: string;
  nameEn: string; specialtyEn: string; descriptionEn: string; deliveryEn: string; instructions: string;
  /** Read-only declarations are ceilings; live owner grants remain separate. */
  allowedToolIds: readonly string[];
}
export interface AgentRosterPage { items: AgentProfile[]; nextCursor: string | null }
export interface CreateAgentInput {
  requestKey: string; templateId?: AgentTemplateId; name?: string; specialty?: string; description?: string;
  instructions?: string; executor: AgentExecutor; allowedToolIds?: string[]; allowedSources?: ResearchSourceRef[];
  preferences?: Partial<AgentPreferences>;
}
export interface UpdateAgentInput extends Omit<Partial<CreateAgentInput>, 'requestKey'> {
  requestKey: string; expectedRevision: number;
}
export interface AddRecommendedAgentsInput {
  requestKey: string; executor: AgentExecutor; templateIds?: AgentTemplateId[];
}
export interface ArchiveAgentInput { requestKey: string; expectedRevision: number }
export interface AgentSelection {
  agentId: string; agentVersionId: string; memberId?: string; role?: CouncilRole;
}
export interface AgentResolveOptions { sourceRefs?: ResearchSourceRef[]; allowedToolIds?: string[]; dataCutoffAt?: string }
export interface AgentMemoryRecallOptions extends AgentResolveOptions { sourceRefs: ResearchSourceRef[]; dataCutoffAt: string }
export type AgentCouncilMember = CouncilMember & { rosterAgentId: string; rosterAgentVersionId: string };

/** An omitted scope is never interpreted as access to every team or conversation. */
export type AgentMemoryScope = { kind: 'personal' } | { kind: 'team'; teamId: string }
  | { kind: 'conversation'; conversationId: string };
export interface AgentMemory {
  id: string; agentId: string; scope: AgentMemoryScope; content: string;
  origin: 'user_note' | 'source_summary'; sourceRefs: ResearchSourceRef[]; createdAt: string;
  sharedFrom: { memoryId: string; agentId: string; scope: AgentMemoryScope } | null;
}
export interface WriteAgentMemoryInput {
  requestKey: string; expectedRevision: number; scope: AgentMemoryScope; content: string;
  origin: 'user_note' | 'source_summary'; sourceRefs: ResearchSourceRef[];
}
export interface ShareAgentMemoryInput {
  requestKey: string; expectedRevision: number; targetAgentId: string; targetScope: AgentMemoryScope;
}
