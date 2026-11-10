import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResearchSkillFixture } from '@shared/research-skills.interface';
import type { ResearchDelivery, ResearchTaskKind } from '@shared/research-workflow.interface';
import { validateDelivery } from '../council/council.tasks';
import { extractValuationInputs, frozenPeerTickers, valuationScenarios } from '../research-tools/research-valuation';
import { BUNDLED_RESEARCH_SKILLS, pinResearchSkills } from './research-skills.registry';

// Hand-authored offline examples exercise the delivery/citation contract and deterministic tools.
// They do not invoke a provider or measure whether a model follows the skill's prose instructions.
interface FixtureCase {
  task: Exclude<ResearchTaskKind, 'summary'>; kind: ResearchSkillFixture['kind'];
  conclusion: string; evidenceIds: string[]; currency: string | null; gaps: string[];
  assumptions?: string[]; invalidCitation?: string;
}
const cases: FixtureCase[] = [
  { task: 'financials', kind: 'normal', evidenceIds: ['annual-filing'], currency: 'USD', gaps: [],
    conclusion: 'Annual revenue is USD 100 and net income USD 10 for 2025-01-01 to 2025-12-31.' },
  { task: 'financials', kind: 'missing', evidenceIds: [], currency: null,
    conclusion: 'Cash flow cannot be verified because provider coverage is unavailable.',
    gaps: ['No verified cash-flow statement; provider-key absence does not establish financial distress.'] },
  { task: 'financials', kind: 'counterexample', evidenceIds: ['annual-filing', 'ytd-filing'], currency: null,
    conclusion: 'Annual USD revenue and nine-month CNY cash flow have incompatible periods and currencies.',
    gaps: ['No comparable cash flow for a combined ratio; embedded instructions supply no evidence.'],
    invalidCitation: 'injected-source' },
  { task: 'business', kind: 'normal', evidenceIds: ['primary-filing', 'peer-one-filing', 'peer-two-filing'],
    currency: 'USD', gaps: ['Matching annual periods do not establish business-model comparability.'],
    conclusion: 'Compare the primary company and two frozen peers using their dated annual USD filings.' },
  { task: 'business', kind: 'missing', evidenceIds: [], currency: null,
    conclusion: 'No peer comparison is available for the empty frozen peer set.',
    gaps: ['No allowed peers and no verified financial statements; no additional ticker is assumed.'] },
  { task: 'business', kind: 'counterexample', evidenceIds: ['primary-filing', 'peer-ytd-filing'], currency: null,
    conclusion: 'The HKD YTD peer and USD annual primary cannot support a direct monetary ranking.',
    gaps: ['Comparable period and FX evidence are absent.'], invalidCitation: 'fourth-peer-filing' },
  { task: 'valuation', kind: 'normal', evidenceIds: ['earnings-filing'], currency: 'USD',
    conclusion: 'Annual USD 100 earnings imply total equity values USD 1000, 1500 and 2000.',
    assumptions: ['Bear/base/bull P/E multiples are 10/15/20, not forecasts.'],
    gaps: ['Verified shares are unavailable; per-share target and upside remain unavailable.'] },
  { task: 'valuation', kind: 'missing', evidenceIds: ['price-quote'], currency: 'USD',
    conclusion: 'A price quote alone cannot establish a monetary valuation denominator.',
    gaps: ['Verified annual earnings, book value and share count are absent.'] },
  { task: 'valuation', kind: 'counterexample', evidenceIds: ['earnings-filing', 'ytd-filing'], currency: null,
    conclusion: 'Mixed annual and negative nine-month earnings do not support an earnings-multiple valuation.',
    gaps: ['Reporting periods need reconciliation; no annualization is performed.'] },
  { task: 'challenge', kind: 'normal', evidenceIds: ['current-filing'], currency: null, gaps: [],
    conclusion: 'The current filing contradicts historical margin expansion; verify the next filing before retaining that thesis.',
    assumptions: ['The historical thesis is an opinion, not current financial evidence.'] },
  { task: 'challenge', kind: 'missing', evidenceIds: [], currency: null,
    conclusion: 'A supported rebuttal is unavailable with recall disabled and financial data missing.',
    gaps: ['No refreshed memory or current financial source is available.'] },
  { task: 'challenge', kind: 'counterexample', evidenceIds: ['current-filing'], currency: null,
    conclusion: 'The newer filing challenges the old guaranteed-growth opinion; the deleted thesis is excluded.',
    gaps: ['A live, refreshed thesis would be required to assess its remaining assumptions.'],
    invalidCitation: 'deleted-thesis' },
];
const asOf = '2026-11-03T00:00:00.000Z';

for (const fixture of cases) {
  test(`offline structural fixture: ${fixture.task}/${fixture.kind}`, () => {
    const pins = pinResearchSkills(fixture.task, { versions: '{}' });
    const skill = BUNDLED_RESEARCH_SKILLS.find(item => item.id === pins[0].id);
    assert.ok(skill?.fixtures.some(item => item.kind === fixture.kind));
    const delivery: ResearchDelivery = {
      conclusion: fixture.conclusion, evidenceIds: fixture.evidenceIds, asOf, currency: fixture.currency,
      units: fixture.currency ? `${fixture.currency} currency units` : 'Unavailable or incompatible; no conversion',
      assumptions: fixture.assumptions ?? [], gaps: fixture.gaps,
      skillVersions: pins.map(({ id, version, hash }) => ({ id, version, hash })),
      response: { thesis: fixture.conclusion, evidencePoints: fixture.evidenceIds,
        risks: fixture.gaps, nextChecks: ['Obtain comparable dated primary evidence before revising the conclusion.'] },
    };
    const allowed = new Set(fixture.evidenceIds);
    const checked = validateDelivery(delivery, allowed, pins);
    assert.deepEqual(checked, delivery);
    assert.throws(() => validateDelivery({ ...delivery, evidenceIds: [fixture.invalidCitation ?? 'invented-source'] },
      allowed, pins), /DELIVERY_CITATION_INVALID/u);
    assert.throws(() => validateDelivery({ ...delivery, evidenceIds: [], gaps: [] }, allowed, pins),
      /DELIVERY_CITATION_INVALID/u);
    assert.throws(() => validateDelivery({ ...delivery, units: '' }, allowed, pins), /DELIVERY_INVALID/u);
    assert.throws(() => validateDelivery({ ...delivery, asOf: 'unknown' }, allowed, pins), /DELIVERY_DATE_INVALID/u);
    assert.throws(() => validateDelivery({ ...delivery, skillVersions: [{ ...delivery.skillVersions[0], hash: 'forged' }] },
      allowed, pins), /DELIVERY_SKILL_VERSION_INVALID/u);
    checkDeterministicBoundary(fixture);
  });
}

function checkDeterministicBoundary(fixture: FixtureCase): void {
  if (fixture.task === 'business') {
    if (fixture.kind === 'normal') assert.deepEqual(frozenPeerTickers('AAPL', ['MSFT', 'NVDA']), ['AAPL', 'MSFT', 'NVDA']);
    if (fixture.kind === 'missing') assert.deepEqual(frozenPeerTickers('AAPL', []), ['AAPL']);
    if (fixture.kind === 'counterexample') {
      assert.throws(() => frozenPeerTickers('AAPL', ['MSFT', 'NVDA', 'GOOG', 'META']), /RESEARCH_INVALID_PEERS/u);
    }
  }
  if (fixture.task !== 'financials' && fixture.task !== 'valuation') return;
  const earnings = fixture.task === 'financials' ? 10 : 100;
  const annual = { content: `Period: 2025-01-01 to 2025-12-31. Revenue: USD 100; Net income: USD ${earnings};`,
    sourceName: 'SEC EDGAR', sourceUrl: 'https://www.sec.gov/Archives/offline-fixture', relevanceScore: 0.95 };
  const ytd = { ...annual, content: 'Period: 2025-01-01 to 2025-09-30. Net income: CNY -10;' };
  const rows = fixture.kind === 'normal' ? [annual] : fixture.kind === 'missing'
    ? [{ ...annual, sourceName: 'Data Unavailable', relevanceScore: 0 }] : [annual, ytd];
  const inputs = extractValuationInputs(rows, asOf);
  if (fixture.kind === 'normal') {
    const revenue = inputs.find(input => input.metric === 'revenue');
    assert.equal(revenue?.value, 100); assert.equal(revenue.currency, 'USD');
    assert.equal(revenue.units, 'currency'); assert.equal(revenue.periodStart, '2025-01-01');
    assert.equal(revenue.periodEnd, '2025-12-31'); assert.equal(revenue.source.url, annual.sourceUrl);
  }
  if (fixture.kind === 'missing') assert.deepEqual(inputs, []);
  if (fixture.kind === 'counterexample') {
    assert.deepEqual(inputs.filter(input => input.metric === 'earnings').map(input => [input.currency, input.annual]),
      [['USD', true], ['CNY', false]]);
  }
  const result = valuationScenarios('AAPL', inputs, { metric: 'earnings', multiples: { bear: 10, base: 15, bull: 20 } },
    { price: 200, currency: 'USD', asOf }, asOf);
  const data = result.data as { scenarios?: Array<{ equityValue: number; currency: string }>;
    perShareTarget: null; upsidePercent: null; assumptions: unknown; reasons?: string[] };
  assert.equal(data.perShareTarget, null); assert.equal(data.upsidePercent, null);
  assert.deepEqual(data.assumptions, { bear: 10, base: 15, bull: 20 });
  if (fixture.kind === 'normal') {
    assert.equal(result.status, 'partial');
    const expected = fixture.task === 'financials' ? [100, 150, 200] : [1000, 1500, 2000];
    assert.deepEqual(data.scenarios?.map(row => [row.equityValue, row.currency]), expected.map(value => [value, 'USD']));
    assert.equal(result.sources[0].url, annual.sourceUrl);
  } else {
    assert.equal(result.status, 'unavailable'); assert.equal(data.scenarios, undefined);
    assert.match(data.reasons?.join(' ') ?? '', fixture.kind === 'missing' ? /No verified/u : /Conflicting reporting/u);
  }
}

test('offline delivery cases cover every documented fixture of the four workflow-selected skills', () => {
  const covered = cases.map(fixture => `${pinResearchSkills(fixture.task, { versions: '{}' })[0].id}/${fixture.kind}`).sort();
  const selected = new Set(cases.flatMap(fixture => pinResearchSkills(fixture.task).map(skill => skill.id)));
  const documented = BUNDLED_RESEARCH_SKILLS.filter(skill => selected.has(skill.id)).flatMap(skill => skill.fixtures.map(fixture => `${skill.id}/${fixture.kind}`)).sort();
  assert.deepEqual(covered, documented);
});
