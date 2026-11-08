/**
 * @file pages/Holdings/HoldingsPage.tsx
 * @description Route `/holdings`: list, filter, sort and manage open positions.
 *
 * Composes the holdings table (desktop), mobile card list, detail dialog, add
 * dialog, and the AI run-detail modal. Subscribes to live quotes via
 * `useMarketQuotes`, enriches each row with derived market value / P/L, and
 * supports search, group filter, multi-market filter, and column sorting.
 */
import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Briefcase,
  Search,
  Plus,
  RefreshCw,
  Check,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import type {
  Holding,
  Group,
  QuoteResponse,
  Market,
  CashAccount,
  DashboardOverview,
  LatestRating,
  AgentRun,
} from '@shared/api.interface';
import { fetchHoldings, fetchGroups, fetchCashAccounts, fetchDashboard, getLatestRatings, getAgentRuns } from '@/api';
import { useMarketQuotes } from '@/hooks/use-market-quotes';
import {
  formatCurrencyWithCode,
  plClass,
  cn,
} from '@/utils/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
  AlertTitle,
  AlertDescription,
} from '@/components/ui/alert';

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

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
 * multi-select, AI ratings map, and the pending-human run count.
 */
export default function HoldingsPage() {
  const { t, i18n } = useTranslation();
  const [holdings, setHoldings] = useState<DerivedHolding[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('marketValue');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [detailOpen, setDetailOpen] = useState(false);
  const [selected, setSelected] = useState<Holding | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedMarkets, setSelectedMarkets] = useState<Set<Market>>(
    new Set(['US', 'HK', 'CN'])
  );
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([]);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [aiRatings, setAiRatings] = useState<Record<string, LatestRating>>({});
  const [aiRatingsLoading, setAiRatingsLoading] = useState(false);
  const [awaitingHumanCount, setAwaitingHumanCount] = useState(0);
  const [aiDetailRunId, setAiDetailRunId] = useState<string | null>(null);
  const [aiDetailOpen, setAiDetailOpen] = useState(false);

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
    setAiRatingsLoading(true);
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
    } finally {
      setAiRatingsLoading(false);
    }
  };

  /** Count runs awaiting human decision (drives the risk-alert banner). */
  const loadAwaitingHuman = async () => {
    try {
      const result = await getAgentRuns({ status: 'awaiting_human', limit: 10 });
      const items = (result?.items ?? []) as AgentRun[];
      setAwaitingHumanCount(result?.total ?? items.length);
    } catch (err) {
      // 静默失败
    }
  };

  /** Parallel-fetch holdings, groups, cash accounts and the dashboard overview. */
  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [h, g, cash, dash] = await Promise.all([
        fetchHoldings(),
        fetchGroups(),
        fetchCashAccounts().catch(() => []),
        fetchDashboard('USD').catch(() => null),
      ]);
      setHoldings((h as Holding[]).map(computeDerived));
      setGroups(g as Group[]);
      setCashAccounts(cash as CashAccount[]);
      setOverview(dash as DashboardOverview | null);
    } catch (err) {
      setError(t('common.failed'));
      toast.error(t('common.failed'));
    } finally {
      setLoading(false);
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
    loadAwaitingHuman();
    const handleUpdate = () => {
      loadData();
      loadAiRatings();
      loadAwaitingHuman();
    };
    window.addEventListener('portfolio-updated', handleUpdate);
    return () => window.removeEventListener('portfolio-updated', handleUpdate);
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

  return (
    <div className="space-y-5">
      {/* Header */}
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
              {formatCurrencyWithCode(totalMv, displayCurrency)}
            </span>{' '}
            · {t('ui.holdings.floatingPl')}{' '}
            <span
              className={cn(
                'font-mono-nums font-medium',
                plClass(totalPl)
              )}
            >
              {formatCurrencyWithCode(totalPl, displayCurrency)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
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
            <Button variant="outline" size="sm" asChild><Link to="/paper?seedReal=1">{i18n.language.startsWith('en') ? 'Copy to simulation' : '复制到模拟盘'}</Link></Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            {t('holdings.addHolding')}
          </Button>
        </div>
      </div>

      {/* Pending analysis reviews */}
      {awaitingHumanCount > 0 && (
        <Alert className="border-warning/35 bg-warning/10 text-foreground">
          <AlertTriangle className="size-4 text-warning" />
          <AlertTitle className="font-medium">{t('ui.holdings.riskAlert')}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3 text-muted-foreground">
            <span>
              {t('ui.holdings.riskMessage', { count: awaitingHumanCount })}
            </span>
            <Button
              asChild
              variant="outline"
              size="sm"
              className="shrink-0 border-warning/35 bg-background/70 text-foreground hover:bg-warning/15"
            >
              <Link to="/analysis">
                {t('ui.holdings.viewDetails')}
                <ChevronRight className="size-3" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

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
            <Badge
              key={m}
              variant={active ? 'default' : 'outline'}
              className={cn(
                'cursor-pointer select-none gap-1.5 h-7 px-3',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted'
              )}
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
            </Badge>
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
          <Select value={groupId} onValueChange={setGroupId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('ui.holdings.allGroups')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t('ui.holdings.allGroups')}</SelectItem>
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
        loading={loading}
        error={error}
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
        loading={loading}
        error={error}
        holdings={filtered}
        groups={groups}
        onAdd={() => setAddOpen(true)}
        onDetail={openDetail}
        aiRatings={aiRatings}
        onViewAiAnalysis={handleViewAiAnalysis}
      />

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
