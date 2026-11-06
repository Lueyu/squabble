const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');
const ExcelJS = require('exceljs');
function load(file) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} }; new Function('require', 'module', 'exports', compiled)(require, mod, mod.exports); return mod.exports;
}
test('CSV preserves quoted cash amounts and missing fees for human review', async () => {
  const { readTransactionMatrix } = load('transaction-file.ts');
  const matrix = await readTransactionMatrix({ name: 'trades.csv', size: 80, text: async () => 'Date,Amount,Fees\n2026-11-06,"1,200",\n' });
  assert.deepEqual(matrix, [['Date', 'Amount', 'Fees'], ['2026-11-06', '1,200', '']]);
});
test('Excel reads real numeric cells and date cells without fabricating missing fees', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Trades');
  sheet.addRow(['Date', 'Quantity', 'Price', 'Fees', 'Currency']);
  sheet.addRow([new Date('2026-11-06T00:00:00Z'), 2, 10.25, 0, 'USD']);
  sheet.addRow([new Date('2026-11-06T00:00:00Z'), 3, 11, null, 'USD']);
  const bytes = await workbook.xlsx.writeBuffer();
  const { readTransactionMatrix } = load('transaction-file.ts');
  const matrix = await readTransactionMatrix({ name: 'trades.xlsx', size: bytes.byteLength, arrayBuffer: async () => bytes });
  assert.deepEqual(matrix[1], ['2026-11-06', '2', '10.25', '0', 'USD']);
  assert.equal(matrix[2][3], '');
});
test('all transaction types show the same signed cash amount as the ledger', () => {
  const { transactionCashDelta } = load('transaction-cash.ts');
  const value = { shares: '100', price: '1', fees: '2' };
  assert.equal(transactionCashDelta({ ...value, txType: 'Deposit' }), 98);
  assert.equal(transactionCashDelta({ ...value, txType: 'Withdrawal' }), -102);
  assert.equal(transactionCashDelta({ ...value, txType: 'Fee' }), -102);
  assert.equal(transactionCashDelta({ ...value, txType: 'Opening' }), 0);
});
