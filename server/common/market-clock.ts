/**
 * @file server/common/market-clock.ts
 * @description 市场交易时段时钟（服务端）。
 *
 * 职责边界：判断给定时刻三个市场（US/HK/CN）是否处于连续交易时段；
 * 不做行情抓取、不处理节假日日历。
 *
 * 上下游：import 共享类型 Market（@shared/api.interface）；被行情相关
 * 服务/任务调用，用于"闭市时不触发轮询/推送"之类的节流判断。
 *
 * 关键约定（从代码读出）：
 * - 时段窗口与客户端定义保持一致（use-market-quotes.ts）：
 *   US 09:30–16:00 America/New_York · HK 09:30–12:00 / 13:00–16:00
 *   Asia/Hong_Kong · CN 09:30–11:30 / 13:00–15:00 Asia/Shanghai；
 * - 周末（周六/周日，按市场本地墙钟）一律闭市；HK/CN 午休时段视为闭市；
 *   美股节假日不处理（免费自托管 bot 容忍该近似）；
 * - 时段用"市场本地一天的分钟数"表示，判定为左闭右开 [start, end)；
 * - 墙钟解析用 Intl + 显式 IANA 时区，不依赖宿主机时区设置。
 */
import type { Market } from '@shared/api.interface';

/** 一个交易时段，用市场本地"一天内分钟数"表示边界。 */
interface SessionWindow {
  start: number;
  end: number;
}

// 各市场对应的 IANA 时区（与上方文件头约定一致）。
const MARKET_TIMEZONES: Record<Market, string> = {
  US: 'America/New_York',
  HK: 'Asia/Hong_Kong',
  CN: 'Asia/Shanghai',
};

// 各市场的连续交易时段（分钟数为市场本地时间，9*60+30 = 09:30，以此类推）。
const MARKET_SESSIONS: Record<Market, SessionWindow[]> = {
  US: [{ start: 9 * 60 + 30, end: 16 * 60 }],
  HK: [
    { start: 9 * 60 + 30, end: 12 * 60 },
    { start: 13 * 60, end: 16 * 60 },
  ],
  CN: [
    { start: 9 * 60 + 30, end: 11 * 60 + 30 },
    { start: 13 * 60, end: 15 * 60 },
  ],
};

/** 市场本地墙钟的组成成分。 */
interface LocalClock {
  weekday: number;
  minuteOfDay: number;
}

/** 把一个 UTC 时刻解析为市场本地墙钟（星期几 + 一天内分钟数）。 */
function localClock(timezone: string, now: Date): LocalClock {
  // 用 Intl 按显式 IANA 时区取本地时间各成分；不依赖宿主机时区。
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  // formatToParts 输出转成 { weekday/hour/minute } 字典再取数。
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  // weekdays 下标即 weekday 值：0=Sunday ... 6=Saturday。
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // 某些 ICU 在午夜会给出 '24'，归一化为 0 点。
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  return {
    weekday: weekdays.indexOf(parts.weekday),
    minuteOfDay: hour * 60 + Number(parts.minute),
  };
}

/** 市场此刻是否处于连续交易时段内（周末闭市、午休闭市，见文件头约定）。 */
export function isMarketOpen(market: Market, now: Date = new Date()): boolean {
  // 先取市场本地墙钟；0（周日）与 6（周六）直接判闭市。
  const clock = localClock(MARKET_TIMEZONES[market], now);
  if (clock.weekday === 0 || clock.weekday === 6) return false;
  // 任一时段满足 [start, end) 即视为开市。
  return MARKET_SESSIONS[market].some(
    (s) => clock.minuteOfDay >= s.start && clock.minuteOfDay < s.end,
  );
}

/** 三个市场（US/HK/CN）中是否有至少一个正在交易。 */
export function anyMarketOpen(now: Date = new Date()): boolean {
  return (['US', 'HK', 'CN'] as Market[]).some((m) => isMarketOpen(m, now));
}
