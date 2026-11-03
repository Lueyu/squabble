import type { FinnhubFinancialsResult } from './finnhub-financials';
import { finiteFinnhubNumber } from './finnhub-financials';
import { financialMetadata } from './financial-evidence-metadata';

interface Filing {
  accession: string;
  form: string;
  end: string;
  filed: string;
}

interface FinancialFact {
  value: number;
  unit: string;
  start: string;
  concept: string;
}

interface Field {
  label: string;
  concepts: string[];
  instant?: boolean;
}

const FIELDS: Field[] = [
  { label: 'Revenue', concepts: ['RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax', 'Revenues', 'SalesRevenueNet'] },
  { label: 'Net income', concepts: ['NetIncomeLoss', 'ProfitLoss'] },
  { label: 'Operating cash flow', concepts: ['NetCashProvidedByUsedInOperatingActivities'] },
  { label: 'Liabilities', concepts: ['Liabilities'], instant: true },
];

export function secRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function secDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const timestamp: number = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? value : undefined;
}

export function secTicker(value: string): string | undefined {
  const normalized: string = value.toUpperCase().trim().replace('.', '-');
  // US ordinary/class tickers only; SEC is not a source for HK/CN exchange listings.
  return /^[A-Z][A-Z0-9]{0,9}(?:-[A-Z])?$/.test(normalized) ? normalized : undefined;
}

function latestFiling(submissions: Record<string, unknown>): Filing | undefined {
  const recent: Record<string, unknown> | undefined = secRecord(secRecord(submissions.filings)?.recent);
  if (!recent || !Array.isArray(recent.form)) return undefined;
  const accessions: unknown[] = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
  const dates: unknown[] = Array.isArray(recent.filingDate) ? recent.filingDate : [];
  const ends: unknown[] = Array.isArray(recent.reportDate) ? recent.reportDate : [];
  const result: Filing[] = [];
  for (let index: number = 0; index < Math.min(recent.form.length, 2000); index++) {
    const form: unknown = recent.form[index];
    if (typeof form !== 'string' || !/^(10-Q|10-K|20-F|40-F)(\/A)?$/.test(form)) continue;
    const accession: unknown = accessions[index];
    const end: string | undefined = secDate(ends[index]);
    const filed: string | undefined = secDate(dates[index]);
    if (typeof accession !== 'string' || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || !end || !filed) continue;
    result.push({ accession, form, end, filed });
  }
  return result.sort((left: Filing, right: Filing) =>
    right.end.localeCompare(left.end) || right.filed.localeCompare(left.filed))[0];
}

function fieldFacts(gaap: Record<string, unknown>, field: Field, filing: Filing): FinancialFact[] {
  const result: FinancialFact[] = [];
  for (const concept of field.concepts) {
    const units: Record<string, unknown> | undefined = secRecord(secRecord(gaap[concept])?.units);
    if (!units) continue;
    for (const [unit, entries] of Object.entries(units)) {
      if (!/^[A-Z]{3}$/.test(unit) || !Array.isArray(entries)) continue;
      for (const entry of entries.slice(-10000)) {
        const row: Record<string, unknown> | undefined = secRecord(entry);
        if (!row || row.accn !== filing.accession || row.end !== filing.end
          || row.filed !== filing.filed || row.form !== filing.form) continue;
        const value: number | undefined = finiteFinnhubNumber(row.val);
        const start: string | undefined = field.instant ? '' : secDate(row.start);
        if (value === undefined || start === undefined || start > filing.end) continue;
        if (field.instant && row.start !== undefined) continue;
        if (start && Date.parse(filing.end) - Date.parse(start) > 380 * 86_400_000) continue;
        result.push({ value, unit, start, concept: `us-gaap:${concept}` });
      }
    }
  }
  return result;
}

function uniqueFact(facts: FinancialFact[], unit: string, start: string): FinancialFact | undefined {
  const candidates: FinancialFact[] = facts.filter((fact: FinancialFact) =>
    fact.unit === unit && (fact.start === start || fact.start === ''));
  if (!candidates.length) return undefined;
  // Do not arbitrarily choose between conflicting numbers in a single filing/context.
  return candidates.every((fact: FinancialFact) => fact.value === candidates[0].value)
    ? candidates[0] : undefined;
}

interface SupplementalFacts {
  capex?: FinancialFact;
  cash?: FinancialFact;
  equity?: FinancialFact;
  assets?: FinancialFact;
  grossProfit?: FinancialFact;
  operatingIncome?: FinancialFact;
  freeCashFlow?: number;
}

function supplementalFacts(gaap: Record<string, unknown>, filing: Filing, unit: string,
  start: string, operatingCashFlow: FinancialFact | undefined): SupplementalFacts {
  const read = (concept: string, instant: boolean = false): FinancialFact | undefined =>
    uniqueFact(fieldFacts(gaap, { label: concept, concepts: [concept], instant }, filing), unit, start);
  const capex: FinancialFact | undefined = read('PaymentsToAcquirePropertyPlantAndEquipment');
  const validCapex: FinancialFact | undefined = capex && capex.value >= 0 ? capex : undefined;
  const freeCashFlow: number | undefined = operatingCashFlow && validCapex
    ? operatingCashFlow.value - validCapex.value : undefined;
  return {
    capex: validCapex,
    cash: read('CashAndCashEquivalentsAtCarryingValue', true),
    equity: read('StockholdersEquity', true),
    assets: read('Assets', true),
    grossProfit: read('GrossProfit'),
    operatingIncome: read('OperatingIncomeLoss'),
    freeCashFlow: Number.isFinite(freeCashFlow) ? freeCashFlow : undefined,
  };
}

function supplementalItems(facts: SupplementalFacts, operatingCashFlow: FinancialFact | undefined,
  ticker: string, filing: Filing, start: string, unit: string, sourceUrl: string): FinnhubFinancialsResult['items'] {
  const items: FinnhubFinancialsResult['items'] = [];
  const period: string = `Period: ${start || filing.end} to ${filing.end} (may be YTD; not TTM; not annualized).`;
  const add = (label: string, content: string, sourceFacts: Array<FinancialFact | undefined>): void => {
    items.push({ role: 'fundamental', evidenceType: 'financial', relevanceScore: 0.9,
      title: `${ticker.toUpperCase()} SEC supplemental ${label}`,
      content: `${content} Form: ${filing.form}. Filed: ${filing.filed}. Accession: ${filing.accession}. Source concepts: ${sourceFacts
        .filter((fact: FinancialFact | undefined): fact is FinancialFact => !!fact).map((fact: FinancialFact) => fact.concept).join('; ')}.`,
      sourceName: 'SEC EDGAR', sourceUrl,
      metadata: financialMetadata({ ticker, provider: 'SEC EDGAR', sourceUrl, accession: filing.accession,
        filed: filing.filed, end: filing.end, amended: filing.form.endsWith('/A'),
        facts: sourceFacts.filter((fact): fact is FinancialFact => Boolean(fact)) }) });
  };
  if (facts.capex) {
    add('cash flow', [period,
      ...(operatingCashFlow ? [`CFO: ${unit} ${operatingCashFlow.value}.`] : []),
      `Capex (PP&E cash payments): ${unit} ${facts.capex.value}.`,
      ...(facts.freeCashFlow !== undefined ? [`Derived FCF (non-GAAP, CFO - capex): ${unit} ${facts.freeCashFlow}.`,
        'Application calculation, not an issuer-defined measure or cash available after all obligations.'] : []),
    ].join(' '), [operatingCashFlow, facts.capex]);
  }
  const balance: Array<[string, FinancialFact | undefined]> = [
    ['Cash and cash equivalents', facts.cash], ['Stockholders equity (parent)', facts.equity], ['Assets', facts.assets],
  ];
  const income: Array<[string, FinancialFact | undefined]> = [
    ['Gross profit', facts.grossProfit], ['Operating income', facts.operatingIncome],
  ];
  for (const [label, prefix, fields] of [
    ['balance sheet', `As of ${filing.end}.`, balance], ['profitability', period, income],
  ] as Array<[string, string, Array<[string, FinancialFact | undefined]>]>) {
    const values: string[] = fields.flatMap(([name, fact]: [string, FinancialFact | undefined]) => fact
      ? [`${name}: ${unit} ${fact.value}.`] : []);
    if (values.length) add(label, `${prefix} ${values.join(' ')}`, fields.map((field: [string, FinancialFact | undefined]) => field[1]));
  }
  return items;
}

/** All values come from the same filing, period end and currency; durations are aligned. */
export function parseSecFinancials(
  rawFacts: unknown,
  rawSubmissions: unknown,
  ticker: string,
  now: Date = new Date(),
): FinnhubFinancialsResult {
  const empty: FinnhubFinancialsResult = { items: [], hasStatements: false, missingFields: [] };
  const facts: Record<string, unknown> | undefined = secRecord(rawFacts);
  const submissions: Record<string, unknown> | undefined = secRecord(rawSubmissions);
  const normalized: string | undefined = secTicker(ticker);
  const cik: string = String(submissions?.cik ?? '');
  const tickers: unknown[] = Array.isArray(submissions?.tickers) ? submissions.tickers : [];
  if (!facts || !submissions || !normalized || !/^\d{1,10}$/.test(cik)
    || Number(facts.cik) !== Number(cik)
    || !tickers.some((value: unknown) => typeof value === 'string' && secTicker(value) === normalized)) {
    return { ...empty, issue: 'invalid_response' };
  }
  const filing: Filing | undefined = latestFiling(submissions);
  if (!filing) return { ...empty, issue: 'no_data' };
  if (filing.filed > now.toISOString().slice(0, 10) || filing.end > filing.filed) {
    return { ...empty, issue: 'invalid_response' };
  }
  const maxAge: number = filing.form.startsWith('10-Q') ? 210 : 550;
  if (now.getTime() - Date.parse(filing.end) > maxAge * 86_400_000) return { ...empty, issue: 'stale_data' };
  const gaap: Record<string, unknown> | undefined = secRecord(secRecord(facts.facts)?.['us-gaap']);
  if (!gaap) return { ...empty, missingFields: FIELDS.map((field: Field) => field.label) };
  const candidates: FinancialFact[][] = FIELDS.map((field: Field) => fieldFacts(gaap, field, filing));
  const units: string[] = [...new Set(candidates.flat().map((fact: FinancialFact) => fact.unit))];
  const starts: string[] = [...new Set(candidates.flat().map((fact: FinancialFact) => fact.start).filter(Boolean))];
  let best: Array<FinancialFact | undefined> = [];
  let bestStart: string = '';
  let bestUnit: string = '';
  let bestCount: number = -1;
  for (const unit of units.sort((left: string, right: string) => left === 'USD' ? -1 : right === 'USD' ? 1 : left.localeCompare(right))) {
    for (const start of starts.length ? starts.sort() : ['']) {
      const matched: Array<FinancialFact | undefined> = candidates.map((values: FinancialFact[]) => uniqueFact(values, unit, start));
      const count: number = matched.filter(Boolean).length;
      if (count <= bestCount) continue;
      best = matched;
      bestStart = start;
      bestUnit = unit;
      bestCount = count;
    }
  }
  const missingFields: string[] = FIELDS.filter((_field: Field, index: number) => !best[index])
    .map((field: Field) => field.label);
  if (bestCount <= 0) return { ...empty, missingFields };
  const values: string[] = best.flatMap((fact: FinancialFact | undefined, index: number) => fact
    ? [`${FIELDS[index].label}: ${fact.unit} ${fact.value}${index === 2 ? ' (period total)' : ''}`] : []);
  const sourceUrl: string = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${filing.accession.replaceAll('-', '')}/${filing.accession}-index.html`;
  const supplemental: SupplementalFacts = supplementalFacts(gaap, filing, bestUnit, bestStart, best[2]);
  const summary: string[] = [
    ...(supplemental.capex ? [`Capex (PP&E): ${bestUnit} ${supplemental.capex.value}`] : []),
    ...(supplemental.freeCashFlow !== undefined
      ? [`Derived FCF (CFO-capex, non-GAAP): ${bestUnit} ${supplemental.freeCashFlow}`] : []),
    ...(supplemental.cash ? [`Cash/equivalents: ${bestUnit} ${supplemental.cash.value}`] : []),
    ...(supplemental.equity ? [`Equity (parent): ${bestUnit} ${supplemental.equity.value}`] : []),
    ...(supplemental.assets ? [`Assets: ${bestUnit} ${supplemental.assets.value}`] : []),
  ];
  return {
    hasStatements: missingFields.length === 0,
    missingFields,
    items: [{
      role: 'fundamental', evidenceType: 'financial', relevanceScore: 0.95,
      title: `${ticker.toUpperCase()} SEC reported financial statements`,
      content: [`Period: ${bestStart || filing.end} to ${filing.end} (may be YTD; not TTM; not annualized). ${[...values, ...summary].join('; ')}.`,
        `Liabilities are a balance as of ${filing.end}; income and cash flow cover the stated period (may be YTD), not annualized.`,
        `Form: ${filing.form}. Filed: ${filing.filed}. Accession: ${filing.accession}.`,
        `Source concepts: ${best.filter((fact: FinancialFact | undefined): fact is FinancialFact => !!fact)
          .map((fact: FinancialFact) => fact.concept).join('; ')}.`,
      ].join(' '),
      sourceName: 'SEC EDGAR', sourceUrl,
      metadata: financialMetadata({ ticker, provider: 'SEC EDGAR', sourceUrl, accession: filing.accession,
        filed: filing.filed, end: filing.end, amended: filing.form.endsWith('/A'),
        facts: [...best, supplemental.capex, supplemental.cash, supplemental.equity, supplemental.assets]
          .filter((fact): fact is FinancialFact => Boolean(fact)) }),
    }, ...supplementalItems(supplemental, best[2], ticker, filing, bestStart, bestUnit, sourceUrl)],
  };
}
