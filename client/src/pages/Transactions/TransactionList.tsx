/**
 * @file pages/Transactions/TransactionList.tsx
 * @description Mobile card list of transactions (shown on small screens; the
 * desktop table lives inline in TransactionsPage).
 *
 * Each card shows ticker, Buy/Sell badge, date, signed amount, shares/price/
 * fees, and optional notes. Buy amounts include fees; sell amounts subtract
 * fees.
 */
import { Receipt, Plus } from 'lucide-react';
import type { Transaction } from '@shared/api.interface';
import {
  formatPrice,
  formatShares,
  formatCurrencyWithCurrency,
  formatDate,
  plClass,
  cn,
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
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Props for {@link TransactionList}. */
interface TransactionListProps {
  loading: boolean;
  error: string | null;
  transactions: Transaction[];
  onAdd: () => void;
  onDelete: (id: string) => void;
}

/**
 * Render the mobile transaction card list.
 */
export default function TransactionList({
  loading,
  error,
  transactions,
  onAdd,
  onDelete,
}: TransactionListProps) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <Card className="md:hidden">
        <CardContent className="p-4 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center text-destructive text-sm md:hidden">
        {error}
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="md:hidden">
        <Empty>
          <EmptyMedia variant="icon">
            <Receipt />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{t('ui.tx.emptyTx')}</EmptyTitle>
            <EmptyDescription>
              {t('ui.tx.emptyTxHint')}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={onAdd}>
              <Plus className="size-4" />
              {t('tx.addTx')}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="md:hidden space-y-3">
      {transactions.map((tx) => {
        const amount =
          parseFloat(tx.shares) * parseFloat(tx.price) +
          (tx.txType === 'Buy'
            ? parseFloat(tx.fees || '0')
            : -parseFloat(tx.fees || '0'));
        return (
          <Card key={tx.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono-nums font-bold text-primary">
                      {tx.ticker}
                    </span>
                    <Badge
                      className={cn(
                        tx.txType === 'Buy'
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted text-muted-foreground',
                        'text-[10px]'
                      )}
                      variant="outline"
                    >
                      {tx.txType === 'Buy' ? t('tx.buy') : t('tx.sell')}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 font-mono-nums">
                    {formatDate(tx.txDate)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div
                    className="font-mono-nums text-lg font-semibold text-foreground"
                  >
                    <span className="text-muted-foreground">
                      {tx.txType === 'Buy' ? '-' : '+'}
                    </span>
                    {formatCurrencyWithCurrency(amount, tx.currency || 'USD')}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(tx.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">{t('tx.shares')}</div>
                  <div className="font-mono-nums">
                    {formatShares(tx.shares)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t('tx.price')}</div>
                  <div className="font-mono-nums">
                    {formatPrice(tx.price)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t('tx.fees')}</div>
                  <div className="font-mono-nums">
                    {formatCurrencyWithCurrency(tx.fees || '0', tx.currency || 'USD')}
                  </div>
                </div>
              </div>

              {tx.notes && (
                <div className="mt-3 pt-3 border-t text-xs text-muted-foreground">
                  {tx.notes}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
