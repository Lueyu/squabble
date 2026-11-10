import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyAccountFacts, dailyDate } from './daily-workspace.rules';

test('daily facts count actual fills rather than order creation and keep unknown valuation unknown', () => {
  const result = dailyAccountFacts({ id: 'a', name: 'Fictional', status: 'paused' }, '2026-11-10', [], [
    { id: 'fill', orderId: 'old-order', ticker: 'TEST', side: 'buy', quantity: '2', price: '10', fee: '1', currency: 'USD', createdAt: new Date('2026-11-10T02:00:00Z') },
  ], [{ id: 'blocked', ticker: 'TEST', side: 'buy', status: 'rejected_risk', reason: 'Cash limit', createdAt: new Date('2026-11-10T03:00:00Z') }]);
  assert.equal(result.trades.length, 1);
  assert.equal(result.notExecuted.length, 1);
  assert.equal(result.equityUsd, null);
  assert.equal(result.dailyPnlUsd, null);
  assert.ok(result.gaps.length > 0);
  assert.equal(result.trades[0].fee, 1);
  assert.equal(result.trades[0].feeCurrency, 'USD', 'recorded paper fees are converted to USD by the execution ledger');
});

test('verified neighboring snapshots reconcile recorded daily profit without model arithmetic', () => {
  const result = dailyAccountFacts({ id: 'a', name: 'Fictional', status: 'running' }, '2026-11-10', [
    { snapshotDate: '2026-11-09', equity: '100', cash: '50', dailyPl: '0', valuedAt: new Date('2026-11-09T08:00:00Z') },
    { snapshotDate: '2026-11-10', equity: '104', cash: '50', dailyPl: '4', valuedAt: new Date('2026-11-10T08:00:00Z') },
  ], [], []);
  assert.equal(result.openingEquityUsd, 100);
  assert.equal(result.dailyPnlUsd, 4);
});

test('a fill after valuation makes daily profit unknown; unknown fees never become zero', () => {
  const result = dailyAccountFacts({ id: 'a', name: 'Fictional', status: 'running' }, '2026-11-10', [
    { snapshotDate: '2026-11-10', equity: '100', cash: '50', dailyPl: '4', valuedAt: new Date('2026-11-10T01:00:00Z') },
  ], [{ id: 'fill', orderId: 'o', ticker: 'TEST', side: 'buy', quantity: '2', price: '10', fee: null, currency: 'CNY', createdAt: new Date('2026-11-10T02:00:00Z') }], []);
  assert.equal(result.dailyPnlUsd, null);
  assert.equal(result.trades[0].fee, null);
});

test('business date is explicitly Shanghai and invalid dates fail', () => {
  assert.equal(dailyDate(undefined, new Date('2026-11-09T17:00:00Z')), '2026-11-10');
  assert.throws(() => dailyDate('2026-02-30'), /INVALID_DAILY_DATE/);
});

test('pending approvals and failed attempts remain visible as unexecuted orders', () => {
  const statuses = ['pending', 'pending_approval', 'failed', 'rejected_risk', 'cancelled', 'filled'];
  const result = dailyAccountFacts({ id: 'a', name: 'Fictional', status: 'paused' }, '2026-11-10', [], [],
    statuses.map(status => ({ id: status, ticker: 'TEST', side: 'buy', status, reason: `${status} reason`, createdAt: new Date() })));
  assert.deepEqual(result.notExecuted.map(row => row.status), statuses.filter(status => status !== 'filled'));
});
