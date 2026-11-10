/** Explicit removal from research/history; immutable evidence and executed ledgers are retained. */
export interface DeleteResearchDocumentVersionInput { expectedVersion: number; requestKey: string }
export interface DeleteResearchConversationInput { expectedRevision: number; requestKey: string }
export interface ResearchDeletionResult { id: string; deleted: true; deletedAt: string }
