import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { combinationHash, combinationIssues, workspaceCombinationSchema } from './portfolio-workspace.rules';
import { DEFAULT_INVESTMENT_CONFIG, effectiveInvestmentConfig } from './investment-policy.rules';
import type { PortfolioStrategyAssignment } from '../../../shared/portfolio-workspace.interface';
import * as workspaceRules from './portfolio-workspace.rules';

test('companion preferences have a separate revision and reject execution fields and unknown identities', () => {
  assert.ok('workspaceCompanionSchema' in workspaceRules, 'companion requests need a separate non-execution contract');
  const schema = workspaceRules.workspaceCompanionSchema;
  const input = { companionId: 'macro', expectedRevision: 0, requestKey: 'fixture-request' };
  assert.equal(schema.safeParse(input).success, true);
  assert.equal(schema.safeParse({ ...input, companionId: 'fictional-person' }).success, false);
  assert.equal(schema.safeParse({ ...input, expectedRevision: -1 }).success, false);
  assert.equal(schema.safeParse({ ...input, expectedPolicyRevision: 1 }).success, false);
  assert.equal(schema.safeParse({ ...input, allocations: [] }).success, false);
});

function assignment(quantity = 10): PortfolioStrategyAssignment {
  const id = randomUUID(); const stamp = '2026-11-09T00:00:00Z';
  return { strategyId: id, strategyRevision: 1, allocationPct: 50, enabled: true,
    snapshot: { id, revision: 1, parentId: null, status: 'confirmed', createdAt: stamp, updatedAt: stamp, confirmedAt: stamp,
      content: { title: 'Fictional entry', body: 'Reviewed', timezone: 'UTC', startsAt: stamp,
        endsAt: '2026-11-20T00:00:00Z', entries: [] }, sources: [],
      preview: { revision: 1, contentHash: 'reviewed', generatedAt: stamp, canConfirm: true, entries: [], mandateRules: [], issues: [],
        directives: [{ entryId: 'entry', ticker: 'AAPL', side: 'buy', quantity, trigger: { kind: 'always' },
          reviewedText: 'Reviewed', numericEvidence: [], sourceKeys: [], startsAt: stamp, endsAt: '2026-11-20T00:00:00Z', timezone: 'UTC', route: 'direct' }] } } };
}
test('combination budgets reject duplicate identities, excess enabled allocation and zero-budget activation', () => {
  const a = assignment(); const b = assignment();
  const request = (allocations: PortfolioStrategyAssignment[]) => ({ expectedPolicyRevision: 1, requestKey: 'fixture-request',
    allocations: allocations.map(({ snapshot: _snapshot, ...input }) => input) });
  assert.equal(workspaceCombinationSchema.safeParse(request([a, a])).success, false);
  assert.equal(workspaceCombinationSchema.safeParse(request([a, { ...b, allocationPct: 51 }])).success, false);
  assert.equal(workspaceCombinationSchema.safeParse(request([{ ...a, allocationPct: 0 }])).success, false);
  assert.equal(workspaceCombinationSchema.safeParse(request([a, { ...b, enabled: false, allocationPct: 100 }])).success, true);
});
test('overlapping incompatible targets name both sources, while disabled or disjoint entries do not conflict', () => {
  const a = assignment(10); const b = assignment(20);
  assert.equal(combinationIssues([a, b])[0].code, 'STRATEGY_TARGET_CONFLICT');
  assert.deepEqual(combinationIssues([a, b])[0].strategyIds, [a.strategyId, b.strategyId]);
  assert.deepEqual(combinationIssues([a, { ...b, enabled: false }]), []);
  b.snapshot.preview.directives[0].startsAt = a.snapshot.preview.directives[0].endsAt;
  assert.deepEqual(combinationIssues([a, b]), []);
});
test('review hash binds account, policy, immutable content and budgets but not rendering timestamps or selection order', () => {
  const a = assignment(); const b = assignment(); const accountId = randomUUID();
  const hash = combinationHash(accountId, 2, [a, b]);
  a.snapshot.preview.generatedAt = '2026-11-10T00:00:00Z';
  assert.equal(combinationHash(accountId, 2, [b, a]), hash);
  assert.notEqual(combinationHash(randomUUID(), 2, [a, b]), hash);
  assert.notEqual(combinationHash(accountId, 3, [a, b]), hash);
  assert.notEqual(combinationHash(accountId, 2, [{ ...a, allocationPct: 40 }, b]), hash);
  a.snapshot.content.body = 'Changed investor intent';
  assert.notEqual(combinationHash(accountId, 2, [a, b]), hash);
});
test('combination confirmation binds exact team decision references',()=>{
  const a=assignment(),accountId=randomUUID(),ref={proposalId:randomUUID(),proposalRevision:1,decisionId:randomUUID()};
  assert.notEqual(combinationHash(accountId,1,[a]),combinationHash(accountId,1,[a],[ref]));
  assert.notEqual(combinationHash(accountId,1,[a],[ref]),combinationHash(accountId,1,[a],[{...ref,proposalRevision:2}]));
});
test('combined authority preserves the tightest reviewed strategy caps without changing base account limits', () => {
  const a = assignment(); const b = assignment();
  a.snapshot.content.limits = { maxPositionPct: 8, maxDailyIncreasePct: 3, maxDailyTurnoverPct: 12, minCashPct: 20, maxOrderPct: 2 };
  b.snapshot.content.limits = { maxPositionPct: 6, maxDailyIncreasePct: 4, maxDailyTurnoverPct: 15, minCashPct: 30, maxOrderPct: 4 };
  const base = { ...structuredClone(DEFAULT_INVESTMENT_CONFIG), portfolio: [a, b] };
  const effective = effectiveInvestmentConfig(base, []);
  assert.equal(effective.limits.maxPositionPct, 6);
  assert.equal(effective.limits.maxOrderPct, 2);
  assert.equal(effective.limits.maxDailyIncreasePct, 3);
  assert.equal(effective.limits.minCashPct, 30);
  assert.equal(effective.limits.maxGrossExposurePct, 70);
  assert.equal(base.limits.minCashPct, 10);
  assert.equal(effectiveInvestmentConfig({ ...base, portfolio: [] }, []).limits.maxOrderPct, 5);
});
