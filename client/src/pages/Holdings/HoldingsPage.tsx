/**
 * HoldingsPage.tsx — 持仓页（路由 `/holdings`）：持仓的列表、筛选、排序与管理入口。
 *
 * 职责边界：
 *  - 页面编排层：组合桌面表格（HoldingsTable）、移动端卡片（HoldingsMobileList）、
 *    持仓详情对话框、新增持仓对话框与 AI 分析运行详情弹窗；
 *  - 数据层：并行拉取持仓 / 分组 / 现金账户 / 总览，并经 useMarketQuotes 订阅实时行情，
 *    用最新报价覆盖 currentPrice 重新推导市值 / 盈亏；
 *  - 交互层：搜索、分组筛选、多市场筛选（US/HK/CN 徽标多选）、列排序。
 * 上下游：
 *  - 上游：路由 /holdings 的直接入口；
 *  - 下游：HoldingsTable / HoldingsMobileList / HoldingDetailDialog / AddHoldingDialog /
 *    AgentRunDetailModal，@/api 的 fetch* 与 getLatestRatings / getAgentRuns，
 *    @/hooks/use-market-quotes 的实时行情订阅。
 * 关键约定：
 *  - Holding 原始字段的 shares / buyPrice / currentPrice 是"字符串数值"，
 *    在 computeDerived / enrichedHoldings 中 parseFloat 转 number 参与运算——
 *    派生字段 marketValue / cost / pl / returnPct 一律是 number；
 *  - 市值与盈亏用实时行情价重算（q.price 也是"字符串数值"），无报价时回退 stored currentPrice；
 *  - window 事件 'portfolio-updated' 触发全量刷新（其他页面增删改后广播）；
 *  - 排序：点击已排序列仅翻转方向；切到新列时数值列默认降序、文本列默认升序。
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
import {
  fetchHoldings,
  fetchGroups,
  fetchCashAccounts,
  fetchDashboard,
  getLatestRatings,
  getAgentRuns,
} from '@/api';
import { useMarketQuotes } from '@/hooks/use-market-quotes';
import { formatCurrencyWithCode, plClass, cn } from '@/utils/format';
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
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

/** 持仓表可排序的列。 */
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

/** 在 Holding 原始记录上追加派生数值字段的形状。 */
interface DerivedHolding extends Holding {
  marketValue: number;
  cost: number;
  pl: number;
  returnPct: number;
}

/**
 * 由原始持仓计算派生市值、成本、盈亏与收益率。
 * @param h - 原始持仓（数字字段为"字符串数值"）。
 * @returns 附加了 number 派生字段的持仓。
 */
function computeDerived(h: Holding): DerivedHolding {
  // 第一步：把字符串数值字段转 number（空串兜底为 0）。
  const shares = parseFloat(h.shares || '0');
  const buyPrice = parseFloat(h.buyPrice || '0');
  const currentPrice = parseFloat(h.currentPrice || '0');
  // 第二步：推导市值 / 成本 / 盈亏；成本为 0 时收益率记 0（避免除零）。
  const marketValue = shares * currentPrice;
  const cost = shares * buyPrice;
  const pl = marketValue - cost;
  const returnPct = cost > 0 ? (pl / cost) * 100 : 0;
  return { ...h, marketValue, cost, pl, returnPct };
}

/**
 * 持仓列表页。
 *
 * 状态分组：原始数据（holdings / groups / cash / overview）、筛选与排序控件、
 * 详情对话框的选中持仓、新增对话框开关、市场多选集合、AI 评级映射与待人工复核数量。
 */
export default function HoldingsPage() {
  // ---- 状态声明区 ----
  const { t } = useTranslation();
  // 原始数据（holdings 已经过 computeDerived 附加派生字段）。
  const [holdings, setHoldings] = useState<DerivedHolding[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 筛选与排序控件。
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('marketValue');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // 详情 / 新增对话框状态。
  const [detailOpen, setDetailOpen] = useState(false);
  const [selected, setSelected] = useState<Holding | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // 市场多选（初始三个市场全选）。
  const [selectedMarkets, setSelectedMarkets] = useState<Set<Market>>(new Set(['US', 'HK', 'CN']));
  // 现金账户与总览（均允许拉取失败，失败时用空值兜底）。
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([]);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  // AI 评级映射（ticker → 最新评级）与加载标记。
  const [aiRatings, setAiRatings] = useState<Record<string, LatestRating>>({});
  const [aiRatingsLoading, setAiRatingsLoading] = useState(false);
  // 待人工复核的运行数量（>0 时显示风险提醒横幅）。
  const [awaitingHumanCount, setAwaitingHumanCount] = useState(0);
  // AI 运行详情弹窗状态。
  const [aiDetailRunId, setAiDetailRunId] = useState<string | null>(null);
  const [aiDetailOpen, setAiDetailOpen] = useState(false);

  // ---- 数据获取区 ----
  // 当前持仓的代码列表，作为行情订阅的 key。
  const tickers = useMemo(() => holdings.map((h) => h.ticker), [holdings]);

  // 实时行情订阅：quotes / 各市场开闭市状态 / 行情错误 / 最后更新时间。
  const {
    quotes,
    marketStatus,
    marketErrors,
    lastUpdated,
    refresh: refreshQuotes,
  } = useMarketQuotes(tickers);

  /**
   * 拉取所有代码的最新已发布 AI 评级。失败静默——评级只是增强信息，不阻塞列表渲染。
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

  /** 统计等待人工决策的运行数量（驱动风险提醒横幅）。失败静默。 */
  const loadAwaitingHuman = async () => {
    try {
      const result = await getAgentRuns({ status: 'awaiting_human', limit: 10 });
      const items = (result?.items ?? []) as AgentRun[];
      setAwaitingHumanCount(result?.total ?? items.length);
    } catch (err) {
      // 静默失败
    }
  };

  /** 并行拉取持仓 / 分组 / 现金账户 / 总览；现金与总览单独 catch 用空值兜底。 */
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

  // ---- 事件处理区 ----
  /** 打开某代码的 AI 运行详情弹窗（runId 由子组件给出）。 */
  const handleViewAiAnalysis = (ticker: string, runId: string) => {
    setAiDetailRunId(runId);
    setAiDetailOpen(true);
  };

  /** 按具体 runId 打开 AI 运行详情弹窗。 */
  const handleViewFullAnalysis = (runId: string) => {
    setAiDetailRunId(runId);
    setAiDetailOpen(true);
  };

  // 首挂：加载全量数据；并订阅 'portfolio-updated' 窗口事件做全量刷新。
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

  /** 列头排序：点击已排序列仅翻转方向；新列按类型决定初始方向（数值列降序、文本列升序）。 */
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

  // ---- 派生计算区 ----
  /**
   * 用最新实时报价重推市值 / 盈亏，覆盖存储的 currentPrice；无报价或价格非法时回退原始行。
   */
  const enrichedHoldings = useMemo<DerivedHolding[]>(() => {
    return holdings.map((h) => {
      // 无该代码的报价或价格未定义 → 原样返回。
      const q: QuoteResponse | undefined = quotes[h.ticker];
      if (!q || q.price === undefined) return h;
      // 报价价格是"字符串数值"，parseFloat 后非法也原样返回。
      const quotePrice = parseFloat(q.price);
      if (isNaN(quotePrice)) return h;
      // 用实时价重算派生字段；currentPrice 一并替换为报价（转回字符串保持双轨一致）。
      const shares = parseFloat(h.shares || '0');
      const buyPrice = parseFloat(h.buyPrice || '0');
      const marketValue = shares * quotePrice;
      const cost = shares * buyPrice;
      const pl = marketValue - cost;
      const returnPct = cost > 0 ? (pl / cost) * 100 : 0;
      return { ...h, currentPrice: String(quotePrice), marketValue, cost, pl, returnPct };
    });
  }, [holdings, quotes]);

  /** 依次应用搜索 / 分组 / 市场筛选，再按当前列与方向排序（副本上排序，不改原数组）。 */
  const filtered = useMemo(() => {
    let list = [...enrichedHoldings];
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (h) => h.ticker.toLowerCase().includes(q) || (h.company ?? '').toLowerCase().includes(q),
      );
    }
    if (groupId) {
      list = list.filter((h) => h.groupId === groupId);
    }
    // 市场多选为空集合时不按市场过滤（全放行）。
    if (selectedMarkets.size > 0) {
      list = list.filter((h) => selectedMarkets.has(h.market));
    }
    list.sort((a, b) => {
      // 排序键动态取自对象；字符串数值字段（shares/buyPrice/currentPrice）按 Number 化的数值比。
      const va = (a as unknown as Record<string, unknown>)[sortKey];
      const vb = (b as unknown as Record<string, unknown>)[sortKey];
      let cmp: number;
      if (['shares', 'buyPrice', 'currentPrice'].includes(sortKey)) {
        // 空值 / null → NaN：非有限值一律排在有限值之后。
        const na = va === null || va === undefined || va === '' ? NaN : Number(va);
        const nb = vb === null || vb === undefined || vb === '' ? NaN : Number(vb);
        if (!Number.isFinite(na)) return Number.isFinite(nb) ? 1 : 0;
        if (!Number.isFinite(nb)) return -1;
        cmp = na - nb;
      } else if (typeof va === 'number' && typeof vb === 'number') {
        // 已派生的 number 字段直接相减。
        cmp = va - vb;
      } else {
        // 其余（文本字段）按字符串本地化比较。
        cmp = String(va ?? '').localeCompare(String(vb ?? ''));
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [enrichedHoldings, search, groupId, selectedMarkets, sortKey, sortDir]);

  /** 打开某行的持仓详情对话框。 */
  const openDetail = (h: DerivedHolding) => {
    setSelected(h);
    setDetailOpen(true);
  };

  // 总览合计：overview 的 totalMv / totalPl 是"字符串数值"，parseFloat 转 number。
  const totalMv = overview ? parseFloat(overview.totalMv || '0') : 0;
  const totalPl = overview ? parseFloat(overview.totalPl || '0') : 0;
  const displayCurrency = overview?.baseCurrency ?? 'USD';

  // ---- 渲染区 ----
  return (
    <div className="space-y-5">
      {/* Header：标题 + 市场状态徽标 + 汇总（数量/总市值/浮动盈亏）+ 刷新与新增按钮。 */}
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
            <span className={cn('font-mono-nums font-medium', plClass(totalPl))}>
              {formatCurrencyWithCode(totalPl, displayCurrency)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* 刷新：同时刷新行情与全量数据；loading 时转圈。 */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              refreshQuotes();
              loadData();
            }}
            disabled={loading}
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            {t('ui.tx.refresh')}
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            {t('holdings.addHolding')}
          </Button>
        </div>
      </div>

      {/* Pending analysis reviews：有待人工复核的 AI 运行时显示风险提醒横幅。 */}
      {awaitingHumanCount > 0 && (
        <Alert className="border-warning/35 bg-warning/10 text-foreground">
          <AlertTriangle className="size-4 text-warning" />
          <AlertTitle className="font-medium">{t('ui.holdings.riskAlert')}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3 text-muted-foreground">
            <span>{t('ui.holdings.riskMessage', { count: awaitingHumanCount })}</span>
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

      {/* Market Filter：US/HK/CN 多选徽标，点击切换选中集合。 */}
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
                active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
              )}
              onClick={() => {
                // 不可变更新：复制 Set 再增删，保证重渲染。
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

      {/* Filters：搜索框（按代码/公司名）+ 分组下拉（空 value = 全部分组）。 */}
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

      {/* Desktop Table：桌面端总表（md 以下由 CSS 隐藏）。 */}
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

      {/* Mobile Cards：移动端卡片列表（md 以上由 CSS 隐藏）。 */}
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

      {/* 持仓详情对话框：选中行数据 + 最新 AI 评级。 */}
      <HoldingDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        holding={selected}
        groups={groups}
        onUpdated={loadData}
        onDeleted={loadData}
        aiRating={selected ? (aiRatings[selected.ticker] ?? null) : null}
        onViewFullAnalysis={handleViewFullAnalysis}
      />

      {/* AI 运行详情弹窗：按 runId 展示一次多智能体运行的完整过程。 */}
      <AgentRunDetailModal
        open={aiDetailOpen}
        onOpenChange={setAiDetailOpen}
        runId={aiDetailRunId}
      />

      {/* 新增持仓对话框：创建成功或新建分组后都触发全量刷新。 */}
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
