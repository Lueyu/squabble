import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvidenceInput } from '../multi-agent/evidence.service';
import { extractValuationInputs, valuationScenarios, frozenPeerTickers, canonicalResearchTicker } from './research-valuation';

const annual: EvidenceInput = { role: 'fundamental', evidenceType: 'financial', title: 'AAPL SEC reported financial statements',
  content: 'Period: 2025-01-01 to 2025-12-31 (may be YTD; not TTM; not annualized). Revenue: USD 1000; Net income: USD 100; Equity (parent): USD 500. Form: 10-K. Filed: 2026-02-01.',
  sourceName: 'SEC EDGAR', sourceUrl: 'https://www.sec.gov/Archives/example', relevanceScore: 0.95 };
const now = '2026-11-03T00:00:00.000Z';
const request = { metric: 'earnings' as const, multiples: { bear: 10, base: 15, bull: 20 } };

test('deterministic valuation uses explicit annual sourced inputs, preserves units and separates assumptions', () => {
  const inputs = extractValuationInputs([annual], now);
  const result = valuationScenarios('AAPL', inputs, request, null, now);
  assert.equal(result.status, 'partial');
  const data = result.data as { scenarios: Array<{ equityValue: number }>; denominator: { currency: string; periodStart: string; units: string }; limitations: string[] };
  assert.deepEqual(data.scenarios.map(row => row.equityValue), [1000, 1500, 2000]);
  assert.equal(data.denominator.currency, 'USD'); assert.equal(data.denominator.units, 'currency');
  assert.equal(data.denominator.periodStart, '2025-01-01');
  assert.match(data.limitations.join(' '), /share|assumption/i);
  assert.equal(result.sources[0].url, annual.sourceUrl);
});

test('valuation refuses missing, negative, zero, conflicting, foreign-unit and YTD denominators', () => {
  for (const rows of [[], [{ ...annual, sourceName: 'Data Unavailable' }],
    [{ ...annual, content: annual.content.replace('USD 100;', 'USD 0;') }],
    [{ ...annual, content: annual.content.replace('USD 100;', 'USD -100;') }],
    [{ ...annual, content: annual.content.replace('2025-01-01', '2025-07-01') }],
    [{ ...annual, sourceUrl: undefined }],
    [{ ...annual, content: annual.content.replace('Net income: USD', 'Net income: reported units') }],
    [annual, { ...annual, content: annual.content.replace('USD 100;', 'USD 120;') }]]) {
    const result = valuationScenarios('AAPL', extractValuationInputs(rows, now), request, null, now);
    assert.equal(result.status, 'unavailable');
    assert.ok(!JSON.stringify(result.data).includes('equityValue'));
  }
});

test('balance sheet multiple keeps instant date, while quoted price cannot substitute for a denominator', () => {
  const result = valuationScenarios('AAPL', extractValuationInputs([annual], now),
    { metric: 'book_value', multiples: { bear: 1, base: 2, bull: 3 } }, null, now);
  assert.match(JSON.stringify(result.data), /2025-12-31/);
  assert.match(JSON.stringify(result.data), /1500/);
  assert.equal(valuationScenarios('AAPL', [], request, { price: 200, currency: 'USD', asOf: now }, now).status, 'unavailable');
});

test('annual denominators accept full calendar and 52/53 week years but reject shortened transition periods', () => {
  for (const [start, end, expected] of [
    ['2024-01-01', '2024-12-31', true], ['2025-01-01', '2025-12-31', true],
    ['2024-12-29', '2025-12-27', true], ['2024-12-29', '2026-01-03', true],
    ['2025-02-01', '2025-12-31', false], ['2025-01-06', '2025-12-31', false],
    ['2024-12-22', '2026-01-03', false],
  ] as const) {
    const item = { ...annual, content: annual.content.replace('2025-01-01 to 2025-12-31', `${start} to ${end}`) };
    const inputs = extractValuationInputs([item], now);
    assert.equal(inputs.find(input => input.metric === 'earnings')?.annual, expected, `${start} to ${end}`);
    assert.equal(valuationScenarios('AAPL', inputs, request, null, now).status, expected ? 'partial' : 'unavailable');
  }
});

test('peer allowlist is bounded, unique, canonical, persisted and excludes primary aliases', () => {
  assert.deepEqual(frozenPeerTickers('AAPL', ['MSFT', 'NVDA']), ['AAPL', 'MSFT', 'NVDA']);
  for (const peers of [['MSFT', 'NVDA', 'GOOG', 'AMD'], ['msft'], ['MSFT', 'MSFT'], ['AAPL'], ['../secret']]) {
    assert.throws(() => frozenPeerTickers('AAPL', peers), /RESEARCH_INVALID_PEERS/);
  }
  assert.throws(() => frozenPeerTickers('0700.HK', ['00700.HK']), /RESEARCH_INVALID_PEERS/);
});

test('ambiguous scaled amounts cannot be partially parsed and dated snapshots keep original acquisition times', () => {
  for (const amount of ['100.5 million', '100 million', '1,000', '100.00USD', '100.5e2 million']) {
    const items = [{ ...annual, content: annual.content.replace('Net income: USD 100;', `Net income: USD ${amount};`) }];
    assert.equal(valuationScenarios('AAPL', extractValuationInputs(items, now), request, null, now).status, 'unavailable');
  }
  const inputs = extractValuationInputs([{ ...annual, fetchedAt: '2026-09-01T00:00:00Z' }], now);
  assert.equal(inputs[0].source.fetchedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(canonicalResearchTicker('999999'), null);
  assert.equal(canonicalResearchTicker('0700.HK'), '00700.HK');
  assert.equal(canonicalResearchTicker('600519.SS'), '600519.SH');
});
