import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { councilReports } from '../../database/council.schema';
import { monitorFixture, seedMonitor } from './research-memory.monitor.fixtures';
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

const shortQueries = [
  { name: 'Chinese alias', query: '现金流怎么样', relevant: ['cash', 'cash-risk'], first: 'cash' },
  { name: 'Two-character Chinese alias', query: '回款', relevant: ['cash', 'cash-risk'], first: 'cash' },
  { name: 'English alias', query: 'free cash flow', relevant: ['cash', 'cash-risk'], first: 'cash' },
  { name: 'English literal', query: 'premium pricing', relevant: ['pricing'], first: 'pricing' },
  { name: 'Unlisted renewal query', query: '续约', relevant: ['renewals-cn'], first: 'renewals-cn' },
  { name: 'Unlisted price query with punctuation', query: '提价？', relevant: ['price-cn'], first: 'price-cn' },
  { name: 'Unlisted capacity query', query: '扩产', relevant: ['capacity-cn'], first: 'capacity-cn' },
  { name: 'Unlisted continuous question', query: '续约怎么样', relevant: ['renewals-cn'] },
  { name: 'No literal or alias match', query: '商誉', relevant: [], first: 'capacity' },
  { name: 'Two-letter English control', query: 'AI', relevant: ['capacity-cn'], first: 'capacity' },
];

for (const fixture of shortQueries) {
  test(`short-query rank: ${fixture.name}`, t => {
    const corpus = retrievalCorpus();
    const claim = corpus[0];
    const localFixtures = [
      { id: 'renewals-cn', summary: '订阅到期续约比例上升，主要来自企业客户。' },
      { id: 'price-cn', summary: '试点渠道年底提价，销量仍待核对。' },
      { id: 'capacity-cn', summary: '新厂扩产将在明年交付，供给将覆盖 AI 加速卡。' },
    ];
    const items = [...corpus, ...localFixtures.map(({ id, summary }) => ({
      ...claim,
      id,
      memoryId: `memory-${id}`,
      summary,
      content: claim.content && { ...claim.content, claim: summary },
      citations: [],
      source: { ...claim.source, reportId: `report-${id}`, reportCreatedAt: '2026-09-01T00:00:00.000Z' },
    }))];
    const topThree = rankMemoryRecall(items, fixture.query, preferences).items.slice(0, 3).map(item => item.id);
    const hits = fixture.relevant.filter(id => topThree.includes(id)).length;
    t.diagnostic(JSON.stringify({ query: fixture.query, topThree, hits, relevant: fixture.relevant }));
    if (fixture.first) assert.equal(topThree[0], fixture.first);
  });
}

test('a matching short query obeys request and saved opt-outs, owner and ticker scope, and live source eligibility', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL,
}, async () => monitorFixture(async (db, _client, owner) => {
  const { memory, report, thesis } = await seedMonitor(db, owner);
  const edited = await memory.updateThesis(owner, thesis.id, {
    action: 'edit',
    expectedVersion: thesis.version,
    content: {
      claim: '订阅续约比例上升',
      supportingEvidence: thesis.supportingEvidence,
      opposingEvidence: [],
      assumptions: [],
      indicators: [],
      invalidationConditions: [],
    },
  });
  const query = { ticker: 'AAPL', query: '续约' };
  const initial = await memory.recall(owner, query);
  assert.ok(initial.items.some(item => item.id === edited.id && item.content?.claim.includes('续约')));
  assert.deepEqual((await memory.recall(owner, { ...query, enabled: false })).items, []);
  assert.deepEqual((await memory.recall(randomUUID(), query)).items, []);
  assert.deepEqual((await memory.recall(owner, { ...query, ticker: 'MSFT' })).items, []);
  await memory.updatePreferences(owner, { autoArchive: true, recallEnabled: false });
  assert.deepEqual((await memory.recall(owner, query)).items, []);
  await memory.updatePreferences(owner, { autoArchive: true, recallEnabled: true });
  await db.delete(councilReports).where(eq(councilReports.id, report.id));
  assert.deepEqual((await memory.recall(owner, query)).items, []);
  assert.deepEqual((await memory.refreshRecall(owner, initial, query)).items, []);
}));
