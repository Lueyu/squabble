import type { ResearchDatasetTiming, ResearchDatasetVersion, ResearchInstrument } from '../../../../shared/research-dataset.interface';

export interface FinancialProviderQuery {
  operation: 'daily-history' | 'trading-calendar' | 'financials'; market: 'CN' | 'HK' | 'US';
  exchange?: string; symbol?: string; from?: string; to?: string;
  adjustment?: 'unadjusted' | 'forward' | 'backward';
}
export interface FinancialProviderResult {
  provider: string; operation: string; parameterVersion: string; instrument: ResearchInstrument | null;
  rows: Record<string, unknown>[]; timing: ResearchDatasetTiming;
  coverage: ResearchDatasetVersion['coverage']; adjustment: ResearchDatasetVersion['adjustment'];
  sourceUrl: string;
}
export interface FinancialProvider {
  readonly id: string; query(input: FinancialProviderQuery): Promise<FinancialProviderResult>;
}
export type ProviderJsonRequest = (url: URL, init: RequestInit) => Promise<unknown>;
export type AktoolsMcpCall = (name: 'search_interfaces' | 'describe_interface' | 'get_data', input: Record<string, unknown>) => Promise<unknown>;
