import type { CreateTransactionDto } from './api.interface';
export interface TransactionImportCandidate {
  txDate?: string; txTime?: string; txType?: string; ticker?: string;
  shares?: string | number; price?: string | number; fees?: string | number;
  currency?: string; brokerId?: string; notes?: string;
  recordKind?: 'transaction' | 'settlement' | 'balance';
}
export interface TransactionImportInput {
  kind: 'trades' | 'cash-flows'; source: 'csv' | 'excel' | 'screenshot';
  broker: string; account: string; filename?: string; rows: TransactionImportCandidate[];
  baselineScope?: 'after-opening';
}
export interface TransactionImportRow {
  id: string; raw: TransactionImportCandidate; value?: CreateTransactionDto;
  issues: string[]; identity?: string; fingerprint?: string;
  status: 'ready' | 'duplicate' | 'review' | 'reference';
}
export interface TransactionImportPreview {
  id: string; revision: number; ledgerRevision: string; rows: TransactionImportRow[];
  input: Omit<TransactionImportInput, 'rows'>;
  changes: Array<{ currency: string; cashDelta: number }>;
  balances: Array<{ currency: string; before: number; after: number; status: string }>;
  positions: Array<{ ticker: string; before: number; after: number }>;
}
export interface TransactionImportCommit {
  requestKey: string; revision: number; ledgerRevision: string; rowIds: string[];
}
export interface TransactionImportReceipt { id: string; requestKey: string; rowIds: string[]; created: number; duplicates: number }
