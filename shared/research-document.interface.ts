/** A reference always selects an immutable version, never a latest pointer. */
export interface ReportReference { versionId: string; sectionId?: string; excerpt?: string }
export interface ReportSource { type: 'daily' | 'deep' | 'portfolio' | 'council'; id: string }
export type ResearchDocumentKind = ReportSource['type'];
export interface ResearchDocumentSection { id: string; title: string; content: string }
export interface ResearchInputSnapshot { capturedAt?: string; gaps?: string[]; [key: string]: unknown }
export interface ResearchDocumentVersion {
  id: string; reportId: string; version: number; title: string; kind: ResearchDocumentKind; ticker: string | null;
  content: string; sections: ResearchDocumentSection[]; dataAsOf: string | null; availableAt: string | null;
  createdAt: string; snapshot: ResearchInputSnapshot | null; source: ReportSource | null; parentVersionId: string | null;
  changeReason: string | null; contentHash: string; status: 'valid' | 'revoked'; sourceStatus: 'available' | 'missing';
}
export interface ResolvedReportReference extends ReportReference {
  reportId: string; version: number; title: string; kind: ResearchDocumentKind; ticker: string | null;
  content: string; section: ResearchDocumentSection | null; dataAsOf: string | null; availableAt: string | null;
  createdAt: string; snapshot: ResearchInputSnapshot | null; source: ReportSource | null; parentVersionId: string | null;
  status: 'valid' | 'revoked'; sourceStatus: 'available' | 'missing';
}
export interface ResearchDocument {
  id: string; title: string; kind: ResearchDocumentKind; ticker: string | null; parentReportId: string | null;
  latestVersionId: string | null; adoptedVersionId: string | null; strategyVersionIds: string[];
}
export interface ResearchRevisionInput { title: string; content: string; changeReason: string; sections?: ResearchDocumentSection[]; sourceReferences?: ReportReference[] }
export interface ResearchRevisionDraft extends ResearchRevisionInput {
  id: string; reportId: string; parentVersionId: string; revision: number; createdAt: string; updatedAt: string;
}
export interface ResearchSectionDiff { id: string; title: string; before: string | null; after: string | null; change: 'added' | 'removed' | 'changed' }
export interface ResearchDocumentView {
  document: ResearchDocument; version: ResearchDocumentVersion; versions: ResearchDocumentVersion[];
  drafts: ResearchRevisionDraft[]; diff: ResearchSectionDiff[];
  strategyUses: Array<{ strategyId: string; versionId: string; createdAt: string }>;
  adoptions: Array<{ id: string; versionId: string; previousVersionId: string | null; actorId: string; createdAt: string }>;
}
export interface SubmitResearchDocument {
  idempotencyKey: string; title: string; kind: ResearchDocumentKind; ticker?: string | null;
  content: string; sections: ResearchDocumentSection[]; source?: ReportSource | null;
  reportId?: string; parentVersionId?: string | null; changeReason?: string | null;
  dataAsOf?: string | null; availableAt?: string | null; snapshot?: ResearchInputSnapshot | null;
}
export type ResearchReportCategory = 'daily' | 'stock' | 'review';
export interface ResearchDocumentIndexQuery {
  category?: ResearchReportCategory | 'all'; topic?: string; state?: 'all' | 'adopted' | 'draft' | 'strategy';
  search?: string; limit?: number; offset?: number; history?: boolean; from?: string; to?: string;
  date?: string; source?: ReportSource['type'];
}
export interface ResearchDocumentIndexItem {
  generatedAt?: string | null;
  id: string; reportId: string; version: number; title: string; kind: ResearchDocumentKind; ticker: string | null;
  topicKey: string; category: ResearchReportCategory; dataAsOf: string | null; availableAt: string | null; createdAt: string;
  status: ResearchDocumentVersion['status']; sourceStatus: ResearchDocumentVersion['sourceStatus']; source: ReportSource | null;
  adoptedVersionId: string | null; latestVersionId: string | null; draftCount: number; strategyUseCount: number; updatesAvailable: boolean;
}
export interface ResearchDocumentIndex {
  items: ResearchDocumentIndexItem[]; total: number; topics: Array<{ key: string; label: string; count: number }>; moreLegacySources: boolean;
}
