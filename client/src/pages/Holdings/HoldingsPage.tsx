/**
 * @file pages/Holdings/HoldingsPage.tsx
 * @description Route `/holdings`: list, filter, sort and manage open positions.
 *
 * Composes the holdings table (desktop), mobile card list, detail dialog, add
 * dialog, and the AI run-detail modal. Subscribes to live quotes via
 * `useMarketQuotes`, enriches each row with derived market value / P/L, and
 * supports search, group filter, multi-market filter, and column sorting.
 */
import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Briefcase,
  Search,
  Plus,
  RefreshCw,
  Check,
  AlertTriangle,
} from 'lucide-react';
import type {
  Holding,
  Group,
  QuoteResponse,
  Market,
  CashAccount,
  Currency,
  DashboardOverview,
  LatestRating,
} from '@shared/api.interface';
import { fetchHoldings, fetchGroups, fetchCashAccounts, fetchDashboard, getLatestRatings } from '@/api';
import { useMarketQuotes } from '@/hooks/use-market-quotes';
import {
  formatCurrencyWithCode,
  formatCurrencyWithCurrency,
  formatPriceWithCurrency,
  formatShares,
  plClass,
  cn,
} from '@/utils/format';
import { Button } from '@/components/ui/button';
import { MarketStatusBadges } from '@/components/MarketStatusBadges';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import HoldingDetailDialog from './HoldingDetailDialog';
import AddHoldingDialog from './AddHoldingDialog';
import HoldingsMobileList from './HoldingsMobileList';
import HoldingsTable from './HoldingsTable';
import AddTransactionDialog from '@/pages/Transactions/AddTransactionDialog';
import CashBalanceDialog from '@/pages/Today/CashBalanceDialog';
import AgentRunDetailModal from '@/components/MultiAgent/AgentRunDetailModal';
import {
  Alert,
  AlertDescription,
} from '@/components/ui/alert';

import { useTranslation } from 'react-i18next';
import { Link, useNavigationType, useSearchParams } from 'react-router-dom';
import { AccountAssetsPage } from '@/features/assets/AccountAssetsPage';
import { assetHref, SIMULATION_ACCOUNTS_PATH } from '@/features/assets/account-context';
import { formatComparisonTime } from '@/features/portfolio-comparison/comparison-chart-options';

/** Columns that the holdings table can sort by. */
const sortKeys = ['ticker', 'company', 'buyPrice', 'currentPrice', 'shares', 'marketValue', 'cost', 'pl', 'returnPct'] as const;
type SortKey = typeof sortKeys[number];
const markets: Market[] = ['US', 'HK', 'CN'];
const currencies: Currency[] = ['CNY', 'USD', 'HKD'];

/** Holding record augmented with derived numeric values used by the table. */
interface DerivedHolding extends Holding {
  marketValue: number;
  cost: number;
  pl: number;
  returnPct: number;
}

function isNumeric(value: string | null | undefined): value is string {
  return value != null && value.trim() !== '' && Number.isFinite(Number(value));
}

function RealPositionsTable({ holdings, allHoldings, quotes, cashAccounts, sortKey, sortDir, onSort, onDetail }: {
  holdings: DerivedHolding[];
  allHoldings: DerivedHolding[];
  quotes: Record<string, QuoteResponse | undefined>;
  cashAccounts: CashAccount[];
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
  onDetail: (holding: DerivedHolding) => void;
}) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const headers: { label: string; sort?: SortKey }[] = [
    { label: zh ? '标的 / 代码' : 'Name / ticker', sort: 'ticker' },
    { label: zh ? '市场' : 'Market' },
    { label: zh ? '持有数量' : 'Quantity', sort: 'shares' },
    { label: zh ? '平均成本' : 'Average cost', sort: 'buyPrice' },
    { label: zh ? '最新价' : 'Latest price', sort: 'currentPrice' },
    { label: zh ? '市值' : 'Market value', sort: 'marketValue' },
    { label: zh ? '浮动盈亏' : 'Unrealized P/L', sort: 'pl' },
    { label: zh ? '仓位占比' : 'Portfolio weight' },
    { label: zh ? '报价时间' : 'Quote time' },
  ];
  const portfolioCurrency = allHoldings[0]?.currency;
  const completeCash = currencies.every(currency => cashAccounts.some(cash =>
    cash.currency === currency && cash.reconciliationStatus === 'confirmed' && isNumeric(cash.balance)
    && (currency === portfolioCurrency || Number(cash.balance) === 0)));
  const equity = completeCash && allHoldings.every(holding =>
    holding.currency === portfolioCurrency && isNumeric(holding.currentPrice) && isNumeric(holding.shares))
    ? allHoldings.reduce((sum, holding) => sum + holding.marketValue, 0)
      + Number(cashAccounts.find(cash => cash.currency === portfolioCurrency)?.balance)
    : null;
  const percent = new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 1 });

  return <>
    <div className="max-w-full overflow-x-auto focus-visible:outline focus-visible:outline-ring"
      tabIndex={0} role="region" aria-label={zh ? '持仓明细表，可横向滚动' : 'Position details table, scrollable horizontally'}>
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/60 text-xs">
          <tr>{headers.map(({ label, sort }) => <th key={label} scope="col" className="whitespace-nowrap px-3 py-2.5 font-medium"
            aria-sort={sort && sort === sortKey ? sortDir === 'asc' ? 'ascending' : 'descending' : undefined}>
            {sort ? <button type="button" className="inline-flex items-center gap-1 hover:underline" onClick={() => onSort(sort)}>
              {label}{sort === sortKey && <span aria-hidden="true">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            </button> : label}
          </th>)}</tr>
        </thead>
        <tbody>{holdings.map(holding => {
          const { ticker, company, currency, market, shares, buyPrice, currentPrice, marketValue, pl } = holding;
          const quote = quotes[ticker];
          const quoteAt = quote?.currency === currency && isNumeric(quote.price) && quote.quoteAt
            && Number.isFinite(Date.parse(quote.quoteAt)) ? quote.quoteAt : null;
          const hasValue = isNumeric(currentPrice) && isNumeric(shares) && Number.isFinite(marketValue);
          const hasProfit = hasValue && isNumeric(buyPrice) && Number.isFinite(pl);
          const symbol = holding.displaySymbol || ticker;
          return <tr key={holding.id} className="border-t">
            <th scope="row" className="min-w-32 px-3 py-2.5 font-medium">
              <button type="button" className="min-h-8 text-left [overflow-wrap:anywhere] hover:underline" onClick={() => onDetail(holding)}>
                {company && <>{company}{' · '}</>}{symbol}
              </button>
            </th>
            <td className="whitespace-nowrap px-3 py-2.5">{t(market === 'CN' ? 'dash.cn' : market === 'HK' ? 'dash.hk' : 'dash.us')}</td>
            <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{isNumeric(shares) ? formatShares(shares) : '—'}</td>
            <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{isNumeric(buyPrice) ? formatPriceWithCurrency(buyPrice, currency) : '—'}</td>
            <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{isNumeric(currentPrice) ? formatPriceWithCurrency(currentPrice, currency) : '—'}</td>
            <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{hasValue ? formatCurrencyWithCurrency(marketValue, currency) : '—'}</td>
            <td className={cn('whitespace-nowrap px-3 py-2.5 tabular-nums', hasProfit && plClass(pl))}>
              {hasProfit ? (pl > 0 ? '+' : '') + formatCurrencyWithCurrency(pl, currency) : '—'}
            </td>
            <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{equity !== null && equity > 0 && hasValue
              ? percent.format(marketValue / equity) : '—'}</td>
            <td className="whitespace-nowrap px-3 py-2.5 text-xs">
              {quoteAt ? <time dateTime={quoteAt}>{formatComparisonTime(quoteAt, i18n.language)}</time>
                : isNumeric(currentPrice) ? '—' : zh ? '暂无报价' : 'No quote'}
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p className="border-t px-3 py-2 text-xs text-muted-foreground">
      {zh ? '— 表示该项数据暂缺。' : 'A dash indicates unavailable data.'}
      <span className="ml-2 md:hidden">{zh ? '横向滑动查看全部列。' : 'Scroll horizontally to see all columns.'}</span>
    </p>
  </>;
}

/**
 * Compute derived market value, cost, P/L and return % from a raw holding.
 * @param h - Raw holding with string-encoded numeric fields.
 * @returns The holding with numeric derived fields attached.
 */
function computeDerived(h: Holding): DerivedHolding {
  const shares = parseFloat(h.shares || '0');
  const buyPrice = parseFloat(h.buyPrice || '0');
  const currentPrice = parseFloat(h.currentPrice || '0');
  const marketValue = shares * currentPrice;
  const cost = shares * buyPrice;
  const pl = marketValue - cost;
  const returnPct = cost > 0 ? (pl / cost) * 100 : 0;
  return { ...h, marketValue, cost, pl, returnPct };
}

/**
 * Holdings list page.
 *
 * State groups: raw holdings/groups/cash/overview, filter/sort controls,
 * selected holding for the detail dialog, add-dialog open state, market
 * multi-select and AI ratings.
 */
export default function HoldingsPage() {
  return <AccountAssetsPage mode="holdings" real={<RealHoldingsPage />}
    renderRealHoldings={context => <RealHoldingsPage ledger={context} />} />;
}

function RealHoldingsPage({ ledger }: { ledger?: { accountSelector: ReactNode; importPath: string; returnTo: string } }) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [accountParams, setAccountParams] = useSearchParams();
  const [holdings, setHoldings] = useState<DerivedHolding[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLoadedHoldings, setHasLoadedHoldings] = useState(false);
  const loadRevision = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const navigationType = useNavigationType();
  const urlSearch = accountParams.get('q') ?? '';
  const [search, setSearch] = useState(urlSearch);
  useEffect(() => {
    if (navigationType !== 'REPLACE') setSearch(urlSearch);
  }, [navigationType, urlSearch]);
  const groupId = accountParams.get('group') ?? '';
  const currencyFilter = accountParams.get('currency');
  const sortKey = sortKeys.find(key => key === accountParams.get('sort')) ?? 'marketValue';
  const sortDir = accountParams.get('direction') === 'asc' ? 'asc' : 'desc';
  const [detailOpen, setDetailOpen] = useState(false);
  const [selected, setSelected] = useState<Holding | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [tradeOpen, setTradeOpen] = useState(false);
  const [cashOpen, setCashOpen] = useState(false);
  const marketFilter = accountParams.get('markets');
  const selectedMarkets = useMemo(() => {
    const selected = marketFilter?.split(',');
    return new Set(selected ? markets.filter(market => selected.includes(market)) : markets);
  }, [marketFilter]);
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([]);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [aiRatings, setAiRatings] = useState<Record<string, LatestRating>>({});
  const [aiDetailRunId, setAiDetailRunId] = useState<string | null>(null);
  const [aiDetailOpen, setAiDetailOpen] = useState(false);

  function updateFilters(changes: Record<string, string | null>) {
    const next = new URLSearchParams(accountParams);
    next.set('accountId', 'real');
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key); else next.set(key, value);
    }
    setAccountParams(next, { replace: true });
  }

  const tickers = useMemo(
    () => holdings.map((h) => h.ticker),
    [holdings]
  );

  const { quotes, marketStatus, marketErrors, lastUpdated, refresh: refreshQuotes } = useMarketQuotes(tickers);

  /**
   * Load the latest published AI ratings for all tickers. Failures are silent
   * because ratings are an enhancement, not required for the list to render.
   */
  const loadAiRatings = async () => {
    try {
      const result = await getLatestRatings();
      const items = (result?.items ?? []) as LatestRating[];
      const map: Record<string, LatestRating> = {};
      for (const r of items) {
        map[r.ticker] = r;
      }
      setAiRatings(map);
    } catch (err) {
      // 静默失败，不影响主流程
    }
  };

  /** Show saved positions immediately; quotes, FX totals and labels load independently. */
  const loadData = async () => {
    const revision = ++loadRevision.current;
    const isCurrent = () => revision === loadRevision.current;
    setLoading(true);
    setError(null);

    // Supplemental failures keep the last successful values and never block rows.
    void fetchGroups().then((groups) => {
      if (isCurrent()) setGroups(groups);
    }).catch(() => {});
    void fetchCashAccounts().then((cash) => {
      if (isCurrent()) setCashAccounts(cash);
    }).catch(() => {});
    if (!ledger) void fetchDashboard('USD').then((dashboard) => {
      if (isCurrent()) setOverview(dashboard);
    }).catch(() => {});

    try {
      const savedHoldings = await fetchHoldings();
      if (!isCurrent()) return;
      setHoldings(savedHoldings.map(computeDerived));
      setHasLoadedHoldings(true);
    } catch (err) {
      if (!isCurrent()) return;
      setError(t('common.failed'));
      toast.error(t('common.failed'));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  /** Open the AI run-detail modal for a given ticker's latest run. */
  const handleViewAiAnalysis = (ticker: string, runId: string) => {
    setAiDetailRunId(runId);
    setAiDetailOpen(true);
  };

  /** Open the AI run-detail modal for a specific run id. */
  const handleViewFullAnalysis = (runId: string) => {
    setAiDetailRunId(runId);
    setAiDetailOpen(true);
  };

  useEffect(() => {
    loadData();
    loadAiRatings();
    const handleUpdate = () => {
      loadData();
      loadAiRatings();
    };
    window.addEventListener('portfolio-updated', handleUpdate);
    return () => {
      ++loadRevision.current;
      window.removeEventListener('portfolio-updated', handleUpdate);
    };
  }, []);

  /** Toggle sort on a column; switches direction when clicking the same column. */
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      updateFilters({ sort: key, direction: sortDir === 'asc' ? 'desc' : 'asc' });
    } else {
      const descKeys: SortKey[] = [
        'marketValue',
        'cost',
        'pl',
        'returnPct',
        'shares',
        'currentPrice',
        'buyPrice',
      ];
      updateFilters({ sort: key, direction: descKeys.includes(key) ? 'desc' : 'asc' });
    }
  };

  /**
   * Re-derive market value / P/L using the latest live quote price, overriding
   * the stored `currentPrice`. Falls back to the stored price when no quote.
   */
  const enrichedHoldings = useMemo<DerivedHolding[]>(() => {
    return holdings.map((h) => {
      const q: QuoteResponse | undefined = quotes[h.ticker];
      if (!q || q.currency !== h.currency || !isNumeric(q.price)) return h;
      const quotePrice = Number(q.price);
      const shares = parseFloat(h.shares || '0');
      const buyPrice = parseFloat(h.buyPrice || '0');
      const marketValue = shares * quotePrice;
      const cost = shares * buyPrice;
      const pl = marketValue - cost;
      const returnPct = cost > 0 ? (pl / cost) * 100 : 0;
      return { ...h, currentPrice: String(quotePrice), marketValue, cost, pl, returnPct };
    });
  }, [holdings, quotes]);

  /** Apply search, group filter and market filter, then sort by the active column. */
  const filtered = useMemo(() => {
    let list = [...enrichedHoldings];
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (h) =>
          h.ticker.toLowerCase().includes(q) ||
          (h.company ?? '').toLowerCase().includes(q)
      );
    }
    if (groupId) {
      list = list.filter((h) => h.groupId === groupId);
    }
    if (ledger && currencies.some(currency => currency === currencyFilter)) {
      list = list.filter(holding => holding.currency === currencyFilter);
    }
    if (selectedMarkets.size > 0) {
      list = list.filter((h) => selectedMarkets.has(h.market));
    }
    list.sort((a, b) => {
      const va = (a as unknown as Record<string, unknown>)[sortKey];
      const vb = (b as unknown as Record<string, unknown>)[sortKey];
      let cmp: number;
      if (['shares', 'buyPrice', 'currentPrice'].includes(sortKey)) {
        const na = va === null || va === undefined || va === '' ? NaN : Number(va);
        const nb = vb === null || vb === undefined || vb === '' ? NaN : Number(vb);
        if (!Number.isFinite(na)) return Number.isFinite(nb) ? 1 : 0;
        if (!Number.isFinite(nb)) return -1;
        cmp = na - nb;
      } else if (typeof va === 'number' && typeof vb === 'number') {
        cmp = va - vb;
      } else {
        cmp = String(va ?? '').localeCompare(String(vb ?? ''));
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [enrichedHoldings, search, groupId, currencyFilter, ledger, selectedMarkets, sortKey, sortDir]);

  /** Open the holding detail dialog for the given row. */
  const openDetail = (h: DerivedHolding) => {
    setSelected(h);
    setDetailOpen(true);
  };

  const totalMv = overview ? parseFloat(overview.totalMv || '0') : 0;
  const totalPl = overview ? parseFloat(overview.totalPl || '0') : 0;
  const displayCurrency = overview?.baseCurrency ?? 'USD';

  const details = <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl md:text-3xl font-semibold tracking-tight flex items-center gap-2.5">
            <Briefcase className="size-6 text-primary" />
            {t('holdings.title')}
          </h1>
          <div className="text-sm text-muted-foreground mt-1 flex items-center flex-wrap gap-1.5">
            <MarketStatusBadges
              marketStatus={marketStatus}
              marketErrors={marketErrors}
              lastUpdated={lastUpdated}
            />
            <span className="mx-1">·</span>
            {t('ui.holdings.summaryCount', { count: filtered.length })}{' '}
            <span className="font-mono-nums">
              {overview ? formatCurrencyWithCode(totalMv, displayCurrency) : '—'}
            </span>{' '}
            · {t('ui.holdings.floatingPl')}{' '}
            <span
              className={cn(
                'font-mono-nums font-medium',
                overview && plClass(totalPl)
              )}
            >
              {overview ? formatCurrencyWithCode(totalPl, displayCurrency) : '—'}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              refreshQuotes();
              loadData();
            }}
            disabled={loading}
          >
            <RefreshCw
              className={cn('size-4', loading && 'animate-spin')}
            />
            {t('ui.tx.refresh')}
          </Button>
            <Button variant="outline" size="sm" asChild><Link to={SIMULATION_ACCOUNTS_PATH + '?seedReal=1'}>{i18n.language.startsWith('en') ? 'Copy to simulation' : '复制到模拟盘'}</Link></Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            {t('holdings.addHolding')}
          </Button>
        </div>
      </div>

      {/* Market Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        {markets.map((m) => {
          const labels: Record<Market, string> = {
            US: t('dash.us'),
            HK: t('dash.hk'),
            CN: t('dash.cn'),
          };
          const active = selectedMarkets.has(m);
          return (
            <Button
              key={m}
              type="button"
              size="sm"
              variant={active ? 'default' : 'outline'}
              aria-pressed={active}
              onClick={() => {
                const next = new Set(selectedMarkets);
                if (next.has(m)) next.delete(m); else next.add(m);
                updateFilters({ markets: [...next].join(',') });
              }}
            >
              {active && <Check className="size-3" />}
              {labels[m]}
            </Button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder={t('ui.holdings.searchPlaceholder')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              updateFilters({ q: e.target.value || null });
            }}
            className="pl-9"
          />
        </div>
        <div className="sm:w-48">
          <Select value={groupId || '__all__'} onValueChange={value => updateFilters({ group: value === '__all__' ? null : value })}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('ui.holdings.allGroups')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('ui.holdings.allGroups')}</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Desktop Table */}
      <HoldingsTable
        loading={loading && !hasLoadedHoldings}
        error={hasLoadedHoldings ? null : error}
        holdings={filtered}
        groups={groups}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        onAdd={() => setAddOpen(true)}
        onDetail={openDetail}
        cashAccounts={cashAccounts}
        aiRatings={aiRatings}
        onViewAiAnalysis={handleViewAiAnalysis}
      />

      {/* Mobile Cards */}
      <HoldingsMobileList
        loading={loading && !hasLoadedHoldings}
        error={hasLoadedHoldings ? null : error}
        holdings={filtered}
        groups={groups}
        onAdd={() => setAddOpen(true)}
        onDetail={openDetail}
        aiRatings={aiRatings}
        onViewAiAnalysis={handleViewAiAnalysis}
      />

    </div>;

  const updatedAt = holdings.reduce<string | null>((latest, holding) =>
    Number.isFinite(Date.parse(holding.updatedAt)) && (!latest || Date.parse(holding.updatedAt) > Date.parse(latest))
      ? holding.updatedAt : latest, null);

  return (
    <div className="space-y-5">
      {hasLoadedHoldings && error && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {ledger ? <>
        <header className="space-y-2 border-b pb-4">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[32px]">{zh ? '我的实仓' : 'My real portfolio'}</h1>
          <p className="text-sm text-muted-foreground">
            {zh ? '实仓账本' : 'Real account ledger'}
            {updatedAt && <> · {zh ? '持仓记录截至 ' : 'Positions updated '}
              <time dateTime={updatedAt}>{formatComparisonTime(updatedAt, i18n.language)}</time>
              {' '}{zh ? '北京时间' : 'Beijing time'}</>}
          </p>
        </header>

        <div className="flex min-w-0 flex-wrap items-start gap-2">
          {ledger.accountSelector}
          <label className="flex min-h-9 items-center gap-2 rounded-md border bg-card px-2 text-sm">
            {zh ? '市场' : 'Market'}
            <select className="max-w-full bg-transparent" value={selectedMarkets.size === 1 ? [...selectedMarkets][0] : selectedMarkets.size === 2 ? 'custom' : 'all'}
              onChange={event => updateFilters({ markets: event.target.value === 'all' ? null : event.target.value })}>
              <option value="all">{zh ? '全部' : 'All'}</option>
              {selectedMarkets.size === 2 && <option value="custom" disabled>{zh ? '多个市场' : 'Multiple markets'}</option>}
              {markets.map(market => <option key={market} value={market}>{t(market === 'CN' ? 'dash.cn' : market === 'HK' ? 'dash.hk' : 'dash.us')}</option>)}
            </select>
          </label>
          <label className="flex min-h-9 items-center gap-2 rounded-md border bg-card px-2 text-sm">
            {zh ? '币种' : 'Currency'}
            <select className="max-w-full bg-transparent" value={currencyFilter ?? 'all'}
              onChange={event => updateFilters({ currency: event.target.value === 'all' ? null : event.target.value })}>
              <option value="all">{zh ? '全部' : 'All'}</option>
              {currencies.map(currency => <option key={currency} value={currency}>{currency}</option>)}
            </select>
          </label>
          <Input className="w-full sm:w-48" placeholder={t('ui.holdings.searchPlaceholder')}
            aria-label={zh ? '搜索名称或代码' : 'Search name or ticker'} value={search}
            onChange={event => {
              setSearch(event.target.value);
              updateFilters({ q: event.target.value || null });
            }} />
          {(groups.length > 0 || groupId) && <Select value={groupId || '__all__'}
            onValueChange={value => updateFilters({ group: value === '__all__' ? null : value })}>
            <SelectTrigger aria-label={t('ui.holdings.allGroups')} className="w-auto max-w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('ui.holdings.allGroups')}</SelectItem>
              {groups.map(group => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
            </SelectContent>
          </Select>}
          <Button type="button" variant="outline" onClick={() => {
            setSearch('');
            updateFilters({ markets: null, currency: null, q: null, group: null, sort: null, direction: null });
          }}>{zh ? '重置' : 'Reset'}</Button>
        </div>

        <section className="min-w-0 overflow-hidden rounded-xl border bg-card" aria-labelledby="real-holdings-heading">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <h2 id="real-holdings-heading" className="font-semibold">{zh ? '持仓明细' : 'Position details'}</h2>
            {hasLoadedHoldings && <p className="text-xs text-muted-foreground">{zh ? `${filtered.length} 项持仓` : `${filtered.length} positions`}</p>}
          </div>
          {loading && !hasLoadedHoldings ? <p role="status" className="px-4 pb-4 text-sm text-muted-foreground">{t('common.loading')}</p>
            : !hasLoadedHoldings && error ? <div className="flex flex-wrap items-center gap-3 px-4 pb-4">
              <p role="alert" className="text-sm text-destructive">{error}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void loadData()}>{t('common.retry')}</Button>
            </div>
            : filtered.length ? <RealPositionsTable holdings={filtered} allHoldings={enrichedHoldings} quotes={quotes}
              cashAccounts={cashAccounts} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} onDetail={openDetail} />
            : <p className="px-4 pb-4 text-sm text-muted-foreground">{t(holdings.length ? 'assets.noMatchingHoldings' : 'holdings.noHoldings')}</p>}
        </section>

        <section className="rounded-xl border bg-card p-4" aria-labelledby="real-cash-heading">
          <h2 id="real-cash-heading" className="font-semibold">{zh ? '现金余额' : 'Cash balances'}</h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            {currencies.map(currency => {
              const cash = cashAccounts.find(account => account.currency === currency);
              return <div key={currency} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                <dt className="text-muted-foreground">{new Intl.DisplayNames(i18n.language, { type: 'currency' }).of(currency)}</dt>
                <dd className="break-words font-medium tabular-nums">{cash && cash.reconciliationStatus !== 'review'
                  && cash.reconciliationStatus !== 'unconfirmed' && isNumeric(cash.balance)
                  ? formatCurrencyWithCurrency(cash.balance, currency) : '—'}</dd>
              </div>;
            })}
          </dl>
        </section>

        <section className="rounded-xl border bg-card p-4" aria-labelledby="real-ledger-actions-heading">
          <h2 id="real-ledger-actions-heading" className="font-semibold">{zh ? '账本操作' : 'Ledger actions'}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild size="sm"><Link to={ledger.importPath} state={{ returnTo: ledger.returnTo }}>{zh ? '导入持仓' : 'Import holdings'}</Link></Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setTradeOpen(true)}>{zh ? '录入交易' : 'Record a trade'}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setCashOpen(true)}>{zh ? '调整现金' : 'Adjust cash'}</Button>
            <Button asChild size="sm" variant="outline"><Link to={assetHref('/transactions', 'real')} state={{ returnTo: ledger.returnTo }}>{zh ? '查看操作记录' : 'View ledger activity'}</Link></Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1">
            <Button size="sm" variant="ghost" onClick={() => setAddOpen(true)}>{t('holdings.addHolding')}</Button>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => { refreshQuotes(); void loadData(); }}>{t('ui.tx.refresh')}</Button>
            <Button asChild size="sm" variant="ghost"><Link to={SIMULATION_ACCOUNTS_PATH + '?seedReal=1'}>{zh ? '复制到模拟盘' : 'Copy to simulation'}</Link></Button>
            <Button asChild size="sm" variant="ghost"><Link to={assetHref('/watchlist', 'real', new URLSearchParams({ returnTo: ledger.returnTo }).toString())}>{t('assets.watchlist')}</Link></Button>
          </div>
        </section>
        <AddTransactionDialog open={tradeOpen} onOpenChange={setTradeOpen}
          onCreated={() => window.dispatchEvent(new CustomEvent('portfolio-updated'))} />
        <CashBalanceDialog open={cashOpen} onClose={() => { setCashOpen(false); void loadData(); }} />
      </> : details}

      <HoldingDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        holding={selected}
        groups={groups}
        onUpdated={loadData}
        onDeleted={loadData}
        aiRating={selected ? aiRatings[selected.ticker] ?? null : null}
        onViewFullAnalysis={handleViewFullAnalysis}
      />

      <AgentRunDetailModal
        open={aiDetailOpen}
        onOpenChange={setAiDetailOpen}
        runId={aiDetailRunId}
      />

      <AddHoldingDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        groups={groups}
        onCreated={loadData}
        onGroupsChanged={loadData}
      />
    </div>
  );
}
