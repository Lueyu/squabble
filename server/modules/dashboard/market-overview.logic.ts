/**
 * market-overview.logic.ts — 市场概览的纯函数逻辑：指数定义、上游响应解析、市场情绪计算。
 *
 * 职责边界：
 *  - 只承载无副作用的解析/计算逻辑（不保存可变状态），不发起网络请求、不读数据库。
 *  - 与用户数据无关，输出可被 MarketOverviewService 直接缓存复用。
 * 上下游：
 *  - 上游：MarketOverviewService 调用 parseIndexQuote / calculateMarketMood，并复用 INDEX_DEFINITIONS。
 *  - 下游：无外部调用（纯逻辑，仅依赖 @shared 类型）。
 * 关键约定：
 *  - 腾讯行情响应格式：v_<symbol>="..."，字段以 '~' 分隔；
 *    fields[3] = 当前点位，fields[4] = 前收，fields[30] = 行情时间。
 *  - 行情时间须匹配 'YYYY-MM-DD HH:mm:ss'，并以 UTC 语义解析（'T' + 'Z' 拼接后做往返校验）。
 *  - 时效窗口：行情日期距今超过 7 天（7 * 86_400_000）或晚于当前时间 1 天以上
 *    （-86_400_000）判定为 outdated——休市/长假不当作实时值。
 *  - 市场情绪：同一市场取最近 sessionDate 的可用指数，至少 2 个才计算平均涨跌幅；
 *    score = round(clamp(50 + 20 * 平均涨跌幅, 0, 100))，method = 'index_daily_change_v1'。
 */
import type { Market, MarketIndexQuote, MarketMood } from '@shared/api.interface';

export interface IndexDefinition {
  id: string;
  symbol: string;
  market: Market;
  timeZone: string;
}

/** 显式列出指数代码，避免被 QuoteService 的个股 ticker 启发式规则误判。 */
export const INDEX_DEFINITIONS: readonly IndexDefinition[] = [
  { id: 'sp500', symbol: 'us.INX', market: 'US', timeZone: 'America/New_York' },
  { id: 'nasdaq', symbol: 'us.IXIC', market: 'US', timeZone: 'America/New_York' },
  { id: 'dow', symbol: 'us.DJI', market: 'US', timeZone: 'America/New_York' },
  { id: 'hsi', symbol: 'hkHSI', market: 'HK', timeZone: 'Asia/Hong_Kong' },
  { id: 'hstech', symbol: 'hkHSTECH', market: 'HK', timeZone: 'Asia/Hong_Kong' },
  { id: 'sse', symbol: 'sh000001', market: 'CN', timeZone: 'Asia/Shanghai' },
  { id: 'csi300', symbol: 'sh000300', market: 'CN', timeZone: 'Asia/Shanghai' },
  { id: 'szse', symbol: 'sz399001', market: 'CN', timeZone: 'Asia/Shanghai' },
];

// 解析上游行情时间：兼容 YYYYMMDDHHMMSS 与斜杠日期两种格式，归一化后严格校验。
function providerTime(raw: string): string | null {
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]}:${compact[6]}`
    : raw.replaceAll('/', '-');
  // 不是标准 'YYYY-MM-DD HH:mm:ss' 形态的直接判为无效。
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) return null;
  // 以 UTC 语义解析并做往返校验，拦住不存在的时间串（如 2 月 30 日）。
  const date = new Date(`${normalized.replace(' ', 'T')}Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 19) !== normalized.replace(' ', 'T')
  )
    return null;
  return normalized;
}

// 解析单个指数的行情：缺失/无效字段一律返回 status: 'unavailable' 的占位结构。
export function parseIndexQuote(
  body: string,
  definition: IndexDefinition,
  now: Date,
): MarketIndexQuote {
  // 先构造该指数的"不可用"占位结构，解析成功时在其上展开覆盖。
  const missing: MarketIndexQuote = {
    id: definition.id,
    market: definition.market,
    value: null,
    change: null,
    changePercent: null,
    quoteTime: null,
    sessionDate: null,
    timeZone: definition.timeZone,
    retrievedAt: null,
    source: 'Tencent',
    status: 'unavailable',
    issue: 'invalid_quote',
  };
  // 在响应体中定位该指数的原始字段串（正则需转义 symbol 中的特殊字符）。
  const escaped = definition.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matched = new RegExp(`v_${escaped}="([^"]*)"`).exec(body);
  if (!matched) return missing;
  // 按 '~' 拆字段：3 = 当前点位，4 = 前收，30 = 行情时间。
  const fields = matched[1].split('~');
  const value = Number(fields[3]);
  const previous = Number(fields[4]);
  const quoteTime = providerTime(fields[30] ?? '');
  // 点位与前收必须是正数且行情时间有效，否则视为不可用。
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isFinite(previous) ||
    previous <= 0 ||
    !quoteTime
  )
    return missing;
  // 以行情日期评估时效：过旧（>7 天）或来自未来（>1 天）都判为 outdated。
  const sessionDate = quoteTime.slice(0, 10);
  const dateAge = now.getTime() - Date.parse(`${sessionDate}T00:00:00Z`);
  // 长假/休市期间上游仍会返回最后一次行情的实际日期。
  // 不得把过旧的快照当作实时值，也不得让它参与当前的市场情绪计算。
  const outdated = dateAge > 7 * 86_400_000 || dateAge < -86_400_000;
  return {
    ...missing,
    value,
    change: Number((value - previous).toFixed(4)),
    changePercent: Number(((value / previous - 1) * 100).toFixed(4)),
    quoteTime,
    sessionDate,
    retrievedAt: now.toISOString(),
    status: outdated ? 'stale' : 'available',
    issue: outdated ? 'outdated_quote' : null,
  };
}

// 计算单个市场的情绪：取最近 sessionDate 的可用指数求平均涨跌幅并映射到 0-100 分。
export function calculateMarketMood(market: Market, quotes: MarketIndexQuote[]): MarketMood {
  // 筛选该市场当前可用（available、涨跌幅有限且带 sessionDate）的指数。
  const available = quotes.filter(
    (quote) =>
      quote.market === market &&
      quote.status === 'available' &&
      quote.changePercent !== null &&
      Number.isFinite(quote.changePercent) &&
      quote.sessionDate,
  );
  // 会话日期取可用指数中最大的 sessionDate，只统计"最近一个交易日"的报价。
  const sessionDate =
    available
      .map((quote) => quote.sessionDate as string)
      .sort()
      .at(-1) ?? null;
  const current = available.filter((quote) => quote.sessionDate === sessionDate);
  const total = INDEX_DEFINITIONS.filter((definition) => definition.market === market).length;
  // 至少覆盖 2 个指数才计算平均涨跌幅，否则记为 null（不给出情绪分）。
  const average =
    current.length >= 2
      ? current.reduce((sum, quote) => sum + (quote.changePercent ?? 0), 0) / current.length
      : null;
  return {
    market,
    sessionDate,
    total,
    covered: current.length,
    method: 'index_daily_change_v1',
    averageChangePercent: average === null ? null : Number(average.toFixed(4)),
    score: average === null ? null : Math.round(Math.max(0, Math.min(100, 50 + 20 * average))),
  };
}
