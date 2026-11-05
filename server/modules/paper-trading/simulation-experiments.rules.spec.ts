import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOpeningSeed, executionEconomics, seedRevision, sourceLedgerRevision, validateCashTransfer } from './simulation-experiments.rules';
import { cashSettlementAt } from './simulation-ledger';

const source = {
  holdings: [{ id: 'holding', ticker: 'AAPL', market: 'US', currency: 'USD', company: 'Example', shares: '10',
    buyPrice: '25', currentPrice: '100', updatedAt: new Date('2026-11-05T01:00:00Z') }],
  cash: [{ currency: 'USD', balance: '500', updatedAt: new Date('2026-11-05T01:00:00Z') }],
};
test('opening balances conserve shares and cash without treating historical cost as performance', () => {
  const seed = buildOpeningSeed(source, [{ ticker: 'AAPL', price: '100', at: '2026-11-05T01:00:00Z' }],
    [{ currency: 'USD', rate: '1', at: '2026-11-05' }], '2026-11-05T01:00:00Z');
  assert.equal(seed.initialEquityUsd, '1500.00');
  assert.equal(seed.positions[0].shares, '10');
  assert.equal(seed.positions[0].historicalCost, '25');
  assert.equal(seed.positions[0].initialPrice, '100');
  assert.equal(seed.positions[0].sellableShares, null);
  assert.equal(seed.cash[0].total, '500');
  assert.equal(seed.cash[0].available, '0');
  assert.equal(seed.cash[0].frozen, '500');
  assert.ok(seed.gaps.includes('SELLABILITY_UNKNOWN:AAPL'));
});
test('missing cash and FX remain unknown instead of inventing USD funding', () => {
  const seed = buildOpeningSeed({ holdings: [{ ...source.holdings[0], currency: 'HKD', market: 'HK' }], cash: [] },
    [{ ticker: 'AAPL', price: '100', at: '2026-11-05T01:00:00Z' }], [], '2026-11-05T01:00:00Z');
  assert.equal(seed.initialEquityUsd, null);
  assert.ok(seed.gaps.includes('CASH_UNKNOWN'));
  assert.ok(seed.gaps.includes('FX_MISSING:HKD'));
});
test('source revision changes with quantities, cash and source update time', () => {
  assert.notEqual(seedRevision(source), seedRevision({ ...source, cash: [{ ...source.cash[0], balance: '501' }] }));
  assert.notEqual(seedRevision(source), seedRevision({ ...source, holdings: [{ ...source.holdings[0], shares: '11' }] }));
});
test('source ledger comparison ignores marks, timestamps and confirmations but detects economic changes', () => {
  const seed = buildOpeningSeed(source, [], [], '2026-11-05T01:00:00Z');
  seed.cash[0].available = '200'; seed.cash[0].frozen = '300';
  seed.positions[0].sellableShares = '5';
  const refreshed = { holdings: [{ ...source.holdings[0], shares: '10.000', buyPrice: '25.00',
    currentPrice: '200', updatedAt: new Date() }], cash: [{ ...source.cash[0], balance: '500.00', updatedAt: new Date() }] };
  assert.equal(sourceLedgerRevision(seed), sourceLedgerRevision(refreshed));
  assert.notEqual(seedRevision(source), seedRevision(refreshed), 'preview CAS retains its existing stricter revision');
  assert.notEqual(sourceLedgerRevision(seed), sourceLedgerRevision({ ...source, cash: [{ ...source.cash[0], balance: '501' }] }));
  assert.notEqual(sourceLedgerRevision(seed), sourceLedgerRevision({ ...source, holdings: [{ ...source.holdings[0], shares: '11' }] }));
  assert.equal(sourceLedgerRevision({ ...seed, positions: [{ ...seed.positions[0], sourceHoldingId: '' }] }), null, 'incomplete historical source identity is unknown');
});
test('FX transfers require explicit currency, settled funds and a positive fresh rate', () => {
  assert.throws(() => validateCashTransfer('USD', 'HKD', 100, 50, 7.8), /available/i);
  assert.throws(() => validateCashTransfer('USD', 'USD', 10, 50, 1), /different/i);
  assert.equal(validateCashTransfer('USD', 'HKD', 10, 50, 7.8), '78.00000000');
});
test('execution model charges fees and unfavorable slippage without changing the opening valuation', () => {
  const buy = executionEconomics(100, 10, 'buy', 5, 10);
  assert.equal(buy.price, 100.1);
  assert.ok(Math.abs(buy.cashAmount - 1001.5005) < 1e-8);
  const sell = executionEconomics(100, 10, 'sell', 5, 10);
  assert.equal(sell.price, 99.9);
  assert.ok(Math.abs(sell.cashAmount - 998.5005) < 1e-8);
  assert.throws(() => executionEconomics(100, 10, 'buy', -1, 10), /model/);
});
test('cash settlement skips weekends and US money-settlement bank holidays', () => {
  assert.equal(cashSettlementAt('US', new Date('2026-11-10T15:30:00Z')).toISOString(), '2026-11-12T21:00:00.000Z');
  assert.equal(cashSettlementAt('HK', new Date('2026-11-05T02:00:00Z')).toISOString(), '2026-11-09T08:00:00.000Z');
});
