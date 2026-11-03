import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachValuation, excerptToolData, compactPeerComparison, compactValuationHandoff, referenceEvidenceMetadata } from './council.workflow-tools';
import { nativeWorkflowSources } from './council.workflow-executor';
import type { ResearchDelivery } from '../../../shared/research-workflow.interface';
import { workflowReviewPrompt } from './council.workflow-review';
import { parseFinnhubFinancials } from '../multi-agent/finnhub-financials';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { compactToolEvidence } from '../research-tools/research-tools.evidence';
import { CouncilWorkflowExecutor } from './council.workflow-executor';
import { boundedResult } from '../research-tools/research-tools.output';
import { evidenceExcerpts, type CouncilEvidence } from './council.rules';
import { evidencePromptMetadata } from '../research-memory/research-memory.temporal';
import { valuationScenarios } from '../research-tools/research-valuation';

test('calculator handoffs compact exact repeated fields while preserving measurements and every limitation', () => {
  const result = valuationScenarios('AAPL', [{ metric: 'earnings', value: 123.45, annual: true, currency: 'USD', units: 'currency',
    periodStart: '2025-01-01', periodEnd: '2025-12-31', source: { title: 'SEC EDGAR', url: 'https://example.test/filing', fetchedAt: '2026-02-01T00:00:00Z' } }],
  { metric: 'earnings', multiples: { bear: 10, base: 15, bull: 20 } }, { price: 100, currency: 'USD', asOf: '2026-02-02T00:00:00Z' }, '2026-02-02T00:00:00Z');
  const data = result.data as Record<string, unknown> & { scenarios: Array<Record<string, unknown>>; limitations: string[] };
  data.limitations.push('Unique issuer-specific caveat: no reliable renewal data.');
  const before = structuredClone(data);
  const packed = compactValuationHandoff(data) as typeof data & { scenarioDefaults: Record<string, unknown> };
  assert.deepEqual(packed.scenarios.map(scenario => ({ ...packed.scenarioDefaults, ...scenario })), data.scenarios);
  assert.deepEqual(packed.denominator, data.denominator);
  assert.deepEqual(packed.quote, data.quote);
  assert.equal('assumptions' in packed, false, 'scenario multiples already retain exactly the same assumptions');
  assert.deepEqual(packed.limitations, [
    'Multiples are caller assumptions, not verified forecasts or recommendations.',
    'No verified share count: no per-share target or upside.',
    'No FX conversion, growth extrapolation or annualization.',
    'Floating-point approximations; source currency units preserved.',
    data.limitations.at(-1),
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(JSON.stringify(data)) - 250);
  assert.deepEqual(data, before, 'the durable calculation and full caveats remain unchanged');
  for (const variation of ['missing', 'null', 'different', 'empty']) {
    const changed = structuredClone(data);
    if (variation === 'empty') changed.scenarios = [];
    else if (variation === 'missing') delete changed.scenarios[0].currency;
    else changed.scenarios[0].currency = variation === 'null' ? null : 'EUR';
    const projected = compactValuationHandoff(changed) as typeof packed;
    assert.deepEqual(projected.scenarios.map(scenario => ({ ...projected.scenarioDefaults, ...scenario })), changed.scenarios);
  }
  const different = { ...data, assumptions: { bear: 1, base: 15, bull: 20, additional: null }, formula: 'An issuer-defined formula.' };
  const projected = compactValuationHandoff(different) as typeof different;
  assert.deepEqual(projected.assumptions, different.assumptions);
  assert.equal(projected.formula, different.formula);
});

test('snapshot metadata references identical tool facts while retaining each observation and unique prose', () => {
  const provider = parseFinnhubFinancials({ symbol: 'AAPL', data: [{ symbol: 'AAPL', cik: '123', startDate: '2025-01-01',
    endDate: '2025-12-31', filedDate: '2026-02-01', accessNumber: '0000000123-26-000001', form: '10-K',
    report: { ic: [{ concept: 'Revenues', value: 123456, unit: 'USD' }, { concept: 'NetIncomeLoss', value: 98765, unit: 'USD' }],
      cf: [{ concept: 'NetCashProvidedByUsedInOperatingActivities', value: 87654, unit: 'USD' }],
      bs: [{ concept: 'Liabilities', value: 76543, unit: 'USD' }] } }] }, 'AAPL', 'annual').items[0];
  const original: CouncilEvidence = { ...provider, id: 'old-citation', content: 'Unique accounting qualification.',
    sourceName: provider.sourceName!, sourceUrl: provider.sourceUrl!, fetchedAt: '2026-02-02T00:00:00Z' };
  const fresh = { ...original, id: 'tool-citation', fetchedAt: '2026-02-03T00:00:00Z', metadata: structuredClone(original.metadata!) };
  fresh.metadata.sources[0].observedAt = fresh.fetchedAt;
  fresh.metadata.sources[0].observationBasis = 'server';
  const excerpts = evidenceExcerpts([original], 550), before = structuredClone([original, fresh]);
  const available = [{ id: fresh.id, data: { metadata: evidencePromptMetadata(fresh.metadata) } }];
  const aliased = referenceEvidenceMetadata(excerpts, [original, fresh], available);
  assert.deepEqual(aliased[0].metadata, { sameSourcesAs: { evidenceId: fresh.id, sourceIndexes: [0] },
    observations: [{ at: null, basis: 'unknown' }] });
  assert.equal(aliased[0].fetchedAt, original.fetchedAt);
  assert.equal(aliased[0].content, original.content);
  const repeated = referenceEvidenceMetadata(excerpts, [original, fresh], [{ ...available[0], data: {
    metadata: evidencePromptMetadata(fresh.metadata), title: excerpts[0].title, content: original.content } }]);
  assert.equal(repeated[0].content, '', 'only a prose excerpt already present in the tool is omitted');
  assert.equal('title' in repeated[0], false, 'an exact repeated title can use its referenced tool source');
  assert.equal('source' in repeated[0], false, 'an exact provider already in referenced provenance is not repeated');
  assert.deepEqual([original, fresh], before, 'prompt deduplication never changes historical observation metadata');
  for (const change of [
    (source: typeof fresh.metadata.sources[0]) => { source.facts[0].value = 1; },
    (source: typeof fresh.metadata.sources[0]) => { source.facts[0].periodStart = '2025-04-01'; },
    (source: typeof fresh.metadata.sources[0]) => { source.facts[0].currency = 'EUR'; },
    (source: typeof fresh.metadata.sources[0]) => { source.facts[0].unit = 'shares'; },
    (source: typeof fresh.metadata.sources[0]) => { source.facts[0].basis = 'adjusted'; },
    (source: typeof fresh.metadata.sources[0]) => { source.sourceRevision = 'amended'; },
    (source: typeof fresh.metadata.sources[0]) => { source.publishedAt = '2026-02-02'; },
    (source: typeof fresh.metadata.sources[0]) => { source.sourceUrl = 'https://example.test/other'; },
  ]) {
    const changed = structuredClone(fresh); change(changed.metadata.sources[0]);
    assert.deepEqual(referenceEvidenceMetadata(excerpts, [original, changed], available), excerpts);
  }
  assert.deepEqual(referenceEvidenceMetadata(excerpts, [original, fresh], []), excerpts, 'an archived tool absent from the request is not a usable reference');
  assert.deepEqual(referenceEvidenceMetadata(excerpts, [original, fresh], [{ id: fresh.id, data: {} }]), excerpts,
    'an archived source absent from the actual tool excerpt is not a usable reference');
});

test('real financial and nested peer facts survive tight executor excerpts or stop before dispatch', async () => {
  const provider = parseFinnhubFinancials({ symbol: 'AAPL', data: [{ symbol: 'AAPL', cik: '123', startDate: '2025-01-01',
    endDate: '2025-12-31', filedDate: '2026-02-01', accessNumber: '0000000123-26-000001', form: '10-K',
    report: { ic: [{ concept: 'Revenues', value: 123456, unit: 'USD' }, { concept: 'NetIncomeLoss', value: 98765, unit: 'USD' }],
      cf: [{ concept: 'NetCashProvidedByUsedInOperatingActivities', value: 87654, unit: 'USD' }],
      bs: [{ concept: 'Liabilities', value: 76543, unit: 'USD' }] } }] }, 'AAPL', 'annual');
  const result = (ResearchToolsService.prototype as unknown as { evidenceResult(...args: unknown[]): { data: object } })
    .evidenceResult.call({}, provider.items, 'AAPL', new Date().toISOString(), 10);
  for (const peer of [false, true]) {
    const data = compactToolEvidence({ evidenceId: 'current-provider', ...(peer ? {
      primary: 'AAPL', companies: [{ ticker: 'AAPL', financials: { data: result.data } }] } : result.data) });
    const bounded = boundedResult({ ...result, data } as never);
    const excerpt = JSON.stringify(excerptToolData(bounded.data, 60));
    for (const value of [123456, 98765, 87654, 76543]) assert.ok(excerpt.includes(String(value)), `lost ${value} in ${peer ? 'peer' : 'direct'} projection`);
    assert.ok(excerpt.includes(provider.items[0].sourceUrl!));
    const row = { id: 'session', owner: 'owner', revision: 1, ticker: 'AAPL', language: 'en', status: 'running',
      profileSnapshot: {}, checkpoint: { workflow: { peers: peer ? ['MSFT'] : [], recallEnabled: false } }, evidenceSnapshot: [] };
    const builder = { from: () => builder, where: () => builder,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve([row]).then(resolve),
      orderBy: async () => [{ content: '请核对财报期间和单位。'.repeat(100).slice(0, 960) }] };
    let captured = '', measured = 0;
    const executor = new CouncilWorkflowExecutor({ db: { select: () => builder },
      llm: { getInputLimit: async () => 6000, chatFastJSON: async (messages: unknown) => { captured = JSON.stringify(messages); throw new Error('CAPTURED'); } },
      tools: { call: async () => bounded },
      store: { markRemote: async (_row: unknown, _task: unknown, _id: unknown, update: { memory: { requestTokens: number } }) => { measured = update.memory.requestTokens; } },
      activity: async () => {} } as never);
    await assert.rejects(executor.execute(row as never, { id: 'task', key: peer ? 'business' : 'financials', position: 0,
      dependencies: [], skills: [], reason: null } as never, { id: 'attempt', revision: 1, kind: 'work' } as never,
    { id: 'researcher', name: 'Fixture', model: 'fast', instructions: '' } as never, []), /CAPTURED|RESEARCH_CONTEXT_LIMIT/);
    if (captured) {
      assert.ok(measured <= 6000);
      for (const value of [123456, 98765, 87654, 76543]) assert.ok(captured.includes(String(value)));
      assert.ok(captured.includes(provider.items[0].sourceUrl!));
      assert.match(captured, /2025-01-01.*2025-12-31/);
      assert.match(captured, /currency=USD/); assert.match(captured, /basis=us-gaap/);
    } else assert.ok(measured > 6000, 'an oversized protected source must fail before the model transport');
  }
});

test('tool excerpts preserve numeric values and identify omitted text', () => {
  assert.deepEqual(excerptToolData({ price: 123.456, units: 'USD', details: 'long text' }, 4),
    { price: 123.456, units: 'USD', details: 'long [excerpt]' });
  assert.equal(excerptToolData(null, 60, 8), null, 'unknown metadata remains null at the excerpt depth boundary');
  assert.equal(excerptToolData(123.456, 60, 8), 123.456, 'a nested numeric fact must not become an excerpt marker');
});
test('peer field factoring retains exact sources, numeric values and all caveats', () => {
  const source = { url: 'https://example.test/annual', fetchedAt: '2026-11-03T00:00:00.000Z', title: 'Annual audited filing' };
  const financials = [{ revenue: 123.45, period: '2025-01-01/2025-12-31', currency: 'USD', source,
    caveats: ['No FX conversion or annualization is performed. '.repeat(5)] }];
  const value = { primary: 'AAPL', companies: ['AAPL', 'MSFT', 'AMD'].map((ticker, index) => ({ ticker, financials,
    quote: { currency: 'USD', units: { price: 'USD', volume: 'shares' }, asOf: '2026-11-03T00:00:00.000Z',
      price: 100 + index, volume: index === 0 ? null : 1000, ...(index === 0 ? { delay: null } : {}) } })), gaps: ['Verify comparability'] };
  const packed = compactPeerComparison(value) as { commonCompanyFields: object; companies: object[]; fieldInheritance: string };
  const merge = (defaults: object, specific: object): object => Object.fromEntries(Object.entries({ ...defaults, ...specific }).map(([key, item]) => {
    const original = (defaults as Record<string, unknown>)[key];
    return [key, item && original && typeof item === 'object' && typeof original === 'object' && !Array.isArray(item)
      ? merge(original, item) : item];
  }));
  assert.deepEqual(packed.companies.map(company => merge(packed.commonCompanyFields, company)), value.companies);
  assert.ok(Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(JSON.stringify(value)));
  assert.deepEqual(compactPeerComparison({ value: 123.45 }), { value: 123.45 });
  const collision = { ...value, commonCompanyFields: { foreign: true } };
  assert.equal(compactPeerComparison(collision), collision);
});
test('valuation output adds sourced arithmetic while unavailable arithmetic prevents full coverage', () => {
  const delivery: ResearchDelivery = { conclusion: 'Range', evidenceIds: ['filing'], asOf: '2026-11-03', currency: 'USD', units: 'USD',
    assumptions: [], gaps: [], skillVersions: [], response: { thesis: 'Range', evidencePoints: [], risks: [], nextChecks: [] } };
  attachValuation(delivery, { status: 'partial', data: { evidenceId: 'calculation', scenarios: [
    { equityValue: 1000, currency: 'USD' }, { equityValue: 1500, currency: 'USD' }, { equityValue: 2000, currency: 'USD' }] },
  sources: [], asOf: '2026-11-03', truncated: false }, 'en');
  assert.ok(delivery.evidenceIds.includes('calculation'));
  assert.match(delivery.response.evidencePoints[0], /not per-share targets/);
  assert.equal(delivery.gaps.length, 0);
  attachValuation(delivery, { status: 'unavailable', data: {}, sources: [], asOf: '2026-11-03', truncated: false }, 'en');
  assert.equal(delivery.gaps.length, 1);
});
test('native source aliases cannot replace existing server evidence IDs or invent unbound citations', () => {
  const existing = [{ id: 'server-id' }] as never;
  assert.throws(() => nativeWorkflowSources({ sources: [{ id: 'server-id', title: 'Forged', url: 'https://example.test/', content: 'Forged' }] }, 'attempt', existing, 'en'));
  const result = nativeWorkflowSources({ evidenceIds: ['s1', 'server-id', 'foreign'], sources: [
    { id: 's1', title: 'Agent report', url: 'https://example.test/', content: 'Unverified excerpt' }] }, 'attempt', existing, 'en');
  assert.deepEqual(result.data.evidenceIds, ['native:attempt:0', 'server-id', 'foreign']);
  assert.match(result.sources[0].title, /unverified/);
});

test('native aliases are bound in nested atomic thesis references before delivery validation', () => {
  const result = nativeWorkflowSources({ evidenceIds: ['s1'], sources: [
    { id: 's1', title: 'Filing', url: 'https://example.test/', content: 'Excerpt' }], thesisCandidates: [{
    claim: 'One claim', supportingEvidence: [{ evidenceId: 's1' }],
    evidenceRelations: [{ evidenceId: 's1', role: 'qualify' }, { evidenceId: 'foreign', role: 'refute' }],
  }] }, 'attempt', [], 'zh-CN');
  const candidates = result.data.thesisCandidates as Array<{ supportingEvidence: unknown; evidenceRelations: unknown }>;
  assert.deepEqual(candidates[0].supportingEvidence, [{ evidenceId: 'native:attempt:0' }]);
  assert.deepEqual(candidates[0].evidenceRelations,
    [{ evidenceId: 'native:attempt:0', role: 'qualify' }, { evidenceId: 'foreign', role: 'refute' }]);
});

test('review retains atomic conditions and includes opposing evidence cited only by a thesis', () => {
  const candidate = { claim: 'Margin can recover', supportingEvidence: [{ evidenceId: 'support' }],
    opposingEvidence: ['Lower mix'], assumptions: ['Demand holds'], indicators: ['Margin'], invalidationConditions: ['Margin below 10%'],
    boundaryOrigin: 'proposed' as const, evidenceRelations: [{ evidenceId: 'opposing', role: 'refute' as const }] };
  const delivery: ResearchDelivery = { conclusion: 'Margin can recover', evidenceIds: ['support'], thesisCandidates: [candidate],
    asOf: '2026-11-03', currency: null, units: 'ratio', assumptions: [], gaps: [], skillVersions: [],
    response: { thesis: 'Margin can recover', evidencePoints: [], risks: [], nextChecks: [] } };
  const prompt = workflowReviewPrompt({ id: 'task', key: 'summary', delivery } as never,
    { id: 'review', revision: 1 } as never, [], { summary: 'Summarize' } as never, 'AAPL', 'en', [],
    [{ id: 'support', content: 'Support' }, { id: 'opposing', content: 'Refutation' }] as never);
  assert.deepEqual(prompt.input.evidence.map(item => item.id), ['support', 'opposing']);
  assert.ok(JSON.stringify(prompt.input.submitted).includes('Margin below 10%'));
  assert.match(prompt.system, /boundaryOrigin/);
});
