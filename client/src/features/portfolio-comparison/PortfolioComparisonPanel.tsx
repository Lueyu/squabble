import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  PortfolioComparisonMetric,
  PortfolioComparisonPeriod,
} from '@shared/portfolio-comparison.interface';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { fetchPortfolioComparison } from '@/api/portfolio-comparison';
import { fetchPortfolioHistory } from '@/api/portfolio-history';
import {
  currentAccountAsOf,
  currentAccountBasis,
  currentAccountValue,
  historicalReferenceSeries,
  partialReferenceCoverage,
  recordedReturnAsOf,
} from './comparison-display';
import {
  accountColor,
  comparisonGapBridges,
  comparisonInclusionPoint,
  comparisonSamplingLabel,
  formatComparisonTime,
} from './comparison-chart-options';
import PortfolioComparisonChart from './PortfolioComparisonChart';

const periods: Record<PortfolioComparisonPeriod, [string, string]> = {
  '1D': ['日内', 'Intraday'],
  '1W': ['近一周', 'Past week'],
  '1M': ['近一月', 'Past month'],
  '3M': ['近三月', 'Past three months'],
  YTD: ['今年', 'Year to date'],
  ALL: ['全部', 'All time'],
};

const periodOptions = Object.keys(periods) as PortfolioComparisonPeriod[];

interface Props {
  accountIds?: string[];
  initialAccountIds?: string[];
  defaultExcludedAccountIds?: ReadonlySet<string>;
  compact?: boolean;
  persistView?: boolean;
}

interface ComparisonControls {
  period: PortfolioComparisonPeriod;
  metric: PortfolioComparisonMetric;
  basis: 'records' | 'reference';
  accounts: string[] | null;
}

export default function PortfolioComparisonPanel({
  accountIds,
  initialAccountIds,
  defaultExcludedAccountIds,
  compact,
  persistView = false,
}: Props) {
  const { i18n } = useTranslation();
  const { language } = i18n;
  const zh = language.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const defaultMetric = compact ? 'equity' : 'return';
  const [local, setLocal] = useState<ComparisonControls>({
    period: compact ? '1M' : '1W',
    metric: defaultMetric,
    basis: 'records',
    accounts: initialAccountIds ?? null,
  });
  const requestedPeriod = params.get('period');
  const savedPeriod = periodOptions.find(value => value === requestedPeriod);
  const basis = persistView ? params.get('basis') === 'reference' ? 'reference' : 'records' : local.basis;
  const metricParam = params.get('metric');
  const savedMetric = metricParam === 'equity' || metricParam === 'return' ? metricParam : null;
  const requestedMetric = basis === 'reference' ? 'equity' : persistView ? savedMetric ?? defaultMetric : local.metric;
  const period = persistView ? savedPeriod ?? local.period : local.period;
  const savedAccounts = params.get('accounts');
  const selectedIds = persistView && savedAccounts !== null ? savedAccounts.split(',').filter(Boolean) : local.accounts;

  function update(changes: Partial<ComparisonControls>, clear: (keyof ComparisonControls)[] = []) {
    if (!persistView) {
      setLocal(previous => ({ ...previous, ...changes }));
      return;
    }
    const next = new URLSearchParams(params);
    clear.forEach(key => next.delete(key));
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, Array.isArray(value) ? value.join(',') : value);
    }
    navigate({ pathname: location.pathname, search: next.toString(), hash: location.hash }, {
      replace: true,
      state: location.state,
    });
  }

  const explicitReference = basis === 'reference';
  const comparison = useQuery({
    queryKey: ['portfolio-comparison', period, accountIds ?? 'all'],
    queryFn: () => fetchPortfolioComparison(period, accountIds),
    refetchInterval: 60_000,
  });
  const series = comparison.data?.series ?? [];
  const isSelected = (id: string) => selectedIds === null ? !defaultExcludedAccountIds?.has(id) : selectedIds.includes(id);
  const selected = series.filter(item => isSelected(item.accountId));
  const selectedAccountIds = selected.map(item => item.accountId);
  const savedSeries = selected.map(account => {
    if (!account.createdAt) return account;
    const createdAt = Date.parse(account.createdAt);
    return { ...account, points: account.points.filter(point => Date.parse(point.timestamp) >= createdAt) };
  });
  const realAccount = savedSeries.find(account => account.kind === 'real');
  const realValuations = realAccount?.points.filter(point => point.equityUsd !== null) ?? [];
  const singleRealSelection = !!realAccount && selected.length === 1;
  const automatic = persistView && !!realAccount && !explicitReference && savedMetric === null;
  const hasComparableReturn = savedSeries.some(account => account.points.some(point => point.returnPct !== null));
  // Keep a usable comparison. When it would be empty, show the real holdings'
  // dated price reference on its own axis instead of mixing it into saved NAV.
  const needsRealReference = automatic && !realValuations.length && !hasComparableReturn;
  const referenceAccounts = needsRealReference && realAccount ? [realAccount] : selected;
  const referenceAccountIds = referenceAccounts.map(item => item.accountId);
  const history = useQuery({
    queryKey: ['portfolio-history', period, referenceAccountIds],
    queryFn: () => fetchPortfolioHistory(period, referenceAccountIds),
    enabled: (explicitReference || needsRealReference) && referenceAccounts.length > 0,
    retry: false,
    refetchInterval: query => query.state.data?.refreshing ? 3000 : 60_000,
  });
  const referenceSeries = explicitReference || needsRealReference
    ? historicalReferenceSeries(referenceAccounts, history.data) : [];
  const reference = explicitReference || referenceSeries.some(account => account.equityUsd !== null);
  const chartSeries = reference ? referenceSeries : savedSeries;
  const realOnly = automatic && singleRealSelection && !reference;
  const showRangeButton = automatic && series.length === 1;
  const singleValuation = realValuations.length === 1 ? realValuations[0] : undefined;
  const latestRealValuation = realValuations.at(-1);
  const metric = reference || (automatic && latestRealValuation && (!hasComparableReturn
    || (singleRealSelection && realValuations.filter(point => point.returnPct !== null).length < 2)))
    ? 'equity' : requestedMetric;
  const partialReferences = reference ? referenceAccounts.flatMap(account => {
    const coverage = partialReferenceCoverage(history.data?.series.find(item => item.accountId === account.accountId));
    return coverage ? [{ account, ...coverage }] : [];
  }) : [];
  const inclusion = reference ? [] : chartSeries.flatMap(account => {
    const point = comparisonInclusionPoint(account, metric, comparison.data);
    return point ? [{ account, point }] : [];
  });
  const hasReferenceWarning = reference && chartSeries.some(account =>
    comparisonGapBridges(account, metric, true).some(bridge => bridge.kind === 'warning'));
  const hasRealGap = !reference && chartSeries.some(account => account.kind === 'real' && account.points.some(point =>
    point.equityUsd === null && point.gaps.some(gap => gap === 'MISSING_OBSERVATION' || gap === 'INCOMPLETE_VALUATION')));
  const label = (item: (typeof series)[number]) => item.kind === 'real' ? text('我的实仓', 'My real portfolio') : item.name;
  const periodLabel = (value: PortfolioComparisonPeriod) => periods[value][zh ? 0 : 1];
  const money = new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const percent = new Intl.NumberFormat(language, {
    style: 'percent', signDisplay: 'exceptZero', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const title = reference ? text('持仓参考市值', 'Holdings lookback')
    : metric === 'return' ? text('账户收益率', 'Account returns') : text('账户资产金额', 'Account equity');

  const annotation = realOnly ? latestRealValuation && (
    <p className="text-xs text-muted-foreground">
      {singleValuation
        ? text('取得第二次可比较观测后显示收益走势。', 'A return trend is available after a second comparable observation.')
        : text('缺少完整实仓估值的时段在图中留空。', 'Periods without a complete real-account valuation are shown as gaps.')}
    </p>
  ) : (inclusion.length > 0 || hasRealGap) && (
    <div className="space-y-2 rounded-lg bg-muted/50 p-4 text-sm">
    {inclusion.map(({ account, point }) => <div key={account.accountId} data-inclusion-account={account.accountId}>
      <p className="font-semibold" style={{ color: accountColor(account.accountId, account.colorIndex) }}>
        {label(account)} · {text('已计入统计', 'Included in comparison')}
      </p>
      <p className="mt-1 text-muted-foreground">
        <time dateTime={point.timestamp}>{formatComparisonTime(point.timestamp, language)}</time>
        {' · '}{text('首次取得完整估值', 'First complete recorded valuation')}
      </p>
    </div>)}
    {hasRealGap && <p className="text-muted-foreground">{text('缺少完整实仓估值的时段在图中留空。', 'Periods without a complete real-account valuation are shown as gaps.')}</p>}
  </div>
  );

  const toggle = (id: string) => update({
    accounts: isSelected(id) ? selectedAccountIds.filter(value => value !== id) : [...selectedAccountIds, id],
  });

  return (
    <section className="portfolio-comparison min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5" aria-label={text('账户表现', 'Account performance')}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold">{realOnly
            ? singleValuation ? text('仅一次有效观测', 'One valid observation')
              : latestRealValuation ? text('多次有效观测', 'Multiple valid observations')
                : text('暂无有效观测', 'No valid observations')
            : title}</h2>
          {realOnly && latestRealValuation && <p className="text-xs text-muted-foreground">
            {singleValuation ? null : text('截至 ', 'As of ')}
            <time dateTime={latestRealValuation.timestamp}>{formatComparisonTime(latestRealValuation.timestamp, language)}</time>
            {' · '}
            {singleValuation && text('首次估值 ', 'First valuation ')}
            {metric === 'return' && latestRealValuation.returnPct === null ? '—' : metric === 'return'
              ? percent.format(latestRealValuation.returnPct! / 100)
              : money.format(latestRealValuation.equityUsd!)}
          </p>}
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" className="shrink-0"
              aria-label={showRangeButton ? text('统计区间', 'Date range') + ' · ' + periodLabel(period) : undefined}>
              {showRangeButton ? periodLabel(period) : text(`选择账户（${selected.length}）`, `Select accounts (${selected.length})`)}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" collisionPadding={12} className="max-h-[min(75dvh,30rem)] max-w-[calc(100vw-24px)] overflow-y-auto" aria-label={text('图表选项', 'Chart options')}>
            {!showRangeButton && <fieldset className="space-y-1">
              <legend className="mb-1 text-sm font-semibold">{text('同图显示的账户', 'Accounts on this chart')}</legend>
              {series.map(item => (
                <label key={item.accountId} className="flex min-h-8 items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={isSelected(item.accountId)} onChange={() => toggle(item.accountId)} />
                  <span className="min-w-0 break-words">{label(item)}
                    {defaultExcludedAccountIds?.has(item.accountId) && (zh ? ' · 原团队已归档' : ' · Former team archived')}
                  </span>
                </label>
              ))}
            </fieldset>}
            <label className="mt-3 grid gap-1 text-sm">
              {text('统计区间', 'Date range')}
              <select className="h-9 rounded-md border bg-background px-2" value={period}
                onChange={event => {
                  const value = periodOptions.find(key => key === event.target.value);
                  if (value) update({ period: value });
                }}>
                {periodOptions.map(value => <option key={value} value={value}>{periodLabel(value)}</option>)}
              </select>
            </label>
            <label className="mt-3 grid gap-1 text-sm">
              {text('图表口径', 'Chart data')}
              <select className="h-9 rounded-md border bg-background px-2" value={explicitReference ? 'reference' : automatic ? 'auto' : metric}
                onChange={event => {
                  const value = event.target.value;
                  if (value === 'reference') update({ basis: 'reference', metric: 'equity' });
                  else if (value === 'auto') update({}, ['basis', 'metric']);
                  else update({ basis: 'records', metric: value === 'return' ? 'return' : 'equity' });
                }}>
                {persistView && realAccount && <option value="auto">{text('自动', 'Automatic')}</option>}
                <option value="return">{text('账户收益率', 'Account returns')}</option>
                <option value="equity">{text('账户资产金额', 'Account equity')}</option>
                <option value="reference">{text('当前持仓回看', 'Current holdings lookback')}</option>
              </select>
            </label>
          </PopoverContent>
        </Popover>
      </div>

      {!showRangeButton && <div className="account-segments" role="group" aria-label={text('比较区间', 'Comparison period')}>
        {(['1D', '1W'] as const).map(value => (
          <Button key={value} type="button" variant="ghost" size="sm" aria-pressed={period === value}
            onClick={() => update({ period: value })}>{periodLabel(value)}</Button>
        ))}
        {period !== '1D' && period !== '1W' && <span className="account-current-range flex items-center rounded-md text-xs">{periodLabel(period)}</span>}
      </div>}

      {comparison.isPending && <p className="portfolio-chart-empty" role="status">{text('正在读取账户估值…', 'Loading saved valuations…')}</p>}
      {comparison.isError && <div className="portfolio-notice" role="alert">
        <span>{text('账户估值暂时无法读取。', 'Unable to read account valuations.')}</span>
        <Button variant="outline" size="sm" onClick={() => void comparison.refetch()}>{text('重试', 'Retry')}</Button>
      </div>}
      {comparison.data && <>
        {!realOnly && <dl className="grid min-w-0 grid-cols-2 gap-4 md:grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))]">
          {chartSeries.map(account => {
            const value = metric === 'return' ? account.returnPct : reference ? account.equityUsd : currentAccountValue(account);
            const asOf = metric === 'return'
              ? value === null ? account.points.filter(point => point.equityUsd !== null).at(-1)?.timestamp ?? account.valuationAsOf : recordedReturnAsOf(account)
              : reference ? account.valuationAsOf : currentAccountAsOf(account);
            const color = accountColor(account.accountId, account.colorIndex);
            return <div key={account.accountId} className="min-w-0 space-y-1">
              <dt className="flex items-baseline gap-2 text-sm font-medium">
                <span className="portfolio-color-dot" style={{ backgroundColor: color }} aria-hidden="true" />
                <span className="min-w-0 break-words">{label(account)}</span>
              </dt>
              <dd className="break-words text-2xl font-semibold tabular-nums sm:text-3xl" style={{ color }}>
                {value == null ? '—' : metric === 'return' ? percent.format(value / 100) : money.format(value)}
              </dd>
              {asOf && <dd className="text-xs text-muted-foreground">
                {text('截至', 'As of')}{' '}<time dateTime={asOf}>{reference && asOf.length === 10 ? asOf : formatComparisonTime(asOf, language)}</time>
              </dd>}
              {!reference && metric === 'equity' && account.currentMark && <dd className="text-xs text-muted-foreground">{currentAccountBasis(account, zh)}</dd>}
              {!reference && account.kind === 'simulation' && account.firstIncludedAt === null && <dd className="text-xs text-muted-foreground">
                {text('等待首次完整估值', 'Awaiting a first complete valuation')}
              </dd>}
            </div>;
          })}
        </dl>}
        {reference && <div className="space-y-2 text-xs text-muted-foreground">
          {needsRealReference && <p>{text('此区间暂无完整实仓估值，显示可核对的实仓持仓参考市值。', 'Complete real-portfolio valuations are unavailable in this period. Showing the available holdings reference.')}</p>}
          <p>{text('使用当前持仓数量和历史行情，不含现金、交易与分红。', 'Uses current holdings and historical prices. Excludes cash, trades and dividends.')}</p>
          {history.data?.refreshing && <p role="status">{text('正在补齐历史行情…', 'Preparing historical prices…')}</p>}
          {partialReferences.map(({ account, covered, total }) =>
            <p key={account.accountId}>{label(account)} · {text(`覆盖 ${covered}/${total} 项持仓`, `${covered}/${total} holdings covered`)}</p>)}
        </div>}
        {(needsRealReference || explicitReference) && referenceAccounts.length > 0 && history.isPending
          && <p className="text-xs text-muted-foreground" role="status">{text('正在读取历史行情…', 'Loading historical prices…')}</p>}
        {(needsRealReference || explicitReference) && history.isError
          && <p className="text-xs text-muted-foreground" role="alert">{text('历史行情暂时无法读取。', 'Historical prices are unavailable.')} <Button variant="outline" size="sm" onClick={() => void history.refetch()}>{text('重试', 'Retry')}</Button></p>}
        <PortfolioComparisonChart series={chartSeries} metric={metric} compact={compact} reference={reference}
          period={period} window={comparison.data} historySeries={history.data?.series}
          realOnly={realOnly}
          partialAccountIds={partialReferences.map(item => item.account.accountId)}
          granularity={comparison.data.granularity} referenceGranularity={history.data?.intradayGranularity}
          annotation={annotation} />
        {(reference || comparison.data.granularity !== 'observations') && <p className="text-xs text-muted-foreground">
          {comparisonSamplingLabel(comparison.data.granularity, zh, reference, history.data?.intradayGranularity)}
          {hasReferenceWarning && (' · ' + text('警示虚线连接未知区间，区间内估值仍未知。', 'Warning dashes link unknown intervals. Values in those intervals remain unknown.'))}
        </p>}
      </>}
    </section>
  );
}
