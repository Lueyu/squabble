/**
 * HoldingsTable.tsx — 桌面端持仓总表（`md` 以下隐藏，移动端由 HoldingsMobileList 承接）。
 *
 * 职责边界：
 *  - 纯展示组件：接收父组件算好派生值的持仓行，渲染可排序表格与按币种小计的页脚；
 *  - 排序本身不在这里做——点击列头只回调 onSort(key)，排序状态由父组件持有；
 *  - 加载 / 错误 / 空态三态兜底，空态内提供"新增持仓"入口。
 * 上下游：
 *  - 上游：HoldingsPage（传入 holdings / groups / cashAccounts / aiRatings 与各回调）；
 *  - 下游：@/utils/format 的格式化函数、@/components/MultiAgent 的 RatingBadge / ConfidenceBadge、
 *    @/components/ui 的 Table / Badge / Skeleton / Empty 等。
 * 关键约定：
 *  - DerivedHolding 双轨字段：buyPrice / currentPrice / shares 是"字符串数值"（原始精度保留），
 *    marketValue / cost / pl / returnPct 是父组件已算好的 number——展示层不做运算只做格式化；
 *  - 页脚现金余额 balance 同为"字符串数值"，汇总处 parseFloat(c.balance || '0') 兜底空串；
 *  - AI 评级列是条件列：仅当 aiRatings 非空时整列才存在（表头与单元格同步出现/消失）。
 */
import { ChevronDown, ChevronUp, Briefcase, Plus, Eye } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
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
import type { Group, Market, Currency, AgentRating, AgentConfidence } from '@shared/api.interface';
import RatingBadge from '@/components/MultiAgent/RatingBadge';
import ConfidenceBadge from '@/components/MultiAgent/ConfidenceBadge';
import { useTranslation } from 'react-i18next';

/** 持仓表可排序的列（与表头 onClick 一一对应）。 */
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

/** 表格使用的持仓行形状（原始字段 + 父组件算好的派生数值）。 */
interface DerivedHolding {
  id: string;
  ticker: string;
  company: string | null;
  buyPrice: string | null;
  currentPrice: string | null;
  shares: string;
  rating: string | null;
  action: string | null;
  groupId: string | null;
  market: Market;
  currency: Currency;
  marketValue: number;
  cost: number;
  pl: number;
  returnPct: number;
}

/** 页脚小计使用的现金账户行（balance 为"字符串数值"）。 */
interface CashAccountRow {
  currency: Currency;
  balance: string;
}

/** 挂在持仓行上的 AI 评级信息（来自多智能体分析运行结果）。 */
interface AiRatingInfo {
  rating: AgentRating;
  confidence: AgentConfidence;
  runId: string;
  bullSummary?: string | null;
  bearSummary?: string | null;
}

/** {@link HoldingsTable} 的入参。 */
interface HoldingsTableProps {
  loading: boolean;
  error: string | null;
  holdings: DerivedHolding[];
  groups: Group[];
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
  onAdd: () => void;
  onDetail: (h: DerivedHolding) => void;
  cashAccounts: CashAccountRow[];
  aiRatings?: Record<string, AiRatingInfo>;
  onViewAiAnalysis?: (ticker: string, runId: string) => void;
}

/**
 * 渲染桌面端持仓总表，含加载 / 错误 / 空态与按币种小计页脚。
 * @param props - 见 {@link HoldingsTableProps}。
 */
export default function HoldingsTable({
  loading,
  error,
  holdings,
  groups,
  sortKey,
  sortDir,
  onSort,
  onAdd,
  onDetail,
  cashAccounts,
  aiRatings,
  onViewAiAnalysis,
}: HoldingsTableProps) {
  // ---- 状态声明区 ----
  const { t } = useTranslation();

  // ---- 派生计算区 ----
  // 列头排序图标：非当前排序列显示半透明下箭头；当前列按方向显示上/下箭头。
  const SortIcon = ({ column }: { column: SortKey }) => {
    if (sortKey !== column) return <ChevronDown className="size-3 opacity-30" />;
    return sortDir === 'asc' ? (
      <ChevronUp className="size-3" />
    ) : (
      <ChevronDown className="size-3" />
    );
  };

  // 分组名查找：找不到（含 id 为 null）回退到"未分组"文案。
  const groupName = (id: string | null) =>
    groups.find((g) => g.id === id)?.name ?? t('holdings.noGroup');

  // 操作建议文案映射：历史数据可能是中文或英文原文，统一映射到 i18n key；未命中则原样展示。
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

  // 按币种累计持仓市值（marketValue 已是 number）。
  const mvByCurrency = holdings.reduce<Record<string, number>>((acc, h) => {
    acc[h.currency] = (acc[h.currency] ?? 0) + h.marketValue;
    return acc;
  }, {});

  // 按币种累计现金余额（balance 是"字符串数值"，空串兜底为 0）。
  const cashByCurrency = cashAccounts.reduce<Record<string, number>>((acc, c) => {
    acc[c.currency] = (acc[c.currency] ?? 0) + parseFloat(c.balance || '0');
    return acc;
  }, {});

  // 币种 → 本地化名称（未知币种回退显示原代码）。
  const currencyLabel: Record<string, string> = {
    USD: t('dash.us'),
    HKD: t('dash.hk'),
    CNY: t('dash.cn'),
  };

  const sortedCurrencies = Object.keys(mvByCurrency).sort();
  const hasCash = Object.keys(cashByCurrency).length > 0;
  // 任一行有 AI 评级即显示 AI 评级列（表头与单元格都以此为准）。
  const hasAnyAiRating = Object.keys(aiRatings ?? {}).length > 0;

  // ---- 渲染区 ----
  return (
    <Card className="hidden md:block">
      <CardContent className="p-0">
        {/* 四态分发：加载骨架屏 → 错误文案 → 空态引导 → 正常表格。 */}
        {loading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="p-12 text-center text-destructive text-sm">{error}</div>
        ) : holdings.length === 0 ? (
          // 空态：图标 + 提示 + 新增持仓按钮。
          <div className="p-12">
            <Empty>
              <EmptyMedia variant="icon">
                <Briefcase />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>{t('holdings.noHoldings')}</EmptyTitle>
                <EmptyDescription>{t('ui.holdings.emptyHint')}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size="sm" onClick={onAdd}>
                  <Plus className="size-4" />
                  {t('holdings.addHolding')}
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        ) : (
          <>
            <Table>
              {/* 表头：数值列右对齐且可点击排序；AI 评级列为条件列。 */}
              <TableHeader>
                <TableRow>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => onSort('ticker')}
                  >
                    <span className="flex items-center gap-1">
                      {t('holdings.ticker')}
                      <SortIcon column="ticker" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => onSort('company')}
                  >
                    <span className="flex items-center gap-1">
                      {t('holdings.company')}
                      <SortIcon column="company" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="text-right cursor-pointer select-none"
                    onClick={() => onSort('buyPrice')}
                  >
                    <span className="flex items-center gap-1 justify-end">
                      {t('holdings.buyPrice')}
                      <SortIcon column="buyPrice" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="text-right cursor-pointer select-none"
                    onClick={() => onSort('currentPrice')}
                  >
                    <span className="flex items-center gap-1 justify-end">
                      {t('ui.holdings.currentPrice')}
                      <SortIcon column="currentPrice" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="text-right cursor-pointer select-none"
                    onClick={() => onSort('shares')}
                  >
                    <span className="flex items-center gap-1 justify-end">
                      {t('holdings.shares')}
                      <SortIcon column="shares" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="text-right cursor-pointer select-none"
                    onClick={() => onSort('marketValue')}
                  >
                    <span className="flex items-center gap-1 justify-end">
                      {t('ui.holdings.marketValue')}
                      <SortIcon column="marketValue" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="text-right cursor-pointer select-none"
                    onClick={() => onSort('cost')}
                  >
                    <span className="flex items-center gap-1 justify-end">
                      {t('ui.holdings.cost')}
                      <SortIcon column="cost" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="text-right cursor-pointer select-none"
                    onClick={() => onSort('pl')}
                  >
                    <span className="flex items-center gap-1 justify-end">
                      {t('ui.holdings.pl')}
                      <SortIcon column="pl" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="text-right cursor-pointer select-none"
                    onClick={() => onSort('returnPct')}
                  >
                    <span className="flex items-center gap-1 justify-end">
                      {t('ui.holdings.returnPct')}
                      <SortIcon column="returnPct" />
                    </span>
                  </TableHead>
                  <TableHead>{t('ui.holdings.rating')}</TableHead>
                  {/* AI 评级列：仅 hasAnyAiRating 为真时渲染（与单元格同步）。 */}
                  {hasAnyAiRating && <TableHead>{t('ui.holdings.aiRating')}</TableHead>}
                  <TableHead>{t('ui.holdings.actions')}</TableHead>
                  <TableHead>{t('ui.holdings.group')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* 每行整体可点击打开详情；行内按钮需 stopPropagation 避免冒泡触发详情。 */}
                {holdings.map((h) => (
                  <TableRow key={h.id} className="cursor-pointer" onClick={() => onDetail(h)}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono-nums font-semibold text-primary">
                          {h.ticker}
                        </span>
                        <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                          {h.market || 'US'}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell
                      className="max-w-[180px] whitespace-normal break-words text-sm leading-snug"
                      title={h.company ?? undefined}
                    >
                      {h.company ?? '—'}
                    </TableCell>
                    {/* 数值列：字符串数值字段走 formatPriceWithCurrency，number 字段走 formatCurrencyWithCurrency。 */}
                    <TableCell className="text-right font-mono-nums">
                      {formatPriceWithCurrency(h.buyPrice, h.currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono-nums font-medium">
                      {formatPriceWithCurrency(h.currentPrice, h.currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono-nums">
                      {formatShares(h.shares)}
                    </TableCell>
                    <TableCell className="text-right font-mono-nums">
                      {formatCurrencyWithCurrency(h.marketValue, h.currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono-nums">
                      {formatCurrencyWithCurrency(h.cost, h.currency)}
                    </TableCell>
                    <TableCell
                      className={cn('text-right font-mono-nums font-medium', plClass(h.pl))}
                    >
                      {formatCurrencyWithCurrency(h.pl, h.currency)}
                    </TableCell>
                    <TableCell
                      className={cn('text-right font-mono-nums font-medium', plClass(h.returnPct))}
                    >
                      {formatPercent(h.returnPct)}
                    </TableCell>
                    <TableCell>
                      {h.rating ? (
                        <Badge className={cn(ratingColor(h.rating))} variant="outline">
                          {h.rating}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    {/* AI 评级单元格：有评级显示双徽标 + 查看按钮；无则"未评级"占位。 */}
                    {hasAnyAiRating && (
                      <TableCell>
                        {aiRatings?.[h.ticker] ? (
                          <div className="flex items-center gap-1.5">
                            <RatingBadge rating={aiRatings[h.ticker].rating} size="sm" />
                            <ConfidenceBadge
                              confidence={aiRatings[h.ticker].confidence}
                              size="sm"
                            />
                            {/* 查看分析按钮：stopPropagation 防止触发行点击打开详情。 */}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-6"
                              onClick={(e) => {
                                e.stopPropagation();
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
                      </TableCell>
                    )}
                    <TableCell>
                      {h.action ? (
                        <Badge className={cn(actionColor(h.action))} variant="outline">
                          {actionLabel(h.action)}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {groupName(h.groupId)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {/* 页脚小计行：有持仓市值或现金任一存在时渲染，按币种排序展示。 */}
            {(sortedCurrencies.length > 0 || hasCash) && (
              <div className="px-4 py-3 border-t text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                {sortedCurrencies.length > 0 && (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{t('ui.holdings.subtotal')}</span>
                    {sortedCurrencies.map((cur, i) => (
                      <span key={cur} className="font-mono-nums">
                        {i > 0 && <span className="mx-1">·</span>}
                        {currencyLabel[cur] ?? cur}{' '}
                        {formatCurrencyWithCurrency(mvByCurrency[cur], cur)}
                      </span>
                    ))}
                  </span>
                )}
                {hasCash && (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{t('ui.holdings.cash')}</span>
                    {Object.keys(cashByCurrency)
                      .sort()
                      .map((cur, i) => (
                        <span key={cur} className="font-mono-nums">
                          {i > 0 && <span className="mx-1">·</span>}
                          {currencyLabel[cur] ?? cur}{' '}
                          {formatCurrencyWithCurrency(cashByCurrency[cur], cur)}
                        </span>
                      ))}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
