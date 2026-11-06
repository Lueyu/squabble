import type { Transaction } from '@shared/api.interface';
export function transactionCashDelta(tx: Pick<Transaction, 'txType' | 'shares' | 'price' | 'fees'>): number {
  const amount = Number(tx.shares), fees = Number(tx.fees || 0);
  if (tx.txType === 'Buy') return -(amount * Number(tx.price) + fees);
  if (tx.txType === 'Sell') return amount * Number(tx.price) - fees;
  if (tx.txType === 'Deposit') return amount - fees;
  if (tx.txType === 'Withdrawal' || tx.txType === 'Fee') return -(amount + fees);
  return 0;
}
