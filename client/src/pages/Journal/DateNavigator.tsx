/**
 * @file pages/Journal/DateNavigator.tsx
 * @description Date navigator bar for the journal page.
 *
 * Renders prev/next buttons, a clickable date that opens a date-picker popover,
 * and a 4-up strip of the selected day's snapshot stats (daily P/L, P/L %,
 * account value, cash). P/L values are colored by sign via `plClass`.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  TrendingUp,
  TrendingDown,
  Wallet,
  DollarSign,
} from 'lucide-react';
import type { Snapshot } from '@shared/api.interface';
import { formatCurrency, formatPercent, formatDate, plClass, cn } from '@/utils/format';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';

/** Format a Date as `YYYY-MM-DD` for the native date input. */
function formatDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Props for {@link DateNavigator}. */
interface DateNavigatorProps {
  currentDate: Date;
  snapshot: Snapshot | undefined;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
  onDateChange: (date: Date) => void;
}

/**
 * Render the date navigator with prev/next, date picker popover, and today's
 * snapshot stat strip.
 */
export function DateNavigator({
  currentDate,
  snapshot,
  loading,
  onPrev,
  onNext,
  onDateChange,
}: DateNavigatorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(formatDateInput(currentDate));

  /** Parse the date input and commit it when valid. */
  const handleSubmit = () => {
    const d = new Date(input);
    if (!isNaN(d.getTime())) {
      onDateChange(d);
      setOpen(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={onPrev} className="h-9 w-9">
              <ChevronLeft size={16} />
            </Button>
            <div className="relative">
              <button
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:border-ring"
              >
                <Calendar size={14} className="text-primary" />
                <span className="font-mono tabular-nums font-medium">
                  {formatDate(currentDate)}
                </span>
              </button>
              {open && (
                <div className="absolute left-0 top-full z-10 mt-1 flex gap-2 rounded-md border bg-background p-2 shadow-md">
                  <Input
                    type="date"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    className="w-auto"
                  />
                  <Button size="sm" onClick={handleSubmit}>
                    {t('ui.journal.confirmDate')}
                  </Button>
                </div>
              )}
            </div>
            <Button variant="outline" size="icon" onClick={onNext} className="h-9 w-9">
              <ChevronRight size={16} />
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-28" />)
            ) : snapshot ? (
              <>
                <div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <TrendingUp size={12} className={plClass(snapshot.dailyPl)} />
                    {t('journal.dailyPl')}
                  </div>
                  <div
                    className={cn(
                      'font-mono text-lg font-semibold tabular-nums',
                      plClass(snapshot.dailyPl),
                    )}
                  >
                    {formatCurrency(snapshot.dailyPl)}
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <TrendingDown size={12} className={plClass(snapshot.dailyPct)} />
                    {t('ui.journal.dailyReturn')}
                  </div>
                  <div
                    className={cn(
                      'font-mono text-lg font-semibold tabular-nums',
                      plClass(snapshot.dailyPct),
                    )}
                  >
                    {formatPercent(snapshot.dailyPct)}
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Wallet size={12} className="text-primary" />
                    {t('ui.journal.accountValue')}
                  </div>
                  <div className="font-mono text-lg font-semibold tabular-nums text-foreground">
                    {formatCurrency(snapshot.accountValue)}
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <DollarSign size={12} className="text-primary" />
                    {t('ui.journal.cash')}
                  </div>
                  <div className="font-mono text-lg font-semibold tabular-nums text-foreground">
                    {formatCurrency(snapshot.cash)}
                  </div>
                </div>
              </>
            ) : (
              <div className="col-span-4 py-2 text-center text-sm text-muted-foreground">
                {t('ui.journal.noSnapshotForDate')}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
