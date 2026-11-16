/**
 * @file pages/Holdings/HoldingsMobileList.tsx
 * @description Mobile card list for holdings (hidden at `md` and up).
 *
 * Each holding is a tap-to-expand card: the header shows ticker, rating badge,
 * company name, current price and return %; the collapsed grid shows shares,
 * market value, cost and P/L; the expanded section adds buy price, action
 * recommendation, AI rating, group, and a "view detail" button.
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

/** Holding shape used by the mobile list (raw fields + derived numerics). */
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

/** AI rating info attached to a holding row. */
interface AiRatingInfo {
  rating: AgentRating;
  confidence: AgentConfidence;
  runId: string;
  bullSummary?: string | null;
  bearSummary?: string | null;
}

/** Props for {@link HoldingsMobileList}. */
interface HoldingsMobileListProps {
  loading: boolean;
  error: string | null;
  holdings: DerivedHolding[];
  groups: Group[];
  onAdd: () => void;
  onDetail: (h: DerivedHolding) => void;
  aiRatings?: Record<string, AiRatingInfo>;
  onViewAiAnalysis?: (ticker: string, runId: string) => void;
}

/**
 * Render the mobile holdings card list with tap-to-expand rows.
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
  const [expanded, setExpanded] = useState<string | null>(null);

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

  const hasAnyAiRating = Object.keys(aiRatings ?? {}).length > 0;

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

  if (error) {
    return <div className="p-8 text-center text-destructive text-sm md:hidden">{error}</div>;
  }

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

  return (
    <div className="md:hidden space-y-3">
      {holdings.map((h) => (
        <Card key={h.id} className="overflow-hidden">
          <CardContent className="p-4">
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
                  {formatPriceWithCurrency(h.buyPrice, h.currency)}
                </span>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <span className="text-muted-foreground">{t('ui.holdings.actions')}</span>
                <span>
                  {h.action ? (
                    <Badge className={cn(actionColor(h.action))} variant="outline">
                      {actionLabel(h.action)}
                    </Badge>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
              {hasAnyAiRating && (
                <div className="flex flex-wrap justify-between items-center gap-2">
                  <span className="text-muted-foreground">{t('ui.holdings.aiRating')}</span>
                  {aiRatings?.[h.ticker] ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <RatingBadge rating={aiRatings[h.ticker].rating} size="sm" />
                      <ConfidenceBadge confidence={aiRatings[h.ticker].confidence} size="sm" />
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
