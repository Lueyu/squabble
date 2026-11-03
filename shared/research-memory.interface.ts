import type { CouncilReport } from './council.interface';
import type { Market } from './api.interface';

export const THESIS_STATUSES = ['candidate', 'accepted', 'confirmed', 'dismissed', 'expired'] as const;
export type ThesisStatus = (typeof THESIS_STATUSES)[number];
export type MemoryFlag = 'opinion' | 'stale' | 'contradictory' | 'unverified';
export interface ResearchMemoryPreferences { autoArchive: boolean; recallEnabled: boolean }
export interface ResearchMemoryQuery { ticker: string; market?: Market; topic?: string }
/** References contain no copied evidence bodies. Evidence is resolved from the current owner-owned report. */
export interface MemoryEvidenceReference { evidenceId: string }
export interface MemoryCitation extends MemoryEvidenceReference {
  title: string; sourceUrl: string | null; fetchedAt: string;
}
export interface MemorySource {
  sessionId: string; reportId: string; reportVersion: number; reportRevision: number;
  reportCreatedAt: string; url: string;
}
export interface ThesisContent {
  claim: string;
  supportingEvidence: MemoryEvidenceReference[];
  opposingEvidence: string[];
  assumptions: string[];
  indicators: string[];
  invalidationConditions: string[];
  /** Omission means unknown for older records; no horizon is inferred. */
  horizon?: { startAt?: string; endAt?: string; reviewAt?: string };
  boundaryOrigin?: 'stated' | 'proposed' | 'unknown';
  evidenceRelations?: Array<{ evidenceId: string; role: 'support' | 'refute' | 'qualify' }>;
  /** Assigned by the server. Workflow acceptance never implies user endorsement. */
  provenance?: { origin: 'agent' | 'user' | 'legacy'; workflow?: { cycleId: string; taskId: string; attemptId: string } };
}
export interface ThesisCandidateInput extends ThesisContent { expiresAt?: string | null }
export interface ResearchMemoryItem {
  id: string; ticker: string; market: Market; topic: string; language: 'zh-CN' | 'en';
  summary: string; decision: CouncilReport['decision']; excluded: boolean;
  sourceStatus: 'available' | 'source-deleted'; source: MemorySource | null;
  citations: MemoryCitation[]; flags: MemoryFlag[]; createdAt: string;
  thesisStructure?: 'present' | 'missing';
}
export interface ResearchThesis extends ThesisContent {
  id: string; memoryId: string; ticker: string; market: Market; topic: string;
  status: ThesisStatus; version: number; excluded: boolean; expiresAt: string | null;
  sourceStatus: 'available' | 'source-deleted'; source: MemorySource | null;
  citations: MemoryCitation[]; flags: MemoryFlag[]; createdAt: string; updatedAt: string;
}
export interface ResearchThesisVersion {
  version: number; action: 'candidate' | 'accept' | 'confirm' | 'edit' | 'dismiss' | 'expire' | 'exclude';
  status: ThesisStatus; content: ThesisContent | null; expiresAt: string | null; excluded: boolean;
  sourceStatus: 'available' | 'source-deleted'; createdAt: string;
}
export interface ResearchMemoryList {
  memories: ResearchMemoryItem[]; theses: ResearchThesis[]; preferences: ResearchMemoryPreferences;
}
export interface ResearchMemoryRecallItem {
  kind: 'history' | 'thesis'; id: string; version: number; memoryId: string;
  topic?: string;
  summary: string; flags: MemoryFlag[]; source: MemorySource; citations: MemoryCitation[];
  provenance?: ThesisContent['provenance']; endorsement?: 'agent' | 'user';
}
export interface ResearchMemoryRecall {
  items: ResearchMemoryRecallItem[]; context: string; preferences: ResearchMemoryPreferences;
}
export interface ArchiveResearchReport {
  sessionId: string; ticker: string; language: 'zh-CN' | 'en'; report: CouncilReport;
  topic?: string; thesisCandidates?: ThesisCandidateInput[];
}
export interface UpdateResearchThesis {
  expectedVersion: number;
  action: 'confirm' | 'edit' | 'dismiss' | 'expire' | 'exclude';
  content?: ThesisContent; expiresAt?: string | null; excluded?: boolean;
}
