import type { ResearchToolResult } from '../../../shared/research-tools.interface';
import type { ResearchDelivery } from '../../../shared/research-workflow.interface';

/** Preserve numeric values and field names; text and list omissions are explicitly marked. */
export function excerptToolData(value: unknown, limit = 300, depth = 0): unknown {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)} [excerpt]` : value;
  if (depth > 7) return '[nested excerpt]';
  if (Array.isArray(value)) return [...value.slice(0, 5).map(item => excerptToolData(item, limit, depth + 1)),
    ...(value.length > 5 ? [`[${value.length - 5} more items omitted]`] : [])];
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40)
    .map(([key, entry]) => [key, excerptToolData(entry, limit, depth + 1)]));
  return value;
}

export function attachValuation(delivery: ResearchDelivery, result: ResearchToolResult, language: string): void {
  delivery.valuation = result;
  const data = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {};
  if (typeof data.evidenceId === 'string') delivery.evidenceIds = [...new Set([...delivery.evidenceIds, data.evidenceId])].slice(-20);
  if ((result.status === 'succeeded' || result.status === 'partial') && Array.isArray(data.scenarios)) {
    const labels = language === 'en' ? ['bear', 'base', 'bull'] : ['悲观', '基础', '乐观'];
    const values = data.scenarios.map((s: { equityValue: number; currency: string }, index: number) => `${labels[index]} ${s.equityValue} ${s.currency}`);
    delivery.response.evidencePoints.push(language === 'en'
      ? `Application-calculated total equity values: ${values.join('; ')}. Multiples are assumptions; these are not per-share targets.`
      : `应用核算的总股权价值：${values.join('；')}。倍数是假设，以上不是每股目标价。`);
  } else {
    const gap = language === 'en' ? 'A reproducible valuation range is unavailable. Supply valid sourced annual inputs and explicit scenario multiples.'
      : '尚无法计算可复核的估值区间，需要有效的完整年度数据和明确的情景倍数。';
    delivery.gaps = [...new Set([...delivery.gaps, gap])];
    delivery.response.risks = [...new Set([...delivery.response.risks, gap])];
  }
}
