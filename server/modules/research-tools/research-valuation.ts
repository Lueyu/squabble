import type { EvidenceInput } from '../multi-agent/evidence.service';
import type { ResearchToolResult, ResearchValuationInput, ResearchValuationMetric,
  ResearchValuationRequest, ResearchValuationQuote } from '@shared/research-tools.interface';
import { citationUrl, isoDate, researchFailure, researchSource } from './research-tools.output';

const LABELS: Array<[ResearchValuationMetric, string]> = [
  ['earnings', 'Net income'], ['revenue', 'Revenue'], ['book_value', '(?:Equity \\(parent\\)|Stockholders equity \\(parent\\))'],
];
function validDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}

/** Parse only the application's normalized, source-bound provider fields. Never parse model-supplied numbers. */
export function extractValuationInputs(items: Array<Pick<EvidenceInput, 'content' | 'sourceName' | 'sourceUrl' | 'relevanceScore'>
  & { fetchedAt?: string }>, asOf: string): ResearchValuationInput[] {
  const inputs: ResearchValuationInput[] = [];
  for (const item of items.slice(0, 30)) {
    const url = citationUrl(item.sourceUrl);
    if (item.relevanceScore <= 0 || !['SEC EDGAR', 'Finnhub API'].includes(item.sourceName) || !url) continue;
    const host = new URL(url).hostname;
    if (!['www.sec.gov', 'sec.gov', 'finnhub.io'].includes(host)) continue;
    const duration = /(?:Reporting period|Period): (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})\b/u.exec(item.content);
    const instant = /As of (\d{4}-\d{2}-\d{2})\b/u.exec(item.content);
    const start = duration?.[1] ?? null; const end = duration?.[2] ?? instant?.[1];
    if (!end || !validDay(end) || end > asOf.slice(0, 10) || (start && (!validDay(start) || start > end))) continue;
    const durationDays = start ? (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1 : 0;
    // Inclusive days: calendar years or exactly 52/53 weeks. Transition/YTD
    // periods are not full years and must never be silently annualized.
    const annual = [364, 365, 366, 371].includes(durationDays);
    for (const [metric, label] of LABELS) {
      const pattern = new RegExp(`(?:^|[.;]\\s*)${label}: ([A-Z]{3}) ([+-]?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)(?=;|\\.(?:\\s|$)|(?:\\s+\\([^)]*\\))[;.])`, 'giu');
      for (const match of item.content.matchAll(pattern)) {
        const value = Number(match[2]);
        if (!Number.isFinite(value)) continue;
        inputs.push({ metric, value, currency: match[1], units: 'currency',
          periodStart: metric === 'book_value' ? null : start, periodEnd: end, annual: metric === 'book_value' || annual,
          source: researchSource(item.sourceName, url, isoDate(item.fetchedAt) ?? asOf) });
      }
    }
  }
  return inputs;
}

export function valuationScenarios(ticker: string, inputs: ResearchValuationInput[], request: ResearchValuationRequest,
  quote: ResearchValuationQuote | null, asOf: string): ResearchToolResult {
  const values = Object.values(request.multiples);
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1000)
    || request.multiples.bear > request.multiples.base || request.multiples.base > request.multiples.bull) {
    return researchFailure('failed', 'RESEARCH_INVALID_ARGUMENTS');
  }
  const candidates = inputs.filter(input => input.metric === request.metric);
  const unique = new Map(candidates.map(input => [JSON.stringify([input.value, input.currency, input.periodStart, input.periodEnd, input.annual]), input]));
  const denominator = [...unique.values()][0];
  if (unique.size !== 1 || !denominator || denominator.value <= 0 || !denominator.annual) {
    return { ...researchFailure('unavailable', 'RESEARCH_VALUATION_INPUT_UNAVAILABLE'), asOf,
      sources: candidates.slice(0, 12).map(input => input.source), data: { ticker, metric: request.metric,
        reasons: [unique.size > 1 ? 'Conflicting reporting periods, currencies or values require reconciliation.'
          : !denominator ? 'No verified sourced monetary denominator is available.'
            : denominator.value <= 0 ? 'The multiple method is unavailable for nonpositive denominators.'
              : 'The reporting period is not a full annual period. YTD/quarterly values are not annualized.'],
        assumptions: request.multiples, quote, perShareTarget: null, upsidePercent: null } };
  }
  const scenarios = (['bear', 'base', 'bull'] as const).map(name => ({ name, multiple: request.multiples[name],
    equityValue: denominator.value * request.multiples[name], currency: denominator.currency, units: 'currency' }));
  if (scenarios.some(row => !Number.isFinite(row.equityValue))) return researchFailure('unavailable', 'RESEARCH_VALUATION_INPUT_UNAVAILABLE');
  return { status: 'partial', asOf, truncated: false, sources: [denominator.source], data: { ticker,
    method: { earnings: 'P/E', revenue: 'P/S', book_value: 'P/B' }[request.metric], denominator, scenarios,
    formula: 'total equity value = sourced monetary denominator × assumed multiple',
    assumptions: request.multiples, quote, perShareTarget: null, upsidePercent: null,
    limitations: ['Multiples are explicit caller assumptions, not verified forecasts or recommendations.',
      'Verified comparable share count is unavailable; per-share target and upside cannot be calculated.',
      'No currency conversion, growth extrapolation or annualization is performed.',
      'The arithmetic uses floating-point numbers; values are indicative and preserve source currency units.'] } };
}

export function canonicalResearchTicker(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9.^-]{0,19}$/u.test(value)) return null;
  if (/^\d{1,5}\.HK$/u.test(value)) return `${value.slice(0, -3).padStart(5, '0')}.HK`;
  if (/^\d{4,5}$/u.test(value)) return `${value.padStart(5, '0')}.HK`;
  if (/^\d{6}\.SS$/u.test(value)) return value.replace(/\.SS$/u, '.SH');
  if (/^\d{6}$/u.test(value)) {
    const exchange = value.startsWith('6') ? 'SH' : /^[03]/u.test(value) ? 'SZ' : /^[48]/u.test(value) ? 'BJ' : null;
    return exchange ? `${value}.${exchange}` : null;
  }
  if (/^\d{6}\.(?:SH|SZ|BJ)$/u.test(value) || /^[A-Z][A-Z0-9.^-]{0,19}$/u.test(value) && !/\.(?:HK|SH|SZ|BJ|SS)$/u.test(value)) return value;
  return null;
}

/** The persisted peer list is authority. Incoming scope/request fields never widen it. */
export function frozenPeerTickers(ticker: string, peers: unknown): string[] {
  if (!Array.isArray(peers) || peers.length > 3) throw new Error('RESEARCH_INVALID_PEERS');
  const primary = canonicalResearchTicker(ticker);
  const normalized = peers.map(canonicalResearchTicker);
  if (!primary || normalized.some((peer, index) => !peer || peer !== peers[index])
    || new Set([primary, ...normalized]).size !== peers.length + 1) throw new Error('RESEARCH_INVALID_PEERS');
  return [ticker, ...peers];
}
