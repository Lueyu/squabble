import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankMemoryRecall } from './research-memory.rules';
import { packMemoryContext } from './research-memory.context';
import { retrievalCases, retrievalCorpus } from './research-memory.retrieval.fixtures';
import { MEMORY_CANDIDATE_LIMIT, taskMemoryQuery } from './research-memory.ranking';

const preferences = { autoArchive: true, recallEnabled: true };
test('task queries retrieve bilingual financial claims and explicitly related refutation within whole-unit budgets', () => {
  for (const fixture of retrievalCases) {
    const corpus = retrievalCorpus(fixture.name === 'crowded-linked-refutation');
    const ranked = rankMemoryRecall(corpus, fixture.query, preferences);
    const packed = packMemoryContext(ranked.items, fixture.budget, undefined, ranked);
    assert.deepEqual(packed.items.map(item => item.id).sort(), [...fixture.expected].sort(), fixture.name);
    for (const item of JSON.parse(packed.context || '[]')) {
      assert.deepEqual(item.content, corpus.find(original => original.id === item.id)!.content);
    }
  }
});

test('finite frozen pool and task query bounds are deterministic; typed links do not require matching prose', () => {
  const corpus = retrievalCorpus(), cash = corpus.find(item => item.id === 'cash')!;
  const linked = { ...corpus[0], id: 'linked', summary: 'A revised comparable figure', content: { ...corpus[0].content!, claim: 'A revised comparable figure' },
    citations: [{ ...corpus[0].citations[0], relatedEvidence: [{ recordId: 'cash-record', kind: 'conflict' as const }] }] };
  assert.deepEqual(rankMemoryRecall([cash, linked, corpus[0]], 'free cash flow', preferences).items.map(item => item.id), ['cash', 'linked', 'capacity']);
  const many = Array.from({ length: 601 }, (_, index) => ({ ...corpus[0], id: `fixture-${String(index).padStart(3, '0')}`, memoryId: `m${index}` }));
  const a = rankMemoryRecall(many, '', preferences), b = rankMemoryRecall([...many].reverse(), '', preferences);
  assert.equal(a.items.length, MEMORY_CANDIDATE_LIMIT); assert.deepEqual(a.items, b.items);
  assert.ok(taskMemoryQuery('financials', 'Verify debt and cash conversion', '重点核查自由现金流'.repeat(500)).length <= 1200);
  assert.match(taskMemoryQuery('valuation', 'Verify earnings', '核查估值'), /核查估值 valuation Verify earnings/u);
});
test('candidate pool retains more than three independent claims, exact deduplication and report-history suppression', () => {
  const corpus = retrievalCorpus();
  const result = rankMemoryRecall([...corpus, corpus[0]], '', preferences);
  assert.equal(result.items.length, 7);
  assert.ok(result.items.every(item => item.kind === 'thesis'));
  assert.equal(result.items.filter(item => item.id === 'capacity').length, 1);
  assert.equal(rankMemoryRecall(corpus, 'debt', preferences).items[0].id, 'debt');
});

test('linked refutation gets capacity beside its anchor ahead of equally relevant positive claims', () => {
  const corpus = retrievalCorpus(), cash = corpus.find(item => item.id === 'cash')!;
  const crowded = Array.from({ length: 4 }, (_, i) => ({ ...cash, id: `recent-support-${i}`, memoryId: `recent-${i}`,
    source: { ...cash.source, reportId: `recent-report-${i}`, reportCreatedAt: '2026-11-01T00:00:00Z' },
    citations: [{ ...cash.citations[0], recordId: `independent-${i}` }] }));
  const ranked = rankMemoryRecall([...crowded, ...corpus], 'free cash flow', preferences);
  assert.deepEqual(packMemoryContext(ranked.items, 2500).items.map(item => item.id), ['cash', 'cash-risk']);
  const history = { ...cash, kind: 'history' as const, id: 'cash-only-history', memoryId: 'only-history', content: undefined, status: undefined };
  assert.equal(rankMemoryRecall([history, ...corpus.filter(item => !item.id.startsWith('cash'))], 'free cash flow', preferences).items[0].id,
    history.id, 'relevant history-only evidence outranks unrelated atomic theses');
});
