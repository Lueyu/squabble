/**
 * DashboardPage.tsx — 路由 `/`：投资组合总览首页。
 *
 * 职责边界：
 *  - 顶部指标卡（账户净值、市值、成本、现金、累计盈亏、收益率）；
 *  - AI 分析状态卡（运行中 / 待人工决策 / 已完成数量、最近评级、硬规则风闸不通过数）；
 *  - 每日盈亏图表 + 个股盈亏明细（DailyPlChart / DailyPnLBreakdown）；
 *  - 按市场分组的持仓（桌面端表格，移动端卡片）；
 *  - 分币种现金余额。
 * 上下游：
 *  - 上游：路由 `/`（App 路由表）；
 *  - 下游：fetchDashboard / fetchHoldings / fetchDailyPl / getAgentRuns（@/api）、
 *    useMarketQuotes（实时行情订阅）、DailyPlChart / DailyPnLBreakdown / MarketOverview（本目录子组件）。
 * 关键约定：
 *  - overview / holdings / daily PL 三请求并行，出错弹 toast，finally 清 loading；
 *  - 监听全局 `portfolio-updated` 事件重新加载——任何改动持仓的页面都能触发刷新；
 *  - 汇总币种（baseCurrency）与盈亏时间窗口（plRange）变化也触发重载。
 */
import { useMemo, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  TrendingUp,
  Wallet,
  PiggyBank,
  DollarSign,
  BarChart3,
  PieChart,
  ChevronDown,
  Clock,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Eye,
} from 'lucide-react';
import http from '@/api/http';
import { toast } from 'sonner';
import { fetchDashboard, fetchHoldings, fetchDailyPl, logger, getAgentRuns } from '@/api';
import type {
  DashboardOverview,
  GroupSummary,
  Holding,
  Currency,
  AgentRunWithRating,
  RiskGateResult,
} from '@shared/api.interface';
import RatingBadge from '@/components/MultiAgent/RatingBadge';
import ConfidenceBadge from '@/components/MultiAgent/ConfidenceBadge';
import { Mascot } from '@/components/Mascot';
import { useMarketQuotes } from '@/hooks/use-market-quotes';
import { MarketStatusBadges } from '@/components/MarketStatusBadges';
import { displayCompanyName } from '@/utils/company-name';
import {
  formatCurrencyWithCode,
  formatPercent,
  formatNumber,
  formatTime,
  plClass,
  cn,
} from '@/utils/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import DailyPlChart from './DailyPlChart';
import DailyPnLBreakdown from './DailyPnLBreakdown';
import MarketOverview from './MarketOverview';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import './dashboard-design.css';

/** 市场分组 → 展示文案 i18n key 的映射（已知市场用词条，未知分组回退原名）。 */
const MARKET_LABEL_KEYS: Record<string, string> = {
  US: 'common.usMarket',
  HK: 'common.hkMarket',
  CN: 'common.cnMarket',
};

/** 顶部指标卡的配置形状：标签、图标、取 overview 的哪个字段、格式化方式等。 */
interface MetricCard {
  label: string;
  icon: typeof Wallet;
  key: keyof Pick<
    DashboardOverview,
    'accountValue' | 'totalMv' | 'cost' | 'cash' | 'totalPl' | 'totalPct'
  >;
  format: (v: string | number | null | undefined, c: string) => string;
  large?: boolean;
  pl?: boolean;
  percent?: boolean;
}

/** 折算金额可选的基准（报告）币种。 */
/** 币种选择器选项（在组件外定义为纯函数，以便接入 i18n）。 */
function currencyOptions(t: (k: string) => string): { value: Currency; label: string }[] {
  return [
    { value: 'USD', label: t('common.usd') },
    { value: 'HKD', label: t('common.hkd') },
    { value: 'CNY', label: t('common.cny') },
  ];
}

/** {@link RealtimeBadge} 的入参。 */
interface RealtimeBadgeProps {
  marketStatus: Record<string, string>;
  holdings: Holding[];
}

/**
 * 实时行情徽标：只要任一持仓市场处于盘前 / 盘中 / 盘后交易，
 * 就显示绿色脉冲的 t('dash.realtime')，否则显示"已收盘"。
 */
function RealtimeBadge({ marketStatus, holdings }: RealtimeBadgeProps) {
  const { t } = useTranslation();
  const heldMarkets = new Set(holdings.map((h: Holding) => h.market));
  const heldActive = Array.from(heldMarkets).filter(
    (m) => marketStatus[m] === 'trading' || marketStatus[m] === 'pre' || marketStatus[m] === 'post',
  );
  const isRealtime = heldActive.length > 0;
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-5 px-2 text-[11px] font-medium',
        isRealtime
          ? 'bg-success/15 text-success border-transparent'
          : 'bg-muted text-muted-foreground border-transparent',
      )}
    >
      <span
        className={cn(
          'mr-1 inline-block size-1.5 rounded-full',
          isRealtime ? 'bg-success animate-pulse' : 'bg-muted-foreground/50',
        )}
      />
      {isRealtime ? t('dash.realtime') : t('layout.closed')}
    </Badge>
  );
}

/**
 * 仪表盘首页组件。
 *
 * 状态：overview 数据、持仓列表、每日盈亏序列、所选基准币种、
 * 盈亏时间窗口、今日 agent 运行列表、硬规则风闸失败数。
 */
export default function DashboardPage() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  // API 可能返回历史遗留的中文分组名；已知市场改用本地化词条，未知分组回退原名。
  const marketName = (group: GroupSummary): string => {
    const key = MARKET_LABEL_KEYS[group.groupId ?? ''];
    return key ? t(key) : group.groupName || t('holdings.noGroup');
  };
  // ===== 状态声明区 =====
  const [dashboard, setDashboard] = useState<DashboardOverview | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [dailyPl, setDailyPl] = useState<
    Array<{ date: string; accountValue: string; dailyPl: string; dailyPct: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [baseCurrency, setBaseCurrency] = useState<Currency>('USD');
  const [plRange, setPlRange] = useState<number>(30);
  const [agentRuns, setAgentRuns] = useState<AgentRunWithRating[]>([]);
  const [agentRunsLoading, setAgentRunsLoading] = useState(true);
  const [hardRuleFailures, setHardRuleFailures] = useState<number>(0);
  const [riskGateLoading, setRiskGateLoading] = useState(true);

  // ===== 数据获取区 =====
  const tickers = useMemo(() => holdings.map((h) => h.ticker), [holdings]);

  const { quotes, marketStatus, marketErrors, lastUpdated } = useMarketQuotes(tickers);

  /**
   * 按给定币种与时间窗口并行拉取 overview、持仓、每日盈亏。
   * 出错弹 toast；`loading` 在 finally 里统一清除。
   */
  const loadData = async (currency: Currency, range: number) => {
    try {
      const [dashData, holdingsData, plData] = await Promise.all([
        fetchDashboard(currency),
        fetchHoldings(),
        fetchDailyPl(range, currency),
      ]);
      setDashboard(dashData);
      setHoldings(holdingsData || []);
      setDailyPl(plData || []);
    } catch (error) {
      logger.error('Dashboard load failed', error);
      toast.error(t('ui.dashboard.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  // 币种 / 时间窗口变化时重载数据；同时订阅全局 `portfolio-updated` 事件
  // （其他页面改动持仓后触发），保持首页数据最新。mounted 防止卸载后 setState。
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    loadData(baseCurrency, plRange).then(() => {
      if (!mounted) return;
    });

    const handleUpdate = () => {
      if (!mounted) return;
      setLoading(true);
      loadData(baseCurrency, plRange);
    };
    window.addEventListener('portfolio-updated', handleUpdate);

    return () => {
      mounted = false;
      window.removeEventListener('portfolio-updated', handleUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseCurrency, plRange]);

  // ===== 派生计算区 =====
  // 六张顶部指标卡的配置（标签 / 图标 / 取值字段 / 格式化方式）。
  const metricCards: MetricCard[] = useMemo(
    () => [
      {
        label: t('dash.accountValue'),
        icon: Wallet,
        key: 'accountValue',
        format: formatCurrencyWithCode,
        large: true,
      },
      {
        label: t('dash.marketValue'),
        icon: TrendingUp,
        key: 'totalMv',
        format: formatCurrencyWithCode,
      },
      {
        label: t('dash.totalCost'),
        icon: PiggyBank,
        key: 'cost',
        format: formatCurrencyWithCode,
      },
      {
        label: t('dash.cashTotal'),
        icon: DollarSign,
        key: 'cash',
        format: formatCurrencyWithCode,
      },
      {
        label: t('dash.totalPl'),
        icon: BarChart3,
        key: 'totalPl',
        format: formatCurrencyWithCode,
        pl: true,
      },
      {
        label: t('dash.totalReturn'),
        icon: PieChart,
        key: 'totalPct',
        format: (v) => formatPercent(v),
        pl: true,
        percent: true,
      },
    ],
    [t],
  );

  /** 市场分组汇总，按市值降序，供"按市场"表格展示。 */
  const sortedMarkets = useMemo<GroupSummary[]>(() => {
    if (!dashboard?.groups) return [];
    return [...dashboard.groups].sort((a, b) => Number(b.marketValue) - Number(a.marketValue));
  }, [dashboard]);

  /** 从每日盈亏序列取最近一天的盈亏额与百分比。 */
  const dailyPlTotal = useMemo(() => {
    if (!dailyPl || dailyPl.length === 0) return { pl: '0', pct: '0' };
    const latest = dailyPl[dailyPl.length - 1];
    return { pl: latest.dailyPl, pct: latest.dailyPct };
  }, [dailyPl]);

  /** 按市场把持仓分桶，供移动端"每个市场一组持仓卡"渲染。 */
  const holdingsByMarket = useMemo(() => {
    const map = new Map<string, Holding[]>();
    for (const h of holdings) {
      const mkt = h.market || 'US';
      const list = map.get(mkt) ?? [];
      list.push(h);
      map.set(mkt, list);
    }
    return map;
  }, [holdings]);

  /** 把今日 agent 运行归类统计：运行中 / 待人工决策 / 已完成 三个桶。 */
  const runStats = useMemo(() => {
    const stats = {
      running: 0,
      awaiting: 0,
      completed: 0,
    };
    for (const run of agentRuns) {
      if (run.status === 'completed') {
        stats.completed += 1;
      } else if (run.status === 'awaiting_human') {
        stats.awaiting += 1;
      } else if (
        run.status === 'pending' ||
        run.status === 'fetching' ||
        run.status === 'debating' ||
        run.status === 'critiquing' ||
        run.status === 'risk_check'
      ) {
        stats.running += 1;
      }
    }
    return stats;
  }, [agentRuns]);

  /** 取第一个带评级的已完成运行，作为"最近完成"卡片的展示对象。 */
  const latestCompletedRun = useMemo(() => {
    const completed = agentRuns.filter(
      (r: AgentRunWithRating) => r.status === 'completed' && r.rating,
    );
    return completed.length > 0 ? completed[0] : null;
  }, [agentRuns]);

  // ===== 数据获取区（补充）：今日 AI 运行 + 硬规则风闸统计 =====
  // 加载今日 agent 运行；对每个已完成运行再查风闸结果，
  // 统计"硬规则不通过"的条数（软规则不计数；单次风闸查询失败按 0 条处理）。
  useEffect(() => {
    let mounted = true;
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

    const loadRuns = async () => {
      try {
        setAgentRunsLoading(true);
        setRiskGateLoading(true);
        const data = await getAgentRuns({
          from: dayStart.toISOString(),
          to: dayEnd.toISOString(),
          limit: 20,
        });
        if (!mounted) return;
        const items: AgentRunWithRating[] = data?.items ?? [];
        setAgentRuns(items);

        const completedIds = items
          .filter((r: AgentRunWithRating) => r.status === 'completed')
          .map((r: AgentRunWithRating) => r.id);

        if (completedIds.length === 0) {
          setHardRuleFailures(0);
          setRiskGateLoading(false);
          return;
        }

        const results = await Promise.all(
          completedIds.map(async (id: string) => {
            try {
              const res = await http({
                url: `/api/multi-agent/runs/${id}/risk-gate`,
                method: 'GET',
              });
              return (res.data as RiskGateResult[]) || [];
            } catch {
              return [] as RiskGateResult[];
            }
          }),
        );
        if (!mounted) return;

        let failures = 0;
        for (const gate of results) {
          for (const rule of gate) {
            if (rule.ruleType === 'hard' && !rule.passed) {
              failures += 1;
            }
          }
        }
        setHardRuleFailures(failures);
      } catch (error) {
        logger.error('AI analysis status load failed', error);
      } finally {
        if (mounted) {
          setAgentRunsLoading(false);
          setRiskGateLoading(false);
        }
      }
    };

    loadRuns();

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className="dashboard-page space-y-5">
      {/* ===== 渲染区 ===== */}
      {/* 欢迎横幅：吉祥物 + 市场开闭市状态 + 基准币种选择 */}
      <section className="dashboard-hero" aria-labelledby="dashboard-title">
        <div className="dashboard-hero-main">
          <div className="dashboard-mascot-frame" aria-hidden="true">
            <Mascot className="dashboard-hero-mascot" />
          </div>
          <div className="dashboard-hero-copy">
            <span className="dashboard-eyebrow">{t('auth.welcomeBack')}</span>
            <h1
              id="dashboard-title"
              className="font-serif text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
            >
              {t('dash.title')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('dash.subtitle')}</p>
            <div className="dashboard-market-status">
              <MarketStatusBadges
                marketStatus={marketStatus}
                marketErrors={marketErrors}
                lastUpdated={lastUpdated}
              />
            </div>
          </div>
        </div>
        <div className="dashboard-currency-control">
          <label htmlFor="dashboard-base-currency" className="text-xs text-muted-foreground">
            {t('ui.dashboard.baseCurrency')}
          </label>
          <Select value={baseCurrency} onValueChange={(v) => setBaseCurrency(v as Currency)}>
            <SelectTrigger id="dashboard-base-currency" className="w-[160px] bg-card">
              <SelectValue placeholder={t('ui.dashboard.baseCurrency')} />
            </SelectTrigger>
            <SelectContent>
              {currencyOptions(t).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      {/* 顶部指标卡：加载中渲染 6 张骨架卡，完成后渲染真实指标 */}
      <div className="dashboard-metrics" data-ai-section-type="card-stat">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} className="metric-card">
                <CardContent className="metric-card-content">
                  <Skeleton className="mb-2 h-4 w-16" />
                  <Skeleton className="h-7 w-24" />
                </CardContent>
              </Card>
            ))
          : metricCards.map((m) => {
              const value = dashboard ? dashboard[m.key] : '0';
              const colorCls = m.pl ? plClass(value) : 'text-foreground';
              const displayValue = m.percent
                ? formatPercent(value)
                : formatCurrencyWithCode(value, baseCurrency);
              return (
                <Card key={m.key} className={cn('metric-card', m.large && 'metric-card-primary')}>
                  <CardContent className="metric-card-content">
                    <div className="metric-label">
                      <m.icon size={15} className="metric-icon" aria-hidden="true" />
                      <span className="min-w-0">{m.label}</span>
                    </div>
                    <div
                      className={cn(
                        'metric-value font-mono font-semibold tabular-nums',
                        displayValue.length > 12 && 'metric-value-compact',
                        colorCls,
                      )}
                      title={displayValue}
                    >
                      {displayValue}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
      </div>

      <div className="dashboard-analysis-grid">
        <div className="min-w-0 space-y-5">
          <Card className="dashboard-panel dashboard-ai-card">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Sparkles size={16} className="dashboard-brand-icon shrink-0" />
                  <CardTitle className="font-serif text-base">{t('dash.aiStatus')}</CardTitle>
                </div>
                <Link
                  to="/analysis"
                  className="dashboard-detail-link flex shrink-0 items-center gap-0.5 text-xs hover:underline"
                >
                  {t('dash.viewAll')}
                  <ChevronDown size={12} className="-rotate-90" />
                </Link>
              </div>
            </CardHeader>
            <CardContent className="dashboard-ai-content space-y-4">
              {/* AI 分析状态卡：加载中先出骨架，完成后为三段——运行统计 / 最近完成 / 风闸 */}
              {agentRunsLoading ? (
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <Skeleton className="h-10 flex-1" />
                    <Skeleton className="h-10 flex-1" />
                    <Skeleton className="h-10 flex-1" />
                  </div>
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : (
                <>
                  <div className="dashboard-ai-stats">
                    <div className="dashboard-ai-stat">
                      <div className="dashboard-ai-stat-label">
                        <Loader2
                          size={12}
                          className={cn(
                            'dashboard-brand-icon shrink-0',
                            runStats.running > 0 && 'animate-spin',
                          )}
                        />
                        {t('dash.inProgress')}
                      </div>
                      <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-foreground">
                        {runStats.running}
                      </div>
                    </div>
                    <div className="dashboard-ai-stat">
                      <div className="dashboard-ai-stat-label">
                        <Eye size={12} className="shrink-0 text-warning" />
                        {t('dash.awaitingDecision')}
                      </div>
                      <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-warning">
                        {runStats.awaiting}
                      </div>
                    </div>
                    <div className="dashboard-ai-stat">
                      <div className="dashboard-ai-stat-label">
                        <CheckCircle2 size={12} className="shrink-0 text-success" />
                        {t('dash.completed')}
                      </div>
                      <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-success">
                        {runStats.completed}
                      </div>
                    </div>
                  </div>

                  <div className="dashboard-ai-result">
                    <div className="mb-1.5 text-xs text-muted-foreground">
                      {t('dash.recentCompleted')}
                    </div>
                    {/* 什么时候走到这里：今日已有带评级的完成运行——展示最近一次的评级 + 置信度 */}
                    {latestCompletedRun?.rating ? (
                      <div className="dashboard-latest-result">
                        <div className="dashboard-latest-company font-medium text-foreground">
                          {latestCompletedRun.ticker}
                          {latestCompletedRun.tickerName && (
                            <span className="block text-xs font-normal text-muted-foreground">
                              {displayCompanyName(
                                latestCompletedRun.tickerName,
                                latestCompletedRun.ticker,
                                language,
                              )}
                            </span>
                          )}
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <RatingBadge rating={latestCompletedRun.rating.rating} size="sm" />
                          <ConfidenceBadge
                            confidence={latestCompletedRun.rating.confidence}
                            size="sm"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        {t('ui.dashboard.noCompletedToday')}
                      </div>
                    )}
                  </div>

                  <div className="dashboard-ai-risk">
                    <div className="mb-1.5 text-xs text-muted-foreground">
                      {t('dash.riskAlerts')}
                    </div>
                    {/* 风闸区：加载中骨架 → 有硬规则不通过时告警 → 否则显示全部通过 */}
                    {riskGateLoading ? (
                      <div className="flex items-center gap-2">
                        <Skeleton className="h-4 w-32" />
                      </div>
                    ) : hardRuleFailures > 0 ? (
                      <div className="flex items-start gap-2">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
                        <span className="text-sm font-medium text-warning">
                          {t('ui.dashboard.hardRulesFailed', { count: hardRuleFailures })}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />
                        <span className="text-sm font-medium text-success">
                          {t('dash.allPassed')}
                        </span>
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <MarketOverview />
        </div>
        <Card className="dashboard-panel dashboard-performance-card">
          <CardHeader className="pb-3">
            <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <CardTitle className="font-serif text-lg">{t('dash.dailyPlOverview')}</CardTitle>
                {lastUpdated && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock size={12} />
                    {t('dash.lastUpdate', { time: formatTime(lastUpdated) })}
                  </span>
                )}
                <RealtimeBadge marketStatus={marketStatus} holdings={holdings} />
              </div>
              <Select value={String(plRange)} onValueChange={(v) => setPlRange(parseInt(v, 10))}>
                <SelectTrigger className="w-auto min-w-[140px] shrink-0">
                  <SelectValue placeholder={t('ui.dashboard.timeRange')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">{t('ui.dashboard.lastDays', { count: 7 })}</SelectItem>
                  <SelectItem value="30">{t('dash.last30d')}</SelectItem>
                  <SelectItem value="90">{t('ui.dashboard.lastDays', { count: 90 })}</SelectItem>
                  <SelectItem value="180">{t('ui.dashboard.lastDays', { count: 180 })}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {/* 每日盈亏卡：加载中骨架；完成后展示汇总数字 + 图表 + 个股明细 */}
            {loading ? (
              <div className="space-y-4">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-[280px] w-full" />
              </div>
            ) : (
              <div className="space-y-5">
                <div className="dashboard-performance-summary grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
                  <div>
                    <div className="text-xs text-muted-foreground">
                      {t('ui.dashboard.dailyPlForCurrency', { currency: baseCurrency })}
                    </div>
                    <div
                      className={cn(
                        'mt-1 font-mono text-2xl font-semibold tabular-nums',
                        plClass(dailyPlTotal.pl),
                      )}
                    >
                      {formatCurrencyWithCode(dailyPlTotal.pl, baseCurrency)}
                    </div>
                    <div
                      className={cn(
                        'mt-0.5 font-mono text-xs tabular-nums',
                        plClass(dailyPlTotal.pct),
                      )}
                    >
                      {formatPercent(dailyPlTotal.pct)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{t('dash.latestNav')}</div>
                    <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
                      {dailyPl.length > 0
                        ? formatCurrencyWithCode(
                            dailyPl[dailyPl.length - 1].accountValue,
                            baseCurrency,
                          )
                        : '—'}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t('dash.accountValue')}
                    </div>
                  </div>
                  {/* 第三格（日收益率）只在 md 及以上显示，小屏由第一格的百分比代替 */}
                  <div className="hidden md:block">
                    <div className="text-xs text-muted-foreground">{t('dash.dailyReturn')}</div>
                    <div
                      className={cn(
                        'mt-1 font-mono text-2xl font-semibold tabular-nums',
                        plClass(dailyPlTotal.pct),
                      )}
                    >
                      {formatPercent(dailyPlTotal.pct)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t('dash.vsPrevDay')}
                    </div>
                  </div>
                </div>
                <DailyPlChart data={dailyPl} baseCurrency={baseCurrency} />
                <div className="border-t border-border pt-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">{t('dash.plBreakdown')}</h3>
                    <span className="text-xs text-muted-foreground">
                      {t('dash.sortedByPl', { count: holdings.length })}
                    </span>
                  </div>
                  {/* 行情还没到手时让明细表先显示占位（有持仓但 quotes 为空也算 loading） */}
                  <DailyPnLBreakdown
                    holdings={holdings}
                    quotes={quotes}
                    baseCurrency={baseCurrency}
                    loading={loading || (holdings.length > 0 && Object.keys(quotes).length === 0)}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="dashboard-panel">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-3">
          <CardTitle className="font-serif text-lg">{t('dash.byMarket')}</CardTitle>
          <span className="text-xs text-muted-foreground">
            {t('dash.sortedByMv', { count: sortedMarkets.length })}
          </span>
        </CardHeader>
        <CardContent>
          {/* 按市场卡：加载骨架 → 无数据空态 → 正常展示（桌面表格 + 移动卡片） */}
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : sortedMarkets.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyTitle>{t('ui.dashboard.noMarketData')}</EmptyTitle>
                <EmptyDescription>{t('ui.dashboard.addHoldingsForMarkets')}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="space-y-6">
              {/* 桌面端：完整市场表格（md 以下隐藏） */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('dash.market')}</TableHead>
                      <TableHead className="text-right">{t('dash.holdingsCount')}</TableHead>
                      <TableHead className="text-right">{t('dash.mvOriginal')}</TableHead>
                      <TableHead className="text-right">{t('dash.cost')}</TableHead>
                      <TableHead className="text-right">{t('dash.pl')}</TableHead>
                      <TableHead className="text-right">{t('dash.returnPct')}</TableHead>
                      <TableHead className="text-right">{t('dash.mvShare')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedMarkets.map((g) => (
                      <TableRow key={g.groupId || 'unknown'}>
                        <TableCell>
                          <span className="font-medium">{marketName(g)}</span>
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {formatNumber(g.count, 0)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {formatCurrencyWithCode(g.marketValue, baseCurrency)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {formatCurrencyWithCode(g.cost, baseCurrency)}
                        </TableCell>
                        <TableCell
                          className={cn('text-right font-mono tabular-nums', plClass(g.pl))}
                        >
                          {formatCurrencyWithCode(g.pl, baseCurrency)}
                        </TableCell>
                        <TableCell
                          className={cn('text-right font-mono tabular-nums', plClass(g.returnPct))}
                        >
                          {formatPercent(g.returnPct)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                          {formatPercent(g.weight)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* 移动端：每个市场一组标题行；组内持仓卡片仅小屏显示（md:hidden） */}
              {sortedMarkets.map((g) => {
                const mkt = g.groupId || 'US';
                const mktHoldings = holdingsByMarket.get(mkt) ?? [];
                return (
                  <div key={mkt} className="space-y-2">
                    <div className="flex items-center justify-between border-b border-border pb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{marketName(g)}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatNumber(g.count, 0)} {t('dash.holdingsUnit')}
                        </span>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm font-semibold tabular-nums">
                          {formatCurrencyWithCode(g.marketValue, baseCurrency)}
                        </div>
                        <div className={cn('font-mono text-xs tabular-nums', plClass(g.returnPct))}>
                          {formatPercent(g.returnPct)}
                        </div>
                      </div>
                    </div>

                    {mktHoldings.length > 0 && (
                      <div className="md:hidden">
                        {mktHoldings.map((h) => {
                          const current = Number(h.currentPrice) || 0;
                          const buy = Number(h.buyPrice) || 0;
                          // 移动端卡片里现算涨跌幅（无买入价时按 0 处理）。
                          const pct = buy > 0 ? ((current - buy) / buy) * 100 : 0;
                          const company = displayCompanyName(h.company, h.ticker, language);
                          return (
                            <Card key={h.id} className="mb-2 p-3">
                              <div className="flex items-center justify-between">
                                <div>
                                  <div className="font-medium">{h.ticker}</div>
                                  <div className="text-xs text-muted-foreground">
                                    {company ?? <span className="text-muted-foreground/60">—</span>}
                                  </div>
                                </div>
                                <div className="text-right">
                                  <div className="font-mono tabular-nums">
                                    {formatCurrencyWithCode(
                                      h.currentPrice || '0',
                                      h.currency || 'USD',
                                    )}
                                  </div>
                                  <div
                                    className={cn(
                                      'font-mono text-xs tabular-nums',
                                      plClass(String(pct)),
                                    )}
                                  >
                                    {formatPercent(pct)}
                                  </div>
                                </div>
                              </div>
                            </Card>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="dashboard-panel">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-3">
          <CardTitle className="font-serif text-lg">{t('dash.cashDetail')}</CardTitle>
          <span className="text-xs text-muted-foreground">
            {t('dash.currencies', {
              count: dashboard?.cashByCurrency ? Object.keys(dashboard.cashByCurrency).length : 0,
            })}
          </span>
        </CardHeader>
        <CardContent>
          {/* 现金明细卡：加载骨架 → 有数据按币种铺开 → 无数据空态 */}
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : dashboard?.cashByCurrency ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {Object.entries(dashboard.cashByCurrency).map(([cur, bal]) => (
                <div
                  key={cur}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2"
                >
                  <span className="text-sm font-medium text-foreground">{cur}</span>
                  <span className="break-all font-mono text-sm tabular-nums">
                    {formatCurrencyWithCode(bal, cur)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty className="py-8">
              <EmptyHeader>
                <EmptyTitle>{t('ui.dashboard.noCashData')}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
