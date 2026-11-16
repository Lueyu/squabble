/**
 * @file pages/Holdings/HoldingsTable.tsx
 * @description Desktop holdings table (hidden below `md`).
 *
 * Renders sortable columns for ticker, company, buy/current price, shares,
 * market value, cost, P/L, return %, rating, AI rating badges, action and group.
 * A footer row shows market-value subtotals and cash balances per currency.
 * Mobile layout is delegated to `HoldingsMobileList`.
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

/** Columns the holdings table can sort by. */
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

/** Holding shape used by the table (raw fields + derived numerics). */
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

/** Cash account row used in the footer subtotals. */
interface CashAccountRow {
  currency: Currency;
  balance: string;
}

/** AI rating info attached to a holding row. */
interface AiRatingInfo {
  rating: AgentRating;
  confidence: AgentConfidence;
  runId: string;
  bullSummary?: string | null;
  bearSummary?: string | null;
}

/** Props for {@link HoldingsTable}. */
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
 * Render the desktop holdings table with loading / error / empty states and
 * per-currency subtotal footer.
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
  const { t } = useTranslation();
  const SortIcon = ({ column }: { column: SortKey }) => {
    if (sortKey !== column) return <ChevronDown className="size-3 opacity-30" />;
    return sortDir === 'asc' ? (
      <ChevronUp className="size-3" />
    ) : (
      <ChevronDown className="size-3" />
    );
  };

  const groupName = (id: string | null) =>
    groups.find((g) => g.id === id)?.name ?? t('holdings.noGroup');
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

  const mvByCurrency = holdings.reduce<Record<string, number>>((acc, h) => {
    acc[h.currency] = (acc[h.currency] ?? 0) + h.marketValue;
    return acc;
  }, {});

  const cashByCurrency = cashAccounts.reduce<Record<string, number>>((acc, c) => {
    acc[c.currency] = (acc[c.currency] ?? 0) + parseFloat(c.balance || '0');
    return acc;
  }, {});

  const currencyLabel: Record<string, string> = {
    USD: t('dash.us'),
    HKD: t('dash.hk'),
    CNY: t('dash.cn'),
  };

  const sortedCurrencies = Object.keys(mvByCurrency).sort();
  const hasCash = Object.keys(cashByCurrency).length > 0;
  const hasAnyAiRating = Object.keys(aiRatings ?? {}).length > 0;

  return (
    <Card className="hidden md:block">
      <CardContent className="p-0">
        {loading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="p-12 text-center text-destructive text-sm">{error}</div>
        ) : holdings.length === 0 ? (
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
                  {hasAnyAiRating && <TableHead>{t('ui.holdings.aiRating')}</TableHead>}
                  <TableHead>{t('ui.holdings.actions')}</TableHead>
                  <TableHead>{t('ui.holdings.group')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
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
                    {hasAnyAiRating && (
                      <TableCell>
                        {aiRatings?.[h.ticker] ? (
                          <div className="flex items-center gap-1.5">
                            <RatingBadge rating={aiRatings[h.ticker].rating} size="sm" />
                            <ConfidenceBadge
                              confidence={aiRatings[h.ticker].confidence}
                              size="sm"
                            />
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
