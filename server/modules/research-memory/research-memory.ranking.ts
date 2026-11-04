import type { ResearchMemoryRecallItem } from '@shared/research-memory.interface';

export const MEMORY_CANDIDATE_LIMIT = 200;
export const MEMORY_THESIS_WINDOW = 500;
export const MEMORY_QUERY_LIMIT = 1200;
const aliases = [
  ['cash flow', 'cash flows', '现金流'],
  ['operating cash flow', 'cash conversion', '经营现金流', '经营活动现金流', '回款'],
  ['free cash flow', 'fcf', '自由现金流'], ['revenue', 'sales', '营收', '收入'],
  ['debt', 'leverage', '债务', '负债', '杠杆'], ['interest coverage', '利息保障', '利息覆盖'],
  ['valuation', '估值'], ['p/e', 'pe ratio', 'price earnings', '市盈率'],
  ['earnings per share', 'eps', '每股收益'], ['gross margin', '毛利率'],
  ['net margin', '净利率'], ['dilution', 'share issuance', '稀释', '增发'],
  ['capital expenditure', 'capex', '资本开支'], ['inventory', '存货', '库存'],
  ['receivables', '应收账款'], ['dividend', '股息', '分红'],
  ['buyback', 'repurchase', '回购'], ['return on equity', 'roe', '净资产收益率'],
];
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
function includes(text: string, term: string): boolean {
  return /[\u3400-\u9fff]/u.test(term) ? text.includes(term)
    : new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?=$|[^a-z0-9])`, 'u').test(text);
}
/** Query text affects ranking only. Never use lexical matches to establish factual conflict or authority. */
export function memoryRelevance(item: ResearchMemoryRecallItem, query: string): number {
  const text = normalize([item.topic, item.summary, item.content?.claim,
    ...(item.content?.assumptions ?? []), ...(item.content?.opposingEvidence ?? []),
    ...(item.content?.indicators ?? []), ...(item.content?.invalidationConditions ?? []),
    ...item.citations.map(citation => citation.title)].filter(Boolean).join(' '));
  const normalized = normalize(query.slice(0, MEMORY_QUERY_LIMIT));
  const concepts = aliases.filter(group => group.some(term => includes(normalized, term)));
  const terms = [...new Set(normalized.match(/[\p{L}\p{N}/]+/gu) ?? [])].filter(term => term.length > 2).slice(0, 64);
  return concepts.reduce((score, group) => score + (group.some(term => includes(text, term)) ? 10 : 0), 0)
    + terms.reduce((score, term) => score + Number(includes(text, term)), 0);
}
export function boundedMemoryPins(items: ResearchMemoryRecallItem[]): ResearchMemoryRecallItem[] {
  return [...new Map(items.map(item => [`${item.kind}:${item.id}:${item.version}`, item])).values()].slice(0, MEMORY_CANDIDATE_LIMIT);
}
/** Explicit refutation of a shared scoped record, or server-computed comparable fact relations only. */
export function relatedCounterclaim(a: ResearchMemoryRecallItem, b: ResearchMemoryRecallItem): boolean {
  const records = new Set(a.citations.flatMap(citation => citation.recordId ? [citation.recordId] : []));
  return b.citations.some(citation => citation.recordId && (
    citation.relatedEvidence?.some(link => records.has(link.recordId))
    || records.has(citation.recordId) && b.content?.evidenceRelations?.some(ref => ref.evidenceId === citation.evidenceId && ref.role === 'refute')))
    || a.citations.some(citation => citation.relatedEvidence?.some(link => b.citations.some(peer => peer.recordId === link.recordId)));
}
export function taskMemoryQuery(goal: string, instruction: string, steering: string): string {
  // Derive only from the context already authorized for this task; no additional account-wide lookup.
  return `${steering.slice(0, 800)} ${goal} ${instruction.slice(0, 350)}`.slice(0, MEMORY_QUERY_LIMIT);
}
