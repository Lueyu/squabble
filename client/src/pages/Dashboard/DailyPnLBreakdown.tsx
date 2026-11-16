/**
 * DailyPnLBreakdown.tsx — 仪表盘"个股每日盈亏"明细表。
 *
 * 职责边界：
 *  - 对每个持仓：股数 × 报价当日涨跌额 = 当日盈亏；按盈亏降序排序；
 *  - 以各行 |盈亏| 之和为分母，计算每行的贡献度占比；
 *  - 默认最多显示 10 行，超过时可展开 / 收起；
 *  - 纯展示 + 本地派生，不发请求（行情由父组件经 useMarketQuotes 传入）。
 * 上下游：
 *  - 上游：DashboardPage（每日盈亏卡片底部）；
 *  - 下游：@/utils/format（金额 / 百分比格式化、plClass 正负配色）、
 *    ui 组件（Table / Badge / Empty / Button）。
 * 关键约定：
 *  - 行情未就绪（loading 或 quotes 为空）时显示占位文案；
 *  - 有持仓但全部缺报价时显示空态。
 */
import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Holding, Currency, QuoteResponse, Market } from '@shared/api.interface';
import {
  formatCurrencyWithCurrency,
  formatPercent,
  formatPriceWithCurrency,
  plClass,
  cn,
} from '@/utils/format';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { useTranslation } from 'react-i18next';
import { displayCompanyName } from '@/utils/company-name';

/** {@link DailyPnLBreakdown} 的入参。 */
interface DailyPnLBreakdownProps {
  /** 当前持仓列表。 */
  holdings: Holding[];
  /** 实时行情映射，key 为股票代码（来自 useMarketQuotes）。 */
  quotes: Record<string, QuoteResponse>;
  /** 折算金额使用的报告币种。 */
  baseCurrency: Currency;
  /** 行情还在预热时显示占位。 */
  loading?: boolean;
}

/** 行情行的市场徽标文案（在组件内构建以接入 i18n）。 */
function marketLabels(t: (k: string) => string): Record<Market, string> {
  return {
    US: t('dash.us'),
    HK: t('dash.hk'),
    CN: t('dash.cn'),
  };
}

/**
 * 渲染个股每日盈亏明细表。
 * @param props - 见 {@link DailyPnLBreakdownProps}。
 */
export default function DailyPnLBreakdown({
  holdings,
  quotes,
  baseCurrency,
  loading,
}: DailyPnLBreakdownProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  // 展开 / 收起全部行。
  const [showAll, setShowAll] = useState(false);

  // ===== 派生计算区：由持仓 + 行情算出带贡献度的排序行 =====
  const rows = useMemo(() => {
    // 步骤 1：逐持仓算当日盈亏（股数 × 当日涨跌额），公司名按语言显示。
    const result = holdings
      .map((h) => {
        const quote = quotes[h.ticker];
        const shares = parseFloat(h.shares || '0');
        const change = quote && quote.change ? parseFloat(quote.change) : 0;
        const changePercent = quote && quote.changePercent ? parseFloat(quote.changePercent) : 0;
        const dailyPl = shares * change;
        return {
          ticker: h.ticker,
          company: displayCompanyName(h.company, h.ticker, language),
          market: h.market,
          currency: h.currency,
          shares,
          change,
          changePercent,
          dailyPl,
          hasQuote: !!quote,
        };
      })
      // 步骤 2：只保留有行情的持仓。
      .filter((r) => r.hasQuote)
      // 步骤 3：按当日盈亏降序（赚得最多在最上）。
      .sort((a, b) => b.dailyPl - a.dailyPl);

    // 步骤 4：以 |盈亏| 之和为分母，算每行对总波动的贡献度。
    const totalAbs = result.reduce((sum: number, r) => sum + Math.abs(r.dailyPl), 0);

    return result.map((r) => ({
      ...r,
      contribution: totalAbs > 0 ? (r.dailyPl / totalAbs) * 100 : 0,
    }));
  }, [holdings, quotes, language]);

  const hasQuotes = Object.keys(quotes).length > 0;

  // 什么时候走到这里：行情还在加载（或没拿到任何报价）——显示占位文案。
  if (loading || !hasQuotes) {
    return (
      <div className="py-8 text-center text-xs text-muted-foreground">
        {holdings.length > 0 ? t('ui.dashboard.loadingQuotes') : t('dash.noHoldings')}
      </div>
    );
  }

  // 什么时候走到这里：有行情，但持仓全部缺报价——显示空态。
  if (rows.length === 0) {
    return (
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyTitle>{t('ui.dashboard.noPositions')}</EmptyTitle>
          <EmptyDescription>{t('dash.noHoldingsHint')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  // 默认只展示前 10 行；超过 10 行才显示展开按钮。
  const visibleRows = showAll ? rows : rows.slice(0, 10);
  const hasMore = rows.length > 10;

  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('dash.stock')}</TableHead>
            <TableHead className="text-right">{t('dash.shares')}</TableHead>
            <TableHead className="text-right">{t('dash.dailyChange')}</TableHead>
            <TableHead className="text-right">{t('dash.changePct')}</TableHead>
            <TableHead className="text-right">{t('dash.dailyPlCol')}</TableHead>
            <TableHead className="text-right">{t('dash.contribution')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleRows.map((r) => (
            <TableRow key={r.ticker}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.ticker}</span>
                  <Badge
                    variant="outline"
                    className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground"
                  >
                    {marketLabels(t)[r.market] || r.market}
                  </Badge>
                  <span className="truncate text-xs text-muted-foreground">
                    {r.company || <span className="text-muted-foreground/60">—</span>}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-sm">
                {r.shares.toLocaleString('en-US', {
                  maximumFractionDigits: 4,
                })}
              </TableCell>
              <TableCell
                className={cn('text-right font-mono tabular-nums text-sm', plClass(r.change))}
              >
                {formatPriceWithCurrency(r.change, r.currency)}
              </TableCell>
              <TableCell
                className={cn(
                  'text-right font-mono tabular-nums text-sm',
                  plClass(r.changePercent),
                )}
              >
                {formatPercent(r.changePercent)}
              </TableCell>
              <TableCell
                className={cn(
                  'text-right font-mono tabular-nums text-sm font-medium',
                  plClass(r.dailyPl),
                )}
              >
                {formatCurrencyWithCurrency(r.dailyPl, r.currency)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-sm text-muted-foreground">
                {formatPercent(r.contribution)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {/* 超过 10 行时的展开 / 收起切换 */}
      {hasMore && (
        <div className="flex justify-center pt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAll((v) => !v)}
            className="text-xs text-muted-foreground"
          >
            {showAll
              ? t('ui.dashboard.collapse')
              : t('ui.dashboard.showMore', { count: rows.length - 10 })}
            <ChevronDown
              size={14}
              className={cn('transition-transform', showAll && 'rotate-180')}
            />
          </Button>
        </div>
      )}
    </div>
  );
}
