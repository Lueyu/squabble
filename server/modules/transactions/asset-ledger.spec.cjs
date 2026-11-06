const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryDb, loadService } = require('./transactions-regression.spec.cjs');
const TransactionsService = loadService('server/modules/transactions/transactions.service.ts', 'TransactionsService');
const quote = { detectMarket: () => ({ market: 'US', currency: 'USD' }) };
const owner = 'fictional-ledger';
const dto = (txType, shares, price = 10) => ({ txType, shares, price, txDate: '2026-11-06', ticker: 'TEST', currency: 'USD' });
test('imported position survives buy, sell, edit, deletion and reconciliation', async () => {
  const db = new MemoryDb();
  db.data.holdings.push({ id: 'holding', owner, ticker: 'TEST', shares: '10', buyPrice: '8', currency: 'USD', market: 'US' });
  db.data.positionBaselines.push({ id: 'opening', owner, ticker: 'TEST', shares: '10', avgCost: '8', currency: 'USD', market: 'US', coveredTransactionIds: [], source: 'csv', observedAt: new Date('2026-11-06') });
  const service = new TransactionsService(db, quote);
  await service.create(owner, dto('Deposit', 100));
  const buy = await service.create(owner, dto('Buy', 2));
  assert.equal(Number(db.data.holdings[0].shares), 12);
  const sell = await service.create(owner, dto('Sell', 3, 12));
  assert.equal(Number(db.data.holdings[0].shares), 9);
  assert.equal(Number(db.data.cashAccounts[0].balance), 116);
  await service.update(owner, sell.id, { shares: 2 });
  assert.equal(Number(db.data.holdings[0].shares), 10);
  await service.remove(owner, sell.id);
  assert.equal(Number(db.data.holdings[0].shares), 12);
  await service.remove(owner, buy.id);
  assert.equal(Number(db.data.holdings[0].shares), 10);
  await service.reconcileAll(owner);
  assert.equal(Number(db.data.holdings[0].shares), 10);
  assert.equal(Number(db.data.cashAccounts[0].balance), 100);
});
test('invalid fee, currency and edited oversell roll back the entire ledger', async () => {
  const db = new MemoryDb(), service = new TransactionsService(db, quote);
  await service.create(owner, dto('Opening', 10));
  await assert.rejects(service.create(owner, { ...dto('Sell', 1), fees: -2 }));
  await assert.rejects(service.create(owner, { ...dto('Deposit', 100), currency: 'XYZ' }));
  const sell = await service.create(owner, dto('Sell', 2));
  const before = structuredClone(db.data);
  await assert.rejects(service.update(owner, sell.id, { shares: 20 }));
  assert.deepEqual(db.data, before);
});
test('reconciliation preserves recorded cash without inventing historical deposits', async () => {
  const db = new MemoryDb(), service = new TransactionsService(db, quote);
  db.data.cashAccounts.push({ id: 'cash', owner, currency: 'USD', balance: '500', reconciliationStatus: 'confirmed' });
  await service.create(owner, dto('Buy', 2));
  await service.reconcileAll(owner);
  assert.equal(Number(db.data.cashAccounts[0].balance), 480);
  assert.deepEqual(db.data.transactions.map(row => row.txType), ['Buy']);
});
test('fee quick entry moves cash and rejects nonfinite quantities', async () => {
  const db = new MemoryDb(), service = new TransactionsService(db, quote);
  await service.create(owner, dto('Deposit', 100));
  await service.create(owner, dto('Fee', 3, 1));
  assert.equal(Number(db.data.cashAccounts[0].balance), 97);
  await assert.rejects(service.create(owner, dto('Deposit', Infinity)));
});
test('a trade preceding the imported checkpoint cannot be counted again as a new lot', async () => {
  const db = new MemoryDb(), service = new TransactionsService(db, quote);
  db.data.holdings.push({ id: 'h', owner, ticker: 'TEST', shares: '10', buyPrice: '8', currency: 'USD' });
  db.data.positionBaselines.push({ id: 'b', owner, ticker: 'TEST', shares: '10', avgCost: '8', currency: 'USD', coveredTransactionIds: [], observedAt: new Date('2026-11-06T00:00:00Z') });
  await service.create(owner, dto('Deposit', 100));
  await assert.rejects(service.create(owner, { ...dto('Buy', 2), txDate: '2026-11-05' }), /BEFORE_POSITION_BASELINE/);
  assert.equal(Number(db.data.holdings[0].shares), 10);
});
test('first recorded cash movement does not confirm an unknown opening cash balance', async () => {
  for (const txType of ['Deposit', 'Sell']) {
    const db = new MemoryDb(), service = new TransactionsService(db, quote);
    if (txType === 'Sell') await service.create(owner, dto('Opening', 10));
    await service.create(owner, dto(txType, 2));
    assert.equal(db.data.cashAccounts[0].reconciliationStatus, 'unconfirmed');
    assert.equal(Number(db.data.cashAccounts[0].balance), txType === 'Sell' ? 20 : 2);
  }
});
test('position identity preserves a supported slash-class security during quick entry', async () => {
  const db = new MemoryDb(), service = new TransactionsService(db, quote);
  await service.create(owner, dto('Deposit', 1000));
  const buy=await service.create(owner,{...dto('Buy',2),ticker:'BRK/B'});
  assert.equal(buy.ticker,'BRK/B');
  assert.equal(db.data.holdings[0].ticker,'BRK/B');
  await service.remove(owner,buy.id);
  assert.equal(db.data.holdings.length,0);
});
