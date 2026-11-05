import type { EvidenceInput } from './evidence.service';
import { financialMetadata } from './financial-evidence-metadata';

export interface FinnhubFinancialsResult {
  items: EvidenceInput[];
  hasStatements: boolean;
  missingFields: string[];
  issue?: 'no_data' | 'invalid_response' | 'stale_data';
}

interface StatementField {
  section: 'ic' | 'cf' | 'bs';
  label: string;
  concepts: string[];
}

interface StatementValue {
  value: number;
  unit?: string;
  concept: string;
}

const DAY_MS = 86_400_000;
const REQUIRED_FIELDS: StatementField[] = [
  { section: 'ic', label: 'Revenue', concepts: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax', 'Revenues', 'SalesRevenueNet',
  ] },
  { section: 'ic', label: 'Net income', concepts: ['NetIncomeLoss', 'ProfitLoss'] },
  { section: 'cf', label: 'Operating cash flow', concepts: ['NetCashProvidedByUsedInOperatingActivities'] },
  { section: 'bs', label: 'Liabilities', concepts: ['Liabilities'] },
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Provider timestamps are date-only financial metadata, not browser-local times. */
function reportDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/.test(value)) {
    return undefined;
  }
  const day: string = value.slice(0, 10);
  const timestamp: number = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === day
    ? day : undefined;
}

export function finiteFinnhubNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string'
    || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) return undefined;
  const number: number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function statementValue(section: unknown, concepts: string[]): StatementValue | undefined {
  for (const concept of concepts) {
    if (Array.isArray(section)) {
      for (const item of section.slice(0, 1000)) {
        const row: Record<string, unknown> | undefined = record(item);
        if (!row || ![concept, `us-gaap_${concept}`, `us-gaap:${concept}`].includes(String(row.concept))) continue;
        const value: number | undefined = finiteFinnhubNumber(row.value);
        if (value === undefined) continue;
        const rawUnit: string = typeof row.unit === 'string' ? row.unit.toUpperCase() : '';
        const unit: string | undefined = /^[A-Z]{3}$/.test(rawUnit) ? rawUnit : undefined;
        return { value, unit, concept: String(row.concept) };
      }
    } else {
      const values: Record<string, unknown> | undefined = record(section);
      const value: number | undefined = finiteFinnhubNumber(values?.[concept]);
      if (value !== undefined) return { value, concept };
    }
  }
  return undefined;
}

/** Extract only named financial concepts; provider text cannot inject arbitrary evidence. */
export function parseFinnhubFinancials(
  raw: unknown,
  ticker: string,
  frequency: 'quarterly' | 'annual',
  now: Date = new Date(),
): FinnhubFinancialsResult {
  const empty: FinnhubFinancialsResult = { items: [], hasStatements: false, missingFields: [] };
  const payload: Record<string, unknown> | undefined = record(raw);
  if (!payload || !Array.isArray(payload.data)) return { ...empty, issue: 'invalid_response' };
  if (!payload.data.length) return { ...empty, issue: 'no_data' };
  const today: string = now.toISOString().slice(0, 10);
  const filings: Record<string, unknown>[] = payload.data.slice(0, 100)
    .map((value: unknown) => record(value))
    .filter((value: Record<string, unknown> | undefined): value is Record<string, unknown> => !!value)
    .filter((value: Record<string, unknown>) => {
      const symbol: unknown = value.symbol ?? payload.symbol;
      const start: string | undefined = reportDate(value.startDate);
      const end: string | undefined = reportDate(value.endDate);
      const filed: string | undefined = reportDate(value.filedDate);
      return typeof symbol === 'string' && symbol.toUpperCase() === ticker.toUpperCase()
        && !!start && !!end && !!filed && start <= end && end <= filed && filed <= today
        && typeof value.accessNumber === 'string' && /^\d{10}-\d{2}-\d{6}$/.test(value.accessNumber);
    })
    .sort((left: Record<string, unknown>, right: Record<string, unknown>) =>
      String(right.endDate).localeCompare(String(left.endDate))
      || String(right.filedDate).localeCompare(String(left.filedDate)));
  const filing: Record<string, unknown> | undefined = filings[0];
  if (!filing) return { ...empty, issue: 'invalid_response' };
  const end: string = reportDate(filing.endDate)!;
  const maxAgeDays: number = frequency === 'quarterly' ? 210 : 550;
  if (now.getTime() - Date.parse(`${end}T00:00:00Z`) > maxAgeDays * DAY_MS) {
    return { ...empty, issue: 'stale_data' };
  }

  const report: Record<string, unknown> | undefined = record(filing.report);
  const values: string[] = [];
  const concepts: string[] = [];
  const typed: Array<StatementValue & { start: string | null }> = [];
  const missingFields: string[] = [];
  const currencies: Set<string> = new Set();
  let missingUnits: boolean = false;
  for (const field of REQUIRED_FIELDS) {
    const entry: StatementValue | undefined = statementValue(report?.[field.section], field.concepts);
    if (!entry) {
      missingFields.push(field.label);
      continue;
    }
    if (entry.unit) currencies.add(entry.unit);
    else missingUnits = true;
    const periodNote: string = field.section === 'cf' ? ' (may be YTD)' : '';
    values.push(`${field.label}: ${entry.unit ?? 'reported units (currency not supplied)'} ${entry.value}${periodNote}`);
    concepts.push(`${field.label}: ${entry.concept}`);
    typed.push({ ...entry, start: field.section === 'bs' ? '' : field.section === 'cf' ? null : reportDate(filing.startDate)! });
  }
  if (missingUnits) missingFields.push('reported currency units');
  if (currencies.size > 1) missingFields.push('consistent reported currency units');
  if (!values.length) return { ...empty, missingFields };

  const accession: string = String(filing.accessNumber);
  const cik: string = String(filing.cik ?? payload.cik ?? '');
  const sourceUrl: string = /^\d{1,10}$/.test(cik)
    ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${accession}-index.html`
    : 'https://finnhub.io/docs/api/financials-reported';
  const form: string = typeof filing.form === 'string' && /^(10-[KQ]|20-F|40-F)(\/A)?$/.test(filing.form)
    ? filing.form : frequency;
  return {
    hasStatements: missingFields.length === 0,
    missingFields,
    items: [{
      role: 'fundamental', evidenceType: 'financial',
      title: `${ticker.toUpperCase()} Finnhub reported financial statements`,
      content: [
        `Period ended: ${end}. ${values.join('; ')}.`,
        `Form: ${form}. Reporting period: ${reportDate(filing.startDate)} to ${end}.`,
        `Filed: ${reportDate(filing.filedDate)}. Accession: ${accession}.`,
        'Values as reported; cash flow may cover the year to date; no annualization or growth estimates.',
        `Source concepts: ${concepts.join('; ')}.`,
      ].join(' '),
      sourceName: 'Finnhub API', sourceUrl, relevanceScore: 0.9,
      metadata: financialMetadata({ ticker, provider: 'Finnhub API', sourceUrl, accession,
        filed: reportDate(filing.filedDate)!, end, amended: form.endsWith('/A'), facts: typed }),
    }],
  };
}
