/**
 * @file pages/Transactions/ClosedList.tsx
 * @description Mobile card list of closed positions (realized trades).
 *
 * Each card shows ticker, realized P/L (colored by sign), return %, open/close
 * dates, buy/sell prices, shares, and optional notes.
 */
import { TrendingDown, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ClosedPosition } from '@shared/api.interface';
import {
  formatPrice,
  formatShares,
  formatCurrency,
  formatPercent,
  formatDate,
  plClass,
  cn,
} from '@/utils/format';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

/** Props for {@link ClosedList}. */
interface ClosedListProps {
  loading: boolean;
  error: string | null;
  closed: ClosedPosition[];
  onAdd: () => void;
}

/**
 * Render the mobile closed-position card list.
 */
export default function ClosedList({ loading, error, closed, onAdd }: ClosedListProps) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="md:hidden space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4 space-y-3">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-8 w-32" />
              <div className="grid grid-cols-2 gap-3">
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

  if (closed.length === 0) {
    return (
      <div className="md:hidden">
        <Empty>
          <EmptyMedia variant="icon">
            <TrendingDown />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{t('ui.tx.emptyClosed')}</EmptyTitle>
            <EmptyDescription>{t('ui.tx.emptyClosedHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={onAdd}>
              <Plus className="size-4" />
              {t('ui.tx.addClosed')}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="md:hidden space-y-3">
      {closed.map((c) => (
        <Card key={c.id}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-mono-nums font-bold text-primary text-lg">{c.ticker}</div>
                <div className="text-sm text-muted-foreground truncate max-w-[200px]">
                  {c.company ?? '—'}
                </div>
              </div>
              <div className="text-right">
                <div className={cn('font-mono-nums text-lg font-semibold', plClass(c.realizedPl))}>
                  {formatCurrency(c.realizedPl)}
                </div>
                <div className={cn('font-mono-nums text-sm', plClass(c.returnPct))}>
                  {formatPercent(c.returnPct)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">{t('tx.openDate')}</div>
                <div className="font-mono-nums">{formatDate(c.openDate)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('tx.closeDate')}</div>
                <div className="font-mono-nums">{formatDate(c.closeDate)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('tx.buyPrice')}</div>
                <div className="font-mono-nums">{formatPrice(c.buyPrice)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('tx.sellPrice')}</div>
                <div className="font-mono-nums">{formatPrice(c.sellPrice)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('tx.shares')}</div>
                <div className="font-mono-nums">{formatShares(c.shares)}</div>
              </div>
            </div>

            {c.notes && (
              <div className="mt-3 pt-3 border-t text-xs text-muted-foreground">{c.notes}</div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
