import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as rules from './research-memory.rules';
import { memoryQuerySchema } from './research-memory.requests';

const at = '2026-11-03T12:00:00.000Z';
const fact = { entity: 'AAPL', metric: 'us-gaap:Revenues', value: 100, unit: 'currency', currency: 'USD',
  basis: 'us-gaap', actuality: 'actual', periodStart: '2026-01-01', periodEnd: '2026-03-31', instant: null };
const source = { origin: 'provider', verification: 'server-verified', provider: 'SEC EDGAR', kind: 'financial',
  sourceUrl: 'https://example.test/filing', sourceRevision: 'filing-1', supersedesSourceRevision: null, revisionReason: null,
  publishedAt: '2026-04-30', publicationPrecision: 'day', observedAt: '2026-05-01T00:00:00.000Z', observationBasis: 'server', facts: [fact] };
function rule(name: string): (...args: unknown[]) => unknown {
  const value = (rules as unknown as Record<string, unknown>)[name];
  assert.equal(typeof value, 'function', `Temporal rule ${name} must exist`);
  return value as (...args: unknown[]) => unknown;
}

test('memory asOf accepts precise ISO cutoffs and rejects malformed or date-only cutoffs', () => {
  assert.equal(memoryQuerySchema.safeParse({ ticker: 'AAPL', asOf: at }).success, true);
  for (const asOf of ['2026-02-30', 'yesterday', '2026-11-03', '2026-11-03T25:00:00Z']) {
    assert.equal(memoryQuerySchema.safeParse({ ticker: 'AAPL', asOf }).success, false);
  }
});

test('old quarterly facts and unknown review dates do not acquire a thirty-day expiry', () => {
  assert.equal(rule('evidenceVisibleAt')({ sources: [source] }, '2026-05-01T00:00:00.000Z', at), true);
  assert.equal(rule('thesisFreshness')({ horizon: { endAt: '2027-01-01T00:00:00Z' } }, null, at), 'current');
  assert.equal(rule('thesisFreshness')({}, null, at), 'unknown');
  assert.equal(rule('thesisFreshness')({ horizon: { reviewAt: '2026-11-01T00:00:00Z' } }, null, at), 'needs_review');
  assert.equal(rule('thesisFreshness')({}, '2026-11-01T00:00:00Z', at), 'expired');
});

test('only exact trusted comparable facts conflict, and explicit revisions remain distinguishable', () => {
  const compare = rule('compareEvidence');
  const left = { source, fact };
  const right = (changes: Record<string, unknown>, provenance = source) => ({ source: provenance, fact: { ...fact, value: 101, ...changes } });
  assert.deepEqual(compare(left, right({})), { kind: 'conflict' });
  assert.deepEqual(compare(left, right({ value: 100 })), { kind: 'same' });
  assert.deepEqual(compare(left, right({ periodEnd: '2026-06-30' })), { kind: 'different_period' });
  for (const changes of [{ currency: 'EUR' }, { basis: 'non-gaap' }, { actuality: 'forecast' }, { unit: 'millions' }, { entity: 'MSFT' }]) {
    assert.deepEqual(compare(left, right(changes)), { kind: 'not_comparable' });
  }
  assert.deepEqual(compare(left, right({ basis: null })), { kind: 'unknown' });
  assert.deepEqual(compare(left, right({}, { ...source, verification: 'unknown', origin: 'legacy' })), { kind: 'unknown' });
  assert.deepEqual(compare(left, right({}, { ...source, sourceRevision: 'filing-2', supersedesSourceRevision: 'filing-1', revisionReason: 'Issuer restatement' })), { kind: 'superseded' });
});

test('historical visibility respects publication precision, observation and ingestion, but permits known forecasts', () => {
  const visible = rule('evidenceVisibleAt');
  const metadata = (changes: Record<string, unknown>) => ({ sources: [{ ...source, ...changes }] });
  assert.equal(visible(metadata({ publishedAt: '2026-11-04' }), '2026-05-01T00:00:00Z', at), false);
  assert.equal(visible(metadata({ publishedAt: '2026-11-03' }), '2026-05-01T00:00:00Z', at), false, 'date-only publication cannot invent an earlier instant');
  assert.equal(visible(metadata({ publishedAt: '2026-11-03', observedAt: '2026-11-03T08:00:00Z' }), '2026-11-03T09:00:00Z', at), true,
    'a real same-day observation proves availability without inventing the release instant');
  assert.equal(visible(metadata({ observedAt: '2026-11-04T00:00:00Z' }), '2026-05-01T00:00:00Z', at), false);
  assert.equal(visible({ sources: [source] }, '2026-11-04T00:00:00Z', at), false);
  assert.equal(visible(metadata({ publishedAt: null, publicationPrecision: null }), '2026-05-01T00:00:00Z', at), true);
  assert.equal(visible(metadata({ facts: [{ ...fact, actuality: 'forecast', periodEnd: '2027-03-31' }] }), '2026-05-01T00:00:00Z', at), true);
  assert.equal(visible(metadata({ facts: [{ ...fact, periodEnd: '2027-03-31' }] }), '2026-05-01T00:00:00Z', at), false);
});
