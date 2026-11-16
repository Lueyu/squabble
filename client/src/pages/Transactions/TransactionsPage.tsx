/**
 * TransactionsPage.tsx — 交易流水页（路由 /transactions）。
 *
 * 职责边界：
 *  - "交易流水" Tab：可按 ticker 过滤的买卖/出入金台账（桌面表格 + 移动端
 *    TransactionList 卡片），含笔数与买卖总额统计卡、删除（确认弹窗）与
 *    "重新对账"（服务端由原始流水重算持仓/已平仓）；
 *  - "已实现盈亏" Tab：跨币种已实现盈亏汇总横幅 + 按 ticker 明细
 *    （RealizedPlContent，按已实现盈亏降序）。
 * 上下游：
 *  - 上游：路由 /transactions（App 路由表）；
 *  - 下游：@/api（fetchTransactions/fetchClosed/fetchRealizedPlSummary/
 *    reconcileTransactions）、AddTransactionDialog/AddClosedDialog/
 *    TransactionList。
 * 关键约定：
 *  - 金额/股数字段（shares/price/fees/realizedPl/returnPct/totalByCurrency
 *    等）均为"字符串数值"，运算/比较前须 parseFloat；currency 缺省按 'USD'；
 *  - 分页：每次 limit=100，返回恰好满 100 条视为可能还有下一页
 *    （hasMoreTransactions），"加载更多"以当前列表长度作 offset 追加；
 *  - 变更后派发 window 'portfolio-updated' 事件，Dashboard/Holdings 据此重拉。
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

/**
 * 交易流水页组件。
 */
export default function TransactionsPage() {
  // ---- 状态声明区 ----
  const { t } = useTranslation();
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
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null); // 待删除的交易 id（非空时弹确认框）
  const [deleting, setDeleting] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  // ---- 数据获取区 ----

  /** 通知其他页面组合数据已变化（触发各自重拉）。 */
  const notifyPortfolioUpdate = () => {
    window.dispatchEvent(new CustomEvent('portfolio-updated'));
  };

  /**
   * 拉取交易流水（可按 ticker 过滤，按 txDate 倒序）。
   * append=true 时以当前列表长度作 offset 追加下一页，否则重查第一页。
   */
  const loadTransactions = async (append = false) => {
    // 进入加载态并清空上次错误。
    setTxLoading(true);
    setTxError(null);
    try {
      // 请求参数：ticker 大写化（空串不传）；固定每页 100 条。
      const params = {
        ticker: tickerFilter.trim().toUpperCase() || undefined,
        limit: 100,
        offset: append ? transactions.length : 0,
      };
      // 统一按 txDate 倒序（append 时先拼接旧列表再整体排序）。
      const data = await fetchTransactions(params);
      const list = (append ? [...transactions, ...data] : (data as Transaction[]))
        .slice()
        .sort((a, b) => b.txDate.localeCompare(a.txDate));
      setTransactions(list);
      // 恰好拿满一页（100 条）视为可能还有下一页。
      setHasMoreTransactions(data.length === 100);
    } catch (err) {
      setTxError(t('tx.loadTxFailed'));
      toast.error(t('tx.loadTxFailed'));
    } finally {
      setTxLoading(false);
    }
  };

  /** 拉取已平仓记录（已实现的交易）。 */
  const loadClosed = async () => {
    // 进入加载态并清空上次错误。
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

  /** 拉取已实现盈亏汇总。 */
  const loadRealizedPl = async () => {
    // 进入加载态并清空上次错误。
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

  // 首次挂载：一次性拉取流水 / 已平仓 / 已实现盈亏三份数据。
  useEffect(() => {
    loadTransactions();
    loadClosed();
    loadRealizedPl();
  }, []);

  // ticker 过滤防抖：输入变化 300ms 后重查第一页（挂载时也会先执行一次）。
  useEffect(() => {
    const timer = setTimeout(() => {
      loadTransactions();
    }, 300);
    return () => clearTimeout(timer);
  }, [tickerFilter]);

  // ---- 事件处理区 ----

  /** 删除选中交易，随后刷新已平仓/已实现盈亏并广播更新。 */
  const handleDelete = async () => {
    // 无删除目标时直接返回（弹窗关闭后 target 复位为 null）。
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      // 删除后本地移除该行，并重拉受影响的汇总数据。
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
      toast.error(t('tx.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  /**
   * 触发服务端"重新对账"：由原始交易流水重算持仓与已平仓记录。
   */
  const handleReconcile = async () => {
    setReconciling(true);
    try {
      // 对账完成后提示各计数，并全量刷新三份数据。
      const result = await reconcileTransactions();
      toast.success(
        t('ui.tx.reconcileComplete', {
          holdings: result.holdingsCount,
          closed: result.closedCount,
          transactions: result.processedTxCount,
        }),
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

  // ---- 派生计算区 ----

  /**
   * 按币种分别累计买入/卖出总额（各币种独立小计，不跨币种合并）。
   * 费用计入每笔交易：买入总额加费用、卖出总额减费用。
   */
  const txStats = useMemo(() => {
    const buyTotal: Record<string, number> = {};
    const sellTotal: Record<string, number> = {};
    for (const tx of transactions) {
      const currency = tx.currency || 'USD';
      // 毛额 = 股数 × 价格（shares/price/fees 均为字符串数值，先 parseFloat）。
      const gross = parseFloat(tx.shares) * parseFloat(tx.price);
      const fees = parseFloat(tx.fees || '0');
      if (tx.txType === 'Buy') buyTotal[currency] = (buyTotal[currency] || 0) + gross + fees;
      if (tx.txType === 'Sell') sellTotal[currency] = (sellTotal[currency] || 0) + gross - fees;
    }
    return { buyTotal, sellTotal, count: transactions.length };
  }, [transactions]);

  // ---- 渲染区 ----
  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl md:text-3xl font-semibold tracking-tight flex items-center gap-2.5">
            <Receipt className="size-6 text-primary" />
            {t('tx.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t('ui.tx.subtitle')}</p>
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
              <Button variant="outline" size="sm" onClick={handleReconcile} disabled={reconciling}>
                <Calculator className="size-4" />
                {reconciling ? t('ui.tx.reconciling') : t('ui.tx.reconcile')}
              </Button>
              <Button size="sm" onClick={() => setAddTxOpen(true)}>
                <Plus className="size-4" />
                {t('tx.addTx')}
              </Button>
            </div>
          </div>

          {/* 统计卡：笔数与按币种分列的买入/卖出总额（现金流不计入买卖总额）。 */}
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
                  {txLoading
                    ? '—'
                    : Object.entries(txStats.buyTotal).map(([currency, value]) => (
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
                  {txLoading
                    ? '—'
                    : Object.entries(txStats.sellTotal).map(([currency, value]) => (
                        <div key={currency}>{formatCurrencyWithCurrency(value, currency)}</div>
                      ))}
                </div>
              </CardContent>
            </Card>
          </div>
          {/* 还有下一页：当前统计只覆盖已加载部分。什么时候走到这里：hasMoreTransactions。 */}
          {hasMoreTransactions && (
            <p className="mb-4 text-xs text-muted-foreground">{t('ui.tx.loadedSubtotal')}</p>
          )}

          {/* 桌面表格（只在 md 以上显示）：加载中→骨架屏；出错→错误文案；无数据→空态；否则渲染表格。 */}
          <Card className="hidden md:block">
            <CardContent className="p-0">
              {txLoading ? (
                <div className="p-6 space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : txError ? (
                <div className="p-12 text-center text-destructive text-sm">{txError}</div>
              ) : transactions.length === 0 ? (
                <div className="p-12">
                  <Empty>
                    <EmptyMedia variant="icon">
                      <Receipt />
                    </EmptyMedia>
                    <EmptyHeader>
                      <EmptyTitle>{t('ui.tx.emptyTx')}</EmptyTitle>
                      <EmptyDescription>{t('ui.tx.emptyTxHint')}</EmptyDescription>
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
                      // 行内派生：类型布尔与金额。
                      // 金额口径：入金 = shares；出金 = −shares；期初 = 0；
                      // 买卖 = shares×price ∓ 费用（买入加费用、卖出减费用）。
                      const isBuy = tx.txType === 'Buy';
                      const isSell = tx.txType === 'Sell';
                      const isDeposit = tx.txType === 'Deposit';
                      const isWithdrawal = tx.txType === 'Withdrawal';
                      const isOpening = tx.txType === 'Opening';
                      const amount = isDeposit
                        ? parseFloat(tx.shares)
                        : isWithdrawal
                          ? -parseFloat(tx.shares)
                          : isOpening
                            ? 0
                            : parseFloat(tx.shares) * parseFloat(tx.price) +
                              (isBuy ? parseFloat(tx.fees || '0') : -parseFloat(tx.fees || '0'));
                      const isOutflow = isBuy || isWithdrawal;
                      // 类型徽章的文案与配色（三元链按类型逐级判定）。
                      const typeLabel = isBuy
                        ? t('tx.buy')
                        : isSell
                          ? t('tx.sell')
                          : isDeposit
                            ? t('ui.tx.typeDeposit')
                            : isWithdrawal
                              ? t('ui.tx.typeWithdrawal')
                              : t('tx.opening');
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
                          <TableCell className="font-mono-nums">{formatDate(tx.txDate)}</TableCell>
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
                          {/* 现金流/期初行没有成交价，占位显示。 */}
                          <TableCell className="text-right font-mono-nums">
                            {isDeposit || isWithdrawal || isOpening ? '—' : formatPrice(tx.price)}
                          </TableCell>
                          <TableCell className="text-right font-mono-nums text-muted-foreground">
                            {formatCurrencyWithCurrency(tx.fees || '0', tx.currency || 'USD')}
                          </TableCell>
                          {/* 金额列：符号与绝对值分开渲染（正负由 isOutflow 决定）。 */}
                          <TableCell
                            className={cn(
                              'text-right font-mono-nums font-medium',
                              isOpening ? 'text-slate-400' : 'text-foreground',
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

          {/* 移动端卡片列表（与桌面表格同数据源）。 */}
          <TransactionList
            loading={txLoading}
            error={txError}
            transactions={transactions}
            onAdd={() => setAddTxOpen(true)}
            onDelete={(id) => setDeleteTarget(id)}
          />
          {/* 加载更多：append 模式续拉下一页。什么时候走到这里：还有下一页且不在加载中。 */}
          {hasMoreTransactions && !txLoading && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={() => loadTransactions(true)}>
                {t('common.loadMore')}
              </Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="realized" className="mt-0">
          {/* 已实现盈亏 Tab：加载中→骨架屏；出错→错误文案；无记录→空态；否则渲染汇总内容。 */}
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
            <div className="p-12 text-center text-destructive text-sm">{realizedPlError}</div>
          ) : !realizedPl || realizedPl.items.length === 0 ? (
            <div className="p-12">
              <Empty>
                <EmptyMedia variant="icon">
                  <TrendingUp />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>{t('ui.tx.emptyRealized')}</EmptyTitle>
                  <EmptyDescription>{t('ui.tx.emptyRealizedHint')}</EmptyDescription>
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

      {/* 新增交易弹窗：创建成功后重拉流水与已平仓并广播。 */}
      <AddTransactionDialog
        open={addTxOpen}
        onOpenChange={setAddTxOpen}
        onCreated={() => {
          loadTransactions();
          loadClosed();
          notifyPortfolioUpdate();
        }}
      />

      {/* 新增已平仓弹窗：创建成功后重拉已平仓与已实现盈亏。 */}
      <AddClosedDialog
        open={addClosedOpen}
        onOpenChange={setAddClosedOpen}
        onCreated={() => {
          loadClosed();
          loadRealizedPl();
        }}
      />

      {/* 删除确认弹窗：deleteTarget 非空时打开，取消即清空目标。 */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tx.deleteConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>{t('ui.tx.confirmDeleteDesc')}</AlertDialogDescription>
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
 * 已实现盈亏 Tab 内容：总盈亏横幅（各币种独立一行，不跨币种求和）、
 * 按 ticker 的桌面表格/移动卡片明细（按已实现盈亏降序）。
 *
 * 字段约定：totalByCurrency 与 realizedPl/returnPct 为字符串数值，
 * 判断正负/是否为 0 前先 parseFloat。
 */
function RealizedPlContent({
  summary,
  onAddClosed,
}: {
  summary: RealizedPlSummary;
  onAddClosed: () => void;
}) {
  const { t } = useTranslation();
  // 只保留数值非 0 的币种（字符串数值 parseFloat 后比较）。
  const currencies = Object.entries(summary.totalByCurrency).filter(
    ([, v]) => parseFloat(v || '0') !== 0,
  );
  // 明细按已实现盈亏从高到低排序。
  const sortedItems = [...summary.items].sort(
    (a, b) => parseFloat(b.realizedPl) - parseFloat(a.realizedPl),
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={onAddClosed}>
          <Plus className="size-4" />
          {t('ui.tx.addClosed')}
        </Button>
      </div>

      {/* 总览卡片：盈亏横幅（正数带 + 号）+ 胜/负笔数。 */}
      <Card className="overflow-hidden border-0 bg-muted/40">
        <CardContent className="p-6 md:p-8">
          <div className="text-sm font-medium text-muted-foreground">{t('tx.realizedPl')}</div>
          <div className="mt-2 font-mono-nums text-3xl md:text-4xl font-bold tracking-tight space-y-1">
            {currencies.map(([currency, value]) => (
              <div key={currency} className={plClass(value)}>
                {parseFloat(value) >= 0 ? '+' : ''}
                {formatCurrencyWithCurrency(value, currency)}
              </div>
            ))}
            {/* 所有币种都为 0 时显示占位。什么时候走到这里：currencies 为空。 */}
            {currencies.length === 0 && '—'}
          </div>
          <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="font-semibold text-success">{summary.totalWinners}</span>
              {t('ui.tx.countWinners')}
            </span>
            <span className="text-border">·</span>
            <span className="flex items-center gap-1">
              <span className="font-semibold text-destructive">{summary.totalLosers}</span>
              {t('ui.tx.countLosers')}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* 桌面明细表 */}
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
                    <div className="font-mono-nums font-semibold text-primary">{item.ticker}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-[180px]">
                      {item.company ?? '—'}
                    </div>
                  </TableCell>
                  <TableCell
                    className={cn('font-mono-nums font-semibold', plClass(item.realizedPl))}
                  >
                    {parseFloat(item.realizedPl) >= 0 ? '+' : ''}
                    {formatCurrencyWithCurrency(item.realizedPl, item.currency)}
                  </TableCell>
                  <TableCell
                    className={cn('text-right font-mono-nums font-medium', plClass(item.returnPct))}
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
                    <span className="text-xs text-muted-foreground font-mono">{item.currency}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 移动端卡片 */}
      <div className="md:hidden space-y-3">
        {sortedItems.map((item) => (
          <Card key={item.ticker}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="min-w-0 flex-1">
                  <div className="font-mono-nums font-bold text-primary text-lg">{item.ticker}</div>
                  <div className="text-sm text-muted-foreground truncate">
                    {item.company ?? '—'}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={cn('font-mono-nums text-lg font-semibold', plClass(item.realizedPl))}
                  >
                    {parseFloat(item.realizedPl) >= 0 ? '+' : ''}
                    {formatCurrencyWithCurrency(item.realizedPl, item.currency)}
                  </div>
                  <div className={cn('font-mono-nums text-sm', plClass(item.returnPct))}>
                    {formatPercent(item.returnPct)}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-sm pt-2 border-t border-border/50">
                <div>
                  <div className="text-xs text-muted-foreground">{t('tx.shares')}</div>
                  <div className="font-mono-nums">{formatShares(item.totalShares)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t('ui.tx.closeCount')}</div>
                  <div className="font-mono-nums">{item.closeCount}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t('ui.tx.recentClose')}</div>
                  <div className="font-mono-nums text-xs">{formatDate(item.lastCloseDate)}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
