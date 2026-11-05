import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeStrategyBuy, sizeStrategySell } from './strategy-sizing';

test('candidate budgets include execution price and fee before rounding', () => {
  assert.equal(sizeStrategyBuy({ ticker: 'AAPL', market: 'US', budgetUsd: 200, cashUsd: 200, price: 100, fx: 1, feeBps: 5, slippageBps: 10 }), 1);
  assert.equal(sizeStrategyBuy({ ticker: 'AAPL', market: 'US', budgetUsd: 10000, cashUsd: 100, price: 100, fx: 1, feeBps: 5, slippageBps: 0 }), 0);
});
test('CN and HK buys respect verified lots and STAR minimums without rounding up', () => {
  assert.equal(sizeStrategyBuy({ ticker: '600000.SS', market: 'CN', budgetUsd: 200, cashUsd: 200, price: 5, fx: 0.14 }), 200);
  assert.equal(sizeStrategyBuy({ ticker: '688001.SS', market: 'CN', budgetUsd: 139, cashUsd: 139, price: 5, fx: 0.14 }), 0);
  assert.equal(sizeStrategyBuy({ ticker: '688001.SS', market: 'CN', budgetUsd: 200, cashUsd: 200, price: 5, fx: 0.14 }), 285);
  assert.equal(sizeStrategyBuy({ ticker: '0700.HK', market: 'HK', budgetUsd: 10000, cashUsd: 10000, price: 500, fx: 0.13, lotSize: 100 }), 100);
  assert.equal(sizeStrategyBuy({ ticker: '0700.HK', market: 'HK', budgetUsd: 10000, cashUsd: 10000, price: 500, fx: 0.13 }), 0);
});
test('reductions subtract restricted and unsettled shares and preserve sellable residuals', () => {
  assert.equal(sizeStrategySell('AAPL', 'US', 100, 30, 0), 70);
  assert.equal(sizeStrategySell('600000.SS', 'CN', 350, 50, 100), 200);
  assert.equal(sizeStrategySell('600000.SS', 'CN', 155, 30, 0), 125);
  assert.equal(sizeStrategySell('0700.HK', 'HK', 350, 30, 0, 100), 300);
});
