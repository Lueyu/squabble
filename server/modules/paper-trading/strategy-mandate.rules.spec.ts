import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMandate } from './strategy-mandate.rules';
import { DEFAULT_ROUTE_POLICY } from './strategy-route.rules';
const input = () => ({
  title: 'November protection', objective: 'Bounded paper allocation', period: 'custom', timezone: 'Asia/Shanghai',
  startsAt: '2026-11-05T00:00:00Z', endsAt: '2026-11-30T15:59:59Z',
  accountId: '11111111-1111-4111-8111-111111111111', profileId: '22222222-2222-4222-8222-222222222222',
  references: [{ versionId: '33333333-3333-4333-8333-333333333333' }],
  rules: [{ id: 'entry', ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_below', value: 100 },
    referencePrice: 100, minPrice: 95, maxPrice: 101, maxPositionPct: 10, stopLossPrice: 90,
    expiresAt: '2026-11-30T15:59:59Z', evidenceIds: ['33333333-3333-4333-8333-333333333333'], rationale: 'Measured price' }],
  limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20 },
  routePolicy: DEFAULT_ROUTE_POLICY, dailyPlanMode: 'fixed_rules',
});
test('mandates normalize valid bounded periods and measurable rules', () => {
  const v = normalizeMandate(input(), new Date('2026-11-05T01:00:00Z'));
  assert.equal(v.rules[0].ticker, 'AAPL');
  assert.equal(v.routePolicy.councilIncrementPct, 3);
});
test('a published mandate cannot use an expired period, reversed period, unknown timezone or semantic-only trigger', () => {
  for (const changes of [
    { endsAt: '2026-11-04T00:00:00Z' }, { startsAt: '2026-12-01T00:00:00Z' }, { timezone: 'bad-timezone' },
    { rules: [{ ...input().rules[0], trigger: { kind: 'looks_cheap', value: 1 } }] },
    { routePolicy: { ...DEFAULT_ROUTE_POLICY, councilPositionCapRatio: 1.1 } },
    { dailyPlanMode: 'unbounded_ai' },
  ]) assert.throws(() => normalizeMandate({ ...input(), ...changes }, new Date('2026-11-05T01:00:00Z')));
});
test('rules cannot cite another version or exceed the frozen mandate caps', () => {
  assert.throws(() => normalizeMandate({ ...input(), rules: [{ ...input().rules[0], evidenceIds: ['other'] }] }));
  assert.throws(() => normalizeMandate({ ...input(), limits: { ...input().limits, maxPositionPct: 4 } }));
});
