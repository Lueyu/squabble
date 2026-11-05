import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveInvestmentConfig, normalizeInvestmentRequest, investmentOrderBlock, DEFAULT_INVESTMENT_CONFIG } from './investment-policy.rules';

test('investment requests reject client owners, unknown keys and unconfirmed imaginary cash', () => {
  assert.throws(() => normalizeInvestmentRequest('preview', { origin: 'cash', requestKey: 'cash-start-1' }));
  assert.throws(() => normalizeInvestmentRequest('preview', { origin: 'holdings', requestKey: 'cash-start-1', owner: 'other' }));
  assert.equal(normalizeInvestmentRequest('preview', { origin: 'cash', cash: { amount: 1000, currency: 'USD' }, requestKey: 'cash-start-1' }).origin, 'cash');
});

test('temporary numeric limits restore permanent settings; no_sell includes protection', () => {
  const now = new Date('2026-11-06T00:00:00Z');
  const records = [
    { id: 'one', proposalId: 'p1', createdAt: '2026-11-04T00:00:00Z', revokedAt: null, status: 'active' as const, constraint: { kind: 'cash_floor' as const, percent: 20, expiresAt: null } },
    { id: 'two', proposalId: 'p2', createdAt: '2026-11-05T00:00:00Z', revokedAt: null, status: 'active' as const, constraint: { kind: 'cash_floor' as const, percent: 40, expiresAt: '2026-11-07T00:00:00Z' } },
    { id: 'three', proposalId: 'p3', createdAt: '2026-11-05T00:00:00Z', revokedAt: null, status: 'active' as const, constraint: { kind: 'no_sell' as const, ticker: 'AAPL', expiresAt: null } },
  ];
  assert.equal(effectiveInvestmentConfig(DEFAULT_INVESTMENT_CONFIG, records, now).limits.minCashPct, 40);
  const after = effectiveInvestmentConfig(DEFAULT_INVESTMENT_CONFIG, records, new Date('2026-11-08T00:00:00Z'));
  assert.equal(after.limits.minCashPct, 20);
  assert.match(investmentOrderBlock(after, { ticker: 'AAPL', side: 'sell', market: 'US', protectiveStop: true })!, /NO_SELL/);
});

test('invalid cash and market combinations cannot silently create authority', () => {
  assert.throws(() => effectiveInvestmentConfig(DEFAULT_INVESTMENT_CONFIG, [{ id: 'c', proposalId: 'p', createdAt: new Date().toISOString(), revokedAt: null, status: 'active', constraint: { kind: 'markets', markets: [], expiresAt: null } }]));
  assert.throws(() => normalizeInvestmentRequest('pause', { requestKey: 'pause-once', expectedRevision: 0 }));
});
