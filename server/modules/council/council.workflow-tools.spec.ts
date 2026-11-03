import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachValuation, excerptToolData, compactPeerComparison } from './council.workflow-tools';
import { nativeWorkflowSources } from './council.workflow-executor';
import type { ResearchDelivery } from '../../../shared/research-workflow.interface';
import { workflowReviewPrompt } from './council.workflow-review';
import { parseFinnhubFinancials } from '../multi-agent/finnhub-financials';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { compactToolEvidence } from '../research-tools/research-tools.evidence';
import { CouncilWorkflowExecutor } from './council.workflow-executor';
import { boundedResult } from '../research-tools/research-tools.output';

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
