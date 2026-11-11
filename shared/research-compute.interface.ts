import type { ResearchArtifactRef } from './research-artifact.interface';
import type { RuntimeDatasetSnapshotRef } from './research-runtime.interface';

export interface ResearchComputeManifest {
  version: 1;
  runId: string;
  datasets: RuntimeDatasetSnapshotRef[];
  codeHash: string;
  templateId: string | null;
  seed: number;
  dependencies: Record<string, string>;
  network: { enabled: false } | { enabled: true; authorizedTargets: string[] };
  mode: 'validated_template' | 'exploratory';
}

export interface ResearchStatisticsRequest {
  manifest: ResearchComputeManifest;
  frequency: 'daily' | 'weekly' | 'monthly';
  benchmarkDatasetVersionId: string | null;
  riskFreeRate: string;
  missingValuePolicy: 'reject' | 'retain';
}

export interface ResearchBacktestRequest {
  manifest: ResearchComputeManifest;
  universeVersionId: string;
  universeBasis: 'point_in_time' | 'current_universe';
  calendarVersionId: string;
  marketRulesVersionId: string;
  corporateActionsVersionId: string;
  from: string;
  to: string;
  availabilityBasis: 'application_known_at' | 'provider_vintage';
  signalFrequency: 'daily' | 'weekly' | 'monthly';
  executionRule: 'next_tradable_session';
  executionPriceBasis: 'unadjusted';
  feeModelVersionId: string;
  slippageModelVersionId: string;
  benchmarkDatasetVersionId: string;
  cashFlowDatasetVersionId: string | null;
}

export interface ResearchComputeResult {
  jobId: string;
  manifestHash: string;
  status: 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'provider_unknown';
  verification: 'validated' | 'exploratory' | 'unverified';
  artifacts: ResearchArtifactRef[];
  limitations: string[];
}
