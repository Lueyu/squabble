/**
 * WatchlistPage.tsx — 自选清单页（路由 /watchlist）。
 *
 * 职责边界：
 *  - 拉取并展示全部关注标的：桌面端表格 + 移动端卡片网格两套渲染，行/卡片
 *    点击进入 DetailDialog 查看/编辑；
 *  - 提供搜索（代码/公司名）、信号筛选与"新增关注"对话框（WatchForm）；
 *  - 自身不做行情轮询：实时报价由 useMarketQuotes hook 按当前列表的 ticker
 *    订阅，本页只负责把报价合并进展示。
 * 上下游：
 *  - 上游：路由 /watchlist（App 路由表）；
 *  - 下游：@/api 的 fetchWatchlist / createWatchItem、@/hooks/use-market-quotes
 *    （实时报价 + 市场状态）、@/utils/format 格式化工具、./DetailDialog、
 *    ./WatchForm、@/components/MarketStatusBadges。
 * 关键约定：
 *  - 价格类字段（entryPrice / currentPrice / targetBuy 及 quote.price /
 *    changePercent）均为"字符串数值"（string|null），展示前才 parseFloat，
 *    严禁提前转 number 破坏空值语义；
 *  - 当前价优先用实时报价 quote.price（合法时），否则回退库里的 currentPrice；
 *  - signal 存中文原文（如"强烈买入"），经 localizedSignal 映射 i18n key 展示，
 *    未命中映射时原样展示。
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

/** 信号筛选下拉选项：'all' + 四种信号；在组件外声明、渲染时传入 t 以支持 i18n。 */
function signalFilters(t: (k: string) => string): Array<{ value: 'all' | string; label: string }> {
  return [
    { value: 'all', label: t('watchlist.allSignals') },
    { value: '强烈买入', label: t('analysis.strongBuy') },
    { value: '买入', label: t('analysis.buy') },
    { value: '观望', label: t('analysis.watch') },
    { value: '回避', label: t('analysis.avoid') },
  ];
}

/** 把信号原文（中文或英文）映射为 i18n key 后翻译；未命中映射时原样返回。 */
function localizedSignal(signal: string, t: (k: string) => string): string {
  const keys: Record<string, string> = {
    强烈买入: 'analysis.strongBuy',
    'Strong Buy': 'analysis.strongBuy',
    买入: 'analysis.buy',
    Buy: 'analysis.buy',
    观望: 'analysis.watch',
    Watch: 'analysis.watch',
    回避: 'analysis.avoid',
    Avoid: 'analysis.avoid',
  };
  return keys[signal] ? t(keys[signal]) : signal;
}

/** 新增关注表单的空白初始值；dateAdded 默认取当天（YYYY-MM-DD）。 */
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

/** 字符串数值解析：空串/NaN 返回 undefined（提交 API 时空值不传）。 */
function parseNumber(v: string): number | undefined {
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

/**
 * 计算当前价低于目标买价的幅度（正百分数）。
 * 当前价 >= 目标价，或输入缺失/非法时返回 null（不展示提示）。
 */
function belowTargetPct(current: string | null, target: string | null): number | null {
  const c = parseFloat(current ?? '');
  const t = parseFloat(target ?? '');
  if (isNaN(c) || isNaN(t) || t <= 0) return null;
  if (c >= t) return null;
  return ((t - c) / t) * 100;
}

/**
 * 自选清单页组件。
 *
 * 状态：关注列表 items、搜索/信号筛选、详情对话框选中项、
 * 新增对话框开关与新建表单。
 */
function WatchlistPage() {
  // ---- 状态声明区 ----
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

  // ---- 数据获取区 ----
  // 报价订阅的 ticker 列表随 items 变化而更新。
  const tickers = useMemo(() => items.map((item) => item.ticker), [items]);

  // 实时报价、各市场开闭市状态与最近更新时间都来自同一个订阅 hook。
  const { quotes, marketStatus, marketErrors, lastUpdated } = useMarketQuotes(tickers);

  /** 拉取关注列表并写入状态；失败时同时写 error 状态并 toast。 */
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

  // 首次挂载拉取一次列表。
  useEffect(() => {
    void loadData();
  }, []);

  // ---- 派生计算区 ----
  /** 按搜索词（代码/公司名，大小写不敏感）与信号筛选过滤列表。 */
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item: WatchItem) => {
      if (signalFilter !== 'all' && item.signal !== signalFilter) return false;
      if (!q) return true;
      return (
        item.ticker.toLowerCase().includes(q) || (item.company ?? '').toLowerCase().includes(q)
      );
    });
  }, [items, search, signalFilter]);

  /** 展示用当前价：优先实时报价（合法时），否则回退库里存的 currentPrice。 */
  function getDisplayPrice(item: WatchItem): string {
    const quote = quotes[item.ticker];
    if (quote && quote.price !== undefined && !isNaN(parseFloat(quote.price))) {
      return quote.price;
    }
    return item.currentPrice ?? '';
  }

  // ---- 事件处理区 ----
  /** 打开所选关注项的详情对话框。 */
  const openDetail = (item: WatchItem) => {
    setSelected(item);
    setDetailOpen(true);
  };

  /** 校验并提交新建关注表单：成功后关对话框、重置表单并重新拉列表。 */
  const handleCreate = async () => {
    // 第一步：校验代码必填。
    if (!formData.ticker.trim()) {
      toast.error(t('ui.watchlist.enterTicker'));
      return;
    }
    // 第二步：提交 createWatchItem（空串字段转 undefined 不传）。
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
      // 第三步：成功后收尾。
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

  // 加载中先渲染骨架屏。
  if (loading) {
    return <WatchlistSkeleton />;
  }

  // ---- 渲染区 ----
  return (
    <div className="space-y-4 md:space-y-6">
      {/* 页头：标题 + 各市场开闭市状态徽章。 */}
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
      {/* 工具条：搜索框 + 信号筛选 + "新增关注"按钮（按钮即对话框触发器）。 */}
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
          <Select value={signalFilter} onValueChange={(v) => setSignalFilter(v as 'all' | Signal)}>
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
              <DialogTitle className="font-serif text-xl">{t('watchlist.addWatch')}</DialogTitle>
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

      {/* 加载失败横幅：展示错误信息并提供重试按钮。 */}
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

      {/* 桌面端表格（md 及以上可见）：有数据才渲染。 */}
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
                    // 每行先算"低于目标价幅度"，非 null 才在现价下方展示提示。
                    const belowPct = belowTargetPct(item.currentPrice, item.targetBuy);
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
                        {/* 信号列：有值才渲染彩色徽章，否则占位符。 */}
                        <TableCell>
                          {item.signal ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                'border-transparent font-medium',
                                signalColor(item.signal),
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
                        {/* 现价列：实时价优先，低于目标价时附绿色提示行。 */}
                        <TableCell className="text-right font-mono-nums">
                          {formatPrice(getDisplayPrice(item))}
                          {belowPct !== null && (
                            <div className="text-xs text-success">
                              {t('ui.watchlist.belowTarget')}{' '}
                              {formatPercent(belowPct).replace('+', '')}
                            </div>
                          )}
                        </TableCell>
                        {/* 涨跌幅列：有实时报价才展示，无报价时灰占位 '--'。 */}
                        {quotes[item.ticker] ? (
                          <TableCell
                            className={cn(
                              'text-right font-mono-nums font-medium',
                              plClass(quotes[item.ticker]?.changePercent ?? '0'),
                            )}
                          >
                            {quotes[item.ticker]?.changePercent !== undefined
                              ? formatPercent(quotes[item.ticker].changePercent)
                              : '--'}
                          </TableCell>
                        ) : (
                          <TableCell className="text-right">
                            <span className="text-muted-foreground/60 font-mono-nums">--</span>
                          </TableCell>
                        )}
                        <TableCell className="text-right font-mono-nums">
                          {formatPrice(item.targetBuy)}
                        </TableCell>
                        {/* 评级列：原文直展示（rating 存英文原文，不走 i18n 映射）。 */}
                        <TableCell>
                          {item.rating ? (
                            <Badge
                              variant="outline"
                              className={cn('border-transparent text-xs', ratingColor(item.rating))}
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

      {/* 移动端卡片网格（md 以下可见）：与表格同数据、字段精简。 */}
      {!loading && !error && filteredItems.length > 0 && (
        <div className="grid gap-3 md:hidden">
          {filteredItems.map((item: WatchItem) => {
            const belowPct = belowTargetPct(item.currentPrice, item.targetBuy);
            return (
              <Card
                key={item.id}
                onClick={() => openDetail(item)}
                className="cursor-pointer transition-colors"
              >
                <CardContent className="p-4">
                  {/* 卡片头：代码 + 信号徽章 + 公司名，右侧眼睛图标提示可点开。 */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono-nums text-lg font-bold">{item.ticker}</span>
                        {item.signal && (
                          <Badge
                            variant="outline"
                            className={cn('border-transparent text-xs', signalColor(item.signal))}
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
                  {/* 四列指标：现价 / 涨跌幅 / 目标价 / 建仓价。 */}
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
                            plClass(quotes[item.ticker]?.changePercent ?? '0'),
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
                  {/* 低于目标价提示（与表格行为一致）。 */}
                  {belowPct !== null && (
                    <div className="mt-2 text-xs text-success">
                      {t('ui.watchlist.belowTarget')} {formatPercent(belowPct).replace('+', '')}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* 空状态：区分"真的没有关注"与"被筛选条件滤空"两种文案。 */}
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

      {/* 详情对话框：编辑/删除回调后都重新拉列表。 */}
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

/** 列表加载中的骨架屏（工具条 + 6 行占位）。 */
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
