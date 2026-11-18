/**
 * @file pages/Holdings/HoldingsPage.tsx
 * @description Route `/holdings`: list, filter, sort and manage open positions.
 *
 * Composes the holdings table (desktop), mobile card list, detail dialog, add
 * dialog, and the AI run-detail modal. Subscribes to live quotes via
 * `useMarketQuotes`, enriches each row with derived market value / P/L, and
 * supports search, group filter, multi-market filter, and column sorting.
 */
import { useState, useEffect, useMemo, useRef } from 'react';
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
import AgentRunDetailModal from '@/components/MultiAgent/AgentRunDetailModal';
import {
  Alert,
  AlertDescription,
} from '@/components/ui/alert';

import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { AccountAssetsPage } from '@/features/assets/AccountAssetsPage';
import { SIMULATION_ACCOUNTS_PATH } from '@/features/assets/account-context';
import { formatComparisonTime } from '@/features/portfolio-comparison/comparison-chart-options';
import { useSimpleExperience } from '@/hooks/use-simple-experience';

/** Columns that the holdings table can sort by. */
type SortKey =
  | 'ticker'
  | 'company'
  | 'buyPrice'
  | 'currentPrice'
  | 'shares'
  | 'marketValue'
  | 'cost'
  | 'pl'
  | 'returnPct';

/** Holding record augmented with derived numeric values used by the table. */
interface DerivedHolding extends Holding {
  marketValue: number;
  cost: number;
  pl: number;
  returnPct: number;
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
  return <AccountAssetsPage mode="holdings" real={<RealHoldingsPage />} />;
}

function RealHoldingsPage() {
  const { t, i18n } = useTranslation();
  const { enabled: simple } = useSimpleExperience();
  const zh = i18n.language.startsWith('zh');
  const [accountParams, setAccountParams] = useSearchParams();
  const [holdings, setHoldings] = useState<DerivedHolding[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLoadedHoldings, setHasLoadedHoldings] = useState(false);
  const loadRevision = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(() => accountParams.get('q') ?? '');
  const [groupId, setGroupId] = useState(() => accountParams.get('group') ?? '');
  const [sortKey, setSortKey] = useState<SortKey>(() => { const value = accountParams.get('sort'); return ['ticker', 'company', 'buyPrice', 'currentPrice', 'shares', 'marketValue', 'cost', 'pl', 'returnPct'].includes(value ?? '') ? value as SortKey : 'marketValue'; });
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(() => accountParams.get('direction') === 'asc' ? 'asc' : 'desc');
  const [detailOpen, setDetailOpen] = useState(false);
  const [selected, setSelected] = useState<Holding | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedMarkets, setSelectedMarkets] = useState<Set<Market>>(
    new Set((accountParams.has('markets') ? (accountParams.get('markets') ?? '').split(',').filter(value => ['US', 'HK', 'CN'].includes(value)) : ['US', 'HK', 'CN']) as Market[])
  );
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([]);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [aiRatings, setAiRatings] = useState<Record<string, LatestRating>>({});
  const [aiDetailRunId, setAiDetailRunId] = useState<string | null>(null);
  const [aiDetailOpen, setAiDetailOpen] = useState(false);

  useEffect(() => {
    const next = new URLSearchParams(accountParams);
    next.set('accountId', 'real');
    for (const [key, value] of Object.entries({ q: search, group: groupId, sort: sortKey, direction: sortDir, markets: [...selectedMarkets].join(',') })) {
      if (value) next.set(key, value); else next.delete(key);
    }
    if (next.toString() !== accountParams.toString()) setAccountParams(next, { replace: true });
  }, [search, groupId, sortKey, sortDir, selectedMarkets]);

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
    void fetchDashboard('USD').then((dashboard) => {
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
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      const descKeys: SortKey[] = [
        'marketValue',
        'cost',
        'pl',
        'returnPct',
        'shares',
        'currentPrice',
        'buyPrice',
      ] as SortKey[];
      setSortDir(descKeys.includes(key) ? 'desc' : 'asc');
    }
  };

  /**
   * Re-derive market value / P/L using the latest live quote price, overriding
   * the stored `currentPrice`. Falls back to the stored price when no quote.
   */
  const enrichedHoldings = useMemo<DerivedHolding[]>(() => {
    return holdings.map((h) => {
      const q: QuoteResponse | undefined = quotes[h.ticker];
      if (!q || q.price === undefined) return h;
      const quotePrice = parseFloat(q.price);
      if (isNaN(quotePrice)) return h;
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
  }, [enrichedHoldings, search, groupId, selectedMarkets, sortKey, sortDir]);

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
          {!simple && <h1 className="font-serif text-2xl md:text-3xl font-semibold tracking-tight flex items-center gap-2.5">
            <Briefcase className="size-6 text-primary" />
            {t('holdings.title')}
          </h1>}
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
        {(['US', 'HK', 'CN'] as Market[]).map((m) => {
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
                setSelectedMarkets((prev) => {
                  const next = new Set(prev);
                  if (next.has(m)) {
                    next.delete(m);
                  } else {
                    next.add(m);
                  }
                  return next;
                });
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
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="sm:w-48">
          <Select value={groupId || '__all__'} onValueChange={value => setGroupId(value === '__all__' ? '' : value)}>
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

      {simple ? <>
        <section className="rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="real-holdings-heading">
          <div className="flex items-start justify-between gap-3">
            <h2 id="real-holdings-heading" className="text-lg font-semibold">{zh ? '我的实仓' : 'My real portfolio'}</h2>
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{zh ? '实仓' : 'Real'}</span>
          </div>
          {updatedAt && <p className="mt-3 text-xs text-muted-foreground">
            {zh ? '持仓记录更新于' : 'Holdings updated'}{' '}
            <time dateTime={updatedAt}>{formatComparisonTime(updatedAt, i18n.language)}</time>
          </p>}
          {loading && !hasLoadedHoldings ? <p role="status" className="mt-4 text-sm text-muted-foreground">{t('common.loading')}</p>
            : !hasLoadedHoldings && error ? <div className="mt-4 flex flex-wrap items-center gap-3">
              <p role="alert" className="text-destructive">{error}</p>
              <Button size="sm" variant="outline" onClick={() => void loadData()}>{t('common.retry')}</Button>
            </div>
            : filtered.length ? <ul className="mt-4 divide-y border-t">
              {filtered.map(holding => <li key={holding.id}>
                <button type="button" className="flex w-full min-h-14 items-center justify-between gap-3 rounded-sm py-2.5 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={() => openDetail(holding)}>
                  <span className="min-w-0 break-words">
                    <strong className="block font-semibold">{holding.company || holding.ticker}</strong>
                    {holding.company && <span className="text-xs text-muted-foreground">{holding.ticker}</span>}
                  </span>
                  <span className="text-end">
                    <span className="block text-sm font-medium tabular-nums">{formatShares(holding.shares)} {zh ? '股' : 'shares'}</span>
                    <span className="block text-xs text-muted-foreground">{zh ? '成本' : 'Cost'} {formatPriceWithCurrency(holding.buyPrice, holding.currency)}</span>
                  </span>
                </button>
              </li>)}
            </ul> : <p className="mt-4 text-sm text-muted-foreground">
              {t(holdings.length ? 'assets.noMatchingHoldings' : 'holdings.noHoldings')}
            </p>}
        </section>
        <section className="rounded-xl border bg-card p-4 sm:p-5" aria-label={zh ? '现金' : 'Cash'}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-lg font-semibold">{zh ? '现金' : 'Cash'}</h2>
            {cashAccounts.length ? <dl className="flex flex-wrap gap-x-6 gap-y-3">
              {cashAccounts.map(cash => <div key={cash.currency}>
                <dt className="text-xs text-muted-foreground">{cash.currency}</dt>
                <dd className="font-semibold tabular-nums">{cash.balance != null && String(cash.balance).trim() && Number.isFinite(Number(cash.balance))
                  ? formatCurrencyWithCurrency(cash.balance, cash.currency) : '—'}</dd>
              </div>)}
            </dl> : <p className="text-sm text-muted-foreground">{t('assets.cashUnknown')}</p>}
          </div>
        </section>
        <details className="rounded-xl border bg-card p-4 sm:p-5">
          <summary className="cursor-pointer py-1 text-sm font-medium">{zh ? '筛选与管理持仓' : 'Filter and manage holdings'}</summary>
          <div className="pt-4">{details}</div>
        </details>
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
