import type { ResearchToolResult } from '../../../shared/research-tools.interface';
import type { ResearchDelivery } from '../../../shared/research-workflow.interface';
import { isMemoryToolData } from '../research-memory/research-memory.context';
import { compactEvidencePromptEnvelope, containsEvidencePromptMetadata, evidencePromptMetadata, isEvidencePromptMetadata } from '../research-memory/research-memory.temporal';
import { byteExcerpt, type CouncilEvidence } from './council.rules';
import type { EvidenceSourceMetadata } from '../../../shared/research-evidence.interface';

/** Whole short entries use Unicode code points, not UTF-8 bytes or UTF-16 code units. */
export function handoffEvidenceExcerpt(point: string, maxBytes: number): string {
  return [...point].length <= 60 ? point : byteExcerpt(point, maxBytes);
}

/** Whole equal fields only: arrays are never merged by position, prefix or meaning. */
export function compactHandoffs<T extends Record<string, unknown>>(handoffs: T[]): {
  handoffs: Array<Partial<T>>; handoffDefaults?: Partial<T>; handoffInheritance?: string;
} {
  const unchanged = { handoffs, handoffDefaults: undefined, handoffInheritance: undefined };
  if (handoffs.length < 2) return unchanged;
  const rows = handoffs.map(item => ({ ...item })), defaults: Partial<T> = {};
  for (const key of Object.keys(handoffs[0]) as Array<keyof T>) {
    if (handoffs.every(item => Object.hasOwn(item, key) && JSON.stringify(item[key]) === JSON.stringify(handoffs[0][key]))) {
      defaults[key] = handoffs[0][key]; rows.forEach(item => { delete item[key]; });
    }
  }
  if (!Object.keys(defaults).length) return unchanged;
  const packed = { handoffs: rows, handoffDefaults: defaults,
    handoffInheritance: 'Merge handoffDefaults into each handoff; explicit fields win.' };
  return Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(JSON.stringify(unchanged)) ? packed : unchanged;
}

/** Prompt-only projection of the server calculator. Unknown wording and nonuniform measurements remain exact. */
export function compactValuationHandoff(value: unknown): unknown {
  const record = (item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item));
  if (!record(value)) return value;
  const result = { ...value };
  const caveats = new Map([
    ['Multiples are explicit caller assumptions, not verified forecasts or recommendations.', 'Multiples are caller assumptions, not verified forecasts or recommendations.'],
    ['Verified comparable share count is unavailable; per-share target and upside cannot be calculated.', 'No verified share count: no per-share target or upside.'],
    ['No currency conversion, growth extrapolation or annualization is performed.', 'No FX conversion, growth extrapolation or annualization.'],
    ['The arithmetic uses floating-point numbers; values are indicative and preserve source currency units.', 'Floating-point approximations; source currency units preserved.'],
  ]);
  if (Array.isArray(value.limitations)) {
    result.limitations = value.limitations.map(item => typeof item === 'string' ? caveats.get(item) ?? item : item);
    if (value.limitations.includes('Verified comparable share count is unavailable; per-share target and upside cannot be calculated.')) {
      if (result.perShareTarget === null) delete result.perShareTarget;
      if (result.upsidePercent === null) delete result.upsidePercent;
    }
  }
  if (result.formula === 'total equity value = sourced monetary denominator × assumed multiple') {
    result.formula = 'equityValue = denominator.value × assumed multiple';
  }
  if (Array.isArray(value.scenarios) && value.scenarios.length && value.scenarios.every(record) && !('scenarioDefaults' in value)) {
    const scenarios = value.scenarios.map(item => ({ ...item })), defaults: Record<string, string> = {};
    for (const key of ['currency', 'units']) {
      const first = scenarios[0][key];
      if (typeof first === 'string' && first && scenarios.every(item => item[key] === first)) {
        defaults[key] = first; scenarios.forEach(item => { delete item[key]; });
      }
    }
    if (Object.keys(defaults).length) { result.scenarioDefaults = defaults; result.scenarios = scenarios; }
    const assumptions = value.assumptions;
    if (record(assumptions) && Object.keys(assumptions).length === scenarios.length
      && new Set(scenarios.map(item => item.name)).size === scenarios.length
      && scenarios.every(item => typeof item.name === 'string' && typeof item.multiple === 'number'
        && Number.isFinite(item.multiple) && assumptions[item.name] === item.multiple)) delete result.assumptions;
  }
  return result;
}

/** Reference only complete source/fact matches actually present in this request. Observation differences stay explicit. */
export function referenceEvidenceMetadata<T extends { id: string; content: string; title?: string; source?: string; metadata?: unknown }>(excerpts: T[], snapshot: CouncilEvidence[],
  available: Array<{ id: string; data: unknown }>) {
  const identity = ({ observedAt: _observedAt, observationBasis: _basis, ...source }: EvidenceSourceMetadata) => JSON.stringify(source);
  const contains = (data: unknown, source: EvidenceSourceMetadata): boolean => {
    if (isEvidencePromptMetadata(data)) return (data as ReturnType<typeof evidencePromptMetadata>).sources.some(item =>
      JSON.stringify(item) === JSON.stringify(evidencePromptMetadata({ sources: [source] }).sources[0]));
    return Boolean(data && typeof data === 'object' && Object.values(data).some(value => contains(value, source)));
  };
  const containsText = (data: unknown, key: string, text: string, prefix = false): boolean => Boolean(text && data && typeof data === 'object'
    && Object.entries(data).some(([field, value]) => field === key && typeof value === 'string'
      && (prefix ? value.startsWith(text) : value === text) || containsText(value, key, text, prefix)));
  return excerpts.map(excerpt => {
    const original = snapshot.find(item => item.id === excerpt.id)?.metadata;
    if (!original?.sources.length) return excerpt;
    for (const tool of available) {
      const replacement = snapshot.find(item => item.id === tool.id)?.metadata;
      if (!replacement?.sources.length) continue;
      const indexes = original.sources.map(source => replacement.sources.findIndex(other => identity(source) === identity(other)
        && contains(tool.data, other)));
      if (indexes.some(index => index < 0)) continue;
      const { title, source, ...remaining } = excerpt;
      return { ...remaining,
        ...(title && !containsText(tool.data, 'title', title) ? { title } : {}),
        ...(source && !replacement.sources.some(item => item.provider === source) ? { source } : {}),
        content: containsText(tool.data, 'content', excerpt.content.replace(/…$/u, ''), true) ? '' : excerpt.content,
        metadata: { sameSourcesAs: { evidenceId: tool.id, sourceIndexes: indexes },
        observations: original.sources.map(source => ({ at: source.observedAt, basis: source.observationBasis })) } };
    }
    return excerpt;
  });
}

/** Preserve numeric values and field names; text and list omissions are explicitly marked. */
export function excerptToolData(value: unknown, limit = 300, depth = 0): unknown {
  if (isMemoryToolData(value) || isEvidencePromptMetadata(value)) return value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)} [excerpt]` : value;
  if (depth > 7 && !containsEvidencePromptMetadata(value)) return '[nested excerpt]';
  if (Array.isArray(value)) return [...value.slice(0, 5).map(item => excerptToolData(item, limit, depth + 1)),
    ...(value.length > 5 ? [`[${value.length - 5} more items omitted]`] : [])];
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(compactEvidencePromptEnvelope(value as Record<string, unknown>)).slice(0, 40)
    .map(([key, entry]) => [key, excerptToolData(entry, limit, depth + 1)]));
  return value;
}

/** Only peer envelopes: exact common fields apply to each company; all company-specific facts remain explicit. */
export function compactPeerComparison(value: unknown): unknown {
  const record = (item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item));
  if (!record(value) || typeof value.primary !== 'string' || !Array.isArray(value.companies)
    || value.companies.length < 2 || !value.companies.every(record) || 'commonCompanyFields' in value) return value;
  const protectedUnit = (item: unknown): boolean => isMemoryToolData(item)
    || Boolean(item && typeof item === 'object' && Object.values(item).some(protectedUnit));
  if (protectedUnit(value)) return value;
  const companies = structuredClone(value.companies) as Record<string, unknown>[];
  const common = (rows: Record<string, unknown>[]): Record<string, unknown> => {
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(rows[0])) {
      if (!rows.every(row => Object.hasOwn(row, key))) continue;
      const values = rows.map(row => row[key]);
      if (values.every(item => JSON.stringify(item) === JSON.stringify(values[0]))) {
        fields[key] = values[0]; rows.forEach(row => { delete row[key]; });
      } else if (values.every(record)) {
        const nested = common(values);
        if (Object.keys(nested).length) fields[key] = nested;
      }
    }
    return fields;
  };
  const commonCompanyFields = common(companies);
  const packed = { ...value, commonCompanyFields, companies,
    fieldInheritance: 'Recursively merge commonCompanyFields into companies; specific leaves win.' };
  return Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(JSON.stringify(value)) ? packed : value;
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
