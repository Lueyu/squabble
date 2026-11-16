/**
 * @file pages/Dashboard/DailyPnLBreakdown.tsx
 * @description Per-holding daily P/L table on the Dashboard.
 *
 * For each holding, multiplies share count by the quote's day change to derive
 * daily P/L, then sorts by P/L descending and computes each row's contribution
 * share against the sum of absolute P/Ls. Shows at most 10 rows by default with
 * an expand toggle.
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

/** Props for {@link DailyPnLBreakdown}. */
interface DailyPnLBreakdownProps {
  /** Current open positions. */
  holdings: Holding[];
  /** Live quote map keyed by ticker (from useMarketQuotes). */
  quotes: Record<string, QuoteResponse>;
  /** Reporting currency for converted amounts. */
  baseCurrency: Currency;
  /** Shows a placeholder while quotes are still warming up. */
  loading?: boolean;
}

/** Market labels for the row badges (built inside the component for i18n). */
function marketLabels(t: (k: string) => string): Record<Market, string> {
  return {
    US: t('dash.us'),
    HK: t('dash.hk'),
    CN: t('dash.cn'),
  };
}

/**
 * Render the per-holding daily P/L breakdown table.
 * @param props - See {@link DailyPnLBreakdownProps}.
 */
export default function DailyPnLBreakdown({
  holdings,
  quotes,
  baseCurrency,
  loading,
}: DailyPnLBreakdownProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
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
      .filter((r) => r.hasQuote)
      .sort((a, b) => b.dailyPl - a.dailyPl);

    const totalAbs = result.reduce((sum: number, r) => sum + Math.abs(r.dailyPl), 0);

    return result.map((r) => ({
      ...r,
      contribution: totalAbs > 0 ? (r.dailyPl / totalAbs) * 100 : 0,
    }));
  }, [holdings, quotes, language]);

  const hasQuotes = Object.keys(quotes).length > 0;

  if (loading || !hasQuotes) {
    return (
      <div className="py-8 text-center text-xs text-muted-foreground">
        {holdings.length > 0 ? t('ui.dashboard.loadingQuotes') : t('dash.noHoldings')}
      </div>
    );
  }

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
