import type { ResearchMemoryRecallItem } from '@shared/research-memory.interface';

/** Fictional, fixed corpus. These IDs and expected sets are evaluation data, not market assertions. */
export function retrievalCorpus(crowded = false): ResearchMemoryRecallItem[] {
  const claims = [
    ['capacity', 'Factory capacity expands with orders'], ['pricing', 'Premium pricing supports the brand'],
    ['distribution', 'Distribution reach improves'], ['cash', '经营现金流与自由现金流改善，回款支持增长'],
    ['cash-risk', 'Collections are conditional on customer renewals'], ['value', '市盈率估值需要稳定的每股收益'],
    ['debt', 'Debt and interest coverage constrain investment'],
  ];
  const items: ResearchMemoryRecallItem[] = claims.map(([id, claim], index) => ({
    kind: 'thesis', id, memoryId: `memory-${id}`, version: 2, topic: 'comprehensive', summary: claim,
    status: 'confirmed', flags: ['opinion'],
    content: { claim, supportingEvidence: [{ evidenceId: 'filing' }], opposingEvidence: ['Renewals could weaken'],
      assumptions: ['Stable reporting basis'], indicators: ['Quarterly disclosure'],
      invalidationConditions: ['Revisit after two weaker quarters'], boundaryOrigin: 'stated',
      horizon: { reviewAt: '2027-02-01T00:00:00.000Z' },
      evidenceRelations: [{ evidenceId: 'filing', role: id === 'cash-risk' ? 'refute' : 'support' }] },
    source: { sessionId: `session-${id}`, reportId: `report-${id}`, reportVersion: 1, reportRevision: 1,
      reportCreatedAt: new Date(Date.UTC(2026, 9, 20 - index)).toISOString(), url: '/council' },
    citations: [{ evidenceId: 'filing', recordId: id === 'cash-risk' ? 'cash-record' : `${id}-record`,
      title: 'Fictional filing', sourceUrl: 'https://example.test/filing', fetchedAt: '2026-10-01T00:00:00.000Z' }],
  }));
  const cash = items.find(item => item.id === 'cash')!;
  // Two independent theses can refer to the same durable evidence only within its owning report.
  const risk = items.find(item => item.id === 'cash-risk')!;
  risk.memoryId = cash.memoryId; risk.source = { ...cash.source };
  if (crowded) items.unshift(...Array.from({ length: 4 }, (_, i) => ({ ...cash, id: `recent-support-${i}`, memoryId: `recent-${i}`,
    source: { ...cash.source, reportId: `recent-report-${i}`, reportCreatedAt: '2026-11-01T00:00:00Z' },
    citations: [{ ...cash.citations[0], recordId: `independent-${i}` }] })));
  items.push({ ...cash, kind: 'history', id: cash.memoryId, summary: 'Report covering cash conversion', content: undefined, status: undefined });
  return items;
}

export const retrievalCases = [
  { name: 'english-query-chinese-cash', query: 'operating cash flow free cash flow', expected: ['cash', 'cash-risk'], budget: 2500 },
  { name: 'crowded-linked-refutation', query: 'free cash flow', expected: ['cash', 'cash-risk'], budget: 2500 },
  { name: 'natural-chinese-steering', query: '现金流怎么样', expected: ['cash', 'cash-risk'], budget: 2500 },
  { name: 'chinese-query-english-debt', query: '债务与利息保障倍数', expected: ['debt'], budget: 1550 },
  { name: 'valuation-query', query: 'P/E earnings per share valuation', expected: ['value'], budget: 1550 },
  { name: 'tiny-whole-unit-omission', query: '自由现金流', expected: [], budget: 120 },
];
