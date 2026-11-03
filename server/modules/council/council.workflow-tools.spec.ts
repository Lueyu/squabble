import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachValuation, excerptToolData } from './council.workflow-tools';
import { nativeWorkflowSources } from './council.workflow-executor';
import type { ResearchDelivery } from '../../../shared/research-workflow.interface';

test('tool excerpts preserve numeric values and identify omitted text', () => {
  assert.deepEqual(excerptToolData({ price: 123.456, units: 'USD', details: 'long text' }, 4),
    { price: 123.456, units: 'USD', details: 'long [excerpt]' });
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
