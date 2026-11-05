import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { narrowDailyRules, dailyAiRuntimeReason } from './strategy-daily-adjustments';
import type { StrategyRule } from '../../../shared/strategy.interface';

const base: StrategyRule = { id: 'entry', ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_below', value: 100 },
  referencePrice: 100, minPrice: 90, maxPrice: 110, maxPositionPct: 20, stopLossPrice: 80,
  expiresAt: '2026-11-30T20:00:00Z', evidenceIds: ['fixed-version'], rationale: 'Published evidence' };
const valid = { id: 'entry', enabled: true, minPrice: 95, maxPrice: 105, maxPositionPct: 10, stopLossPrice: 85, reason: 'Reduce uncertainty' };

test('daily AI can only tighten a complete set of rules while preserving immutable authorization', () => {
  const [rule] = narrowDailyRules([base], { rules: [valid] });
  assert.equal(rule.minPrice, 95); assert.equal(rule.maxPrice, 105); assert.equal(rule.maxPositionPct, 10); assert.equal(rule.stopLossPrice, 85);
  assert.equal(rule.dailySuspended, false);
  for (const key of ['ticker', 'side', 'referencePrice', 'trigger', 'evidenceIds', 'expiresAt', 'rationale'] as const) assert.deepEqual(rule[key], base[key]);
  const [paused] = narrowDailyRules([base], { rules: [{ ...valid, enabled: false }] });
  assert.equal(paused.dailySuspended, true); assert.equal(paused.stopLossPrice, 85);
  assert.equal(base.minPrice, 90);
});

test('daily AI rejects widening, missing output, invented rules, extra authority and malformed numbers', () => {
  const bad = [undefined, {}, { rules: [] }, { rules: [valid, valid] }, { rules: [{ ...valid, id: 'other' }] },
    ...[{ minPrice: 89 }, { maxPrice: 111 }, { maxPositionPct: 21 }, { stopLossPrice: 79 }, { stopLossPrice: 95 },
      { minPrice: 106 }, { enabled: 'true' }, { maxPositionPct: NaN }, { minPrice: Infinity }, { ticker: 'MSFT' },
      { expiresAt: '2027-01-01' }, { reason: '' }].map(change => ({ rules: [{ ...valid, ...change }] }))];
  for (const output of bad) assert.throws(() => narrowDailyRules([base], output));
});


test('daily runtime errors explain safe recovery without exposing arbitrary provider details', () => {
  assert.match(dailyAiRuntimeReason(new BadRequestException('DAILY_AI_FAILED: internal detail'), 'en')!, /protective exits remain/u);
  assert.match(dailyAiRuntimeReason(new BadRequestException('DAILY_AI_PENDING'), 'zh-CN')!, /不会重复调用/u);
  assert.equal(dailyAiRuntimeReason(new Error('DAILY_AI_FAILED: provider secret'), 'en'), null);
  assert.equal(dailyAiRuntimeReason(new BadRequestException('unrelated secret'), 'en'), null);
});
