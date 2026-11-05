import test from 'node:test';
import assert from 'node:assert/strict';
import { routeStrategyCandidate, DEFAULT_ROUTE_POLICY } from './strategy-route.rules';

const context = () => ({ hardBlock: null as string | null, side: 'buy' as 'buy' | 'sell', protectiveStop: false,
  deterministic: true, semanticCondition: '', conflict: false, liquidityRisk: false,
  equityUsd: 100000, currentExposureUsd: 1000, pendingBuyUsd: 0, rollingBuyUsd: 0,
  candidateNotionalUsd: 1000, hardPositionCapPct: 10, policy: DEFAULT_ROUTE_POLICY });
test('hard validity wins over protective exits; authorized protection otherwise routes directly', () => {
  assert.equal(routeStrategyCandidate({ ...context(), protectiveStop: true, side: 'sell', hardBlock: 'stale quote' }).route, 'blocked');
  assert.equal(routeStrategyCandidate({ ...context(), protectiveStop: true, side: 'sell', conflict: true }).route, 'direct');
  assert.equal(routeStrategyCandidate({ ...context(), protectiveStop: true }).route, 'blocked');
});
test('small measurable conditions avoid model calls; semantic ambiguity requires AI', () => {
  assert.equal(routeStrategyCandidate(context()).route, 'direct');
  assert.equal(routeStrategyCandidate({ ...context(), semanticCondition: 'earnings thesis remains intact' }).route, 'ai');
  assert.equal(routeStrategyCandidate({ ...context(), deterministic: false }).route, 'ai');
});
test('post-trade position, pending and rolling accumulation independently escalate deterministic buys', () => {
  assert.equal(routeStrategyCandidate({ ...context(), currentExposureUsd: 7000 }).route, 'council');
  assert.equal(routeStrategyCandidate({ ...context(), pendingBuyUsd: 6000 }).route, 'council');
  assert.equal(routeStrategyCandidate({ ...context(), rollingBuyUsd: 2000 }).route, 'council');
  assert.equal(routeStrategyCandidate({ ...context(), candidateNotionalUsd: 3000 }).route, 'council');
});
test('ordinary risk reductions stay fast; conflicting or illiquid exits need council', () => {
  assert.equal(routeStrategyCandidate({ ...context(), side: 'sell', currentExposureUsd: 50000, candidateNotionalUsd: 40000 }).route, 'direct');
  assert.equal(routeStrategyCandidate({ ...context(), side: 'sell', liquidityRisk: true }).route, 'council');
  const unknown = routeStrategyCandidate({ ...context(), side: 'sell', equityUsd: 0, pendingBuyUsd: Infinity });
  assert.equal(unknown.route, 'direct'); assert.equal(unknown.postTradeExposurePct, null);
});
test('invalid amounts and hard position breaches cannot be repaired by a model', () => {
  assert.equal(routeStrategyCandidate({ ...context(), equityUsd: NaN }).route, 'blocked');
  assert.equal(routeStrategyCandidate({ ...context(), currentExposureUsd: 9500 }).route, 'blocked');
});
