import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheKey, isRuleCandidate, parseOpinion, eligibleApproval, councilPrompt, normalizeCandidate } from './council.rules';
import type { BuilderConfig } from '../../../shared/api.interface';
import type { CouncilCandidate } from '../../../shared/council.interface';
import { normalizeCouncil } from '../paper-trading/agent-builder.rules';

const candidate: CouncilCandidate = { ticker: 'AAPL', side: 'buy', quantity: 2, price: 100, reason: 'Investor price rule: 100 reached buy trigger 101' };
const config: BuilderConfig = { name: 'test', template: 'balanced', tickers: ['AAPL'], minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 4, notifyOnProposal: false, priceRules: [{ ticker: 'AAPL', buyAtOrBelow: 101 }] };

test('rule-only status requires a real configured threshold and a matching candidate', () => {
  assert.equal(isRuleCandidate(config, candidate), true);
  assert.equal(isRuleCandidate({ ...config, priceRules: [] }, candidate), false);
  assert.equal(isRuleCandidate(config, { ...candidate, price: 102 }), false);
  assert.equal(isRuleCandidate(config, { ...candidate, reason: 'AI Buy rating' }), false);
});

test('parser rejects unsafe advisor resizing and ungrounded approvals', () => {
  assert.throws(() => parseOpinion({ decision: 'approve', summary: 'good', evidenceIds: ['fake'] }, new Set(['real'])));
  assert.throws(() => parseOpinion({ decision: 'approve', summary: 'good', evidenceIds: ['real'], quantity: 20 }, new Set(['real'])));
  assert.throws(() => parseOpinion({ decision: 'approve', summary: 'good', evidenceIds: [] }, new Set(['real'])));
  assert.equal(parseOpinion({ decision: 'wait', summary: 'Need data', evidenceIds: [], dissent: [], nextReviewCondition: 'Update financials' }, new Set()).decision, 'wait');
});

test('cache deduplicates vetoes by stable evidence and price regime, isolates profiles and owners', () => {
  const evidence = [{ id: 'e1', role: 'fundamental', evidenceType: 'news', title: 'news', content: 'verified', sourceUrl: null, sourceName: 'source', fetchedAt: '2026-10-30', relevanceScore: 1 }];
  const a = cacheKey('user-a', 'profile', 1, candidate, evidence, 'run');
  assert.equal(a, cacheKey('user-a', 'profile', 1, { ...candidate, price: 100.01 }, evidence, 'run'));
  assert.notEqual(a, cacheKey('user-b', 'profile', 1, candidate, evidence, 'run'));
  assert.notEqual(a, cacheKey('user-a', 'profile', 2, candidate, evidence, 'run'));
  assert.notEqual(a, cacheKey('user-a', 'profile', 1, { ...candidate, price: 110 }, evidence, 'run'));
});

test('approval requires current revision, completed state, exact candidate and complete evidence or explicit rule', () => {
  const context = { status: 'completed', revision: 3, reportRevision: 3, decision: 'approve', candidate, reviewedCandidate: candidate, hasCriticalGaps: false, ruleOnly: false, paperOrderId: null };
  assert.equal(eligibleApproval(context), true);
  for (const patch of [{ revision: 4 }, { status: 'paused' }, { hasCriticalGaps: true }, { reviewedCandidate: { ...candidate, quantity: 3 } }, { reviewedCandidate: { ...candidate, price: 101 } }, { paperOrderId: 'order' }]) {
    assert.equal(eligibleApproval({ ...context, ...patch }), false);
  }
  assert.equal(eligibleApproval({ ...context, hasCriticalGaps: true, ruleOnly: true }), true);
});

test('prompt treats steering and evidence as untrusted and prohibits changing order size', () => {
  const prompt = councilPrompt('researcher', 'en');
  assert.match(prompt, /untrusted/);
  assert.match(prompt, /quantity/);
  assert.match(prompt, /never execute/i);
  assert.match(prompt, /evidenceIds/);
});

test('candidate boundary rejects malformed tickers and unsafe numbers', () => {
  assert.throws(() => normalizeCandidate({ ...candidate, ticker: '<script>' }));
  assert.throws(() => normalizeCandidate({ ...candidate, quantity: -1 }));
  assert.throws(() => normalizeCandidate({ ...candidate, price: Infinity }));
  assert.equal(normalizeCandidate({ ...candidate, ticker: ' aapl ' }).ticker, 'AAPL');
});

test('research teams preserve one real source or two to six distinct members with one moderator', () => {
  const member = { id: 'fundamental', role: 'researcher' as const, name: 'Fundamental analyst', instructions: 'Check cash flow', model: 'fast' as const,
    roleTitle: 'Fundamentals', personality: 'Skeptical and patient', researchFocus: ['financials' as const], speakingStyle: 'socratic' as const,
    connectionId: '123e4567-e89b-42d3-a456-426614174000' };
  const manager = { id: 'chair', role: 'manager' as const, name: 'Chair', instructions: '', model: 'slow' as const };
  const team = normalizeCouncil({ enabled: true, webResearch: true, members: [member, { ...member, id: 'macro', name: 'Macro analyst' }, manager] });
  assert.deepEqual(team.members[0], member);
  assert.equal(team.webResearch, true);
  assert.equal(normalizeCouncil({ enabled: true, members: [member, manager] }).members.length, 2);
  const single = normalizeCouncil({ enabled: true, members: [member] });
  assert.equal(single.members.length, 1);
  assert.deepEqual(single.members[0], { ...member, role: 'manager' });
  for (const members of [[], [member, member, manager], [member, manager, { ...manager, id: 'other-chair' }],
    Array.from({ length: 7 }, (_, i) => ({ ...member, id: `m${i}`, role: i === 6 ? 'manager' as const : 'researcher' as const }))]) {
    assert.throws(() => normalizeCouncil({ enabled: true, members }));
  }
  assert.throws(() => normalizeCouncil({ enabled: true, members: [{ ...member, connectionId: 'not-a-uuid' }, manager] }));
});
