/**
 * HoldingsMobileList.tsx — 持仓的移动端卡片列表（md 以下断点可见，桌面表格在 HoldingsTable）。
 *
 * 职责边界：
 *  - 每条持仓一张"点击展开"卡片：头部是代码 + 评级徽标 + 公司名 + 现价 + 收益率；
 *    收起态网格展示股数 / 市值 / 成本 / 盈亏；展开区补充买入价、操作建议、
 *    AI 评级、所属分组与"查看详情"按钮；
 *  - 展开为手风琴语义：同一时刻最多展开一张卡（expanded 存单条持仓 id）；
 *  - 不发请求、不持业务数据：持仓、分组、AI 评级与回调全部来自父组件 HoldingsPage。
 * 上下游：
 *  - 上游：HoldingsPage（mobile 视图分支）；
 *  - 下游：@/components/MultiAgent 的 RatingBadge / ConfidenceBadge（AI 评级徽标）、
 *    @/utils/format 的 formatShares / formatPercent / plClass / ratingColor / actionColor /
 *    formatPriceWithCurrency / formatCurrencyWithCurrency / cn、@/components/ui 的 Card / Button / Badge / Skeleton / Empty。
 * 关键约定：
 *  - DerivedHolding 双轨字段：buyPrice / currentPrice / shares 为"字符串数值"
 *    （服务端序列化约定，展示走 format* 工具），marketValue / cost / pl / returnPct
 *    则是父组件已算好的 number——两层类型不要混用；
 *  - aiRatings 以 ticker 为 key；hasAnyAiRating 为 false 时整个 AI 评级行不渲染；
 *  - 操作建议（action）库中存中 / 英文原文，展示经 actionLabel 映射 i18n，未命中原样展示。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Briefcase, Plus, Eye } from 'lucide-react';
import type { Group, Market, Currency, AgentRating, AgentConfidence } from '@shared/api.interface';
import RatingBadge from '@/components/MultiAgent/RatingBadge';
import ConfidenceBadge from '@/components/MultiAgent/ConfidenceBadge';
import {
  formatShares,
  formatPercent,
  plClass,
  ratingColor,
  actionColor,
  cn,
  formatPriceWithCurrency,
  formatCurrencyWithCurrency,
} from '@/utils/format';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, badgeVariants } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

/** 移动端列表使用的持仓行模型：原始字符串字段 + 父组件派生的 number 字段。 */
interface DerivedHolding {
  id: string;
  ticker: string;
  company: string | null;
  /** 买入价（字符串数值）；未知为 null。 */
  buyPrice: string | null;
  /** 现价（字符串数值）；未知为 null。 */
  currentPrice: string | null;
  /** 股数（字符串数值）。 */
  shares: string;
  rating: string | null;
  action: string | null;
  groupId: string | null;
  market: Market;
  currency: Currency;
  /** 以下四个为父组件已换算好的 number（非字符串数值）。 */
  marketValue: number;
  cost: number;
  pl: number;
  returnPct: number;
}

/** 挂在某条持仓上的 AI 评级信息（按 ticker 索引）。 */
interface AiRatingInfo {
  rating: AgentRating;
  confidence: AgentConfidence;
  runId: string;
  bullSummary?: string | null;
  bearSummary?: string | null;
}

/** {@link HoldingsMobileList} 的入参。 */
interface HoldingsMobileListProps {
  /** 加载中标记：为 true 时渲染骨架屏。 */
  loading: boolean;
  /** 加载错误文案：非 null 时渲染错误态（其余数据忽略）。 */
  error: string | null;
  /** 持仓列表（字段约定见 DerivedHolding）。 */
  holdings: DerivedHolding[];
  /** 分组列表（groupId → 名称的映射来源）。 */
  groups: Group[];
  /** 空态里"新增持仓"按钮的点击回调。 */
  onAdd: () => void;
  /** "查看详情"按钮回调（父组件打开 HoldingDetailDialog）。 */
  onDetail: (h: DerivedHolding) => void;
  /** AI 评级映射（key = ticker）；缺省视为没有任何 AI 评级。 */
  aiRatings?: Record<string, AiRatingInfo>;
  /** AI 评级旁的眼睛按钮回调（父组件打开 AI 分析详情）。 */
  onViewAiAnalysis?: (ticker: string, runId: string) => void;
}

/**
 * 渲染移动端持仓卡片列表（点击头部展开 / 收起）。
 * @param props - 见 {@link HoldingsMobileListProps}。
 */
export default function HoldingsMobileList({
  loading,
  error,
  holdings,
  groups,
  onAdd,
  onDetail,
  aiRatings,
  onViewAiAnalysis,
}: HoldingsMobileListProps) {
  const { t } = useTranslation();
  // 状态声明区：当前展开卡的持仓 id（null = 全部收起）。
  const [expanded, setExpanded] = useState<string | null>(null);

  // 派生计算区：分组名查找 + 操作建议本地化。
  const groupName = (id: string | null) =>
    groups.find((g) => g.id === id)?.name ?? t('holdings.noGroup');
  // 操作建议（库中存中 / 英文原文）→ i18n 文案；映射表未收录的原样返回。
  const actionLabel = (value: string) => {
    const keys: Record<string, string> = {
      加仓: 'analysis.add',
      Add: 'analysis.add',
      买入: 'analysis.buy',
      Buy: 'analysis.buy',
      持有: 'analysis.hold',
      Hold: 'analysis.hold',
      减仓: 'analysis.reduce',
      Reduce: 'analysis.reduce',
      卖出: 'analysis.sell',
      Sell: 'analysis.sell',
      观望: 'analysis.watch',
      Watch: 'analysis.watch',
    };
    return keys[value] ? t(keys[value]) : value;
  };
  // 是否存在任意 AI 评级：为 false 时卡片里的 AI 行整体不渲染。
  const hasAnyAiRating = Object.keys(aiRatings ?? {}).length > 0;

  // 加载中：3 张骨架卡片占位。
  if (loading) {
    return (
      <div className="md:hidden space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4 space-y-3">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-8 w-32" />
              <div className="grid grid-cols-2 gap-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  // 错误态：整块显示错误文案（文案由父组件生成）。
  if (error) {
    return <div className="p-8 text-center text-destructive text-sm md:hidden">{error}</div>;
  }

  // 空态：没有任何持仓时，给一句提示 + 新增入口。
  if (holdings.length === 0) {
    return (
      <div className="md:hidden">
        <Empty>
          <EmptyMedia variant="icon">
            <Briefcase />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{t('holdings.noHoldings')}</EmptyTitle>
            <EmptyDescription>{t('ui.holdings.emptyMobileHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={onAdd}>
              <Plus className="size-4" />
              {t('holdings.addHolding')}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  // 正常态：逐条渲染可展开卡片。
  return (
    <div className="md:hidden space-y-3">
      {holdings.map((h) => (
        <Card key={h.id} className="overflow-hidden">
          <CardContent className="p-4">
            {/* 可点击头部：代码 + 评级徽标 + 公司名（左），现价 + 收益率（右）。 */}
            {/* 点击切换本卡的展开态（手风琴：再点一次收起，或换另一张展开）。 */}
            <button
              type="button"
              id={`holding-trigger-${h.id}`}
              className="w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${h.ticker} · ${t('ui.holdings.viewDetails')}`}
              aria-expanded={expanded === h.id}
              aria-controls={`holding-details-${h.id}`}
              onClick={() => setExpanded(expanded === h.id ? null : h.id)}
            >
              <span className="flex flex-wrap items-start justify-between gap-3">
                <span className="min-w-0 flex-1 basis-32">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-mono-nums font-bold text-primary text-lg">
                      {h.ticker}
                    </span>
                    {/* 评级徽标：有评级才渲染，颜色随评级值。 */}
                    {h.rating && (
                      <span
                        className={cn(
                          badgeVariants({ variant: 'outline' }),
                          ratingColor(h.rating),
                          'text-[10px]',
                        )}
                      >
                        {h.rating}
                      </span>
                    )}
                  </span>
                  <span className="block text-sm text-muted-foreground mt-0.5 truncate">
                    {h.company ?? '—'}
                  </span>
                </span>
                <span className="min-w-0 max-w-full text-right">
                  {/* 现价：字符串数值走 formatPriceWithCurrency；收益率：number 走 formatPercent。 */}
                  <span className="block break-all font-mono-nums text-xl font-semibold">
                    {formatPriceWithCurrency(h.currentPrice, h.currency)}
                  </span>
                  <span
                    className={cn('block font-mono-nums text-sm font-medium', plClass(h.returnPct))}
                  >
                    {formatPercent(h.returnPct)}
                  </span>
                </span>
              </span>
            </button>

            {/* 收起态四格：股数（字符串数值）/ 市值 / 成本 / 盈亏（均为父组件算好的 number）。 */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 mt-3 text-sm">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-muted-foreground">{t('holdings.shares')}</span>
                <span className="break-all font-mono-nums">{formatShares(h.shares)}</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-muted-foreground">{t('ui.holdings.marketValue')}</span>
                <span className="break-all font-mono-nums">
                  {formatCurrencyWithCurrency(h.marketValue, h.currency)}
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-muted-foreground">{t('ui.holdings.cost')}</span>
                <span className="break-all font-mono-nums">
                  {formatCurrencyWithCurrency(h.cost, h.currency)}
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-muted-foreground">{t('ui.holdings.pl')}</span>
                <span className={cn('break-all font-mono-nums font-medium', plClass(h.pl))}>
                  {formatCurrencyWithCurrency(h.pl, h.currency)}
                </span>
              </div>
            </div>

            {/* 展开区：仅当本卡处于展开态时可见（hidden 控制显隐，DOM 始终存在）。 */}
            <div
              id={`holding-details-${h.id}`}
              role="region"
              aria-labelledby={`holding-trigger-${h.id}`}
              hidden={expanded !== h.id}
              className="mt-3 pt-3 border-t space-y-2 text-sm"
            >
              <div className="flex flex-wrap justify-between gap-2">
                <span className="text-muted-foreground">{t('holdings.buyPrice')}</span>
                <span className="font-mono-nums">
                  {/* buyPrice 为字符串数值，走 formatPriceWithCurrency。 */}
                  {formatPriceWithCurrency(h.buyPrice, h.currency)}
                </span>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <span className="text-muted-foreground">{t('ui.holdings.actions')}</span>
                <span>
                  {/* 操作建议：有值渲染徽标（颜色随操作），无值显示 —。 */}
                  {h.action ? (
                    <Badge className={cn(actionColor(h.action))} variant="outline">
                      {actionLabel(h.action)}
                    </Badge>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
              {/* AI 评级行：全局存在 AI 评级时才渲染；本持仓未评级则显示占位文案。 */}
              {hasAnyAiRating && (
                <div className="flex flex-wrap justify-between items-center gap-2">
                  <span className="text-muted-foreground">{t('ui.holdings.aiRating')}</span>
                  {aiRatings?.[h.ticker] ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <RatingBadge rating={aiRatings[h.ticker].rating} size="sm" />
                      <ConfidenceBadge confidence={aiRatings[h.ticker].confidence} size="sm" />
                      {/* 眼睛按钮：跳转 AI 分析详情（runId 随评级下发）。 */}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label={`${t('ui.holdings.aiRating')} · ${h.ticker}`}
                        onClick={() => {
                          onViewAiAnalysis?.(h.ticker, aiRatings[h.ticker].runId);
                        }}
                      >
                        <Eye className="size-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground/70">
                      {t('ui.holdings.notRated')}
                    </span>
                  )}
                </div>
              )}
              <div className="flex flex-wrap justify-between gap-2">
                <span className="text-muted-foreground">{t('ui.holdings.group')}</span>
                <span className="min-w-0 break-words text-xs">{groupName(h.groupId)}</span>
              </div>
              {/* 查看详情：整卡宽度按钮，回调父组件打开详情对话框。 */}
              <Button
                size="sm"
                variant="outline"
                className="w-full mt-2"
                onClick={() => {
                  onDetail(h);
                }}
              >
                {t('ui.holdings.viewDetails')}
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
