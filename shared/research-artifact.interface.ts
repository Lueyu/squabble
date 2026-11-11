import type { AgentDataClass, AgentSourceVersionRef } from './agent-tooling.interface';

export interface ResearchArtifactRef { artifactId: string; sha256: string }
export interface ResearchArtifact {
  id: string;
  owner: string;
  runId: string;
  type: 'file' | 'table' | 'chart' | 'document' | 'code' | 'manifest';
  mime: string;
  sizeBytes: number;
  sha256: string;
  privateStorageRef: string;
  dependencies: AgentSourceVersionRef[];
  datasetVersionIds: string[];
  /** Derived artifacts inherit the union of all input classifications. */
  effectiveDataClasses: AgentDataClass[];
  permittedUses: string[];
  retentionUntil: string | null;
  status: 'active' | 'revoked' | 'deleted';
}

export type ResearchDocumentLocator = {
  kind: 'pdf';
  elementId: string;
  physicalPage: number;
  pageLabel: string | null;
  bbox: { x: number; y: number; width: number; height: number; origin: 'top_left' | 'bottom_left' } | null;
  pageSize: { width: number; height: number; unit: 'pt' | 'px' } | null;
} | {
  kind: 'docx';
  elementId: string;
  paragraphId: string | null;
  tableId: string | null;
  cellId: string | null;
};
