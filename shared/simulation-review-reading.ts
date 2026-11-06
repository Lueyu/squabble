import type { ResearchDocumentSection, ResearchDocumentVersion } from './research-document.interface';
import type { SimulationReview } from './simulation-experiment.interface';
import { readableResearch, readableResearchSection } from './research-reading';

type SavedSimulationReview = Omit<SimulationReview, 'drawdownSampleCount' | 'drawdownCoverage'> & {
  drawdownSampleCount: number | null; drawdownCoverage: SimulationReview['drawdownCoverage'] | null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const decimal = (value: unknown): string | null => typeof value === 'string'
  && /^-?\d+(?:\.\d+)?$/u.test(value) && Number.isFinite(Number(value)) ? value : null;
const count = (value: unknown): number | null => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0 ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item: unknown): item is string => typeof item === 'string').slice(0, 200) : [];
function parsed(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** Older reviews may predate optional benchmark/attribution fields. Missing figures remain unknown. */
function savedReview(value: unknown): SavedSimulationReview | null {
  const data = record(value);
  if (!data || typeof data.accountId !== 'string' || !data.accountId || typeof data.timezone !== 'string'
    || typeof data.from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(data.from)
    || typeof data.to !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(data.to)
    || count(data.orders) === null || decimal(data.feesUsd) === null || !Array.isArray(data.gaps)) return null;
  const contributions: SimulationReview['strategyContributions'] = [];
  if (Array.isArray(data.strategyContributions)) for (const raw of data.strategyContributions.slice(0, 200)) {
    const row = record(raw);
    if (!row || typeof row.title !== 'string' || count(row.version) === null || count(row.orders) === null) continue;
    contributions.push({ mandateId: '', title: readableResearch(row.title), version: Number(row.version),
      from: typeof row.from === 'string' ? row.from : '', to: typeof row.to === 'string' ? row.to : '',
      profitUsd: decimal(row.profitUsd), returnPct: decimal(row.returnPct), orders: Number(row.orders),
      feesUsd: decimal(row.feesUsd) ?? '', gaps: strings(row.gaps) });
  }
  return { accountId: data.accountId, timezone: data.timezone, from: data.from, to: data.to,
    initialEquityUsd: decimal(data.initialEquityUsd), endingEquityUsd: decimal(data.endingEquityUsd),
    profitUsd: decimal(data.profitUsd), returnPct: decimal(data.returnPct),
    buyAndHoldEquityUsd: decimal(data.buyAndHoldEquityUsd), excessReturnPct: decimal(data.excessReturnPct),
    orders: Number(data.orders), feesUsd: String(data.feesUsd), gaps: strings(data.gaps),
    valuationAsOf: typeof data.valuationAsOf === 'string' ? data.valuationAsOf : null,
    indexBenchmarkTicker: typeof data.indexBenchmarkTicker === 'string' ? readableResearch(data.indexBenchmarkTicker) : null,
    indexBenchmarkEquityUsd: decimal(data.indexBenchmarkEquityUsd), indexBenchmarkReturnPct: decimal(data.indexBenchmarkReturnPct),
    indexExcessReturnPct: decimal(data.indexExcessReturnPct), observedMaxDrawdownPct: decimal(data.observedMaxDrawdownPct),
    drawdownSampleCount: count(data.drawdownSampleCount),
    drawdownCoverage: data.drawdownCoverage === 'observed_snapshots_only' || data.drawdownCoverage === 'corporate_action_gap'
      || data.drawdownCoverage === 'insufficient_samples' ? data.drawdownCoverage : null, strategyContributions: contributions };
}

function gapText(gap: string, zh: boolean): string {
  const [code, ...details] = gap.split(':');
  const labels: Record<string, [string, string]> = {
    PERIOD_START_SNAPSHOT_MISSING: ['缺少期初估值，期间收益未知', 'Opening valuation is missing; period returns are unknown'],
    PERIOD_END_SNAPSHOT_MISSING: ['缺少期末估值，期间收益未知', 'Closing valuation is missing; period returns are unknown'],
    MONITOR_OFFLINE_INTERVAL: ['监控曾离线，部分区间未被覆盖', 'Monitoring was offline; part of the period is not covered'],
    STRATEGY_BOUNDARY_VALUATION_MISSING: ['缺少策略版本边界估值，归属收益未知', 'Strategy-boundary valuation is missing; attributed returns are unknown'],
    BENCHMARK_VALUATION_UNAVAILABLE: ['买入持有对照估值缺失', 'Buy-and-hold valuation is unavailable'],
    INDEX_BENCHMARK_VALUATION_UNAVAILABLE: ['指数对照估值缺失', 'Index benchmark valuation is unavailable'],
    CORPORATE_ACTION_RECONCILIATION_REQUIRED: ['公司行动需要核对，受影响收益未知', 'Corporate actions need reconciliation; affected returns are unknown'],
  };
  const label = labels[code]?.[zh ? 0 : 1] ?? readableResearch(code);
  const detail = readableResearch(details.join(':'));
  return `${label}${detail ? ` · ${detail}` : ''}`;
}

function performance(review: SavedSimulationReview, zh: boolean): string {
  const unknown = zh ? '未知' : 'Unknown';
  const money = (value: string | null): string => value ? `${value} ${zh ? '美元' : 'USD'}` : unknown;
  const percent = (value: string | null): string => value ? `${value}%` : unknown;
  const line = (chinese: string, english: string, value: string | number): string =>
    `- ${zh ? chinese : english}${zh ? '：' : ': '}${value}`;
  const coverage = review.drawdownCoverage === 'observed_snapshots_only'
    ? (zh ? '仅覆盖已记录的净值快照' : 'Observed snapshots only') : review.drawdownCoverage === 'corporate_action_gap'
      ? (zh ? '公司行动资料不完整' : 'Corporate-action coverage gap') : review.drawdownCoverage === 'insufficient_samples'
        ? (zh ? '样本不足' : 'Insufficient samples') : unknown;
  const lines: string[] = [
    `${review.from} — ${review.to} · ${readableResearch(review.timezone)}`,
    line('期初净值', 'Opening equity', money(review.initialEquityUsd)),
    line('期末净值', 'Closing equity', money(review.endingEquityUsd)),
    line('期间盈亏', 'Period profit', money(review.profitUsd)), line('期间收益率', 'Period return', percent(review.returnPct)),
    line('成交笔数', 'Fills', review.orders), line('费用', 'Fees', money(review.feesUsd)),
    line('买入持有对照净值', 'Buy-and-hold equity', money(review.buyAndHoldEquityUsd)),
    line('相对买入持有超额收益率', 'Excess return versus buy-and-hold', percent(review.excessReturnPct)),
  ];
  if (review.indexBenchmarkTicker) lines.push(line('指数对照', 'Index benchmark', review.indexBenchmarkTicker),
    line('指数对照净值', 'Index benchmark equity', money(review.indexBenchmarkEquityUsd)),
    line('指数对照收益率', 'Index benchmark return', percent(review.indexBenchmarkReturnPct)),
    line('相对指数超额收益率', 'Excess return versus index', percent(review.indexExcessReturnPct)));
  lines.push(line('已观测最大回撤', 'Observed maximum drawdown', percent(review.observedMaxDrawdownPct)),
    line('回撤样本数', 'Drawdown samples', review.drawdownSampleCount ?? unknown), line('回撤覆盖范围', 'Drawdown coverage', coverage),
    line('最近估值日期', 'Latest valuation date', readableResearch(review.valuationAsOf) || unknown));
  if (review.gaps.length) lines.push(`\n### ${zh ? '数据缺口' : 'Data gaps'}\n`,
    ...review.gaps.map((gap: string): string => `- ${gapText(gap, zh)}`));
  for (const row of review.strategyContributions) lines.push(`\n### ${row.title} · v${row.version}\n`,
    `${readableResearch(row.from)} — ${readableResearch(row.to)}`,
    line('区间账本变化', 'Interval NAV change', money(row.profitUsd)), line('区间收益率', 'Interval return', percent(row.returnPct)),
    line('归属成交', 'Attributed fills', row.orders), line('费用', 'Fees', money(row.feesUsd)),
    ...row.gaps.map((gap: string): string => `- ${gapText(gap, zh)}`));
  return lines.join('\n');
}

function reasons(value: unknown): string[] {
  return Array.isArray(value) ? value.slice(0, 200).map((raw: unknown): string => readableResearch(record(raw)?.reason)).filter(Boolean) : [];
}

function reviewSection(section: ResearchDocumentSection, review: SavedSimulationReview, zh: boolean): string {
  const data = parsed(section.content);
  if (['performance', 'review', 'overview'].includes(section.id)) return performance(review, zh);
  if (section.id === 'execution-limited' && Array.isArray(data)) return reasons(data).map((reason: string): string => `- ${reason}`).join('\n')
    || (zh ? '本期未记录执行受限的决策。' : 'No execution constraints were recorded for this period.');
  const row = record(data);
  if (section.id === 'information-gaps' && row) {
    const lines: string[] = strings(row.gaps).map((gap: string): string => `- ${gapText(gap, zh)}`);
    if (Array.isArray(row.monitorGaps)) for (const raw of row.monitorGaps.slice(0, 200)) {
      const interval = record(raw), from = readableResearch(interval?.from), to = readableResearch(interval?.to);
      if (from && to) lines.push(`- ${zh ? '监控离线区间' : 'Monitoring offline'}: ${from} — ${to}`);
    }
    lines.push(...reasons(row.decisions).map((reason: string): string => `- ${reason}`));
    return lines.join('\n') || (zh ? '本期未记录其他资料缺口。' : 'No additional information gaps were recorded for this period.');
  }
  if (section.id === 'route-attribution' && row && [row.direct, row.ai, row.council].every((value: unknown): boolean => count(value) !== null)) {
    return [`- ${zh ? '直接决策' : 'Direct decisions'}: ${row.direct}`, `- ${zh ? 'AI 决策' : 'AI decisions'}: ${row.ai}`,
      `- ${zh ? '研讨决策' : 'Council decisions'}: ${row.council}`,
      `- ${zh ? '来源策略数' : 'Source strategies'}: ${strings(row.sourcePlans).length}`,
      ...reasons(row.vetoes).map((reason: string): string => `- ${zh ? '否决理由' : 'Veto reason'}: ${reason}`)].join('\n');
  }
  if (section.id === 'thesis-review') {
    const arrayStart = section.content.indexOf('\n[');
    const losing: unknown = arrayStart >= 0 ? parsed(section.content.slice(arrayStart + 1)) : null;
    if (Array.isArray(losing)) {
      const rows: string[] = losing.slice(0, 200).map((raw: unknown): string => {
        const loss = record(raw), ticker = readableResearch(loss?.ticker), value = decimal(loss?.realizedPl);
        return ticker && value ? `- ${ticker}: ${value} ${zh ? '美元' : 'USD'}` : '';
      }).filter(Boolean);
      return [zh ? '亏损本身不能证明原判断错误；需要回看当时假设、价格变化与反证。'
        : 'Loss alone does not establish a wrong thesis. Review the original assumptions, price changes and counter-evidence.', ...rows].join('\n');
    }
  }
  return readableResearchSection(section);
}

/** Project only the server's known simulation-review envelope; never rewrite its archived body or unwrap unrelated JSON. */
export function simulationReviewSections(
  version: Pick<ResearchDocumentVersion, 'kind' | 'source' | 'snapshot' | 'sections'>,
  language: string,
): ResearchDocumentSection[] | null {
  if (version.kind !== 'council' || version.source || !version.snapshot) return null;
  const snapshot = version.snapshot, review = savedReview(snapshot.review);
  if (!review || snapshot.experimentId !== review.accountId || snapshot.from !== review.from || snapshot.to !== review.to) return null;
  const zh = language.startsWith('zh');
  return version.sections.map((section: ResearchDocumentSection): ResearchDocumentSection =>
    ({ ...section, content: reviewSection(section, review, zh) })).filter((section: ResearchDocumentSection): boolean => Boolean(section.content));
}
