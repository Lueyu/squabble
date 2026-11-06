import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { cashAccounts, holdings, transactions } from '../../database/schema';
import { eq } from 'drizzle-orm';
import { ImportService } from './import.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CashAccountsService } from '../cash-accounts/cash-accounts.service';
import type { QuoteService } from '../quote/quote.service';
import { TransactionImportsService } from './transaction-imports.service';

test('snapshot baseline, transactions and concurrent cash initialization stay consistent in PostgreSQL', { skip: !process.env.EXPERIENCE_TEST_DATABASE_URL }, async () => {
  const admin = postgres(process.env.EXPERIENCE_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const namespace = 'ledger_' + randomUUID().replaceAll('-', '');
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  const client = postgres(process.env.EXPERIENCE_TEST_DATABASE_URL!, { max: 6, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    for (const name of (await readdir('scripts/db')).filter(name => /^\d\d_.*\.sql$/.test(name) && !name.startsWith('02_')).sort()) await client.unsafe(await readFile('scripts/db/' + name, 'utf8'));
    const db = drizzle(client), owner = randomUUID(), quote = { detectMarket: () => ({ market: 'US', currency: 'USD' }) } as QuoteService;
    const importer = new ImportService(db, quote), service = new TransactionsService(db, quote), cash = new CashAccountsService(db, service);
    await Promise.all(Array.from({ length: 8 }, () => cash.list(owner)));
    assert.equal((await db.select().from(cashAccounts).where(eq(cashAccounts.owner, owner))).length, 3);
    await importer.commit(owner, { source: 'csv', rows: [{ ticker: 'FIXT', shares: 10, avgCost: 8, currency: 'USD' }] });
    await service.create(owner, { txDate: '2026-11-06', txType: 'Deposit', ticker: '', shares: 100, price: 1, currency: 'USD' });
    const buy = await service.create(owner, { txDate: '2026-11-06', txType: 'Buy', ticker: 'FIXT', shares: 2, price: 10, currency: 'USD' });
    assert.equal(Number((await db.select().from(holdings))[0].shares), 12);
    await importer.commit(owner, { source: 'csv', rows: [{ ticker: 'FIXT', shares: 12, avgCost: 8.333333333333334, currency: 'USD' }] });
    await assert.rejects(importer.commit(owner, { source: 'csv', rows: [{ ticker: 'FIXT', shares: 9, avgCost: 8, currency: 'USD' }] }), /SNAPSHOT_REQUIRES_RECONCILIATION/);
    await service.remove(owner, buy.id);
    assert.equal(Number((await db.select().from(holdings))[0].shares), 10);
    assert.equal((await db.select().from(transactions)).length, 1);
    await service.reconcileAll(owner);
    assert.equal(Number((await cash.list(owner)).find(row => row.currency === 'USD')!.balance), 100);
    const imports = new TransactionImportsService(db, service);
    const input = { kind: 'trades' as const, source: 'csv' as const, baselineScope: 'after-opening' as const, broker: 'fictional', account: 'account-A', rows: [
      { txDate: '2026-11-06', txType: 'Buy', ticker: 'FIXT', shares: '2', price: '10', fees: '1', currency: 'USD', brokerId: 'execution-1' },
      { txDate: '2026-11-06', txType: 'Sell', ticker: 'FIXT', shares: '3', price: '12', fees: '1', currency: 'USD', brokerId: 'execution-2' },
    ] };
    const batch = await imports.create(owner, input);
    const command = { requestKey: randomUUID(), revision: batch.revision, ledgerRevision: batch.ledgerRevision, rowIds: batch.rows.map(row => row.id) };
    assert.equal((await imports.commit(owner, batch.id, command)).created, 2);
    assert.equal((await imports.commit(owner, batch.id, command)).created, 2);
    assert.equal(Number((await db.select().from(holdings))[0].shares), 9);
    assert.equal(Number((await cash.list(owner)).find(row => row.currency === 'USD')!.balance), 114);
    const overlap = await imports.create(owner, { ...input, source: 'screenshot', rows: input.rows.map(({ brokerId: _id, ...row }) => row) });
    assert.deepEqual(overlap.rows.map(row => row.status), ['duplicate', 'duplicate']);
    const separateExecution = await imports.create(owner, { ...input, rows: [{ ...input.rows[0], brokerId: 'different-execution' }] });
    assert.equal(separateExecution.rows[0].status, 'ready', 'two broker execution IDs remain distinct even at the same price and date');
    const conflictingIdentity = await imports.create(owner, { ...input, rows: [{ ...input.rows[0], fees: '2' }] });
    assert.equal(conflictingIdentity.rows[0].status, 'review');
    const invalid = await imports.create(owner, { ...input, rows: [{ ...input.rows[0], brokerId: 'fresh', shares: '1' }, { ...input.rows[1], brokerId: 'oversell', shares: '100' }] });
    await assert.rejects(imports.commit(owner, invalid.id, { requestKey: randomUUID(), revision: invalid.revision, ledgerRevision: invalid.ledgerRevision, rowIds: invalid.rows.map(row => row.id) }), /Insufficient shares/);
    assert.equal(Number((await db.select().from(holdings))[0].shares), 9);
    assert.equal((await db.select().from(transactions)).length, 3);
    await assert.rejects(imports.preview(randomUUID(), batch.id), /BATCH_NOT_FOUND/);
    const currentCash = (await cash.list(owner)).find(row => row.currency === 'USD')!;
    const confirmation = { requestKey: randomUUID(), balances: [{ currency: 'USD' as const, balance: 114, expectedUpdatedAt: currentCash.updatedAt }] };
    assert.equal((await cash.confirm(owner, confirmation)).items.find(row => row.currency === 'USD')?.reconciliationStatus, 'confirmed');
    await cash.confirm(owner, confirmation);
    await assert.rejects(cash.confirm(owner, { ...confirmation, requestKey: randomUUID() }), /CASH_CHANGED/);
    const separateReady = await imports.preview(owner, separateExecution.id);
    await imports.commit(owner, separateReady.id, { requestKey: randomUUID(), revision: separateReady.revision, ledgerRevision: separateReady.ledgerRevision, rowIds: separateReady.rows.map(row => row.id) });
    assert.equal(Number((await cash.list(owner)).find(row => row.currency === 'USD')!.balance), 93);
    const ambiguous = await imports.create(owner, { ...input, rows: [{ ...input.rows[0], brokerId: undefined }] });
    assert.equal(ambiguous.rows[0].status, 'review', 'an unidentified screenshot cannot choose between distinct identical executions');
    const partial = await imports.create(owner, { ...input, rows: [{ ...input.rows[0], brokerId: 'partial-1', shares: '1', fees: '0' }, { ...input.rows[0], brokerId: 'partial-2', shares: '1', fees: '0' }] });
    await imports.commit(owner, partial.id, { requestKey: randomUUID(), revision: partial.revision, ledgerRevision: partial.ledgerRevision, rowIds: [partial.rows[0].id] });
    const remaining = await imports.preview(owner, partial.id);
    assert.deepEqual(remaining.rows.map(row => row.status), ['duplicate', 'ready']);
    await imports.commit(owner, remaining.id, { requestKey: randomUUID(), revision: remaining.revision, ledgerRevision: remaining.ledgerRevision, rowIds: [remaining.rows[1].id] });
    assert.equal(Number((await db.select().from(holdings))[0].shares), 13);
    assert.equal(Number((await cash.list(owner)).find(row => row.currency === 'USD')!.balance), 73);
    const flows = await imports.create(owner, { kind: 'cash-flows', source: 'excel', broker: 'fictional', account: 'account-A', baselineScope: 'after-opening', rows: [
      { txDate: '2026-11-06', txType: 'Deposit', shares: 10, fees: 0, currency: 'USD', brokerId: 'flow-1' },
      { txDate: '2026-11-06', txType: 'Deposit', shares: 83, fees: 0, currency: 'USD', recordKind: 'balance' },
    ] });
    assert.deepEqual(flows.rows.map(row => row.status), ['ready', 'reference']);
    assert.deepEqual(flows.rows[1].issues, []);
    await imports.commit(owner, flows.id, { requestKey: randomUUID(), revision: flows.revision, ledgerRevision: flows.ledgerRevision, rowIds: [flows.rows[0].id] });
    assert.equal(Number((await cash.list(owner)).find(row => row.currency === 'USD')!.balance), 83);
    const unidentifiedOwner = randomUUID();
    await service.create(unidentifiedOwner, { txDate: '2026-11-06', txType: 'Deposit', ticker: '', shares: 100, price: 1, currency: 'USD' });
    const unidentifiedRow = { ...input.rows[0], brokerId: undefined, txTime: '10:30:00' };
    const unidentified = await imports.create(unidentifiedOwner, { ...input, rows: [unidentifiedRow] });
    await imports.commit(unidentifiedOwner, unidentified.id, { requestKey: randomUUID(), revision: unidentified.revision, ledgerRevision: unidentified.ledgerRevision, rowIds: unidentified.rows.map(row => row.id) });
    const identifiedOverlap = await imports.create(unidentifiedOwner, { ...input, rows: [{ ...unidentifiedRow, brokerId: 'distinct-1' }, { ...unidentifiedRow, brokerId: 'distinct-2' }] });
    assert.deepEqual(identifiedOverlap.rows.map(row => row.status), ['review', 'review'], 'one unidentified execution cannot silently consume two distinct broker references');
    assert.ok(identifiedOverlap.rows.every(row => row.issues.includes('AMBIGUOUS_IDENTITY')));
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});

test('cash upgrade retains ambiguous original balances and stays conservative on repeated migration', { skip: !process.env.EXPERIENCE_TEST_DATABASE_URL }, async () => {
  const admin = postgres(process.env.EXPERIENCE_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} }), namespace = 'cash_upgrade_' + randomUUID().replaceAll('-', '');
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  const client = postgres(process.env.EXPERIENCE_TEST_DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    const files = (await readdir('scripts/db')).filter(name => /^\d\d_.*\.sql$/.test(name) && !name.startsWith('02_')).sort();
    for (const name of files.filter(name => Number(name.slice(0, 2)) < 37)) await client.unsafe(await readFile('scripts/db/' + name, 'utf8'));
    // Fresh DDL includes upgrade markers; this isolated fixture deliberately recreates pre-upgrade data.
    await client`DROP TABLE IF EXISTS asset_ledger_migrations`;
    await client`DROP INDEX IF EXISTS idx_cash_owner_currency`;
    await client`INSERT INTO cash_accounts(owner,currency,balance) VALUES ('fixture','USD',200),('fixture','USD',300),('fixture','HKD',0),('fixture','HKD',0)`;
    const migration = await readFile('scripts/db/37_asset_ledger_integrity.sql', 'utf8');
    await client.unsafe(migration); await client.unsafe(migration);
    const rows = await client`SELECT currency,balance,reconciliation_status FROM cash_accounts ORDER BY currency`;
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.currency === 'USD')!.reconciliation_status, 'review');
    assert.equal((await client`SELECT * FROM cash_account_conflicts`).length, 4);
    assert.deepEqual((await client`SELECT (original->>'balance')::numeric AS amount FROM cash_account_conflicts WHERE currency='USD' ORDER BY amount`).map(row => Number(row.amount)), [200, 300]);
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});

test('cash confirmations protect included same-day ledger history while later entries remain editable', { skip: !process.env.EXPERIENCE_TEST_DATABASE_URL }, async () => {
  const admin = postgres(process.env.EXPERIENCE_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} }), namespace = 'cash_checkpoint_' + randomUUID().replaceAll('-', '');
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  const client = postgres(process.env.EXPERIENCE_TEST_DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    for (const name of (await readdir('scripts/db')).filter(name => /^\d\d_.*\.sql$/.test(name) && !name.startsWith('02_')).sort()) await client.unsafe(await readFile('scripts/db/' + name, 'utf8'));
    const db = drizzle(client), owner = randomUUID(), quote = { detectMarket: () => ({ market: 'US', currency: 'USD' }) } as QuoteService;
    const service = new TransactionsService(db, quote), cash = new CashAccountsService(db, service);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    await cash.list(owner);
    const original = await service.create(owner, { txDate: day, txType: 'Deposit', ticker: '', shares: 100, price: 1, currency: 'USD' });
    const account = (await cash.list(owner)).find(row => row.currency === 'USD')!;
    await cash.confirm(owner, { requestKey: randomUUID(), balances: [{ currency: 'USD', balance: 150, expectedUpdatedAt: account.updatedAt }] });
    await assert.rejects(service.update(owner, original.id, { shares: 120 }), /CASH_CHECKPOINT_HISTORY_REQUIRES_RECONCILIATION/);
    await assert.rejects(service.remove(owner, original.id), /CASH_CHECKPOINT_HISTORY_REQUIRES_RECONCILIATION/);
    assert.equal(Number((await cash.list(owner)).find(row => row.currency === 'USD')!.balance), 150);
    const later = await service.create(owner, { txDate: day, txType: 'Deposit', ticker: '', shares: 10, price: 1, currency: 'USD' });
    await service.update(owner, later.id, { shares: 20 });
    assert.equal(Number((await cash.list(owner)).find(row => row.currency === 'USD')!.balance), 170);
    await service.remove(owner, later.id);
    assert.equal(Number((await cash.list(owner)).find(row => row.currency === 'USD')!.balance), 150);
    const previousDay = new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10);
    const another = await service.create(owner, { txDate: day, txType: 'Deposit', ticker: '', shares: 10, price: 1, currency: 'USD' });
    await assert.rejects(service.update(owner, another.id, { txDate: previousDay }), /BEFORE_CASH_BASELINE/);
    assert.equal(Number((await cash.list(owner)).find(row => row.currency === 'USD')!.balance), 160);
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});

test('HK and CN ticker aliases share the imported checkpoint and preserve upgraded ledger identities', { skip: !process.env.EXPERIENCE_TEST_DATABASE_URL }, async () => {
  const admin = postgres(process.env.EXPERIENCE_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} }), namespace = 'ticker_checkpoint_' + randomUUID().replaceAll('-', '');
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  const client = postgres(process.env.EXPERIENCE_TEST_DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    for (const name of (await readdir('scripts/db')).filter(name => /^\d\d_.*\.sql$/.test(name) && !name.startsWith('02_')).sort()) await client.unsafe(await readFile('scripts/db/' + name, 'utf8'));
    const db = drizzle(client), quote = { detectMarket: (ticker: string) => ticker.startsWith('6') ? { market: 'CN', currency: 'CNY' } : { market: 'HK', currency: 'HKD' } } as QuoteService;
    const importer = new ImportService(db, quote), service = new TransactionsService(db, quote);
    for (const [alias, alternate, canonical, currency] of [['0700.HK', '00700.HK', '0700', 'HKD'], ['600000.SH', '600000.SS', '600000', 'CNY']]) {
      const owner = randomUUID();
      await importer.commit(owner, { source: 'csv', rows: [{ ticker: alias, shares: 10, avgCost: 8, currency }] });
      await service.create(owner, { txDate: '2026-11-06', txType: 'Deposit', ticker: '', shares: 1000, price: 1, currency });
      const buy = await service.create(owner, { txDate: '2026-11-06', txType: 'Buy', ticker: alias, shares: 2, price: 10, fees: 1, currency });
      let positions = await db.select().from(holdings).where(eq(holdings.owner, owner));
      assert.equal(positions.length, 1, `${alias} must update the imported security rather than create another holding`);
      assert.equal(Number(positions[0].shares), 12);
      const sell = await service.create(owner, { txDate: '2026-11-06', txType: 'Sell', ticker: alternate, shares: 3, price: 12, fees: 1, currency });
      assert.equal(Number((await db.select().from(holdings).where(eq(holdings.owner, owner)))[0].shares), 9);
      await service.update(owner, buy.id, { ticker: canonical, shares: 1 });
      assert.equal(Number((await db.select().from(holdings).where(eq(holdings.owner, owner)))[0].shares), 8);
      await service.remove(owner, sell.id);
      await service.reconcileAll(owner);
      positions = await db.select().from(holdings).where(eq(holdings.owner, owner));
      assert.equal(positions.length, 1);
      assert.equal(Number(positions[0].shares), 11);
      assert.equal(Number((await db.select().from(cashAccounts).where(eq(cashAccounts.owner, owner)))[0].balance), 989);
    }
    const upgradedOwner = randomUUID();
    await db.insert(holdings).values({ owner: upgradedOwner, ticker: '0700.HK', market: 'HK', currency: 'HKD', shares: '10', buyPrice: '8' });
    await client`INSERT INTO position_baselines(owner,ticker,market,currency,shares,avg_cost,source) VALUES (${upgradedOwner},'0700.HK','HK','HKD',10,8,'upgrade-checkpoint')`;
    await importer.commit(upgradedOwner, { source: 'csv', rows: [{ ticker: '0700', shares: 10, avgCost: 8, currency: 'HKD' }] });
    assert.deepEqual((await db.select().from(holdings).where(eq(holdings.owner, upgradedOwner))).map(row => row.ticker), ['0700.HK']);
    await service.reconcileAll(upgradedOwner);
    assert.equal((await db.select().from(holdings).where(eq(holdings.owner, upgradedOwner))).length, 1);
    const wrongCurrencyOwner = randomUUID();
    await service.create(wrongCurrencyOwner, { txDate: '2026-11-06', txType: 'Deposit', ticker: '', shares: 100, price: 1, currency: 'USD' });
    await assert.rejects(service.create(wrongCurrencyOwner, { txDate: '2026-11-06', txType: 'Buy', ticker: '0700.HK', shares: 1, price: 10, currency: 'USD' }), /POSITION_CURRENCY_MISMATCH/);
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});

test('startup migration replay does not confirm new cash or checkpoint post-upgrade trades', { skip: !process.env.EXPERIENCE_TEST_DATABASE_URL }, async () => {
  const admin = postgres(process.env.EXPERIENCE_TEST_DATABASE_URL!, { max: 1, onnotice: () => {} }), namespace = 'ledger_restart_' + randomUUID().replaceAll('-', '');
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  const client = postgres(process.env.EXPERIENCE_TEST_DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    for (const name of (await readdir('scripts/db')).filter(name => /^\d\d_.*\.sql$/.test(name) && !name.startsWith('02_')).sort()) await client.unsafe(await readFile('scripts/db/' + name, 'utf8'));
    const db = drizzle(client), owner = randomUUID(), service = new TransactionsService(db, { detectMarket: () => ({ market: 'US', currency: 'USD' }) } as QuoteService);
    await service.create(owner, { txDate: '2026-11-06', txType: 'Deposit', ticker: '', shares: 100, price: 1, currency: 'USD' });
    const buy = await service.create(owner, { txDate: '2026-11-06', txType: 'Buy', ticker: 'ACME', shares: 2, price: 10, currency: 'USD' });
    await client.unsafe(await readFile('scripts/db/37_asset_ledger_integrity.sql', 'utf8'));
    assert.equal((await db.select().from(cashAccounts).where(eq(cashAccounts.owner, owner)))[0].reconciliationStatus, 'unconfirmed');
    await service.remove(owner, buy.id);
    assert.equal((await db.select().from(holdings).where(eq(holdings.owner, owner))).length, 0);
    assert.equal(Number((await db.select().from(cashAccounts).where(eq(cashAccounts.owner, owner)))[0].balance), 100);
  } finally { await client.end(); await admin`DROP SCHEMA ${admin(namespace)} CASCADE`; await admin.end(); }
});
