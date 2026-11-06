/**
 * @file pages/Transactions/TransactionsPage.tsx
 * @description Route `/transactions`: buy/sell/deposit/withdrawal ledger and
 * realized P/L summary.
 *
 * Two tabs:
 *  - Transactions: filterable ledger with buy/sell totals and a desktop table +
 *    mobile card list. Supports delete (with confirm) and a "reconcile" action
 *    that recomputes holdings/closed positions server-side.
 *  - Realized P/L: aggregate realized P/L across currencies, per-ticker rows,
 *    and winner/loser counts.
 *
 * Mutations dispatch a `portfolio-updated` window event so Dashboard/Holdings
 * refetch.
 */
import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Receipt,
  Plus,
  TrendingUp,
  Search,
  RefreshCw,
  ArrowDownToLine,
  ArrowUpFromLine,
} from 'lucide-react';
import http from '@/api/http';
import type { Transaction, ClosedPosition, RealizedPlSummary } from '@shared/api.interface';
import {
  fetchTransactions,
  fetchClosed,
  fetchRealizedPlSummary,
  reconcileTransactions,
} from '@/api';
import {
  formatCurrency,
  formatPrice,
  formatShares,
  formatPercent,
  formatDate,
  formatCurrencyWithCurrency,
  plClass,
  cn,
} from '@/utils/format';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Trash2, Calculator } from 'lucide-react';
import AddTransactionDialog from './AddTransactionDialog';
import AddClosedDialog from './AddClosedDialog';
import TransactionList from './TransactionList';

import { useTranslation } from 'react-i18next';
import { transactionCashDelta } from '@/utils/transaction-cash';

/**
 * Transactions page component.
 */
export default function TransactionsPage() {
  const { t, i18n } = useTranslation();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [closed, setClosed] = useState<ClosedPosition[]>([]);
  const [realizedPl, setRealizedPl] = useState<RealizedPlSummary | null>(null);
  const [txLoading, setTxLoading] = useState(true);
  const [hasMoreTransactions, setHasMoreTransactions] = useState(false);
  const [closedLoading, setClosedLoading] = useState(true);
  const [realizedPlLoading, setRealizedPlLoading] = useState(true);
  const [txError, setTxError] = useState<string | null>(null);
  const [closedError, setClosedError] = useState<string | null>(null);
  const [realizedPlError, setRealizedPlError] = useState<string | null>(null);
  const [tickerFilter, setTickerFilter] = useState('');
  const [addTxOpen, setAddTxOpen] = useState(false);
  const [addClosedOpen, setAddClosedOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  /** Notify other pages that portfolio data changed (triggers refetch). */
  const notifyPortfolioUpdate = () => {
    window.dispatchEvent(new CustomEvent('portfolio-updated'));
  };

  /** Load transactions, optionally filtered by ticker, sorted by date desc. */
  const loadTransactions = async (append = false) => {
    setTxLoading(true);
    setTxError(null);
    try {
      const params = {
        ticker: tickerFilter.trim().toUpperCase() || undefined,
        limit: 100,
        offset: append ? transactions.length : 0,
      };
      const data = await fetchTransactions(params);
      const list = (append ? [...transactions, ...data] : data as Transaction[]).slice().sort((a, b) =>
        b.txDate.localeCompare(a.txDate)
      );
      setTransactions(list);
      setHasMoreTransactions(data.length === 100);
    } catch (err) {
      setTxError(t('tx.loadTxFailed'));
      toast.error(t('tx.loadTxFailed'));
    } finally {
      setTxLoading(false);
    }
  };

  /** Load closed positions (realized trades). */
  const loadClosed = async () => {
    setClosedLoading(true);
    setClosedError(null);
    try {
      const data = await fetchClosed();
      setClosed(data as ClosedPosition[]);
    } catch (err) {
      setClosedError(t('tx.loadClosedFailed'));
      toast.error(t('tx.loadClosedFailed'));
    } finally {
      setClosedLoading(false);
    }
  };

  /** Load the realized P/L aggregate summary. */
  const loadRealizedPl = async () => {
    setRealizedPlLoading(true);
    setRealizedPlError(null);
    try {
      const data = await fetchRealizedPlSummary();
      setRealizedPl(data as RealizedPlSummary);
    } catch (err) {
      setRealizedPlError(t('tx.loadPlFailed'));
      toast.error(t('tx.loadPlFailed'));
    } finally {
      setRealizedPlLoading(false);
    }
  };

  useEffect(() => {
    loadTransactions();
    loadClosed();
    loadRealizedPl();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadTransactions();
    }, 300);
    return () => clearTimeout(timer);
  }, [tickerFilter]);

  /** Delete the selected transaction, then refresh closed/realized and notify. */
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await http({
        url: `/api/portfolio/transactions/${deleteTarget}`,
        method: 'DELETE',
      });
      toast.success(t('ui.tx.deleteSynced'));
      setTransactions((prev) => prev.filter((tx) => tx.id !== deleteTarget));
      setDeleteTarget(null);
      loadClosed();
      loadRealizedPl();
      notifyPortfolioUpdate();
    } catch (err) {
      const message=(err as {response?:{data?:{message?:string;error?:{message?:string}}}})?.response?.data;
      const code=message?.error?.message??message?.message;
      toast.error(['CHECKPOINT_HISTORY_REQUIRES_RECONCILIATION','CASH_CHECKPOINT_HISTORY_REQUIRES_RECONCILIATION'].includes(code??'')
        ? i18n.language.startsWith('zh')?'这笔记录已包含在确认的资产起点中，请先核对持仓或现金起点后再删除。':'This record is included in a confirmed asset starting balance. Reconcile the positions or cash starting balance before deleting it.'
        : t('tx.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  /**
   * Trigger a server-side reconciliation that recomputes holdings and closed
   * positions from the raw transaction ledger.
   */
  const handleReconcile = async () => {
    setReconciling(true);
    try {
      const result = await reconcileTransactions();
      toast.success(
        t('ui.tx.reconcileComplete', {
          holdings: result.holdingsCount,
          closed: result.closedCount,
          transactions: result.processedTxCount,
        })
      );
      loadTransactions();
      loadClosed();
      loadRealizedPl();
      notifyPortfolioUpdate();
    } catch (err) {
      toast.error(t('ui.tx.reconcileFailed'));
    } finally {
      setReconciling(false);
    }
  };

  /**
   * Keep native-currency subtotals separate. Fees are included in each trade.
   */
  const txStats = useMemo(() => {
    const buyTotal: Record<string, number> = {};
    const sellTotal: Record<string, number> = {};
    for (const tx of transactions) {
      const currency = tx.currency || 'USD';
      const gross = parseFloat(tx.shares) * parseFloat(tx.price);
      const fees = parseFloat(tx.fees || '0');
      if (tx.txType === 'Buy') buyTotal[currency] = (buyTotal[currency] || 0) + gross + fees;
      if (tx.txType === 'Sell') sellTotal[currency] = (sellTotal[currency] || 0) + gross - fees;
    }
    return { buyTotal, sellTotal, count: transactions.length };
  }, [transactions]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl md:text-3xl font-semibold tracking-tight flex items-center gap-2.5">
            <Receipt className="size-6 text-primary" />
            {t('tx.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('ui.tx.subtitle')}
          </p>
        </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              loadTransactions();
              loadClosed();
              loadRealizedPl();
            }}
          >
          <RefreshCw className="size-4" />
          {t('ui.tx.refresh')}
        </Button>
      </div>

      <Tabs defaultValue="transactions" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="transactions">
            <TrendingUp className="size-4 mr-1.5" />
            {t('ui.tx.ledger')}
          </TabsTrigger>
          <TabsTrigger value="realized">
            <TrendingUp className="size-4 mr-1.5" />
            {t('ui.tx.realized')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="transactions" className="mt-0">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div className="relative flex-1 sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                placeholder={t('ui.tx.tickerFilter')}
                value={tickerFilter}
                onChange={(e) => setTickerFilter(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleReconcile}
                disabled={reconciling}
              >
                <Calculator className="size-4" />
                {reconciling ? t('ui.tx.reconciling') : t('ui.tx.reconcile')}
              </Button>
              <Button size="sm" onClick={() => setAddTxOpen(true)}>
                <Plus className="size-4" />
                {t('tx.addTx')}
              </Button>
            </div>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
             <Card>
               <CardContent className="p-4">
                 <div className="text-xs text-muted-foreground">{t('ui.tx.tradeCount')}</div>
                <div className="font-mono-nums text-xl font-semibold mt-1">
                  {txLoading ? '—' : txStats.count}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  <ArrowDownToLine className="size-3 text-muted-foreground" />
                  {t('ui.tx.totalBuys')}
                </div>
                <div className="font-mono-nums text-xl font-semibold mt-1 text-foreground">
                  {txLoading ? '—' : Object.entries(txStats.buyTotal).map(([currency, value]) => (
                    <div key={currency}>{formatCurrencyWithCurrency(value, currency)}</div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card className="col-span-2 sm:col-span-1">
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  <ArrowUpFromLine className="size-3 text-muted-foreground" />
                  {t('ui.tx.totalSells')}
                </div>
                <div className="font-mono-nums text-xl font-semibold mt-1 text-foreground">
                  {txLoading ? '—' : Object.entries(txStats.sellTotal).map(([currency, value]) => (
                    <div key={currency}>{formatCurrencyWithCurrency(value, currency)}</div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
          {hasMoreTransactions && <p className="mb-4 text-xs text-muted-foreground">{t('ui.tx.loadedSubtotal')}</p>}

          {/* Desktop Table */}
          <Card className="hidden md:block">
            <CardContent className="p-0">
              {txLoading ? (
                <div className="p-6 space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : txError ? (
                <div className="p-12 text-center text-destructive text-sm">
                  {txError}
                </div>
              ) : transactions.length === 0 ? (
                <div className="p-12">
                  <Empty>
                    <EmptyMedia variant="icon">
                      <Receipt />
                    </EmptyMedia>
                    <EmptyHeader>
                      <EmptyTitle>{t('ui.tx.emptyTx')}</EmptyTitle>
                      <EmptyDescription>
                        {t('ui.tx.emptyTxHint')}
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <Button size="sm" onClick={() => setAddTxOpen(true)}>
                        <Plus className="size-4" />
                        {t('tx.addTx')}
                      </Button>
                    </EmptyContent>
                  </Empty>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('tx.date')}</TableHead>
                      <TableHead>{t('tx.type')}</TableHead>
                      <TableHead>{t('holdings.ticker')}</TableHead>
                      <TableHead>{t('ui.tx.currency')}</TableHead>
                      <TableHead className="text-right">{t('tx.shares')}</TableHead>
                      <TableHead className="text-right">{t('tx.price')}</TableHead>
                      <TableHead className="text-right">{t('tx.fees')}</TableHead>
                      <TableHead className="text-right">{t('ui.tx.amount')}</TableHead>
                      <TableHead className="max-w-[200px]">{t('tx.notes')}</TableHead>
                      <TableHead className="w-[60px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {transactions.map((tx) => {
                      const isBuy = tx.txType === 'Buy';
                      const isSell = tx.txType === 'Sell';
                      const isDeposit = tx.txType === 'Deposit';
                      const isWithdrawal = tx.txType === 'Withdrawal';
                      const isOpening = tx.txType === 'Opening';
                      const amount = transactionCashDelta(tx);
                      const isOutflow = amount < 0;
                      const typeLabel = isBuy ? t('tx.buy') : isSell ? t('tx.sell') : isDeposit ? t('ui.tx.typeDeposit') : isWithdrawal ? t('ui.tx.typeWithdrawal') : isOpening ? t('tx.opening') : i18n.language.startsWith('zh') ? '费用' : 'Fee';
                      const typeClass = isOpening
                        ? 'bg-slate-500/15 text-slate-300 border-slate-500/30'
                        : isBuy
                          ? 'bg-primary/10 text-primary border-primary/20'
                          : isSell
                            ? 'bg-muted text-muted-foreground border-border'
                            : isDeposit
                              ? 'bg-warning/15 text-warning border-warning/20'
                              : 'bg-destructive/10 text-destructive border-destructive/20';
                      return (
                        <TableRow key={tx.id}>
                          <TableCell className="font-mono-nums">
                            {formatDate(tx.txDate)}
                          </TableCell>
                          <TableCell>
                            <Badge className={cn(typeClass)} variant="outline">
                              {typeLabel}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono-nums font-semibold text-primary">
                            {tx.ticker}
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground font-mono">
                              {tx.currency || 'USD'}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-mono-nums">
                            {formatShares(tx.shares)}
                          </TableCell>
                          <TableCell className="text-right font-mono-nums">
                            {isDeposit || isWithdrawal || isOpening || tx.txType === 'Fee' ? '—' : formatPrice(tx.price)}
                          </TableCell>
                          <TableCell className="text-right font-mono-nums text-muted-foreground">
                            {formatCurrencyWithCurrency(tx.fees || '0', tx.currency || 'USD')}
                          </TableCell>
                          <TableCell
                             className={cn(
                               'text-right font-mono-nums font-medium',
                               isOpening ? 'text-slate-400' : 'text-foreground'
                             )}
                           >
                            {isOpening ? (
                              '—'
                            ) : (
                              <>
                                <span className="text-muted-foreground">
                                  {isOutflow ? '-' : '+'}
                                </span>
                                {formatCurrencyWithCurrency(Math.abs(amount), tx.currency || 'USD')}
                              </>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs max-w-[200px] truncate">
                            {tx.notes ?? '—'}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => setDeleteTarget(tx.id)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Mobile */}
          <TransactionList
            loading={txLoading}
            error={txError}
            transactions={transactions}
            onAdd={() => setAddTxOpen(true)}
            onDelete={(id) => setDeleteTarget(id)}
          />
          {hasMoreTransactions && !txLoading && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={() => loadTransactions(true)}>
                {t('common.loadMore')}
              </Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="realized" className="mt-0">
          {realizedPlLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-32 w-full rounded-lg" />
              <Card>
                <CardContent className="p-6 space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </CardContent>
              </Card>
            </div>
          ) : realizedPlError ? (
            <div className="p-12 text-center text-destructive text-sm">
              {realizedPlError}
            </div>
          ) : !realizedPl || realizedPl.items.length === 0 ? (
            <div className="p-12">
              <Empty>
                <EmptyMedia variant="icon">
                  <TrendingUp />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>{t('ui.tx.emptyRealized')}</EmptyTitle>
                  <EmptyDescription>
                    {t('ui.tx.emptyRealizedHint')}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button size="sm" onClick={() => setAddClosedOpen(true)}>
                    <Plus className="size-4" />
                    {t('ui.tx.addClosed')}
                  </Button>
                </EmptyContent>
              </Empty>
            </div>
          ) : (
            <RealizedPlContent summary={realizedPl} onAddClosed={() => setAddClosedOpen(true)} />
          )}
        </TabsContent>
      </Tabs>

      <AddTransactionDialog
        open={addTxOpen}
        onOpenChange={setAddTxOpen}
        onCreated={() => {
          loadTransactions();
          loadClosed();
          notifyPortfolioUpdate();
        }}
      />

      <AddClosedDialog
        open={addClosedOpen}
        onOpenChange={setAddClosedOpen}
        onCreated={() => {
          loadClosed();
          loadRealizedPl();
        }}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tx.deleteConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('ui.tx.confirmDeleteDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? t('ui.tx.deleteProgress') : t('ui.tx.confirmDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Realized P/L tab content: total P/L banner, per-currency breakdown, and a
 * per-ticker table/card list sorted by realized P/L desc.
 */
function RealizedPlContent({
  summary,
  onAddClosed,
}: {
  summary: RealizedPlSummary;
  onAddClosed: () => void;
}) {
  const { t } = useTranslation();
  const currencies = Object.entries(summary.totalByCurrency).filter(
    ([, v]) => parseFloat(v || '0') !== 0
  );
  const sortedItems = [...summary.items].sort(
    (a, b) => parseFloat(b.realizedPl) - parseFloat(a.realizedPl)
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={onAddClosed}>
          <Plus className="size-4" />
          {t('ui.tx.addClosed')}
        </Button>
      </div>

      {/* Total summary card */}
      <Card className="overflow-hidden border-0 bg-muted/40">
        <CardContent className="p-6 md:p-8">
          <div className="text-sm font-medium text-muted-foreground">
            {t('tx.realizedPl')}
          </div>
          <div className="mt-2 font-mono-nums text-3xl md:text-4xl font-bold tracking-tight space-y-1">
            {currencies.map(([currency, value]) => (
              <div key={currency} className={plClass(value)}>
                {parseFloat(value) >= 0 ? '+' : ''}{formatCurrencyWithCurrency(value, currency)}
              </div>
            ))}
            {currencies.length === 0 && '—'}
          </div>
          <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="font-semibold text-success">
                {summary.totalWinners}
              </span>
              {t('ui.tx.countWinners')}
            </span>
            <span className="text-border">·</span>
            <span className="flex items-center gap-1">
              <span className="font-semibold text-destructive">
                {summary.totalLosers}
              </span>
              {t('ui.tx.countLosers')}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Desktop table */}
      <Card className="hidden md:block">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('ui.tx.stock')}</TableHead>
                <TableHead>{t('tx.realizedPl')}</TableHead>
                <TableHead className="text-right">{t('ui.tx.returnPct')}</TableHead>
                <TableHead className="text-right">{t('ui.tx.closedShares')}</TableHead>
                <TableHead className="text-right">{t('ui.tx.closeCount')}</TableHead>
                <TableHead className="text-right">{t('ui.tx.recentClose')}</TableHead>
                <TableHead className="text-right">{t('ui.tx.currency')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedItems.map((item) => (
                <TableRow key={item.ticker}>
                  <TableCell>
                    <div className="font-mono-nums font-semibold text-primary">
                      {item.ticker}
                    </div>
                    <div className="text-xs text-muted-foreground truncate max-w-[180px]">
                      {item.company ?? '—'}
                    </div>
                  </TableCell>
                  <TableCell
                    className={cn(
                      'font-mono-nums font-semibold',
                      plClass(item.realizedPl)
                    )}
                  >
                    {parseFloat(item.realizedPl) >= 0 ? '+' : ''}
                    {formatCurrencyWithCurrency(item.realizedPl, item.currency)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-mono-nums font-medium',
                      plClass(item.returnPct)
                    )}
                  >
                    {formatPercent(item.returnPct)}
                  </TableCell>
                  <TableCell className="text-right font-mono-nums">
                    {formatShares(item.totalShares)}
                  </TableCell>
                  <TableCell className="text-right font-mono-nums text-muted-foreground">
                    {item.closeCount}
                  </TableCell>
                  <TableCell className="text-right font-mono-nums text-muted-foreground">
                    {formatDate(item.lastCloseDate)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="text-xs text-muted-foreground font-mono">
                      {item.currency}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {sortedItems.map((item) => (
          <Card key={item.ticker}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="min-w-0 flex-1">
                  <div className="font-mono-nums font-bold text-primary text-lg">
                    {item.ticker}
                  </div>
                  <div className="text-sm text-muted-foreground truncate">
                    {item.company ?? '—'}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={cn(
                      'font-mono-nums text-lg font-semibold',
                      plClass(item.realizedPl)
                    )}
                  >
                    {parseFloat(item.realizedPl) >= 0 ? '+' : ''}
                    {formatCurrencyWithCurrency(item.realizedPl, item.currency)}
                  </div>
                  <div
                    className={cn(
                      'font-mono-nums text-sm',
                      plClass(item.returnPct)
                    )}
                  >
                    {formatPercent(item.returnPct)}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-sm pt-2 border-t border-border/50">
                <div>
                  <div className="text-xs text-muted-foreground">{t('tx.shares')}</div>
                  <div className="font-mono-nums">
                    {formatShares(item.totalShares)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t('ui.tx.closeCount')}</div>
                  <div className="font-mono-nums">{item.closeCount}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t('ui.tx.recentClose')}</div>
                  <div className="font-mono-nums text-xs">
                    {formatDate(item.lastCloseDate)}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}


