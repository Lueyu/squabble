/**
 * trading-cadence.ts — 交易节律（cadence）纯函数工具集。
 *
 * 职责边界：
 *  - 提供 cadence 配置校验/规范化、市场本地日期、交易日间隔计算、
 *    评审到期判定与周度下单频控判定；全部为纯函数，无数据库访问。
 * 上下游：
 *  - 上游（谁调用本文件）：AgentBuilderService（校验配置）、BuilderCadenceService（claimReview 节流）、
 *    paper-trading 的下单/护栏链路（cadenceRejection）。
 *  - 下游（本文件调用谁）：仅依赖 shared 类型（Market、TradingCadence）与标准库。
 * 关键约定：
 *  - 市场本地日期用各市场 IANA 时区计算，格式 YYYY-MM-DD。
 *  - 交易日只排除周六/周日，不接入交易所节假日日历（与 app 的 market clock 行为一致）。
 *  - 周度频控以"账户维度滚动 7 天"计，pending_approval 的订单也占额度，
 *    因此切换市场不能绕开上限。
 *  - notionalUsd / equityUsd 均为美元数值（number，非分、非字符串）。
 */
import type { Market } from '../../../shared/api.interface';
import type { TradingCadence } from '../../../shared/council.interface';

/** cadence 缺省值：每 5 个交易日评审、每周至多 2 单、冷却 3 个交易日、周换手 10%。 */
export const DEFAULT_CADENCE: TradingCadence = {
  reviewEveryTradingDays: 5,
  maxOrdersPerWeek: 2,
  cooldownTradingDays: 3,
  maxWeeklyTurnoverPct: 10,
};
/** 各市场对应的 IANA 时区。 */
const ZONES: Record<Market, string> = {
  US: 'America/New_York',
  HK: 'Asia/Hong_Kong',
  CN: 'Asia/Shanghai',
};

/**
 * normalizeCadence — 校验并规范化 cadence 配置（未传入则用默认值）。
 *
 * 整数字段必须在各自区间内，否则抛错；周换手必须是 0.1–100 之间的有限数值。
 *
 * @param input 可选的原始 TradingCadence。
 * @returns 规范化后的 TradingCadence（仅含四个 cadence 字段）。
 * @throws Error 当任何整数字段越界（`Invalid <key>`）或换手百分比越界时。
 */
export function normalizeCadence(input?: TradingCadence): TradingCadence {
  const value = input ?? DEFAULT_CADENCE;
  // 整数字段逐一校验上下限。
  for (const [key, min, max] of [
    ['reviewEveryTradingDays', 1, 60],
    ['maxOrdersPerWeek', 1, 20],
    ['cooldownTradingDays', 0, 60],
  ] as const) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
      throw new Error(`Invalid ${key}`);
  }
  // 周换手为百分比数值（0.1 表示 0.1%），必须落在 0.1–100。
  if (
    !Number.isFinite(value.maxWeeklyTurnoverPct) ||
    value.maxWeeklyTurnoverPct < 0.1 ||
    value.maxWeeklyTurnoverPct > 100
  ) {
    throw new Error('Weekly turnover must be between 0.1 and 100%');
  }
  return {
    reviewEveryTradingDays: value.reviewEveryTradingDays,
    maxOrdersPerWeek: value.maxOrdersPerWeek,
    cooldownTradingDays: value.cooldownTradingDays,
    maxWeeklyTurnoverPct: value.maxWeeklyTurnoverPct,
  };
}

/**
 * marketDate — 把时刻换算成指定市场的本地日期（YYYY-MM-DD 字符串）。
 *
 * @param market 市场（决定时区）。
 * @param now    要换算的时刻，缺省当前时间。
 * @returns 该时区下的本地日期字符串。
 */
export function marketDate(market: Market, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONES[market],
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * elapsedTradingDays — 计算 from 到 to 之间的交易日数（含 to、不含 from）。
 *
 * 与 app 的 market clock 口径一致：仅排除周六/周日，不考虑交易所节假日。
 * from ≥ to 或任一日期非法时返回 0。
 *
 * @param from 起始日期 YYYY-MM-DD。
 * @param to   结束日期 YYYY-MM-DD。
 * @returns 交易日数。
 */
export function elapsedTradingDays(from: string, to: string): number {
  // 用正午 12:00 UTC 锚定，避免时区偏移把日期推到相邻日。
  const cursor = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime()) || cursor >= end)
    return 0;
  let count = 0;
  // 超过一年的日期区间必然超过任何可配置的冷却天数，直接返回 260。
  if (end.getTime() - cursor.getTime() > 366 * 86400000) return 260;
  // 逐日推进，跳过周六（6）与周日（0）。
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) count += 1;
  }
  return count;
}

/**
 * reviewDue — 判定是否需要进行一次新的候选评审。
 *
 * 首次评审（无历史）、输入哈希变化、或距上次评审已满 days 个交易日，三者其一即到期。
 *
 * @param oldHash  上次评审的输入哈希（无历史为 null）。
 * @param newHash  本次输入哈希。
 * @param lastDate 上次评审的本地日期（无历史为 null）。
 * @param today    今天的市场本地日期。
 * @param days     评审间隔（交易日数）。
 * @returns 是否到期需要评审。
 */
export function reviewDue(
  oldHash: string | null,
  newHash: string,
  lastDate: string | null,
  today: string,
  days: number,
): boolean {
  return !lastDate || oldHash !== newHash || elapsedTradingDays(lastDate, today) >= days;
}

/** 参与频控统计的订单快照（notionalUsd 为美元数值）。 */
export interface CadenceOrder {
  ticker: string;
  market: Market;
  createdAt: Date;
  status: string;
  notionalUsd: number;
}

/**
 * cadenceRejection — 按账户锁定台账对订单做节律判定。
 *
 * 依据已成交（filled）与待审批（pending_approval）订单评估三条规则，
 * 任一命中即返回对应拒绝码，全部通过返回 null：
 *  - weekly_order_cap：滚动 7 天内订单数达到 maxOrdersPerWeek；
 *  - weekly_turnover：7 天内名义金额 + 本单超过 equity 的 maxWeeklyTurnoverPct；
 *  - ticker_cooldown：同标的上一单距今不满 cooldownTradingDays 个交易日。
 *
 * 注意：必须以账户的锁定台账为准评估，pending 订单同样占用额度。
 *
 * @param config  cadence 配置。
 * @param context 订单上下文（标的、市场、本单名义金额、账户净值、订单台账、可选当前时刻）。
 * @returns 拒绝码字符串；无违规返回 null。
 */
export function cadenceRejection(
  config: TradingCadence,
  context: {
    ticker: string;
    market: Market;
    notionalUsd: number;
    equityUsd: number;
    orders: CadenceOrder[];
    now?: Date;
  },
): string | null {
  const now = context.now ?? new Date();
  const today = marketDate(context.market, now);
  // 台账中已成交 + 待审批的订单才算"已占用"。
  const committed = context.orders.filter(
    (order) => order.status === 'filled' || order.status === 'pending_approval',
  );
  // 账户维度的滚动 7 天上限：切换市场也无法重置。
  const week = committed.filter(
    (order) =>
      order.status === 'pending_approval' ||
      order.createdAt.getTime() > now.getTime() - 7 * 86400000,
  );
  if (week.length >= config.maxOrdersPerWeek) return 'weekly_order_cap';
  if (!Number.isFinite(context.equityUsd) || context.equityUsd <= 0) return 'equity_unavailable';
  // 换手累计只计正数名义金额，容差 1e-6 吸收浮点误差。
  const turnover = week.reduce((sum, order) => sum + Math.max(0, order.notionalUsd), 0);
  if (
    turnover + context.notionalUsd >
    (context.equityUsd * config.maxWeeklyTurnoverPct) / 100 + 0.000001
  )
    return 'weekly_turnover';
  // 同标的最近一单的冷却检查（忽略大小写比较代码）。
  const last = committed
    .filter((order) => order.ticker.toUpperCase() === context.ticker.toUpperCase())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (
    last &&
    elapsedTradingDays(marketDate(context.market, last.createdAt), today) <
      config.cooldownTradingDays
  )
    return 'ticker_cooldown';
  return null;
}
