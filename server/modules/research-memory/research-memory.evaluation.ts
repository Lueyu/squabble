import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { ResearchMemoryRecallItem } from '@shared/research-memory.interface';
import { rankMemoryRecall } from './research-memory.rules';
import { packMemoryContext } from './research-memory.context';
import { retrievalCorpus, retrievalCases } from './research-memory.retrieval.fixtures';
import { MEMORY_CANDIDATE_LIMIT, MEMORY_THESIS_WINDOW } from './research-memory.ranking';

// Archived pre-M7 comparator, evaluation only. It receives the old workflow-wide topic, no task query.
function baseline(items: ResearchMemoryRecallItem[]): ResearchMemoryRecallItem[] {
  const topic = 'comprehensive';
  const relevance = (item: ResearchMemoryRecallItem) => (item.topic === topic ? 100 : 0) + Number(item.summary.toLowerCase().includes(topic));
  return [...items].sort((a, b) => Number(b.kind === 'thesis') - Number(a.kind === 'thesis') || relevance(b) - relevance(a)
    || Date.parse(b.source.reportCreatedAt) - Date.parse(a.source.reportCreatedAt) || a.id.localeCompare(b.id)).slice(0, 3);
}
const preferences = { autoArchive: true, recallEnabled: true };
const fixtures = retrievalCases.map(fixture => {
  const corpus = retrievalCorpus(fixture.name === 'crowded-linked-refutation');
  const measure = (items: ResearchMemoryRecallItem[]) => {
    const pack = packMemoryContext(items, fixture.budget), units = JSON.parse(pack.context || '[]') as ResearchMemoryRecallItem[];
    let preserved = 0;
    for (const unit of units) {
      const original = corpus.find(item => item.id === unit.id)!;
      assert.deepEqual(unit.content, original.content); assert.deepEqual(unit.citations, original.citations);
      assert.equal(unit.status, original.status); assert.equal(unit.version, original.version); preserved++;
    }
    const found = fixture.expected.filter(id => units.some(item => item.id === id));
    return { recalled: units.map(item => item.id), foundExpected: found.length, expected: fixture.expected.length,
      recall: fixture.expected.length ? found.length / fixture.expected.length : null,
      intactUnits: preserved, sentUnits: units.length, usedTokens: pack.inventory.usedTokens, countBasis: pack.inventory.basis,
      budgetTokens: fixture.budget, budgetOmissions: pack.inventory.omissions.filter(item => item.reason === 'budget').length };
  };
  const before = measure(baseline(corpus)), after = measure(rankMemoryRecall(corpus, fixture.query, preferences).items);
  assert.deepEqual([...after.recalled].sort(), [...fixture.expected].sort(), fixture.name);
  return { name: fixture.name, query: fixture.query, expectedIds: fixture.expected, baseline: before, current: after };
});
process.stdout.write(JSON.stringify({ corpus: 'fictional-financial-aliases-v1', fixtures,
  limits: { historyWindow: 100, thesisWindow: MEMORY_THESIS_WINDOW, frozenPool: MEMORY_CANDIDATE_LIMIT },
  limitations: ['Fixture-specific recall, not general semantic accuracy.',
    'Literal financial aliases do not resolve negation, free paraphrases, causal reasoning or cross-entity relationships.',
    'Finite candidate windows can omit older relevant claims; active theses are independent of the history window.',
    'No embeddings, semantic merger, vector database or graph database is used.'] }));
