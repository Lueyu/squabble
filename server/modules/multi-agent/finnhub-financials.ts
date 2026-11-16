/**
 * finnhub-financials.ts — 将 Finnhub financials-reported API（SEC XBRL 数据）解析为统一财报证据。
 *
 * 职责边界：
 *  - 负责：校验原始响应结构、按 ticker/申报日期/表单编号过滤申报记录、
 *    从白名单科目（REQUIRED_FIELDS）提取财务数值，并组装单条 fundamental 证据。
 *  - 不负责：网络请求、缓存与多证据源取舍（分别由 finnhub-evidence.service.ts、
 *    sec-evidence.service.ts、evidence.service.ts 处理）。
 * 上下游：
 *  - 上游（谁调用这里）：finnhub-evidence.service.ts 调用 parseFinnhubFinancials；
 *    sec-financials.ts 复用 finiteFinnhubNumber 与 FinnhubFinancialsResult 类型。
 *  - 下游（本文件调用谁）：evidence.service.ts 的 EvidenceInput 类型（仅类型依赖）。
 * 关键约定：
 *  - 只提取白名单内的具名财务科目，provider 文本无法注入任意证据（既有安全约束）。
 *  - 日期一律按"仅日期"语义以 UTC 解析，与浏览器本地时区无关。
 */
import type { EvidenceInput } from './evidence.service';

/** Finnhub 财报证据的统一结构：证据条目 + 是否有报表 + 缺失字段清单 + 问题码。 */
export interface FinnhubFinancialsResult {
  items: EvidenceInput[];
  hasStatements: boolean;
  missingFields: string[];
  issue?: 'no_data' | 'invalid_response' | 'stale_data';
}

/** 必需科目的定义：所属报表段（ic 利润表 / cf 现金流量表 / bs 资产负债表）+ 展示名 + 候选概念名。 */
interface StatementField {
  section: 'ic' | 'cf' | 'bs';
  label: string;
  concepts: string[];
}

/** 从申报记录中解析出的单个科目值：数值 + 可选币种单位 + 命中的概念名。 */
interface StatementValue {
  value: number;
  unit?: string;
  concept: string;
}

const DAY_MS = 86_400_000;
// 必需科目白名单：每个科目列出可接受的 XBRL 概念名（按优先级排列）。
const REQUIRED_FIELDS: StatementField[] = [
  {
    section: 'ic',
    label: 'Revenue',
    concepts: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
    ],
  },
  { section: 'ic', label: 'Net income', concepts: ['NetIncomeLoss', 'ProfitLoss'] },
  {
    section: 'cf',
    label: 'Operating cash flow',
    concepts: ['NetCashProvidedByUsedInOperatingActivities'],
  },
  { section: 'bs', label: 'Liabilities', concepts: ['Liabilities'] },
];

// 宽松对象守卫：非 null 的纯对象（排除数组）才视为记录
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 供应商时间戳是仅含日期的财务元数据，不是浏览器本地时间；校验并返回 YYYY-MM-DD 日期串。 */
function reportDate(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/.test(value)
  ) {
    return undefined;
  }
  // 截取日期部分并按 UTC 午夜解析，再回读校验，防止解析成相邻日
  const day: string = value.slice(0, 10);
  const timestamp: number = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === day
    ? day
    : undefined;
}

/** 把数字或数字字符串（允许正负号、小数、科学计数法）安全解析为有限数值。 */
export function finiteFinnhubNumber(value: unknown): number | undefined {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' ||
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
  )
    return undefined;
  const number: number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

// 在指定报表段中按候选概念顺序查找科目值：数组段逐行扫描（最多 1000 行），
// 对象段按键直取；单位须为 3 位大写字母（ISO 币种码）才算带单位。
function statementValue(section: unknown, concepts: string[]): StatementValue | undefined {
  for (const concept of concepts) {
    if (Array.isArray(section)) {
      for (const item of section.slice(0, 1000)) {
        const row: Record<string, unknown> | undefined = record(item);
        if (
          !row ||
          ![concept, `us-gaap_${concept}`, `us-gaap:${concept}`].includes(String(row.concept))
        )
          continue;
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

/** 只提取白名单内的具名财务科目；provider 文本无法注入任意证据。 */
export function parseFinnhubFinancials(
  raw: unknown,
  ticker: string,
  frequency: 'quarterly' | 'annual',
  now: Date = new Date(),
): FinnhubFinancialsResult {
  // 校验响应骨架：payload 必须是对象且含非空 data 数组，否则分别判 invalid_response / no_data
  const empty: FinnhubFinancialsResult = { items: [], hasStatements: false, missingFields: [] };
  const payload: Record<string, unknown> | undefined = record(raw);
  if (!payload || !Array.isArray(payload.data)) return { ...empty, issue: 'invalid_response' };
  if (!payload.data.length) return { ...empty, issue: 'no_data' };
  const today: string = now.toISOString().slice(0, 10);

  // 过滤申报记录：最多看 100 条，要求 symbol 匹配（行级优先、payload 兜底）、
  // start ≤ end ≤ filed ≤ today（全部为合法日期）、表单编号符合 EDGAR 格式
  const filings: Record<string, unknown>[] = payload.data
    .slice(0, 100)
    .map((value: unknown) => record(value))
    .filter(
      (value: Record<string, unknown> | undefined): value is Record<string, unknown> => !!value,
    )
    .filter((value: Record<string, unknown>) => {
      const symbol: unknown = value.symbol ?? payload.symbol;
      const start: string | undefined = reportDate(value.startDate);
      const end: string | undefined = reportDate(value.endDate);
      const filed: string | undefined = reportDate(value.filedDate);
      return (
        typeof symbol === 'string' &&
        symbol.toUpperCase() === ticker.toUpperCase() &&
        !!start &&
        !!end &&
        !!filed &&
        start <= end &&
        end <= filed &&
        filed <= today &&
        typeof value.accessNumber === 'string' &&
        /^\d{10}-\d{2}-\d{6}$/.test(value.accessNumber)
      );
    })
    // 按报告期末倒序、再按申报日倒序，保证第一条是最新申报
    .sort(
      (left: Record<string, unknown>, right: Record<string, unknown>) =>
        String(right.endDate).localeCompare(String(left.endDate)) ||
        String(right.filedDate).localeCompare(String(left.filedDate)),
    );

  // 取最新一条申报；一条都筛不出来说明响应内容不可信
  const filing: Record<string, unknown> | undefined = filings[0];
  if (!filing) return { ...empty, issue: 'invalid_response' };

  // 时效校验：季报最长 210 天、年报最长 550 天，超期视为 stale_data
  const end: string = reportDate(filing.endDate)!;
  const maxAgeDays: number = frequency === 'quarterly' ? 210 : 550;
  if (now.getTime() - Date.parse(`${end}T00:00:00Z`) > maxAgeDays * DAY_MS) {
    return { ...empty, issue: 'stale_data' };
  }

  // 逐科目提取数值：缺科目记入 missingFields；缺币种单位或币种不一致也要补报
  const report: Record<string, unknown> | undefined = record(filing.report);
  const values: string[] = [];
  const concepts: string[] = [];
  const missingFields: string[] = [];
  const currencies: Set<string> = new Set();
  let missingUnits: boolean = false;
  for (const field of REQUIRED_FIELDS) {
    const entry: StatementValue | undefined = statementValue(
      report?.[field.section],
      field.concepts,
    );
    if (!entry) {
      missingFields.push(field.label);
      continue;
    }
    if (entry.unit) currencies.add(entry.unit);
    else missingUnits = true;
    // 现金流量可能只是年初至今口径，须在文案中注明
    const periodNote: string = field.section === 'cf' ? ' (may be YTD)' : '';
    values.push(
      `${field.label}: ${entry.unit ?? 'reported units (currency not supplied)'} ${entry.value}${periodNote}`,
    );
    concepts.push(`${field.label}: ${entry.concept}`);
  }
  if (missingUnits) missingFields.push('reported currency units');
  if (currencies.size > 1) missingFields.push('consistent reported currency units');
  if (!values.length) return { ...empty, missingFields };

  // 组装来源信息：CIK 为数字时给 SEC EDGAR 原始链接，否则退回 Finnhub 文档链接；
  // 表单类型须匹配 10-K/10-Q/20-F/40-F（含修订版）才原样展示，否则退回 frequency
  const accession: string = String(filing.accessNumber);
  const cik: string = String(filing.cik ?? payload.cik ?? '');
  const sourceUrl: string = /^\d{1,10}$/.test(cik)
    ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${accession}-index.html`
    : 'https://finnhub.io/docs/api/financials-reported';
  const form: string =
    typeof filing.form === 'string' && /^(10-[KQ]|20-F|40-F)(\/A)?$/.test(filing.form)
      ? filing.form
      : frequency;
  // 输出单条 fundamental 证据（相关性固定 0.9），正文拼接口径说明与来源概念
  return {
    hasStatements: missingFields.length === 0,
    missingFields,
    items: [
      {
        role: 'fundamental',
        evidenceType: 'financial',
        title: `${ticker.toUpperCase()} Finnhub reported financial statements`,
        content: [
          `Period ended: ${end}. ${values.join('; ')}.`,
          `Form: ${form}. Reporting period: ${reportDate(filing.startDate)} to ${end}.`,
          `Filed: ${reportDate(filing.filedDate)}. Accession: ${accession}.`,
          'Values as reported; cash flow may cover the year to date; no annualization or growth estimates.',
          `Source concepts: ${concepts.join('; ')}.`,
        ].join(' '),
        sourceName: 'Finnhub API',
        sourceUrl,
        relevanceScore: 0.9,
      },
    ],
  };
}
