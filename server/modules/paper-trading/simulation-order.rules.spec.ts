import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simulationLotRejection } from './simulation-order.rules';

test('CN main-board buys require board lots and sells cannot manufacture odd lots', () => {
  assert.match(simulationLotRejection('600000', 'CN', 'buy', 5, 0) ?? '', /100/);
  assert.equal(simulationLotRejection('600000', 'CN', 'buy', 100, 0), null);
  assert.match(simulationLotRejection('600000', 'CN', 'sell', 101, 500) ?? '', /odd/);
  assert.equal(simulationLotRejection('600000', 'CN', 'sell', 105, 105), null);
});
test('STAR uses 200-share minimum with integer increments; whole residual exits are allowed', () => {
  assert.match(simulationLotRejection('688001.SH', 'CN', 'buy', 100, 0) ?? '', /200/);
  assert.equal(simulationLotRejection('688001.SH', 'CN', 'buy', 201, 0), null);
  assert.equal(simulationLotRejection('688001.SH', 'CN', 'sell', 100, 100), null);
});
test('HK unknown board lot and odd-lot matching fail closed instead of assuming a lot size', () => {
  assert.match(simulationLotRejection('0700.HK', 'HK', 'buy', 100, 0) ?? '', /unknown/);
  assert.equal(simulationLotRejection('0700.HK', 'HK', 'buy', 100, 0, 100), null);
  assert.match(simulationLotRejection('0700.HK', 'HK', 'sell', 25, 25, 100) ?? '', /odd/);
});
