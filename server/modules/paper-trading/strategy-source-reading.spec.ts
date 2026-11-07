import test from 'node:test';
import assert from 'node:assert/strict';
import { splitStrategySourceText, strategyImportReadableContent, strategyImportSections } from '../../../shared/strategy-source-reading';

test('strategy reading excludes unavailable plan placeholders and private metadata from whole sources', () => {
  const sections = [{ id: 'summary', title: 'Research', content: 'Fictional full portfolio research.' },
    { id: 'execution-strategy', title: 'Execution strategy', content: 'NO_VALIDATED_PLAN_PLACEHOLDER' },
    { id: 'researchStance', title: 'Stance', content: 'balanced' },
    { id: 'evidence', title: 'Evidence', content: JSON.stringify([{ title: 'Public filing', sourceUrl: 'https://issuer.example/filing', content: 'PRIVATE_RAW_EVIDENCE' }]) }];
  for (const executionPlanError of ['missing', 'invalid', undefined]) {
    const version = { sections, snapshot: { executionPlanError } };
    assert.deepEqual(strategyImportSections(version).map(section => section.id), ['summary']);
    assert.doesNotMatch(strategyImportReadableContent(version), /PLACEHOLDER|PRIVATE_RAW_EVIDENCE|balanced/);
    assert.match(strategyImportReadableContent(version), /https:\/\/issuer.example\/filing/);
    assert.equal(strategyImportReadableContent(version, 'execution-strategy'), '');
  }
  const available = { sections, snapshot: { executionPlan: { readiness: 'ready' } } };
  assert.ok(strategyImportSections(available).some(section => section.id === 'execution-strategy'));
});

test('long source splitting preserves paragraph text and Unicode boundaries without loss', () => {
  const paragraph = 'A complete fictional holding and cash discussion.\n\n';
  const value = paragraph.repeat(400);
  const parts = splitStrategySourceText(value);
  assert.equal(parts.length, 2); assert.equal(parts.join(''), value);
  assert.ok(parts.every(part => part.length <= 12000));
  assert.ok(parts[0].endsWith('\n\n'));
  const crossing = 'x'.repeat(11999) + '🐈' + 'y'.repeat(12001);
  const unicode = splitStrategySourceText(crossing);
  assert.equal(unicode.join(''), crossing);
  assert.ok(unicode.every(part => part.length <= 12000 && part.isWellFormed()));
  assert.equal(splitStrategySourceText('x'.repeat(200000)).map(part => part.length).reduce((a, b) => a + b), 200000);
  const sparseParagraphs = ('x'.repeat(6000) + '\n\n').repeat(33);
  assert.ok(splitStrategySourceText(sparseParagraphs).length <= 20, 'a bounded new source must fit the unchanged entry capacity');
  assert.throws(() => splitStrategySourceText('x'.repeat(200001)), /200000/);
});
