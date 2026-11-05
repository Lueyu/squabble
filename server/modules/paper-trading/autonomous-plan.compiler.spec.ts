import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAutonomousRules, mergeAutonomousRules } from './autonomous-plan.compiler';
import { DEFAULT_INVESTMENT_CONFIG } from './investment-policy.rules';
import type { VerifiedInvestmentSecurity, InvestmentResearchReview } from '../../../shared/investment-policy.interface';

test('new security needs two verified actual sources and all mandate rules remain parent subsets', () => {
  const now = new Date('2026-11-06T15:00:00Z');
  const security: VerifiedInvestmentSecurity = { ticker: 'ABC', market: 'US', currency: 'USD', assetType: 'stock', sourceUrl: 'https://www.sec.gov/fixture', identitySourceUrl: 'https://www.nasdaq.com/fixture', summary: 'Fictional equity', observedAt: now.toISOString(), providerSymbol: 'ABC', lotSize: 1, leveraged: false, inverse: false };
  const rule = { id: 'entry', ticker: 'ABC', side: 'buy', trigger: { kind: 'price_below', value: 100 }, referencePrice: 100, minPrice: 95, maxPrice: 105, stopLossPrice: 90, maxPositionPct: 10, expiresAt: '2026-11-06T21:00:00Z', evidenceIds: ['report'], rationale: 'Measured fictional input' };
  const review = (identity: string): InvestmentResearchReview => ({ memberId: identity, executorIdentity: identity, executorVerified: true, completedAt: now.toISOString(), conclusion: 'approve', unresolvedDisagreements: [], evidenceIds: ['report'], rules: [rule], summary: 'Approved bounded input' });
  const input = { config: DEFAULT_INVESTMENT_CONFIG, security, reviews: [review('one'), review('one')], isNew: true, marketDate: '2026-11-06', validUntil: rule.expiresAt, cycleId: 'cycle', evidenceIds: ['report'], now };
  assert.throws(() => compileAutonomousRules(input), /INDEPENDENT_REVIEW/);
  const rules = compileAutonomousRules({ ...input, reviews: [review('one'), review('two')] });
  assert.equal(rules[0].requiresIndependentReview, true);
  assert.throws(() => compileAutonomousRules({ ...input, reviews: [review('one'), { ...review('two'), unresolvedDisagreements: ['valuation'] }] }), /UNRESOLVED/);
  assert.throws(() => compileAutonomousRules({ ...input, reviews: [review('one'), review('two')], config: { ...DEFAULT_INVESTMENT_CONFIG, markets: ['HK'] } }), /MARKET/);
  const other = { ...rules[0], id: 'hk_entry', ticker: '0700.HK', market: 'HK' as const, validUntil: '2026-11-07T08:00:00Z' };
  assert.equal(mergeAutonomousRules([other], rules, 'US', now).length, 2);
  assert.equal(mergeAutonomousRules([other], [], 'US', now).length, 1);
});
