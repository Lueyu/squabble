import type { CouncilReport } from './council.interface';
import type { Market } from './api.interface';
import type { CompactEvidenceMetadata, EvidenceMetadata, ThesisFreshness, EvidenceComparisonKind } from './research-evidence.interface';

export const THESIS_STATUSES = ['candidate', 'accepted', 'confirmed', 'dismissed', 'expired'] as const;
export type ThesisStatus = (typeof THESIS_STATUSES)[number];
export type MemoryFlag = 'opinion' | 'stale' | 'contradictory' | 'unverified' | 'provenance_unknown' | 'needs_review';
export interface ResearchMemoryPreferences { autoArchive: boolean; recallEnabled: boolean }
export interface ResearchMemoryQuery { ticker: string; market?: Market; topic?: string; asOf?: string }
/** References contain no copied evidence bodies. Evidence is resolved from the current owner-owned report. */
export interface MemoryEvidenceReference { evidenceId: string }
export interface MemoryCitation extends MemoryEvidenceReference {
  title: string; sourceUrl: string | null; fetchedAt: string;
  recordId?: string; metadata?: CompactEvidenceMetadata; conflicting?: boolean;
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
  sourceStatus: 'available' | 'source-deleted' | 'not-yet-known'; source: MemorySource | null;
  citations: MemoryCitation[]; flags: MemoryFlag[]; createdAt: string;
  thesisStructure?: 'present' | 'missing';
}
export interface ResearchThesis extends ThesisContent {
  freshness?: ThesisFreshness;
  id: string; memoryId: string; ticker: string; market: Market; topic: string;
  status: ThesisStatus; version: number; excluded: boolean; expiresAt: string | null;
  sourceStatus: 'available' | 'source-deleted' | 'not-yet-known'; source: MemorySource | null;
  citations: MemoryCitation[]; flags: MemoryFlag[]; createdAt: string; updatedAt: string;
}
export interface ResearchThesisVersion {
  version: number; action: 'candidate' | 'accept' | 'confirm' | 'edit' | 'dismiss' | 'expire' | 'exclude';
  status: ThesisStatus; content: ThesisContent | null; expiresAt: string | null; excluded: boolean;
  sourceStatus: 'available' | 'source-deleted' | 'not-yet-known'; createdAt: string;
  changeReason?: string | null;
}
export interface ResearchMemoryList {
  memories: ResearchMemoryItem[]; theses: ResearchThesis[]; preferences: ResearchMemoryPreferences;
}
export interface ResearchMemoryRecallItem {
  asOf?: string;
  freshness?: ThesisFreshness;
  kind: 'history' | 'thesis'; id: string; version: number; memoryId: string;
  topic?: string;
  summary: string; flags: MemoryFlag[]; source: MemorySource; citations: MemoryCitation[];
  provenance?: ThesisContent['provenance']; endorsement?: 'agent' | 'user';
  /** Legacy clients may omit these. Never reconstruct an atomic thesis from summary text. */
  content?: ThesisContent; status?: ThesisStatus; expiresAt?: string | null;
}
export interface MemoryReference { kind: ResearchMemoryRecallItem['kind']; id: string; version: number }
export interface MemoryOmission extends MemoryReference {
  reason: 'budget' | 'disabled' | 'revoked' | 'version-changed' | 'structure-missing'; currentVersion?: number;
}
/** Submission is observable; model use and native private context are not. Contains no prompt bodies. */
export interface MemoryContextInventory {
  requested: MemoryReference[]; selected: MemoryReference[]; prepared: MemoryReference[]; submitted: MemoryReference[];
  counts: { requested: number; selected: number; prepared: number; submitted: number };
  budgetTokens: number; usedTokens: number; basis: 'conservative-utf8' | 'exact'; omissions: MemoryOmission[];
  requestTokens?: number; requestBudgetTokens?: number; submission?: 'api' | 'agent';
  requestScope?: 'api-messages' | 'application-prompt' | 'application-prompt-and-snapshot'; sharedRequestAttemptId?: string;
  nativeDelivery?: 'runtime' | 'companion-command';
}
export interface ResearchMemoryRecall {
  /** Only explicit historical requests are pinned to a knowledge cutoff. */
  asOf?: string;
  items: ResearchMemoryRecallItem[]; context: string; preferences: ResearchMemoryPreferences;
  requested?: MemoryReference[]; omissions?: MemoryOmission[];
}
export interface ArchiveResearchReport {
  sessionId: string; ticker: string; language: 'zh-CN' | 'en'; report: CouncilReport;
  topic?: string; thesisCandidates?: ThesisCandidateInput[];
}
export interface UpdateResearchThesis {
  changeReason?: string | null;
  expectedVersion: number;
  action: 'confirm' | 'edit' | 'dismiss' | 'expire' | 'exclude';
  content?: ThesisContent; expiresAt?: string | null; excluded?: boolean;
}
export interface ResearchEvidenceRecord {
  id: string; memoryId: string; reportId: string; reportVersion: number; reportRevision: number;
  evidenceId: string; metadata: EvidenceMetadata; ingestedAt: string;
}
export interface ResearchEvidenceGraph {
  evidence: ResearchEvidenceRecord[];
  relations: Array<{ thesisId: string; version: number; evidenceRecordId: string; role: 'support' | 'refute' | 'qualify' }>;
  comparisons: Array<{ left: string; right: string; leftSourceIndex: number; leftFactIndex: number;
    rightSourceIndex: number; rightFactIndex: number; kind: EvidenceComparisonKind }>;
}
