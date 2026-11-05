import type { PortfolioReport, PortfolioReportRun, PortfolioReportSnapshot, PortfolioReportStatus } from '@shared/portfolio-report.interface';

export function isPortfolioReportActive(status: PortfolioReportStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'cancelling';
}

export function visiblePortfolioRun<T extends Pick<PortfolioReportRun, 'status'>>(runs: T[]): T | undefined {
  return runs.find(run => isPortfolioReportActive(run.status)) ?? runs[0];
}

export function recentPortfolioReports<T extends Pick<PortfolioReportRun, 'id' | 'status' | 'report'>>(
  runs: T[], visibleId: string | undefined,
): T[] {
  return runs.filter(run => run.id !== visibleId && run.status === 'completed' && run.report !== null).slice(0, 5);
}

export function portfolioReportSections(report: PortfolioReport) {
  return [
    { key: 'allocationRisks', values: report.allocationRisks },
    { key: 'actions', values: report.actions },
    { key: 'uncertainties', values: report.uncertainties },
    { key: 'dataGaps', values: report.dataGaps },
  ] as const;
}

export function holdingDataGaps(snapshot: PortfolioReportSnapshot, ticker: string): string[] {
  const holding = snapshot.holdings.find(item => item.ticker === ticker);
  if (!holding) return [];
  const fields = (['currentPrice', 'costPrice', 'marketValueUsd', 'weightPct'] as const)
    .filter(field => holding[field] === null);
  return [...fields, ...snapshot.gaps.filter(gap => gap.includes(ticker))];
}

type EvidenceField = 'shares' | 'currentPrice' | 'costPrice' | 'marketValueUsd' | 'weightPct' | 'cashUsd' | 'totalValueUsd';

export interface PortfolioEvidenceFact {
  subject: string;
  field: EvidenceField;
  value: number;
}

export function portfolioEvidenceFact(ref: string, snapshot: PortfolioReportSnapshot): PortfolioEvidenceFact | null {
  const parts = ref.split(':');
  if (parts[0] === 'portfolio' && parts.length === 2) {
    const field = parts[1];
    if (field !== 'cashUsd' && field !== 'totalValueUsd') return null;
    const value = snapshot[field];
    return typeof value === 'number' && Number.isFinite(value) ? { subject: 'portfolio', field, value } : null;
  }
  if (parts[0] === 'holding' && parts.length === 3) {
    const ticker = parts[1];
    const field = parts[2];
    if (field !== 'shares' && field !== 'currentPrice' && field !== 'costPrice'
      && field !== 'marketValueUsd' && field !== 'weightPct') return null;
    const holding = snapshot.holdings.find(item => item.ticker === ticker);
    const value = holding?.[field];
    return typeof value === 'number' && Number.isFinite(value) ? { subject: ticker, field, value } : null;
  }
  return null;
}
