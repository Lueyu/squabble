import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAdoption, assertIdempotency, contentHash, diffSections, reportCategory, reportTopic, resolveExactReference, sectionsFromRecord, validateRevision } from './research-documents.rules';
import type { ResearchDocumentVersion } from '../../../shared/research-document.interface';

const version: ResearchDocumentVersion = { id: 'v1', reportId: 'r1', version: 1, title: 'Daily', kind: 'daily', ticker: 'ACME',
  content: 'Original evidence', sections: [{ id: 'thesis', title: 'Thesis', content: 'Original evidence' }], dataAsOf: null,
  availableAt: null, createdAt: '2026-11-05T00:00:00.000Z', snapshot: null, source: { type: 'daily', id: 'source1' },
  parentVersionId: null, changeReason: null, contentHash: 'h1', status: 'valid', sourceStatus: 'available' };

test('same task is idempotent, but a changed payload conflicts', () => {
  const first = contentHash({ body: 'first', snapshot: { a: 1, b: 2 } });
  assert.equal(first, contentHash({ snapshot: { b: 2, a: 1 }, body: 'first' }));
  assert.doesNotThrow(() => assertIdempotency(first, first));
  assert.throws(() => assertIdempotency(first, contentHash({ body: 'changed' })), /REPORT_IDEMPOTENCY_CONFLICT/);
});
test('references preserve exact section and reject invented excerpts or sections', () => {
  assert.equal(resolveExactReference(version, { versionId: 'v1', sectionId: 'thesis', excerpt: 'Original' }).content, 'Original evidence');
  assert.throws(() => resolveExactReference(version, { versionId: 'v1', sectionId: 'other' }), /REPORT_SECTION_NOT_FOUND/);
  assert.throws(() => resolveExactReference(version, { versionId: 'v1', excerpt: 'new evidence' }), /REPORT_EXCERPT_MISMATCH/);
  assert.throws(() => resolveExactReference(version, { versionId: 'v2' }), /REPORT_VERSION_MISMATCH/);
});
test('historical unknown metadata remains unknown and deleted source does not redirect', () => {
  const result = resolveExactReference({ ...version, sourceStatus: 'missing' }, { versionId: 'v1' });
  assert.equal(result.dataAsOf, null); assert.equal(result.availableAt, null); assert.equal(result.snapshot, null);
  assert.equal(result.content, 'Original evidence'); assert.equal(result.sourceStatus, 'missing');
});
test('stale adoption conflicts and branch cannot replace a different document', () => {
  assert.doesNotThrow(() => assertAdoption('r1', 'v1', version, 'v1'));
  assert.throws(() => assertAdoption('r1', 'v2', version, 'v1'), /REPORT_ADOPTION_CONFLICT/);
  assert.throws(() => assertAdoption('branch', null, version, null), /REPORT_BRANCH_MISMATCH/);
  assert.throws(() => assertAdoption('r1', null, { ...version, status: 'revoked' }, null), /REPORT_REVOKED/);
});
test('revision requires parent and reason; exact section diff preserves original', () => {
  assert.throws(() => validateRevision({ title: 'x', content: 'y', changeReason: '' }), /REPORT_INVALID_REVISION/);
  const changed = [{ id: 'thesis', title: 'Thesis', content: 'New evidence' }];
  assert.deepEqual(diffSections(version.sections, changed), [{ id: 'thesis', title: 'Thesis', before: 'Original evidence', after: 'New evidence', change: 'changed' }]);
  assert.equal(version.sections[0].content, 'Original evidence');
});
test('source sections have deterministic ids and preserve structured evidence', () => {
  const sections = sectionsFromRecord({ thesis: 'first', risk: [{ claim: 'source' }] });
  assert.equal(sections[0].id, 'thesis'); assert.match(sections[1].content, /source/);
});
test('report index keeps persistent portfolio/ticker topics and distinguishes period reviews', () => {
  assert.equal(reportTopic('aapl'), 'ticker:AAPL'); assert.equal(reportTopic('PORTFOLIO'), 'portfolio'); assert.equal(reportTopic(null), 'portfolio');
  assert.equal(reportCategory({ ...version, kind: 'portfolio', ticker: null }), 'daily');
  assert.equal(reportCategory({ ...version, kind: 'deep' }), 'stock');
  assert.equal(reportCategory({ ...version, kind: 'council', snapshot: { experimentId: 'paper-1' } }), 'review');
});
