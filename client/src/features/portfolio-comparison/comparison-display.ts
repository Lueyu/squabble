import type { PortfolioComparisonSeries } from '@shared/portfolio-comparison.interface';
import type { PortfolioHistoryView } from '@shared/portfolio-history.interface';

export function currentAccountValue(
  series: PortfolioComparisonSeries,
): number | null {
  return series.currentMark ? series.currentMark.valueUsd : series.equityUsd;
}

export function currentAccountAsOf(
  series: PortfolioComparisonSeries,
): string | null {
  return series.currentMark ? series.currentMark.asOf : series.valuationAsOf;
}

export function recordedReturnAsOf(
  series: PortfolioComparisonSeries,
): string | null {
  return (
    series.points.filter((point) => point.returnPct !== null).at(-1)
      ?.timestamp ?? null
  );
}

export function currentAccountBasis(
  series: PortfolioComparisonSeries,
  zh: boolean,
): string {
  const basis = series.currentMark?.basis;
  if (basis === 'holdings_market_value')
    return zh ? '持仓市值 · 现金待核对' : 'Holdings value · Cash unconfirmed';
  if (basis === 'known_assets')
    return zh ? '已知资产 · 资料待补全' : 'Known assets · Partial coverage';
  return zh ? '账户资产' : 'Account assets';
}

/** This replaces an entire series; historical reference values never join an actual NAV line. */
export function historicalReferenceSeries(
  accounts: PortfolioComparisonSeries[],
  history: PortfolioHistoryView | undefined,
): PortfolioComparisonSeries[] {
  return accounts.map((account) => {
    const reference = history?.series.find(
      (item) => item.accountId === account.accountId,
    );
    const points =
      reference?.points.map((point) => ({
        timestamp: `${point.date}T12:00:00.000Z`,
        date: point.date,
        equityUsd: point.valueUsd,
        returnPct: null,
        gaps: point.gaps,
      })) ?? [];
    const last = points.filter((point) => point.equityUsd !== null).at(-1);
    return {
      ...account,
      points,
      equityUsd: last?.equityUsd ?? null,
      valuationAsOf: last?.timestamp ?? null,
      returnPct: null,
      returnFrom: null,
      gaps: reference?.gaps ?? ['HISTORY_PENDING'],
    };
  });
}

export function shouldShowReference(
  selected: PortfolioComparisonSeries[],
  history: PortfolioHistoryView | undefined,
): boolean {
  return selected.some(
    (account) =>
      account.points.filter((point) => point.equityUsd !== null).length < 2 &&
      history?.series.some(
        (item) =>
          item.accountId === account.accountId &&
          item.coverage.totalPositions > 0,
      ),
  );
}
