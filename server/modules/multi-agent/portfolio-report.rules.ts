import type {
  PortfolioHoldingJudgment,
  PortfolioHoldingStance,
  PortfolioReport,
  PortfolioReportSnapshot,
} from '../../../shared/portfolio-report.interface';

const REPORT_KEYS = ['summary', 'allocationRisks', 'actions', 'uncertainties', 'holdings'];
const JUDGMENT_KEYS = ['ticker', 'stance', 'rationale', 'evidenceRefs', 'triggers'];
const STANCES = new Set<PortfolioHoldingStance>(['add', 'hold', 'reduce', 'exit', 'watch']);
const HOLDING_FACTS = ['shares', 'currentPrice', 'costPrice', 'marketValueUsd', 'weightPct'] as const;
const PORTFOLIO_FACTS = ['cashUsd', 'totalValueUsd'] as const;
const MAX_HOLDINGS = 100;
const MAX_JSON_CHARS = 64_000;

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || Object.keys(result).some((key) => !keys.includes(key))) {
    throw new Error(`${label} has an unsupported or missing field`);
  }
  return result;
}

function safeText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be nonempty text within length limit ${maxLength}`);
  }
  const text = value.trim();
  // The UI renders prose as text. Background links are not fetched or promoted
  // to evidence; rejecting all links would discard otherwise complete research.
  if (/(?:mailto|javascript|data):/iu.test(text)) {
    throw new Error(`${label} contains an unsafe URL`);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"\u3000-\u303f\uff00-\uffef]+/giu)) {
    let url: URL;
    try { url = new URL(match[0]); } catch { throw new Error(`${label} contains an invalid URL`); }
    if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|api[_-]?key|authorization|secret|password|signature/iu.test(key))) {
      throw new Error(`${label} contains a credential-bearing URL`);
    }
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) {
    throw new Error(`${label} contains control characters`);
  }
  return text;
}

function textList(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} exceeds array length limit ${maxItems}`);
  }
  return value.map((item, index) => safeText(item, `${label}[${index}]`, maxLength));
}

/** Only present, finite snapshot numbers may be cited as evidence. */
export function portfolioSnapshotEvidenceRefs(snapshot: PortfolioReportSnapshot): string[] {
  const refs: string[] = [];
  for (const field of PORTFOLIO_FACTS) {
    if (typeof snapshot[field] === 'number' && Number.isFinite(snapshot[field])) refs.push(`portfolio:${field}`);
  }
  for (const holding of snapshot.holdings) {
    for (const field of HOLDING_FACTS) {
      if (typeof holding[field] === 'number' && Number.isFinite(holding[field])) {
        refs.push(`holding:${holding.ticker}:${field}`);
      }
    }
  }
  return refs;
}

/** Validate one model reply against the exact frozen holdings, never as a trading instruction. */
export function parsePortfolioReport(raw: string, snapshot: PortfolioReportSnapshot): PortfolioReport {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_JSON_CHARS) {
    throw new Error('Portfolio report JSON exceeds length limit or is empty');
  }
  if (!Array.isArray(snapshot.holdings) || snapshot.holdings.length === 0 || snapshot.holdings.length > MAX_HOLDINGS) {
    throw new Error('Portfolio snapshot holding count is invalid');
  }
  const tickers = new Set<string>();
  for (const holding of snapshot.holdings) {
    if (!/^[A-Z0-9.^][A-Z0-9.^/_-]{0,19}$/u.test(holding.ticker) || tickers.has(holding.ticker)) {
      throw new Error('Portfolio snapshot ticker is invalid or duplicated');
    }
    tickers.add(holding.ticker);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Portfolio report must be valid JSON');
  }
  const value = record(parsed, 'Portfolio report', REPORT_KEYS);
  const summary = safeText(value.summary, 'summary', 2_000);
  const allocationRisks = textList(value.allocationRisks, 'allocationRisks', 20, 600);
  const actions = textList(value.actions, 'actions', 20, 600);
  const uncertainties = textList(value.uncertainties, 'uncertainties', 20, 600);
  if (!Array.isArray(value.holdings) || value.holdings.length !== snapshot.holdings.length) {
    throw new Error('Portfolio report must include one judgment per holding');
  }
  const allowedRefs = new Set(portfolioSnapshotEvidenceRefs(snapshot));
  const seen = new Set<string>();
  const judgments: PortfolioHoldingJudgment[] = value.holdings.map((item: unknown) => {
    const judgment = record(item, 'Holding judgment', JUDGMENT_KEYS);
    const ticker = judgment.ticker;
    if (typeof ticker !== 'string' || !tickers.has(ticker)) {
      throw new Error('Portfolio report contains a foreign ticker');
    }
    if (seen.has(ticker)) throw new Error('Portfolio report contains a duplicate ticker');
    seen.add(ticker);
    if (typeof judgment.stance !== 'string' || !STANCES.has(judgment.stance as PortfolioHoldingStance)) {
      throw new Error(`Holding ${ticker} has an unsupported stance`);
    }
    const rationale = safeText(judgment.rationale, `${ticker} rationale`, 1_200);
    const triggers = textList(judgment.triggers, `${ticker} triggers`, 10, 500);
    if (!Array.isArray(judgment.evidenceRefs) || judgment.evidenceRefs.length === 0 || judgment.evidenceRefs.length > 12) {
      throw new Error(`Holding ${ticker} needs bounded evidence references`);
    }
    const evidenceRefs = judgment.evidenceRefs.map((ref: unknown) => {
      if (typeof ref !== 'string' || !allowedRefs.has(ref)) {
        throw new Error(`Holding ${ticker} cites unsupported evidence`);
      }
      return ref;
    });
    if (new Set(evidenceRefs).size !== evidenceRefs.length) {
      throw new Error(`Holding ${ticker} has duplicate evidence references`);
    }
    if (!evidenceRefs.some((ref) => ref.startsWith(`holding:${ticker}:`))) {
      throw new Error(`Holding ${ticker} needs its own evidence`);
    }
    return { ticker, stance: judgment.stance as PortfolioHoldingStance, rationale, evidenceRefs, triggers };
  });
  if (seen.size !== tickers.size) throw new Error('Portfolio report is missing a holding judgment');
  return {
    summary, allocationRisks, actions, uncertainties, holdings: judgments,
    dataGaps: snapshot.gaps.slice(),
  };
}
