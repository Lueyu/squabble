import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachValuation, excerptToolData, compactPeerComparison } from './council.workflow-tools';
import { nativeWorkflowSources } from './council.workflow-executor';
import type { ResearchDelivery } from '../../../shared/research-workflow.interface';
import { workflowReviewPrompt } from './council.workflow-review';

test('tool excerpts preserve numeric values and identify omitted text', () => {
  assert.deepEqual(excerptToolData({ price: 123.456, units: 'USD', details: 'long text' }, 4),
    { price: 123.456, units: 'USD', details: 'long [excerpt]' });
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
