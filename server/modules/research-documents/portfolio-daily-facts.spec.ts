import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPortfolioDailyFacts } from './portfolio-daily-facts';

const at = new Date('2026-11-05T01:00:00Z');
const tx = (id: string, txType: string, currency: string, shares: string, price: string) => ({ id, txDate: '2026-11-05', ticker: txType === 'Deposit' ? 'CASH' : 'ACME', txType, currency, shares, price, fees: '1', notes: null, updatedAt: at });
const snapshots = [
  { id: 'previous', snapshotDate: '2026-11-04', accountValue: '1000', updatedAt: at },
  { id: 'today', snapshotDate: '2026-11-05', accountValue: '1120', updatedAt: at },
];
test('server daily facts strip deposits from profit and retain raw transaction provenance in original currencies', () => {
  const result = buildPortfolioDailyFacts(at, [tx('d', 'Deposit', 'USD', '1', '100'), tx('b', 'Buy', 'HKD', '10', '3')], snapshots, []);
  assert.equal(result.businessDate, '2026-11-05'); assert.equal(result.timezone, 'Asia/Shanghai');
  assert.equal(result.returnBasis.pnlUsd, 20); assert.equal(result.returnBasis.returnPct, 2);
  assert.equal(result.returnBasis.netExternalFlowUsd, 100);
  assert.equal(result.transactions[1].notional, 30); assert.equal(result.transactions[1].id, 'b');
  assert.equal(result.byCurrency.find(row => row.currency === 'HKD')?.buys, 30);
  assert.equal(result.marketSessions.find(row => row.market === 'US')?.tradingDate, '2026-11-04');
  assert.equal(result.marketSessions.find(row => row.market === 'CN')?.tradingDate, '2026-11-05');
});
test('missing dated FX, missing boundary and later ledger edits leave daily return unknown', () => {
  const flow = tx('c', 'Deposit', 'CNY', '1', '700');
  assert.equal(buildPortfolioDailyFacts(at, [flow], snapshots, []).returnBasis.pnlUsd, null);
  assert.equal(buildPortfolioDailyFacts(at, [flow], snapshots, [{ base: 'USD', quote: 'CNY', rate: '7', rateDate: '2026-11-05' }]).returnBasis.pnlUsd, 20);
  assert.equal(buildPortfolioDailyFacts(at, [], snapshots.slice(1), []).returnBasis.returnPct, null);
  assert.equal(buildPortfolioDailyFacts(at, [], [{ ...snapshots[0], snapshotDate: '2026-11-03' }, snapshots[1]], []).returnBasis.returnPct, null);
  assert.equal(buildPortfolioDailyFacts(at, [{ ...flow, updatedAt: new Date(at.getTime() + 1) }], snapshots, []).returnBasis.pnlUsd, null);
});
test('unknown market calendar, Opening and old snapshots are gaps; old reported dailyPnl is never trusted', () => {
  const result = buildPortfolioDailyFacts(at, [tx('o', 'Opening', 'USD', '1', '80')], snapshots, []);
  assert.equal(result.returnBasis.pnlUsd, null); assert.match(result.gaps.join(' '), /Opening|期初/);
  const future = buildPortfolioDailyFacts(new Date('2027-01-05T01:00:00Z'), [], snapshots, []);
  assert.ok(future.marketSessions.every(row => !row.calendarVerified && row.lastCompletedTradingDate === null));
  assert.equal(future.returnBasis.pnlUsd, null);
});
