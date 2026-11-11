import type { FinancialProvider, FinancialProviderQuery, FinancialProviderResult } from './financial-provider.interface';
import type { AgentSourceVersionRef } from '../../../../shared/agent-tooling.interface';
import type { ResearchDatasetVersion } from '../../../../shared/research-dataset.interface';
import { DataDatasetService } from '../data-dataset.service';

export class FinancialProviderRegistry {
  private readonly providers: Map<string, FinancialProvider>;
  constructor(providers: FinancialProvider[]) {
    this.providers = new Map(providers.map(provider => [provider.id, provider]));
    if (this.providers.size !== providers.length) throw new Error('DUPLICATE_FINANCIAL_PROVIDER');
  }
  query(providerId: string, input: FinancialProviderQuery): Promise<FinancialProviderResult> {
    const provider = this.providers.get(providerId); if (!provider) throw new Error('PROVIDER_UNAVAILABLE');
    return provider.query(input);
  }
  async createDataset(datasets: DataDatasetService, owner: string, sourceVersion: AgentSourceVersionRef,
    result: FinancialProviderResult, license: ResearchDatasetVersion['license']): Promise<ResearchDatasetVersion> {
    return datasets.create(owner, { rows: result.rows, metadata: { sourceVersion, dependencies: [],
      schema: { fields: [...new Set(result.rows.flatMap(row => Object.keys(row)))], provenance: result.sourceUrl },
      schemaVersion: 'financial-row-v1', provider: result.provider, operation: result.operation,
      parameterVersion: result.parameterVersion, timing: result.timing, coverage: result.coverage,
      adjustment: result.adjustment, corporateActionsVersionId: null, dataClasses: ['public'], license } });
  }
}
