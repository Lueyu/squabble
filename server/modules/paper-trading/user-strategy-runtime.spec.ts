import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from './user-strategy-runtime';
import { compileInvestorRules } from './user-strategy-runtime';
import { strategyTriggerMatches } from './strategy.rules';
import { DEFAULT_INVESTMENT_CONFIG } from './investment-policy.rules';
import type { ConfirmedInvestmentStrategy } from '../../../shared/user-investment-strategy.interface';

test('concrete investor prices trigger without history or invented investment bounds, always respects entry time', () => {
  const directive = { entryId: 'aapl-buy', ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_lte', price: 100 }, quantity: 2,
    startsAt: '2026-11-06T00:00:00Z', endsAt: '2026-11-07T00:00:00Z', timezone: 'Asia/Shanghai', sourceKeys: [], route: 'direct', reviewedText: 'Buy 2 AAPL below 100', numericEvidence: [] };
  const snapshot = { id: 'approved', revision: 1, preview: { directives: [directive] }, sources: [] } as unknown as ConfirmedInvestmentStrategy;
  const [rule] = compileInvestorRules(snapshot, DEFAULT_INVESTMENT_CONFIG);
  assert.equal(strategyTriggerMatches(rule, 99, null, new Date('2026-11-06T12:00:00Z')), true);
  assert.equal(strategyTriggerMatches(rule, 101, null, new Date('2026-11-06T12:00:00Z')), false);
  assert.equal(strategyTriggerMatches(rule, 99, null, new Date('2026-11-05T00:00:00Z')), false);
  assert.equal(strategyTriggerMatches(rule, 99, null, new Date('2026-11-08T00:00:00Z')), false);
  assert.equal(rule.stopLossPrice, 0);
});

test('target total exposure uses existing shares, costs and market lot rounding without repeating an increase', () => {
  const size = runtime.investorTargetQuantity;
  const base = { ticker: 'AAPL', market: 'US', heldShares: 2, equityUsd: 10000, price: 100, fx: 1, positionPct: 10, side: 'buy', feeBps: 0, slippageBps: 0, lotSize: 1 };
  assert.equal(size(base), 8, 'buys the gap to 10%, not another 10% order');
  assert.equal(size({ ...base, heldShares: 10 }), 0);
  assert.equal(size({ ...base, heldShares: 20, side: 'sell' }), 10);
  assert.equal(size({ ...base, heldShares: 10, side: 'sell' }), 0);
  assert.equal(size({ ...base, feeBps: 5, slippageBps: 10 }), 7, 'fees cannot push the resulting exposure above the confirmed total target');
  assert.equal(size({ ...base, ticker: '0700.HK', market: 'HK', equityUsd: 100000, heldShares: 200, positionPct: 50, lotSize: 200 }), 200);
  assert.equal(size({ ...base, ticker: '0700.HK', market: 'HK', equityUsd: 100000, heldShares: 1000, positionPct: 50, lotSize: 200, side: 'sell' }), 400, 'round toward the target without selling below it');
});
