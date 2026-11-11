/**
 * @file pages/Watchlist/WatchlistPage.tsx
 * @description Route `/watchlist`: tracked tickers with live quotes.
 *
 * Renders a desktop table and mobile card grid, both click-through to a detail
 * dialog. Supports text search, signal filter, and an add-watch dialog. Live
 * quotes are subscribed via `useMarketQuotes`; when a quote is fresher than
 * the stored `currentPrice`, the quote price is displayed instead.
 */
import { useState, useEffect, useMemo } from 'react';
import { Search, Plus, Eye, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import type { WatchItem, Signal, Market } from '@shared/api.interface';
import { fetchWatchlist, createWatchItem } from '@/api';
import { useMarketQuotes } from '@/hooks/use-market-quotes';
import { MarketStatusBadges } from '@/components/MarketStatusBadges';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import {
  formatPrice,
  formatPercent,
  formatDate,
  formatTime,
  signalColor,
  ratingColor,
  plClass,
  cn,
} from '@/utils/format';
import DetailDialog from './DetailDialog';
import WatchForm, { type WatchFormData } from './WatchForm';

import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { safeReturnPath } from '@/features/navigation/workspace-navigation';
import { useWorkspaceNavigation } from '@/features/navigation/use-workspace-navigation';
import { holdingsHref } from '@/features/assets/account-context';

/** Signal filter options (built inside the component for i18n). */
function signalFilters(t: (k: string) => string): Array<{ value: 'all' | string; label: string }> {
  return [
    { value: 'all', label: t('watchlist.allSignals') },
    { value: '强烈买入', label: t('analysis.strongBuy') },
    { value: '买入', label: t('analysis.buy') },
    { value: '观望', label: t('analysis.watch') },
    { value: '回避', label: t('analysis.avoid') },
  ];
}

function localizedSignal(signal: string, t: (k: string) => string): string {
  const keys: Record<string, string> = {
    '强烈买入': 'analysis.strongBuy', 'Strong Buy': 'analysis.strongBuy',
    '买入': 'analysis.buy', Buy: 'analysis.buy',
    '观望': 'analysis.watch', Watch: 'analysis.watch',
    '回避': 'analysis.avoid', Avoid: 'analysis.avoid',
  };
  return keys[signal] ? t(keys[signal]) : signal;
}

/** Blank watch-form state; `dateAdded` defaults to today. */
const EMPTY_FORM: WatchFormData = {
  ticker: '',
  company: '',
  sector: '',
  dateAdded: new Date().toISOString().split('T')[0],
  entryPrice: '',
  currentPrice: '',
  targetBuy: '',
  rating: '',
  signal: '',
  analysis: '',
};

/** Parse a string to a number, returning undefined for empty/NaN input. */
function parseNumber(v: string): number | undefined {
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

/**
 * Compute how far the current price is below the target buy price, as a
 * positive percent. Returns null when the price is at/above target or inputs
 * are missing/invalid.
 */
function belowTargetPct(
  current: string | null,
  target: string | null
): number | null {
  const c = parseFloat(current ?? '');
  const t = parseFloat(target ?? '');
  if (isNaN(c) || isNaN(t) || t <= 0) return null;
  if (c >= t) return null;
  return ((t - c) / t) * 100;
}

/**
 * Watchlist page component.
 *
 * State: watch items, search/signal filters, selected item for the detail
 * dialog, add-dialog open state, and the create form.
 */
function WatchlistPage() {
  const location = useLocation();
  const { returnToContext } = useWorkspaceNavigation();
  const accountParams = new URLSearchParams(location.search);
  const returnTo = safeReturnPath(accountParams.get('returnTo')) ?? holdingsHref(accountParams.get('accountId') ?? 'real');
  const { t } = useTranslation();
  const [items, setItems] = useState<WatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [signalFilter, setSignalFilter] = useState<'all' | Signal>('all');
  const [selected, setSelected] = useState<WatchItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [formData, setFormData] = useState<WatchFormData>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const tickers = useMemo(
    () => items.map((item) => item.ticker),
    [items]
  );

  const { quotes, marketStatus, marketErrors, lastUpdated } = useMarketQuotes(tickers);



  /** Fetch the watchlist and populate state. */
  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const data: WatchItem[] = await fetchWatchlist();
      setItems(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('watchlist.loadFailed');
      setError(msg);
      toast.error(t('watchlist.loadListFailed'), { description: msg });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  /** Apply text search and signal filter to the watch items. */
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item: WatchItem) => {
      if (signalFilter !== 'all' && item.signal !== signalFilter) return false;
      if (!q) return true;
      return (
        item.ticker.toLowerCase().includes(q) ||
        (item.company ?? '').toLowerCase().includes(q)
      );
    });
  }, [items, search, signalFilter]);

  /** Prefer the live quote price when available; fall back to stored currentPrice. */
  function getDisplayPrice(item: WatchItem): string {
    const quote = quotes[item.ticker];
    if (quote && quote.price !== undefined && !isNaN(parseFloat(quote.price))) {
      return quote.price;
    }
    return item.currentPrice ?? '';
  }

  /** Open the detail dialog for the selected watch item. */
  const openDetail = (item: WatchItem) => {
    setSelected(item);
    setDetailOpen(true);
  };

  /** Validate and submit the create-watch form, then reset and refetch. */
  const handleCreate = async () => {
    if (!formData.ticker.trim()) {
      toast.error(t('ui.watchlist.enterTicker'));
      return;
    }
    setSubmitting(true);
    try {
      await createWatchItem({
        ticker: formData.ticker.trim().toUpperCase(),
        company: formData.company.trim() || undefined,
        sector: formData.sector.trim() || undefined,
        dateAdded: formData.dateAdded || undefined,
        entryPrice: parseNumber(formData.entryPrice),
        currentPrice: parseNumber(formData.currentPrice),
        targetBuy: parseNumber(formData.targetBuy),
        rating: formData.rating || undefined,
        signal: formData.signal || undefined,
        analysis: formData.analysis.trim() || undefined,
      });
      toast.success(t('ui.watchlist.signalAdded'));
      setAddOpen(false);
      setFormData(EMPTY_FORM);
      void loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('ui.watchlist.addFailed');
      toast.error(t('ui.watchlist.addFailed'), { description: msg });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <WatchlistSkeleton />;
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4"><p className="text-sm text-muted-foreground">{t('assets.globalWatchlist')}</p><Button variant="outline" size="sm" onClick={() => returnToContext(returnTo)}>{t('assets.returnAccount')}</Button></section>
      {/* Header actions */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex-1">
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-foreground">
            {t('watchlist.title')}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <MarketStatusBadges
              marketStatus={marketStatus}
              marketErrors={marketErrors}
              lastUpdated={lastUpdated}
            />
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('ui.watchlist.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select
            value={signalFilter}
            onValueChange={(v) => setSignalFilter(v as 'all' | Signal)}
          >
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder={t('ui.watchlist.signalFilter')} />
            </SelectTrigger>
            <SelectContent>
              {signalFilters(t).map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4" />
              {t('watchlist.addWatch')}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle className="font-serif text-xl">
                {t('watchlist.addWatch')}
              </DialogTitle>
            </DialogHeader>
            <WatchForm data={formData} onChange={setFormData} includeTicker />
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">{t('common.cancel')}</Button>
              </DialogClose>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? t('common.saving') : t('watchlist.addWatch')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center justify-between p-4">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              <span className="text-sm">{error}</span>
            </div>
            <Button size="sm" variant="outline" onClick={loadData}>
              {t('ui.watchlist.retry')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Desktop Table */}
      {!loading && !error && filteredItems.length > 0 && (
        <div className="hidden md:block">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="font-serif">{t('watchlist.ticker')}</TableHead>
                    <TableHead className="font-serif">{t('watchlist.company')}</TableHead>
                    <TableHead className="font-serif">{t('ui.holdings.sector')}</TableHead>
                    <TableHead className="font-serif">{t('watchlist.signal')}</TableHead>
                    <TableHead className="text-right font-serif">
                      {t('ui.watchlist.entryPrice')}
                    </TableHead>
                     <TableHead className="text-right font-serif">
                       {t('watchlist.currentPrice')}
                     </TableHead>
                     <TableHead className="text-right font-serif">
                       {t('ui.watchlist.changePct')}
                     </TableHead>
                     <TableHead className="text-right font-serif">
                      {t('ui.watchlist.targetBuyPrice')}
                    </TableHead>
                    <TableHead className="font-serif">{t('watchlist.rating')}</TableHead>
                    <TableHead className="font-serif">{t('ui.watchlist.joinedDate')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.map((item: WatchItem) => {
                    const belowPct = belowTargetPct(
                      item.currentPrice,
                      item.targetBuy
                    );
                    return (
                      <TableRow
                        key={item.id}
                        onClick={() => openDetail(item)}
                        className="cursor-pointer"
                      >
                        <TableCell className="font-mono-nums font-semibold">
                          {item.ticker}
                        </TableCell>
                        <TableCell>{item.company ?? '—'}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {item.sector ?? '—'}
                        </TableCell>
                        <TableCell>
                          {item.signal ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                'border-transparent font-medium',
                                signalColor(item.signal)
                              )}
                            >
                              {localizedSignal(item.signal, t)}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono-nums">
                          {formatPrice(item.entryPrice)}
                        </TableCell>
                         <TableCell className="text-right font-mono-nums">
                           {formatPrice(getDisplayPrice(item))}
                           {belowPct !== null && (
                             <div className="text-xs text-success">
                               {t('ui.watchlist.belowTarget')}{' '}
                               {formatPercent(belowPct).replace('+', '')}
                             </div>
                           )}
                         </TableCell>
                         {quotes[item.ticker] ? (
                           <TableCell
                             className={cn(
                               'text-right font-mono-nums font-medium',
                               plClass(
                                 quotes[item.ticker]?.changePercent ?? '0'
                               )
                             )}
                           >
                             {quotes[item.ticker]?.changePercent !== undefined
                               ? formatPercent(quotes[item.ticker].changePercent)
                               : '--'}
                           </TableCell>
                         ) : (
                           <TableCell className="text-right">
                             <span className="text-muted-foreground/60 font-mono-nums">
                               --
                             </span>
                           </TableCell>
                         )}
                        <TableCell className="text-right font-mono-nums">
                          {formatPrice(item.targetBuy)}
                        </TableCell>
                        <TableCell>
                          {item.rating ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                'border-transparent text-xs',
                                ratingColor(item.rating)
                              )}
                            >
                              {item.rating}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {item.dateAdded ? (
                            formatDate(item.dateAdded)
                          ) : (
                            <span title={t('ui.watchlist.dateMissing')}>--</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Mobile Cards */}
      {!loading && !error && filteredItems.length > 0 && (
        <div className="grid gap-3 md:hidden">
          {filteredItems.map((item: WatchItem) => {
            const belowPct = belowTargetPct(
              item.currentPrice,
              item.targetBuy
            );
            return (
              <Card
                key={item.id}
                onClick={() => openDetail(item)}
                className="cursor-pointer transition-colors"
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono-nums text-lg font-bold">
                          {item.ticker}
                        </span>
                        {item.signal && (
                          <Badge
                            variant="outline"
                            className={cn(
                              'border-transparent text-xs',
                              signalColor(item.signal)
                            )}
                          >
                            {localizedSignal(item.signal, t)}
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-sm text-muted-foreground">
                        {item.company ?? '—'}
                      </div>
                    </div>
                    <Eye className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  </div>
                  <Separator className="my-3" />
                   <div className="grid grid-cols-4 gap-2 text-sm">
                     <div>
                       <div className="text-xs text-muted-foreground">
                          {t('watchlist.currentPrice')}
                       </div>
                       <div className="font-mono-nums font-medium">
                         {formatPrice(getDisplayPrice(item))}
                       </div>
                     </div>
                     <div>
                       <div className="text-xs text-muted-foreground">
                         {t('ui.watchlist.changePct')}
                       </div>
                        {quotes[item.ticker] ? (
                          <div
                            className={cn(
                              'font-mono-nums font-medium',
                              plClass(quotes[item.ticker]?.changePercent ?? '0')
                            )}
                          >
                            {quotes[item.ticker]?.changePercent !== undefined
                              ? formatPercent(quotes[item.ticker].changePercent)
                              : '--'}
                          </div>
                        ) : (
                          <div className="text-muted-foreground/60 font-mono-nums font-medium">
                            --
                          </div>
                        )}
                     </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        {t('watchlist.targetBuy')}
                      </div>
                      <div className="font-mono-nums font-medium">
                        {formatPrice(item.targetBuy)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        {t('ui.watchlist.entryPrice')}
                      </div>
                      <div className="font-mono-nums font-medium">
                        {formatPrice(item.entryPrice)}
                      </div>
                    </div>
                  </div>
                  {belowPct !== null && (
                    <div className="mt-2 text-xs text-success">
                      {t('ui.watchlist.belowTarget')}{' '}
                      {formatPercent(belowPct).replace('+', '')}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filteredItems.length === 0 && (
        <Card>
          <CardContent className="p-6">
            <Empty>
              <EmptyMedia variant="icon">
                <Eye className="h-5 w-5" />
              </EmptyMedia>
              <EmptyContent>
                <EmptyTitle className="font-serif">
                  {search || signalFilter !== 'all'
                    ? t('watchlist.noMatch')
                    : t('watchlist.noItems')}
                </EmptyTitle>
                <EmptyDescription>
                  {search || signalFilter !== 'all'
                    ? t('ui.watchlist.noMatchHint')
                    : t('ui.watchlist.emptyHint')}
                </EmptyDescription>
              </EmptyContent>
            </Empty>
          </CardContent>
        </Card>
      )}

      {/* Detail Dialog */}
      <DetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        item={selected}
        onUpdated={() => void loadData()}
        onDeleted={() => void loadData()}
      />
    </div>
  );
}

/** Loading skeleton shown while the watchlist is being fetched. */
function WatchlistSkeleton() {
  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-full sm:w-40" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <Card>
        <CardContent className="p-6">
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default WatchlistPage;
