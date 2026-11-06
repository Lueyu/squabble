import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { cashAccounts, holdings, transactions } from '../../database/schema';
import { transactionImportBatches } from '../../database/transaction-imports.schema';
import { positionBaselines } from '../../database/asset-ledger.schema';
import { TransactionsService } from '../transactions/transactions.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { ledgerHash, normalizeImportRows } from './transaction-import.rules';
import { securityIdentity } from './screenshot-merge';
import type { TransactionImportCommit, TransactionImportInput, TransactionImportPreview, TransactionImportReceipt, TransactionImportRow } from '../../../shared/transaction-import.interface';

@Injectable()
export class TransactionImportsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase, private readonly ledger: TransactionsService) {}
  async create(owner: string, input: TransactionImportInput): Promise<TransactionImportPreview> {
    if (!input || !['trades', 'cash-flows'].includes(input.kind) || !['csv', 'excel', 'screenshot'].includes(input.source) ||
      typeof input.broker !== 'string' || !input.broker.trim() || input.broker.length > 100 || typeof input.account !== 'string' || !input.account.trim() || input.account.length > 100 ||
      (input.baselineScope !== undefined && input.baselineScope !== 'after-opening') || !Array.isArray(input.rows) || !input.rows.length || input.rows.length > 500 || input.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)) || JSON.stringify(input).length > 900000) throw new BadRequestException('INVALID_IMPORT');
    const rows = normalizeImportRows(input), { rows: _rows, ...metadata } = input;
    const [batch] = await this.db.insert(transactionImportBatches).values({ owner, input: metadata, rows }).returning();
    return this.preview(owner, batch.id);
  }
  private async state(tx: PostgresJsDatabase, owner: string) {
    const ledger = await tx.select().from(transactions).where(eq(transactions.owner, owner)).orderBy(transactions.id);
    const positions = await tx.select().from(holdings).where(eq(holdings.owner, owner)).orderBy(holdings.id);
    const cash = await tx.select().from(cashAccounts).where(eq(cashAccounts.owner, owner)).orderBy(cashAccounts.id);
    return { ledger, positions, cash, ledgerRevision: ledgerHash([ledger, positions, cash]) };
  }
  private classify(rows: TransactionImportRow[], ledger: Array<typeof transactions.$inferSelect>) {
    const identities = new Map(ledger.filter(row => row.sourceIdentity).map(row => [row.sourceIdentity, row.sourceFingerprint]));
    const fingerprints = new Map<string, Array<string | null>>();
    for (const row of ledger) if (row.sourceFingerprint) fingerprints.set(row.sourceFingerprint, [...(fingerprints.get(row.sourceFingerprint) ?? []), row.sourceIdentity]);
    return rows.map(original => {
      const row = structuredClone(original);
      if (row.status === 'reference' || row.issues.length) return row;
      if (row.identity && identities.has(row.identity) && identities.get(row.identity) !== row.fingerprint) { row.status = 'review'; row.issues.push('BROKER_ID_CONFLICT'); }
      else if (row.identity && identities.has(row.identity)) row.status = 'duplicate';
      else {
        const matches = fingerprints.get(row.fingerprint!) ?? [];
        if ((!row.identity && matches.length > 1) || (row.identity && matches.includes(null))) { row.status = 'review'; row.issues.push('AMBIGUOUS_IDENTITY'); }
        else if (matches.length && !row.identity) row.status = 'duplicate';
        else if (!row.identity && !row.raw.txTime) { row.status = 'review'; row.issues.push('MISSING_IDENTITY'); }
        else { row.status = 'ready'; if (row.identity) identities.set(row.identity, row.fingerprint); fingerprints.set(row.fingerprint!, [...matches, row.identity ?? null]); }
      }
      return row;
    });
  }
  async preview(owner: string, id: string): Promise<TransactionImportPreview> {
    const [batch] = await this.db.select().from(transactionImportBatches).where(and(eq(transactionImportBatches.id, id), eq(transactionImportBatches.owner, owner)));
    if (!batch) throw new NotFoundException('BATCH_NOT_FOUND');
    const state = await this.state(this.db, owner), rows = this.classify(batch.rows, state.ledger);
    const baselines = await this.db.select().from(positionBaselines).where(eq(positionBaselines.owner, owner));
    for (const row of rows) if (row.status === 'ready' && row.value?.ticker) {
      const baseline = baselines.find(value => securityIdentity(value.ticker, value.market)?.key === securityIdentity(row.value!.ticker)?.key);
      if (baseline) {
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(baseline.observedAt);
        if (row.value.txDate < day || (row.value.txDate === day && batch.input.baselineScope !== 'after-opening')) {
          row.status = 'review'; row.issues.push(row.value.txDate < day ? 'BEFORE_POSITION_BASELINE' : 'BASELINE_OVERLAP');
        }
      }
    }
    for (const row of rows) if (row.status === 'ready' && row.value) {
      const cash = state.cash.find(value => value.currency === row.value!.currency);
      if (cash?.confirmedAt) {
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(cash.confirmedAt);
        if (row.value.txDate < day || (row.value.txDate === day && batch.input.baselineScope !== 'after-opening')) { row.status = 'review'; row.issues.push(row.value.txDate < day ? 'BEFORE_CASH_BASELINE' : 'BASELINE_OVERLAP'); }
      }
    }
    const changes = new Map<string, number>();
    for (const row of rows) if (row.status === 'ready' && row.value) {
      const value = row.value, amount = value.shares, fees = value.fees ?? 0;
      const delta = value.txType === 'Buy' ? -(amount * value.price + fees) : value.txType === 'Sell' ? amount * value.price - fees : value.txType === 'Deposit' ? amount - fees : -(amount + fees);
      changes.set(value.currency!, (changes.get(value.currency!) ?? 0) + delta);
    }
    const balances = [...changes].map(([currency, delta]) => { const before = state.cash.find(row => row.currency === currency); return { currency, before: Number(before?.balance ?? 0), after: Number(before?.balance ?? 0) + delta, status: before?.reconciliationStatus ?? 'unconfirmed' }; });
    const positionChanges = new Map<string, number>();
    for (const row of rows) if (row.status === 'ready' && row.value?.ticker) positionChanges.set(row.value.ticker, (positionChanges.get(row.value.ticker) ?? 0) + row.value.shares * (row.value.txType === 'Sell' ? -1 : 1));
    const positions = [...positionChanges].map(([ticker, delta]) => { const before = Number(state.positions.find(row => securityIdentity(row.ticker, row.market ?? undefined)?.key === securityIdentity(ticker)?.key)?.shares ?? 0); return { ticker, before, after: before + delta }; });
    for (const row of rows) if (row.status === 'reference' && row.raw.recordKind === 'balance') {
      const expected = balances.find(balance => balance.currency === row.raw.currency)?.after ?? Number(state.cash.find(account => account.currency === row.raw.currency)?.balance ?? NaN);
      const observed = Number(String(row.raw.shares ?? '').replace(/,/g, ''));
      if (!row.raw.currency || !Number.isFinite(observed) || !Number.isFinite(expected) || Math.abs(expected - observed) > 0.01) row.issues.push('BALANCE_MISMATCH');
    }
    return { id, revision: batch.revision, ledgerRevision: state.ledgerRevision, input: batch.input, rows, changes: [...changes].map(([currency, cashDelta]) => ({ currency, cashDelta })), balances, positions };
  }
  async commit(owner: string, id: string, input: TransactionImportCommit): Promise<TransactionImportReceipt> {
    if (!input || typeof input.requestKey !== 'string' || !input.requestKey || input.requestKey.length > 150 || !Array.isArray(input.rowIds) || !input.rowIds.length || input.rowIds.length > 500 || new Set(input.rowIds).size !== input.rowIds.length) throw new BadRequestException('INVALID_COMMIT');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [batch] = await tx.select().from(transactionImportBatches).where(and(eq(transactionImportBatches.id, id), eq(transactionImportBatches.owner, owner))).for('update');
      if (!batch) throw new NotFoundException('BATCH_NOT_FOUND');
      const inputHash = ledgerHash(input), prior = batch.receipts.find(row => row.requestKey === input.requestKey);
      if (prior) { if (prior.inputHash !== inputHash) throw new ConflictException('IDEMPOTENCY_CONFLICT'); const { inputHash: _hash, ...receipt } = prior; return receipt; }
      const state = await this.state(tx, owner);
      if (input.revision !== batch.revision || input.ledgerRevision !== state.ledgerRevision) throw new ConflictException('LEDGER_CHANGED');
      const rows = this.classify(batch.rows, state.ledger), selected = input.rowIds.map(rowId => rows.find(row => row.id === rowId));
      if (selected.some(row => !row || !['ready', 'duplicate'].includes(row.status))) throw new BadRequestException('ROWS_REQUIRE_REVIEW');
      const baselines = await tx.select().from(positionBaselines).where(eq(positionBaselines.owner, owner));
      for (const row of selected) if (row?.status === 'ready' && row.value?.ticker) {
        const baseline = baselines.find(value => securityIdentity(value.ticker, value.market)?.key === securityIdentity(row.value!.ticker)?.key);
        if (baseline && row.value.txDate <= new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(baseline.observedAt) && batch.input.baselineScope !== 'after-opening') throw new ConflictException('BASELINE_OVERLAP');
      }
      for (const row of selected) if (row?.status === 'ready' && row.value) {
        const account = state.cash.find(account => account.currency === row.value!.currency);
        if (account?.confirmedAt && row.value.txDate <= new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(account.confirmedAt) && batch.input.baselineScope !== 'after-opening') throw new ConflictException('BASELINE_OVERLAP');
      }
      const receipt: TransactionImportReceipt = { id: randomUUID(), requestKey: input.requestKey, rowIds: input.rowIds, created: 0, duplicates: 0 };
      const ordered = selected.filter((row): row is TransactionImportRow => !!row).sort((a, b) => `${a.value?.txDate} ${a.raw.txTime ?? ''}`.localeCompare(`${b.value?.txDate} ${b.raw.txTime ?? ''}`));
      for (const row of ordered) {
        if (row.status === 'duplicate') { receipt.duplicates++; continue; }
        await this.ledger.createInTransaction(tx, owner, row.value!, { sourceIdentity: row.identity, sourceFingerprint: row.fingerprint, sourceBatchId: id, sourceData: { ...batch.input, row: row.raw } });
        receipt.created++;
      }
      await tx.update(transactionImportBatches).set({ revision: batch.revision + 1, receipts: [...batch.receipts, { ...receipt, inputHash }] }).where(eq(transactionImportBatches.id, id));
      return receipt;
    });
  }
}
