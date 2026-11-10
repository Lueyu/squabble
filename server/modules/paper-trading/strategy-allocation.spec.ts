import test from 'node:test';
import assert from 'node:assert/strict';
import { allocationBudgetBlock } from './strategy-allocation';
import type { StrategyCandidate } from '../../../shared/strategy.interface';
import type { PortfolioRiskSnapshot } from './strategy-portfolio-risk';

const candidate: StrategyCandidate = { accountId: 'account-a', userStrategyId: 'strategy-a', userStrategyRevision: 1,
  userEntryId: 'entry', signalId: 'candidate', ruleId: 'strategy-a:entry', planId: 'plan', planVersion: 1,
  ticker: 'AAPL', market: 'US', side: 'buy', quantity: 20, price: 100,
  quoteAt: '2026-11-09T15:00:00Z', protectiveStop: false, reason: 'Fictional budget test' };
const portfolio: PortfolioRiskSnapshot = { equityUsd: 10000, availableCashUsd: 8000, grossExposureUsd: 2000,
  holdings: [{ ticker: 'AAPL', valueUsd: 2000 }], pending: [], unitPricesUsd: { AAPL: 100 }, gaps: [] };

test('strategy budget divides investable equity after cashfloor, including stable attributed fills', () => {
  const input = { candidate, allocationPct: 50, minCashPct: 20, portfolio, filled: [{ ...candidate, signalId: 'filled' }], pending: [] };
  assert.equal(allocationBudgetBlock(input), null, '2000 held + 2000 buy fits half of investable 8000');
  assert.equal(allocationBudgetBlock({ ...input, candidate: { ...candidate, quantity: 21 } }), 'PORTFOLIO_STRATEGY_BUDGET_EXCEEDED');
  assert.equal(allocationBudgetBlock({ ...input, minCashPct: 30 }), 'PORTFOLIO_STRATEGY_BUDGET_EXCEEDED');
  assert.equal(allocationBudgetBlock({ ...input, candidate: { ...candidate, userStrategyRevision: 2 } }), null, 'new runtime version retains old exposure');
  assert.equal(allocationBudgetBlock({ ...input, portfolio: { ...portfolio,
    pending: [{ signalId: candidate.signalId, ticker: 'AAPL', valueUsd: 2000, cashUsd: 2001 }] } }), 'PORTFOLIO_STRATEGY_BUDGET_EXCEEDED',
  'execution fees cannot push a fully used allocation over its share of equity');
  assert.equal(allocationBudgetBlock({ ...input, candidate: { ...candidate, quantity: 21 },
    filled: [{ ...candidate, side: 'sell', quantity: 30 }, candidate] }), 'PORTFOLIO_STRATEGY_BUDGET_EXCEEDED',
  'selling starting holdings does not create negative attributed shares');
});

test('same-strategy reservations contend while other accounts and strategies retain separate budgets', () => {
  const input = { candidate, allocationPct: 25, minCashPct: 20, portfolio, filled: [], pending: [] as StrategyCandidate[] };
  assert.equal(allocationBudgetBlock(input), null);
  assert.equal(allocationBudgetBlock({ ...input, pending: [{ ...candidate, signalId: 'other', quantity: 1 }] }), 'PORTFOLIO_STRATEGY_BUDGET_EXCEEDED');
  assert.equal(allocationBudgetBlock({ ...input, pending: [{ ...candidate, signalId: 'other', accountId: 'account-b' }] }), null);
  assert.equal(allocationBudgetBlock({ ...input, pending: [{ ...candidate, signalId: 'other', userStrategyId: 'strategy-b' }] }), null);
  assert.equal(allocationBudgetBlock({ ...input, portfolio: { ...portfolio, equityUsd: null, gaps: ['quote missing'] } }), 'PORTFOLIO_ALLOCATION_VALUATION_REQUIRED');
});
