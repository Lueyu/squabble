import { z } from 'zod';
import type { ResearchFinancialValue, ResearchInstrument, ResearchDatasetTiming } from '../../../../shared/research-dataset.interface';
import type { FinancialProviderQuery, FinancialProviderResult } from './financial-provider.interface';

/** Preserve numeric source lexemes before IEEE-754 coercion loses financial precision. */
export function parseFinancialJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value;
    if (context?.source && (!Number.isSafeInteger(value) || /[.eE]/u.test(context.source))) return context.source;
    if (!Number.isSafeInteger(value)) return null;
    return value;
  });
}

const querySchema = z.object({ operation: z.enum(['daily-history', 'trading-calendar', 'financials']),
  market: z.enum(['CN', 'HK', 'US']), exchange: z.string().regex(/^[A-Z][A-Z0-9_-]{1,15}$/u).optional(),
  symbol: z.string().regex(/^[A-Z0-9][A-Z0-9.^-]{0,24}$/u).optional(),
  from: z.string().optional(), to: z.string().optional(),
  adjustment: z.enum(['unadjusted', 'forward', 'backward']).optional() }).strict();
export function validateFinancialQuery(input: FinancialProviderQuery): FinancialProviderQuery {
  const parsed = querySchema.safeParse(input); if (!parsed.success) throw new Error('UNSUPPORTED_OPERATION_OR_PARAMETERS');
  for (const day of [input.from, input.to]) if (day && (!/^\d{4}-\d{2}-\d{2}$/u.test(day) ||
    !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)) throw new Error('INVALID_DATE_RANGE');
  if (!input.from || !input.to || input.from > input.to || Date.parse(input.to) - Date.parse(input.from) > 30 * 366 * 86400000) {
    throw new Error('INVALID_DATE_RANGE');
  }
  if (input.operation !== 'trading-calendar') normalizeInstrument(input);
  return parsed.data as FinancialProviderQuery;
}
export function normalizeInstrument(input: { symbol?: string; market: string; exchange?: string }): ResearchInstrument {
  if (!input.symbol || !input.exchange) throw new Error('EXCHANGE_AND_SYMBOL_REQUIRED');
  const allowed: Record<string, string[]> = { CN: ['SSE', 'SZSE', 'BSE'], HK: ['HKEX'], US: ['NYSE', 'NASDAQ', 'AMEX'] };
  if (!allowed[input.market]?.includes(input.exchange)) throw new Error('EXCHANGE_MARKET_MISMATCH');
  return { id: `${input.exchange}:${input.symbol}`, exchange: input.exchange, symbol: input.symbol, originalSymbol: input.symbol,
    assetType: 'equity', mappingBasis: 'explicit_request_exchange' };
}
export function normalizeFinancialValue(value: unknown, context: Partial<Omit<ResearchFinancialValue, 'value'>> = {}): ResearchFinancialValue {
  const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value)) ? String(value) : null;
  return { value: text !== null && /^-?\d+(?:\.\d+)?$/u.test(text) ? text : null,
    currency: null, unit: null, scale: null, accountingBasis: 'unknown', consolidation: 'unknown',
    periodBasis: 'unknown', valueBasis: 'unknown', ...context };
}
export function unknownTiming(now: string): ResearchDatasetTiming {
  return { observedAt: now, fetchedAt: now, dataAsOf: null, marketDate: null, reportPeriod: null,
    announcedAt: null, availableAt: null, availableAtBasis: null, datePrecision: 'unknown' };
}
function providerDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const day = /^\d{8}$/u.test(value) ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6)}` : value;
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) && Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0,10) === day ? day : null;
}
export function normalizeProviderRows(rows: Record<string, unknown>[], input: FinancialProviderQuery, provider: string,
  operation: string, fetchedAt: string): Record<string, unknown>[] {
  return rows.map(row => {
    const marketDate = providerDay(row.trade_date ?? row['日期'] ?? row.cal_date ?? row.trade_date);
    const reportPeriod = providerDay(row.end_date ?? row.REPORT_DATE?.toString().slice(0,10));
    const announcedAt = providerDay(row.f_ann_date ?? row.ann_date ?? row.NOTICE_DATE?.toString().slice(0,10));
    const currency = row.CURRENCY ?? row.currency, unit = row.UNIT ?? row.unit ?? row['单位'];
    const scale = row.SCALE ?? row.scale;
    return { ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      typeof value === 'number' ? normalizeFinancialValue(value).value : value])),
    _provenance: { provider, operation, instrument: input.operation === 'trading-calendar' ? null : normalizeInstrument(input),
      timing: { ...unknownTiming(fetchedAt), marketDate, reportPeriod, announcedAt,
        availableAt: announcedAt, availableAtBasis: announcedAt ? 'provider_announcement_day' : null,
        datePrecision: marketDate || announcedAt ? 'day' : 'unknown' },
      accountingBasis: ['CAS', 'IFRS', 'US-GAAP'].includes(String(row.accountingBasis)) ? row.accountingBasis : 'unknown',
      consolidation: ['consolidated', 'parent'].includes(String(row.consolidation)) ? row.consolidation : 'unknown',
      periodBasis: ['annual', 'quarter', 'YTD', 'TTM'].includes(String(row.periodBasis)) ? row.periodBasis : 'unknown',
      currency: typeof currency === 'string' && /^[A-Z]{3}$/u.test(currency) ? currency : null,
      unit: typeof unit === 'string' && unit.length <= 40 ? unit : null,
      scale: typeof scale === 'string' && /^\d+(?:\.\d+)?$/u.test(scale) ? scale : null } };
  });
}
export function resultCoverage(rows: Record<string, unknown>[], input: FinancialProviderQuery, expected: number | null,
  missing: string[]): FinancialProviderResult['coverage'] {
  const gaps = [...missing];
  if (!rows.length) gaps.push('NO_DATA');
  if (input.operation === 'trading-calendar') {
    const actual = new Set(rows.flatMap(row => { const day = providerDay(row.cal_date ?? row.trade_date); return day ? [day] : []; }));
    for (let time = Date.parse(input.from!); time <= Date.parse(input.to!); time += 86400000) {
      const day = new Date(time).toISOString().slice(0,10); if (!actual.has(day)) gaps.push(`MISSING_CALENDAR_DAY:${day}`);
    }
  }
  return { status: gaps.length || expected !== null && expected !== rows.length ? 'partial' : 'complete', rowCount: rows.length,
    expectedRowCount: expected, from: input.from ?? null, to: input.to ?? null, missing: [...new Set(gaps)], delayed: null };
}
