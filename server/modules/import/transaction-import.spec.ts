import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImportRows, parseLedgerScreenshot } from './transaction-import.rules';
const input = { kind: 'trades' as const, source: 'csv' as const, broker: 'fixture', account: 'account-A' };
const buy = { txDate: '2026-11-06', txType: 'Buy', ticker: 'TEST', shares: '2', price: '10', fees: '1', currency: 'USD', brokerId: 'trade-1' };
test('cross-file overlap has stable economic fingerprint and explicit broker identity', () => {
  const [csv] = normalizeImportRows({ ...input, rows: [buy] });
  const [screen] = normalizeImportRows({ ...input, source: 'screenshot', rows: [{ ...buy, brokerId: undefined }] });
  assert.equal(csv.fingerprint, screen.fingerprint);
  assert.ok(csv.identity);
  assert.equal(csv.value?.fees, 1);
});
test('missing currency, price, fees and invalid dates remain reviewable', () => {
  for (const patch of [{ currency: '' }, { price: '' }, { fees: undefined }, { txDate: '2026-02-30' }, { shares: '-2' }]) {
    const [row] = normalizeImportRows({ ...input, rows: [{ ...buy, ...patch }] });
    assert.equal(row.status, 'review');
    assert.ok(row.issues.length);
  }
});
test('cash summaries and trade settlements never become external deposits', () => {
  const rows = normalizeImportRows({ ...input, kind: 'cash-flows', rows: [{ ...buy, txType: 'Deposit', recordKind: 'balance' }, { ...buy, txType: 'Deposit', recordKind: 'settlement' }] });
  assert.deepEqual(rows.map(row => row.status), ['reference', 'reference']);
  assert.ok(rows.every(row => !row.value));
});
test('ledger screenshot keeps incorrect and uncertain records visible for correction', () => {
  const result = parseLedgerScreenshot('Here is the extraction:\n```json\n' + JSON.stringify({ kind: 'trades', rows: [buy, { ...buy, price: '?' }] }) + '\n```', 'trades');
  assert.equal(result.length, 2);
  assert.equal(result[1].price, '?');
  assert.throws(() => parseLedgerScreenshot('{"kind":"holdings","rows":[]}', 'trades'), /DOCUMENT_KIND_MISMATCH/);
});
test('execution time must be a valid clock time before it identifies a transaction', () => {
  for (const txTime of ['24:00', '10:60', '10:30:99', '99:99']) {
    const [row] = normalizeImportRows({ ...input, rows: [{ ...buy, brokerId: undefined, txTime }] });
    assert.equal(row.status, 'review');
    assert.ok(row.issues.includes('INVALID_TIME'));
  }
});
