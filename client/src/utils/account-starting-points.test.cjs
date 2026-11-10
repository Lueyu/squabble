const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

test('all four starting points produce bounded preview requests, never user-selected current prices or historical dates', () => {
  const { accountSeedInput } = fixture().load('features/companions/account-starting-points.ts');
  const input = { origin: 'cash', amount: '10000', currency: 'USD', sourceAccountId: '', positions: [], cash: {} };
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(accountSeedInput(input)), { origin: 'cash', cash: { currency: 'USD', amount: 10000 } });
  assert.deepEqual(plain(accountSeedInput({ ...input, origin: 'holdings' })), { origin: 'holdings' });
  assert.equal(accountSeedInput({ ...input, origin: 'account' }), null);
  assert.deepEqual(plain(accountSeedInput({ ...input, origin: 'account', sourceAccountId: 'owned-account' })), { origin: 'account', sourceAccountId: 'owned-account' });
  const custom = { ...input, origin: 'custom', positions: [{ id: 'row-1', ticker: '700.HK', shares: '10', cost: '99' }], cash: { USD: '1000', HKD: '200' } };
  assert.deepEqual(plain(accountSeedInput(custom)), { origin: 'custom', holdings: [{ ticker: '0700.HK', shares: 10, historicalCost: 99 }], cash: [{ currency: 'USD', amount: 1000 }, { currency: 'HKD', amount: 200 }] });
  for (const shares of ['', '0', '-1', 'Infinity', '1000000000001']) assert.equal(accountSeedInput({ ...custom, positions: [{ ...custom.positions[0], shares }] }), null);
  assert.equal(accountSeedInput({ ...custom, positions: [...custom.positions, { id: 'row-2', ticker: '0700.HK', shares: '5', cost: '' }] }), null);
  assert.equal(accountSeedInput({ ...custom, cash: { USD: '-1' } }), null);
});
