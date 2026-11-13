import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ArrowRight,
  Check,
  SlidersHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchPortfolioComparison } from '@/api/portfolio-comparison';
import { fetchPortfolioHistory } from '@/api/portfolio-history';
import {
  currentAccountAsOf,
  recordedReturnAsOf,
  currentAccountBasis,
  currentAccountValue,
  historicalReferenceSeries,
  partialReferenceCoverage,
  shouldShowReference,
} from './comparison-display';
import type {
  PortfolioComparisonMetric,
  PortfolioComparisonPeriod,
} from '@shared/portfolio-comparison.interface';
import PortfolioComparisonChart from './PortfolioComparisonChart';
import { accountColor, comparisonGapLabel, comparisonSamplingLabel } from './comparison-chart-options';
import {
  portfolioWorkspaceApi,
  portfolioWorkspaceKeys,
} from '@/api/portfolio-workspace';
import { holdingsHref } from '@/features/assets/account-context';
import { useAccountTeams } from '@/features/assets/AccountAssetsPage';
import CompanionIdentity from '@/features/companions/CompanionIdentity';
import { TeamDecisionComparison } from './TeamDecisionComparison';
import { teamResearchStatus } from './team-decision-comparison-state';

interface Props {
  accountIds?: string[];
  initialAccountIds?: string[];
  compact?: boolean;
  showAccounts?: boolean;
  showHeadline?: boolean;
  persistView?: boolean;
}

export default function PortfolioComparisonPanel({
  accountIds,
  initialAccountIds,
  compact,
  showAccounts,
  showHeadline,
  persistView = false,
}: Props) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [localPeriod, setLocalPeriod] =
    useState<PortfolioComparisonPeriod>('1M');
  const [localMetric, setLocalMetric] =
    useState<PortfolioComparisonMetric>('equity');
  const [localBasis, setLocalBasis] = useState<string | null>(null);
  const [localIds, setLocalIds] = useState<string[] | null>(
    initialAccountIds ?? null,
  );
  const requestedPeriod = params.get('period');
  const period: PortfolioComparisonPeriod =
    persistView &&
    ['1D', '1W', '1M', '3M', 'YTD', 'ALL'].includes(requestedPeriod ?? '')
      ? (requestedPeriod as PortfolioComparisonPeriod)
      : localPeriod;
  const metric: PortfolioComparisonMetric =
    persistView && params.has('metric')
      ? params.get('metric') === 'return'
        ? 'return'
        : 'equity'
      : localMetric;
  const selectedIds =
    persistView && params.has('accounts')
      ? params.get('accounts')!.split(',').filter(Boolean)
      : localIds;
  const saveView = (
    key: string,
    value: string,
    extra: Record<string, string> = {},
  ) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    for (const [name, setting] of Object.entries(extra))
      next.set(name, setting);
    setParams(next, { replace: true });
  };
  const setPeriod = (value: PortfolioComparisonPeriod) =>
    persistView ? saveView('period', value) : setLocalPeriod(value);
  const setMetric = (value: PortfolioComparisonMetric) => {
    if (persistView)
      saveView('metric', value, value === 'return' ? { basis: 'records' } : {});
    else {
      setLocalMetric(value);
      if (value === 'return') setLocalBasis('records');
    }
  };
  const setBasis = (value: 'reference' | 'records') => {
    if (persistView)
      saveView(
        'basis',
        value,
        value === 'reference' ? { metric: 'equity' } : {},
      );
    else {
      setLocalBasis(value);
      if (value === 'reference') setLocalMetric('equity');
    }
  };
  const [showSettings, setShowSettings] = useState(false);
  const comparison = useQuery({
    queryKey: ['portfolio-comparison', period, accountIds ?? 'all'],
    queryFn: () => fetchPortfolioComparison(period, accountIds),
    refetchInterval: 60_000,
  });
  const history = useQuery({
    queryKey: ['portfolio-history', period, accountIds ?? 'all'],
    queryFn: () => fetchPortfolioHistory(period, accountIds),
    retry: false,
    refetchInterval: (query) => (query.state.data?.refreshing ? 3000 : 60_000),
  });
  const accountDetails = useQuery({
    queryKey: portfolioWorkspaceKeys.accounts,
    queryFn: portfolioWorkspaceApi.accounts,
    enabled: Boolean(showAccounts),
    retry: false,
  });
  const teams = useAccountTeams();
  const teamFor = (id: string) => teams.data?.find(team => team.accountId === id && team.binding?.state === 'active');
  const money = (value: number | null | undefined) =>
    value == null
      ? '—'
      : new Intl.NumberFormat(zh ? 'zh-CN' : 'en-US', {
          style: 'currency',
          currency: 'USD',
          currencyDisplay: 'narrowSymbol',
          maximumFractionDigits: 2,
        }).format(value);
  const percentage = (value: number | null | undefined) =>
    value == null
      ? zh
        ? '待核对'
        : 'Unavailable'
      : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  const series = comparison.data?.series ?? [];
  const isSelected = (id: string) =>
    selectedIds === null || selectedIds.includes(id);
  const selected = series.filter((item) => isSelected(item.accountId));
  const basis = persistView ? params.get('basis') : localBasis;
  const reference =
    metric === 'equity' &&
    (basis === 'reference' ||
      (!basis && shouldShowReference(selected, history.data)));
  const chartSeries = reference
    ? historicalReferenceSeries(selected, history.data)
    : selected;
  const referenceAvailable = history.data?.series.some(
    (item) => item.coverage.totalPositions > 0,
  );
  const partialReferences = reference
    ? selected.flatMap((account) => {
        const partial = partialReferenceCoverage(
          history.data?.series.find(
            (item) => item.accountId === account.accountId,
          ),
        );
        return partial ? [{ account, ...partial }] : [];
      })
    : [];
  const toggle = (id: string) => {
    const current = selectedIds ?? series.map((item) => item.accountId);
    const next = current.includes(id)
      ? current.filter((value) => value !== id)
      : [...current, id];
    if (persistView) saveView('accounts', next.join(','));
    else setLocalIds(next);
  };
  const accountPath = holdingsHref;
  const returnState = {
    returnTo: `${location.pathname}${location.search}${location.hash}`,
  };
  const label = (item: (typeof series)[number]) =>
    item.kind === 'real' ? (zh ? '实仓' : 'Real portfolio') : item.name;
  const status = (value: string) =>
    ({
      real: zh ? '真实资产' : 'Real assets',
      running: zh ? '运行中' : 'Running',
      paused: zh ? '已暂停' : 'Paused',
      archived: zh ? '已归档' : 'Archived',
    })[value] ?? value;
  if (comparison.isPending)
    return (
      <div className="portfolio-loading" role="status">
        {zh ? '正在读取账户估值…' : 'Loading saved valuations…'}
      </div>
    );
  if (comparison.isError)
    return (
      <div className="portfolio-notice" role="alert">
        <AlertCircle size={18} />
        <span>
          {zh ? '账户估值暂时无法读取。' : 'Unable to read account valuations.'}
        </span>
        <Button variant="outline" onClick={() => void comparison.refetch()}>
          {zh ? '重试' : 'Retry'}
        </Button>
      </div>
    );
  return (
    <section
      className="portfolio-comparison"
      aria-label={zh ? '账户表现' : 'Account performance'}
    >
      {showHeadline && (
        <div className="portfolio-hero">
          <div>
            <h2>
              {zh
                ? '每个想法，都有自己的成长轨迹'
                : 'Every idea has its own journey'}
            </h2>
            <p className="portfolio-valuation-time">
              {zh
                ? '实仓与模拟仓独立记录 · 不同起点不排名'
                : 'Real and simulated assets stay separate · Different starting points are not a ranking'}
            </p>
          </div>
          <div
            className="portfolio-metric-toggle"
            role="group"
            aria-label={zh ? '图表指标' : 'Chart metric'}
          >
            <Button
              variant={metric === 'equity' ? 'default' : 'outline'}
              onClick={() => setMetric('equity')}
              aria-pressed={metric === 'equity'}
            >
              {zh ? '资产金额' : 'Equity'}
            </Button>
            <Button
              variant={metric === 'return' ? 'default' : 'outline'}
              onClick={() => setMetric('return')}
              aria-pressed={metric === 'return'}
            >
              {zh ? '收益率 %' : 'Return %'}
            </Button>
          </div>
        </div>
      )}
      {showHeadline && (
        <div className="portfolio-performance-figures">
          {selected.map((item) => (
            <div key={item.accountId}>
              <p>
                <i
                  className="portfolio-color-dot"
                  style={{
                    background: accountColor(item.accountId, item.colorIndex),
                  }}
                />
                {label(item)}
              </p>
              <strong
                style={{ color: accountColor(item.accountId, item.colorIndex) }}
              >
                {metric === 'equity'
                  ? money(currentAccountValue(item))
                  : percentage(item.returnPct)}
              </strong>
              <small className="portfolio-performance-asof">
                {metric === 'equity'
                  ? currentAccountBasis(item, zh)
                  : zh
                    ? '区间收益 · 账户记录'
                    : 'Period return · Account records'}{' '}
                ·{' '}
                {(
                  metric === 'equity'
                    ? currentAccountAsOf(item)
                    : recordedReturnAsOf(item)
                )
                  ? `${zh ? '截至' : 'As of'} ${new Date((metric === 'equity' ? currentAccountAsOf(item) : recordedReturnAsOf(item))!).toLocaleDateString(i18n.language)}`
                  : zh
                    ? '时间待核对'
                    : 'Time unverified'}
              </small>
            </div>
          ))}
        </div>
      )}
      <div className="portfolio-chart-controls">
        <div
          className="portfolio-periods"
          role="group"
          aria-label={zh ? '时间范围' : 'Period'}
        >
          {(['1D', '1W', '1M', '3M', 'YTD', 'ALL'] as const).map(
            (value, index) => (
              <Button
                key={value}
                size="sm"
                variant={period === value ? 'default' : 'ghost'}
                aria-pressed={period === value}
                onClick={() => setPeriod(value)}
              >
                {zh
                  ? ['1日', '1周', '1月', '3月', '今年', '全部'][index]
                  : value}
              </Button>
            ),
          )}
        </div>
        <div className="portfolio-chart-actions">
          {!showHeadline && (
            <select
              aria-label={zh ? '图表指标' : 'Chart metric'}
              value={metric}
              onChange={(event) =>
                setMetric(event.target.value as PortfolioComparisonMetric)
              }
            >
              <option value="equity">{zh ? '资产金额' : 'Equity'}</option>
              <option value="return">{zh ? '收益率 %' : 'Return %'}</option>
            </select>
          )}
          <Button
            variant="outline"
            size="sm"
            aria-expanded={showSettings}
            onClick={() => setShowSettings(!showSettings)}
          >
            <SlidersHorizontal size={14} />
            {zh ? '比较设置' : 'Compare'}
          </Button>
        </div>
      </div>
      {showSettings && (
        <div className="portfolio-comparison-settings">
          <strong>{zh ? '同图显示的账户' : 'Accounts on this chart'}</strong>
          <div className="portfolio-account-checks">
            {series.map((item) => (
              <label key={item.accountId}>
                <input
                  type="checkbox"
                  checked={isSelected(item.accountId)}
                  onChange={() => toggle(item.accountId)}
                />
                {label(item)}
              </label>
            ))}
          </div>
          <p>
            {zh
              ? '金额包含资金转入转出。收益率仅在区间资金记录与资产起点保持连续时显示；每仓从该区间首个可信估值开始。不同账户的估值时点可能不同。'
              : 'Equity includes external transfers. Returns appear only with continuous cash-flow and balance records, starting at each account’s first trusted observation in the period. Valuation times can differ.'}
          </p>
        </div>
      )}
      {(referenceAvailable || reference) && (
        <div className="portfolio-reference-controls">
          <div className="shrink-0" role="group" aria-label={zh ? '曲线口径' : 'Chart basis'}>
            <Button
              size="sm"
              variant={reference ? 'default' : 'ghost'}
              aria-pressed={reference}
              onClick={() => setBasis('reference')}
            >
              {zh ? '持仓回看' : 'Current holdings lookback'}
            </Button>
            <Button
              size="sm"
              variant={!reference ? 'default' : 'ghost'}
              aria-pressed={!reference}
              onClick={() => setBasis('records')}
            >
              {zh ? '账户记录' : 'Account records'}
            </Button>
          </div>
          <p className="portfolio-valuation-time">
            {reference
              ? zh
                ? '按当前持仓数量回看有来源行情 · 不含现金、交易与分红，不代表实际投资收益'
                : 'Today’s quantities at sourced historical prices or saved quotes · Excludes cash, trades and dividends; not your realized investment return'
              : zh
                ? '账户当时保存的资产记录；资料连续时才计算收益率'
                : 'Assets saved at the time; returns require continuous records'}
          </p>
        </div>
      )}
      <div className="portfolio-legend">
        {series.map((item) => (
          <button
            key={item.accountId}
            type="button"
            aria-pressed={isSelected(item.accountId)}
            className={isSelected(item.accountId) ? '' : 'muted'}
            onClick={() => toggle(item.accountId)}
          >
            <span
              className="portfolio-color-dot"
              style={{
                background: accountColor(item.accountId, item.colorIndex),
              }}
            />
            <span className="min-w-0 break-words">
              {label(item)}
              {partialReferences.some(
                (row) => row.account.accountId === item.accountId,
              )
                ? zh
                  ? ' · 部分持仓'
                  : ' · Partial holdings'
                : ''}
            </span>
            <span className="portfolio-legend-value whitespace-nowrap">
              {metric === 'equity'
                ? money(
                    reference
                      ? chartSeries.find(
                          (row) => row.accountId === item.accountId,
                        )?.equityUsd
                      : currentAccountValue(item),
                  )
                : percentage(item.returnPct)}
            </span>
          </button>
        ))}
      </div>
      {partialReferences.length > 0 && (
        <div className="portfolio-notice" role="note">
          <span>
            {zh ? '部分持仓参考线：' : 'Partial holdings lookback: '}
            {partialReferences
              .map(
                (item) =>
                  `${label(item.account)} ${item.covered}/${item.total} ${zh ? '个标的' : 'positions'}${item.missingTickers.length ? ` (${zh ? '未计入' : 'excludes '}${item.missingTickers.join(', ')})` : ''}`,
              )
              .join(' · ')}
            {zh
              ? '。仅包含整个区间可一致核对的持仓；未覆盖项不计入曲线，账户金额仍按当前可用资料显示。'
              : '. Only a consistent covered set is plotted. Missing holdings are excluded from the line; account figures retain their current coverage.'}
          </span>
        </div>
      )}
      {history.data?.refreshing && (
        <p role="status" className="portfolio-valuation-time">
          {zh
            ? '正在后台补齐历史行情，当前账户金额可先查看…'
            : 'Completing historical prices in the background. Current account values are already available…'}
        </p>
      )}
      {history.isError && (
        <p className="portfolio-valuation-time">
          {zh
            ? '历史行情暂时不可用，当前持仓与已存账户记录仍可查看。'
            : 'Historical prices are unavailable; current holdings and saved account records remain available.'}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void history.refetch()}
          >
            {zh ? '重试历史行情' : 'Retry history'}
          </Button>
        </p>
      )}
      <PortfolioComparisonChart
        series={chartSeries}
        metric={metric}
        compact={compact}
        reference={reference}
        historySeries={reference ? history.data?.series : undefined}
        partialAccountIds={partialReferences.map(
          (item) => item.account.accountId,
        )}
        granularity={comparison.data?.granularity}
        referenceGranularity={reference ? history.data?.intradayGranularity : undefined}
        onSelectAccount={(id) =>
          navigate(accountPath(id), { state: returnState })
        }
      />
      <div className="portfolio-chart-caption">
        <span className="min-w-0 leading-5">
          {reference
            ? zh
              ? 'USD · 当前持仓历史参考市值'
              : 'USD · Current-position historical reference'
            : zh
              ? 'USD · 保存的估值记录'
              : 'USD · Saved observations'}
          {' · '}{comparisonSamplingLabel(comparison.data?.granularity, zh, reference, history.data?.intradayGranularity)}
          {' · '}{metric === 'equity'
            ? (zh ? '浅色虚线连接缺失区间，不代表新增估值'
              : 'Dashed links mark missing intervals, not additional valuations')
            : (zh ? '缺少收益率或财务口径变化时断线' : 'Missing returns and financial discontinuities remain broken')}
        </span>
        <span className="shrink-0 leading-5">
          {zh ? '点选曲线进入对应账户' : 'Select a line to open its account'}
        </span>
      </div>
      {chartSeries.some((item) => item.gaps.length) && (
        <details className="portfolio-data-notes">
          <summary>
            <AlertCircle size={14} />
            {zh ? '估值与比较说明' : 'Valuation and comparison notes'}
          </summary>
          {chartSeries
            .filter((item) => item.gaps.length)
            .map((item) => (
              <p key={item.accountId}>
                <strong>{label(item)}：</strong>
                {[
                  ...new Set(
                    item.gaps.map((gap) => comparisonGapLabel(gap, zh)),
                  ),
                ].join(zh ? '；' : '; ')}
              </p>
            ))}
        </details>
      )}
      <TeamDecisionComparison accounts={selected.filter(item => item.kind === 'simulation').map(item => ({ accountId: item.accountId, name: item.name, createdAt: item.createdAt, strategyCount: item.strategyCount }))} teams={teams.data} teamsLoading={teams.isPending} teamsError={teams.isError} retryTeams={() => void teams.refetch()} zh={zh} returnState={returnState} />
      {showAccounts && (
        <section className="portfolio-account-section">
          <div className="portfolio-section-heading">
            <h2>{zh ? '我的账户' : 'My accounts'}</h2>
            <span>
              {zh
                ? `${series.filter((item) => item.kind === 'simulation').length} 个独立模拟仓`
                : `${series.filter((item) => item.kind === 'simulation').length} independent simulations`}
            </span>
          </div>
          <div className="portfolio-account-grid">
            {series.map((item) => (
              <div key={item.accountId} className="flex min-w-0 flex-col gap-2">
              <Link
                className="portfolio-account-card flex-1"
                key={item.accountId}
                to={accountPath(item.accountId)}
                state={returnState}
              >
                {item.kind === 'simulation' && (
                  <CompanionIdentity
                    id={
                      accountDetails.data?.find(
                        (account) => account.id === item.accountId,
                      )?.companionId
                    }
                    zh={zh}
                    compact
                  />
                )}
                {item.kind === 'simulation' && <small className="text-muted-foreground">{teams.isPending ? (zh ? '正在读取团队…' : 'Loading team…') : teams.isError ? (zh ? '团队归属暂不可用' : 'Team identity unavailable') : teamFor(item.accountId)?.name ?? (zh ? '未绑定团队' : 'No team linked')}</small>}
                {item.kind === 'simulation' && <small className="text-muted-foreground">{teamResearchStatus(teams.isPending || teams.isError ? undefined : teamFor(item.accountId)?.runningCommissionCount, zh)}</small>}
                <div className="portfolio-account-card-heading">
                  <span>
                    <i
                      className="portfolio-color-dot"
                      style={{
                        background: accountColor(
                          item.accountId,
                          item.colorIndex,
                        ),
                      }}
                    />
                    {label(item)}
                  </span>
                  <small>
                    {item.kind === 'real'
                      ? zh
                        ? '实仓'
                        : 'Real'
                      : zh
                        ? '模拟'
                        : 'Simulation'}
                  </small>
                </div>
                <strong className="portfolio-account-value">
                  {money(currentAccountValue(item))}
                </strong>
                {currentAccountValue(item) == null && <small className="text-muted-foreground">{zh ? '暂无法完整估值' : 'Complete valuation unavailable'}</small>}
                <small className="portfolio-performance-asof">
                  {currentAccountBasis(item, zh)}
                </small>
                <p
                  className={
                    item.returnPct == null
                      ? 'text-muted-foreground'
                      : item.returnPct >= 0
                        ? 'text-success'
                        : 'text-destructive'
                  }
                >
                  {zh ? '账户记录收益：' : 'Recorded return: '}
                  {item.returnPct === null && item.points.filter(point => point.equityUsd !== null).length < 2 ? (zh ? '历史不足' : 'Insufficient history') : percentage(item.returnPct)}{' '}
                  <small>
                    {item.returnFrom
                      ? `${zh ? '自' : 'from'} ${new Date(item.returnFrom).toLocaleDateString(zh ? 'zh-CN' : 'en-US')}`
                      : ''}
                  </small>
                </p>
                <div className="portfolio-account-card-footer">
                  <span
                    className={item.status === 'running' ? 'text-success' : ''}
                  >
                    {item.status === 'running' && <Check size={12} />}
                    {item.kind === 'simulation' ? (zh ? '模拟执行 · ' : 'Simulation execution · ') : ''}{status(item.status)}
                    {item.kind === 'simulation' &&
                      ` · ${item.strategyCount} ${zh ? '个策略' : 'strategies'}`}
                  </span>
                  <span>
                    {zh ? '查看资产' : 'View assets'} <ArrowRight size={14} />
                  </span>
                </div>
              </Link>
              {item.kind === 'simulation' && <Link className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-primary" to={teamFor(item.accountId) ? `/teams/${encodeURIComponent(teamFor(item.accountId)!.id)}` : '/teams'} state={returnState}>{teamFor(item.accountId) ? (zh ? '团队与研究记录' : 'Team & research records') : (zh ? '关联团队' : 'Link a team')} <ArrowRight size={12} /></Link>}
              </div>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
