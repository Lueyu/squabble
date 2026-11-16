/**
 * sec-financials.ts — SEC EDGAR companyfacts/submissions JSON 的纯解析函数集。
 *
 * 职责边界：
 *  - 负责：从 SEC 原始 XBRL 事实数据中提取最新 10-Q/10-K/20-F/40-F 申报、
 *  按白名单科目（FIELDS：营收/净利/经营现金流/负债）抽取财务事实，
 *  并组装成 FinnhubFinancialsResult 形态的证据条目（含补充科目与派生 FCF）。
 *  - 不负责：网络请求与缓存（由 sec-evidence.service.ts 负责）；本文件不做任何 IO。
 * 上下游：
 *  - 上游（谁调用这里）：sec-evidence.service.ts（getFinancials 成功后调用
 *    parseSecFinancials；tickers 解析用 secTicker）、evidence.service.ts（类型引用）。
 *  - 下游（本文件调用谁）：finnhub-financials.ts 的 finiteFinnhubNumber 与
 *    FinnhubFinancialsResult 类型（两套数据源共用同一结果形态）。
 * 关键约定：
 *  - 所有值必须来自同一份申报（accession/end/filed/form 全匹配）、同一期末、
 *    同一币种；期间科目对齐到同一 start（380 天内），instant 科目不得带 start。
 *  - 同一申报/上下文内出现互相矛盾的数值时返回 undefined，绝不任选其一。
 *  - 输出字符串（标题/正文/币种单位）为证据层契约，逐字冻结。
 */
import type { FinnhubFinancialsResult } from './finnhub-financials';
import { finiteFinnhubNumber } from './finnhub-financials';

/** 一条申报记录：accession 号、表单类型、报告期末与申报日。 */
interface Filing {
  accession: string;
  form: string;
  end: string;
  filed: string;
}

/** 一条财务事实：数值、币种单位、期间起点与 us-gaap 概念名。 */
interface FinancialFact {
  value: number;
  unit: string;
  start: string;
  concept: string;
}

/** 一个白名单科目：展示名、候选 us-gaap 概念（按优先级）、是否为时点值。 */
interface Field {
  label: string;
  concepts: string[];
  instant?: boolean;
}

// 四个核心科目的候选概念表：靠前的概念优先命中；instant=true 表示资产负债表时点科目
const FIELDS: Field[] = [
  {
    label: 'Revenue',
    concepts: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
    ],
  },
  { label: 'Net income', concepts: ['NetIncomeLoss', 'ProfitLoss'] },
  { label: 'Operating cash flow', concepts: ['NetCashProvidedByUsedInOperatingActivities'] },
  { label: 'Liabilities', concepts: ['Liabilities'], instant: true },
];

/** 宽松收窄：仅当值为非 null、非数组的对象时按 Record 返回，否则 undefined。 */
export function secRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 校验 YYYY-MM-DD 日期串：正则 + UTC 回读一致（防溢出日期如 02-30）。 */
export function secDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const timestamp: number = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

/** 规范化股票代码：大写、点号转连字符；只接受美股普通/类别代码。 */
export function secTicker(value: string): string | undefined {
  const normalized: string = value.toUpperCase().trim().replace('.', '-');
  // 仅限美股普通/类别代码；SEC 不提供港股/A股上市数据。
  return /^[A-Z][A-Z0-9]{0,9}(?:-[A-Z])?$/.test(normalized) ? normalized : undefined;
}

/** 从 submissions.recent 中找出最近一条合规申报（按报告期末、再按申报日倒序取首）。 */
function latestFiling(submissions: Record<string, unknown>): Filing | undefined {
  // recent 区块里 form/accessionNumber/filingDate/reportDate 是等长平行数组
  const recent: Record<string, unknown> | undefined = secRecord(
    secRecord(submissions.filings)?.recent,
  );
  if (!recent || !Array.isArray(recent.form)) return undefined;
  const accessions: unknown[] = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
  const dates: unknown[] = Array.isArray(recent.filingDate) ? recent.filingDate : [];
  const ends: unknown[] = Array.isArray(recent.reportDate) ? recent.reportDate : [];
  // 只扫描前 2000 条，且仅保留四种年报/季报表单、字段全部合规的申报
  const result: Filing[] = [];
  for (let index: number = 0; index < Math.min(recent.form.length, 2000); index++) {
    const form: unknown = recent.form[index];
    if (typeof form !== 'string' || !/^(10-Q|10-K|20-F|40-F)(\/A)?$/.test(form)) continue;
    const accession: unknown = accessions[index];
    const end: string | undefined = secDate(ends[index]);
    const filed: string | undefined = secDate(dates[index]);
    if (typeof accession !== 'string' || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || !end || !filed)
      continue;
    result.push({ accession, form, end, filed });
  }
  return result.sort(
    (left: Filing, right: Filing) =>
      right.end.localeCompare(left.end) || right.filed.localeCompare(left.filed),
  )[0];
}

/** 在指定申报的 XBRL 事实中收集某科目的全部合规事实（单位/期间/数值三重校验）。 */
function fieldFacts(gaap: Record<string, unknown>, field: Field, filing: Filing): FinancialFact[] {
  const result: FinancialFact[] = [];
  // 逐个候选概念尝试，同一概念的 units 按 ISO 4217 三字母币种过滤
  for (const concept of field.concepts) {
    const units: Record<string, unknown> | undefined = secRecord(secRecord(gaap[concept])?.units);
    if (!units) continue;
    for (const [unit, entries] of Object.entries(units)) {
      if (!/^[A-Z]{3}$/.test(unit) || !Array.isArray(entries)) continue;
      // 只看最新 10000 条历史事实；必须精确匹配当前申报的 accession/end/filed/form
      for (const entry of entries.slice(-10000)) {
        const row: Record<string, unknown> | undefined = secRecord(entry);
        if (
          !row ||
          row.accn !== filing.accession ||
          row.end !== filing.end ||
          row.filed !== filing.filed ||
          row.form !== filing.form
        )
          continue;
        // 期间科目必须有合法 start 且不得晚于期末；instant 科目不得携带 start
        const value: number | undefined = finiteFinnhubNumber(row.val);
        const start: string | undefined = field.instant ? '' : secDate(row.start);
        if (value === undefined || start === undefined || start > filing.end) continue;
        if (field.instant && row.start !== undefined) continue;
        // 期间超过 380 天（约跨年）的长期事实剔除，保证期间口径对齐
        if (start && Date.parse(filing.end) - Date.parse(start) > 380 * 86_400_000) continue;
        result.push({ value, unit, start, concept: `us-gaap:${concept}` });
      }
    }
  }
  return result;
}

/** 在同单位同期间的候选事实中取唯一值；数值互相矛盾时返回 undefined。 */
function uniqueFact(
  facts: FinancialFact[],
  unit: string,
  start: string,
): FinancialFact | undefined {
  const candidates: FinancialFact[] = facts.filter(
    (fact: FinancialFact) => fact.unit === unit && (fact.start === start || fact.start === ''),
  );
  if (!candidates.length) return undefined;
  // 同一份申报/上下文里的矛盾数值不做任意取舍。
  return candidates.every((fact: FinancialFact) => fact.value === candidates[0].value)
    ? candidates[0]
    : undefined;
}

/** 补充科目集合：资本开支/现金/权益/资产/毛利/营业利润与派生自由现金流。 */
interface SupplementalFacts {
  capex?: FinancialFact;
  cash?: FinancialFact;
  equity?: FinancialFact;
  assets?: FinancialFact;
  grossProfit?: FinancialFact;
  operatingIncome?: FinancialFact;
  freeCashFlow?: number;
}

/** 读取补充科目并派生 FCF（CFO − 资本开支，非 GAAP 口径）。 */
function supplementalFacts(
  gaap: Record<string, unknown>,
  filing: Filing,
  unit: string,
  start: string,
  operatingCashFlow: FinancialFact | undefined,
): SupplementalFacts {
  // read：按单个概念构造临时 Field 后复用 fieldFacts/uniqueFact 的全部校验
  const read = (concept: string, instant: boolean = false): FinancialFact | undefined =>
    uniqueFact(
      fieldFacts(gaap, { label: concept, concepts: [concept], instant }, filing),
      unit,
      start,
    );
  // 资本开支必须非负才可信；FCF 仅在 CFO 与有效 Capex 同时存在时派生
  const capex: FinancialFact | undefined = read('PaymentsToAcquirePropertyPlantAndEquipment');
  const validCapex: FinancialFact | undefined = capex && capex.value >= 0 ? capex : undefined;
  const freeCashFlow: number | undefined =
    operatingCashFlow && validCapex ? operatingCashFlow.value - validCapex.value : undefined;
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

/** 把补充科目组装成证据条目：现金流量（CFO/Capex/FCF）、资产负债、盈利能力三组。 */
function supplementalItems(
  facts: SupplementalFacts,
  operatingCashFlow: FinancialFact | undefined,
  ticker: string,
  filing: Filing,
  start: string,
  unit: string,
  sourceUrl: string,
): FinnhubFinancialsResult['items'] {
  const items: FinnhubFinancialsResult['items'] = [];
  // 期间口径声明固定写入每条证据正文（may be YTD；非 TTM；未年化）
  const period: string = `Period: ${start || filing.end} to ${filing.end} (may be YTD; not TTM; not annualized).`;
  // add：统一条目形态（role/evidenceType/relevanceScore/标题/正文/来源），正文附申报元数据与命中概念
  const add = (
    label: string,
    content: string,
    sourceFacts: Array<FinancialFact | undefined>,
  ): void => {
    items.push({
      role: 'fundamental',
      evidenceType: 'financial',
      relevanceScore: 0.9,
      title: `${ticker.toUpperCase()} SEC supplemental ${label}`,
      content: `${content} Form: ${filing.form}. Filed: ${filing.filed}. Accession: ${filing.accession}. Source concepts: ${sourceFacts
        .filter((fact: FinancialFact | undefined): fact is FinancialFact => !!fact)
        .map((fact: FinancialFact) => fact.concept)
        .join('; ')}.`,
      sourceName: 'SEC EDGAR',
      sourceUrl,
    });
  };
  if (facts.capex) {
    add(
      'cash flow',
      [
        period,
        ...(operatingCashFlow ? [`CFO: ${unit} ${operatingCashFlow.value}.`] : []),
        `Capex (PP&E cash payments): ${unit} ${facts.capex.value}.`,
        ...(facts.freeCashFlow !== undefined
          ? [
              `Derived FCF (non-GAAP, CFO - capex): ${unit} ${facts.freeCashFlow}.`,
              'Application calculation, not an issuer-defined measure or cash available after all obligations.',
            ]
          : []),
      ].join(' '),
      [operatingCashFlow, facts.capex],
    );
  }
  // 资产负债（时点值，As of 期末）与盈利能力（期间值）两组标签对
  const balance: Array<[string, FinancialFact | undefined]> = [
    ['Cash and cash equivalents', facts.cash],
    ['Stockholders equity (parent)', facts.equity],
    ['Assets', facts.assets],
  ];
  const income: Array<[string, FinancialFact | undefined]> = [
    ['Gross profit', facts.grossProfit],
    ['Operating income', facts.operatingIncome],
  ];
  // 两组统一装配：有任一数值才产出条目，缺值科目静默省略
  for (const [label, prefix, fields] of [
    ['balance sheet', `As of ${filing.end}.`, balance],
    ['profitability', period, income],
  ] as Array<[string, string, Array<[string, FinancialFact | undefined]>]>) {
    const values: string[] = fields.flatMap(([name, fact]: [string, FinancialFact | undefined]) =>
      fact ? [`${name}: ${unit} ${fact.value}.`] : [],
    );
    if (values.length)
      add(
        label,
        `${prefix} ${values.join(' ')}`,
        fields.map((field: [string, FinancialFact | undefined]) => field[1]),
      );
  }
  return items;
}

/** 所有值都来自同一份申报、同一期末与同一币种；期间口径已对齐。 */
export function parseSecFinancials(
  rawFacts: unknown,
  rawSubmissions: unknown,
  ticker: string,
  now: Date = new Date(),
): FinnhubFinancialsResult {
  // 第一步：入口校验——facts/submissions 结构、代码规范化、CIK 数字形态、
  // facts 与 submissions 的 CIK 一致、申报的 tickers 列表须包含目标代码
  const empty: FinnhubFinancialsResult = { items: [], hasStatements: false, missingFields: [] };
  const facts: Record<string, unknown> | undefined = secRecord(rawFacts);
  const submissions: Record<string, unknown> | undefined = secRecord(rawSubmissions);
  const normalized: string | undefined = secTicker(ticker);
  const cik: string = String(submissions?.cik ?? '');
  const tickers: unknown[] = Array.isArray(submissions?.tickers) ? submissions.tickers : [];
  if (
    !facts ||
    !submissions ||
    !normalized ||
    !/^\d{1,10}$/.test(cik) ||
    Number(facts.cik) !== Number(cik) ||
    !tickers.some((value: unknown) => typeof value === 'string' && secTicker(value) === normalized)
  ) {
    return { ...empty, issue: 'invalid_response' };
  }
  // 第二步：选定最新申报并做时间一致性校验（未来申报、期末晚于申报日均拒绝）
  const filing: Filing | undefined = latestFiling(submissions);
  if (!filing) return { ...empty, issue: 'no_data' };
  if (filing.filed > now.toISOString().slice(0, 10) || filing.end > filing.filed) {
    return { ...empty, issue: 'invalid_response' };
  }
  // 季报（10-Q 系）允许 210 天、年报 550 天；超龄按 stale_data 拒绝
  const maxAge: number = filing.form.startsWith('10-Q') ? 210 : 550;
  if (now.getTime() - Date.parse(filing.end) > maxAge * 86_400_000)
    return { ...empty, issue: 'stale_data' };
  // 第三步：抽取核心科目事实；us-gaap 区块缺失时全部科目记缺失
  const gaap: Record<string, unknown> | undefined = secRecord(secRecord(facts.facts)?.['us-gaap']);
  if (!gaap) return { ...empty, missingFields: FIELDS.map((field: Field) => field.label) };
  const candidates: FinancialFact[][] = FIELDS.map((field: Field) =>
    fieldFacts(gaap, field, filing),
  );
  // 第四步：枚举 (币种, 期间起点) 组合，选命中科目数最多的一组；USD 优先
  const units: string[] = [...new Set(candidates.flat().map((fact: FinancialFact) => fact.unit))];
  const starts: string[] = [
    ...new Set(
      candidates
        .flat()
        .map((fact: FinancialFact) => fact.start)
        .filter(Boolean),
    ),
  ];
  let best: Array<FinancialFact | undefined> = [];
  let bestStart: string = '';
  let bestUnit: string = '';
  let bestCount: number = -1;
  for (const unit of units.sort((left: string, right: string) =>
    left === 'USD' ? -1 : right === 'USD' ? 1 : left.localeCompare(right),
  )) {
    for (const start of starts.length ? starts.sort() : ['']) {
      const matched: Array<FinancialFact | undefined> = candidates.map((values: FinancialFact[]) =>
        uniqueFact(values, unit, start),
      );
      const count: number = matched.filter(Boolean).length;
      if (count <= bestCount) continue;
      best = matched;
      bestStart = start;
      bestUnit = unit;
      bestCount = count;
    }
  }
  // 一条都没配齐：返回缺失科目清单
  const missingFields: string[] = FIELDS.filter((_field: Field, index: number) => !best[index]).map(
    (field: Field) => field.label,
  );
  if (bestCount <= 0) return { ...empty, missingFields };
  // 第五步：组装主证据正文（核心科目 + 补充科目摘要）与 EDGAR 索引页链接
  const values: string[] = best.flatMap((fact: FinancialFact | undefined, index: number) =>
    fact
      ? [
          `${FIELDS[index].label}: ${fact.unit} ${fact.value}${index === 2 ? ' (period total)' : ''}`,
        ]
      : [],
  );
  const sourceUrl: string = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${filing.accession.replaceAll('-', '')}/${filing.accession}-index.html`;
  const supplemental: SupplementalFacts = supplementalFacts(
    gaap,
    filing,
    bestUnit,
    bestStart,
    best[2],
  );
  const summary: string[] = [
    ...(supplemental.capex ? [`Capex (PP&E): ${bestUnit} ${supplemental.capex.value}`] : []),
    ...(supplemental.freeCashFlow !== undefined
      ? [`Derived FCF (CFO-capex, non-GAAP): ${bestUnit} ${supplemental.freeCashFlow}`]
      : []),
    ...(supplemental.cash ? [`Cash/equivalents: ${bestUnit} ${supplemental.cash.value}`] : []),
    ...(supplemental.equity ? [`Equity (parent): ${bestUnit} ${supplemental.equity.value}`] : []),
    ...(supplemental.assets ? [`Assets: ${bestUnit} ${supplemental.assets.value}`] : []),
  ];
  return {
    hasStatements: missingFields.length === 0,
    missingFields,
    items: [
      {
        role: 'fundamental',
        evidenceType: 'financial',
        relevanceScore: 0.95,
        title: `${ticker.toUpperCase()} SEC reported financial statements`,
        content: [
          `Period: ${bestStart || filing.end} to ${filing.end} (may be YTD; not TTM; not annualized). ${[...values, ...summary].join('; ')}.`,
          `Liabilities are a balance as of ${filing.end}; income and cash flow cover the stated period (may be YTD), not annualized.`,
          `Form: ${filing.form}. Filed: ${filing.filed}. Accession: ${filing.accession}.`,
          `Source concepts: ${best
            .filter((fact: FinancialFact | undefined): fact is FinancialFact => !!fact)
            .map((fact: FinancialFact) => fact.concept)
            .join('; ')}.`,
        ].join(' '),
        sourceName: 'SEC EDGAR',
        sourceUrl,
      },
      ...supplementalItems(supplemental, best[2], ticker, filing, bestStart, bestUnit, sourceUrl),
    ],
  };
}
