import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePortfolioReport, portfolioSnapshotEvidenceRefs } from './portfolio-report.rules';
import type { PortfolioReportSnapshot } from '../../../shared/portfolio-report.interface';

const snapshot: PortfolioReportSnapshot = {
  capturedAt: '2026-11-05T08:00:00.000Z',
  holdings: [
    { ticker: 'AAPL', company: 'Apple', market: 'US', currency: 'USD', shares: 5, currentPrice: 100, costPrice: 90, marketValueUsd: 500, weightPct: 50 },
    { ticker: 'MSFT', company: 'Microsoft', market: 'US', currency: 'USD', shares: 2, currentPrice: null, costPrice: 80, marketValueUsd: null, weightPct: null },
  ],
  cashUsd: null,
  totalValueUsd: null,
  gaps: ['MSFT current price unavailable', 'Cash balance unavailable'],
};

const valid = {
  summary: 'Concentration is high.',
  allocationRisks: ['AAPL carries half the known value.'],
  actions: ['Review concentration before changing positions.'],
  uncertainties: ['MSFT valuation is unavailable.'],
  holdings: [
    { ticker: 'AAPL', stance: 'hold', rationale: 'Known weight is high.', evidenceRefs: ['holding:AAPL:weightPct'], triggers: ['Reassess when weight changes.'] },
    { ticker: 'MSFT', stance: 'watch', rationale: 'Current price is missing.', evidenceRefs: ['holding:MSFT:shares'], triggers: ['Reassess when price is available.'] },
  ],
};

test('accepts a complete bounded report and retains source data gaps', () => {
  const report = parsePortfolioReport(JSON.stringify(valid), snapshot);
  assert.deepEqual(report.holdings.map((item) => item.ticker), ['AAPL', 'MSFT']);
  assert.deepEqual(report.dataGaps, snapshot.gaps);
  assert.deepEqual(portfolioSnapshotEvidenceRefs(snapshot).filter((ref) => ref.startsWith('holding:MSFT:')), [
    'holding:MSFT:shares', 'holding:MSFT:costPrice',
  ]);
});

test('rejects a foreign holding ticker and missing or duplicate judgments', () => {
  assert.throws(() => parsePortfolioReport(JSON.stringify({ ...valid, holdings: [valid.holdings[0], { ...valid.holdings[1], ticker: 'NVDA' }] }), snapshot), /ticker/i);
  assert.throws(() => parsePortfolioReport(JSON.stringify({ ...valid, holdings: [valid.holdings[0]] }), snapshot), /holding/i);
  assert.throws(() => parsePortfolioReport(JSON.stringify({ ...valid, holdings: [valid.holdings[0], valid.holdings[0]] }), snapshot), /duplicate/i);
});

test('rejects malformed JSON, extra fields, and unbounded prose', () => {
  assert.throws(() => parsePortfolioReport('```json\n{}\n```', snapshot), /JSON/i);
  assert.throws(() => parsePortfolioReport(JSON.stringify({ ...valid, targetPrice: 120 }), snapshot), /field/i);
  assert.throws(() => parsePortfolioReport(JSON.stringify({ ...valid, summary: 'x'.repeat(2001) }), snapshot), /length/i);
});

test('rejects unsupported citations, uncited judgments, and external URLs', () => {
  const first = valid.holdings[0];
  assert.throws(() => parsePortfolioReport(JSON.stringify({ ...valid, holdings: [{ ...first, evidenceRefs: ['holding:AAPL:revenue'] }, valid.holdings[1]] }), snapshot), /evidence/i);
  assert.throws(() => parsePortfolioReport(JSON.stringify({ ...valid, holdings: [{ ...first, evidenceRefs: [] }, valid.holdings[1]] }), snapshot), /evidence/i);
  assert.throws(() => parsePortfolioReport(JSON.stringify({ ...valid, summary: 'See https://example.com/unverified' }), snapshot), /URL/i);
});

test('never treats missing snapshot values as supporting evidence', () => {
  assert.throws(() => parsePortfolioReport(JSON.stringify({ ...valid, holdings: [valid.holdings[0], { ...valid.holdings[1], evidenceRefs: ['holding:MSFT:currentPrice'] }] }), snapshot), /evidence/i);
});

test('each holding judgment must cite a fact for that holding', () => {
  assert.throws(() => parsePortfolioReport(JSON.stringify({ ...valid, holdings: [valid.holdings[0], { ...valid.holdings[1], evidenceRefs: ['holding:AAPL:weightPct'] }] }), snapshot), /own.*evidence/i);
});
