/**
 * @file hooks/use-market-quotes.ts
 * @description 实时行情订阅 hook：按市场分批轮询，阶段感知调速。
 *
 * 对外暴露 `useMarketQuotes(tickers)`。内部是一个模块级 `QuoteScheduler`
 * 单例：合并所有订阅者的 ticker，按市场（US/HK/CN）分批拉取，并按阶段调速轮询：
 *   - 连续交易中：60 秒一轮
 *   - 盘前/盘后：5 分钟一轮
 *   - 收市：10 分钟一轮
 * 页签隐藏时暂停定时器、重新可见时立即刷新一次，避免后台页签狂打行情接口。
 *
 * 职责边界：
 *  - 只负责行情数据的拉取调度与分发；行情的展示格式化在 utils/format.ts
 *  - 不做任何业务判断（评级/持仓逻辑），调用方自行解读 quotes
 * 上下游：
 *  - 上游（谁调用这里）：HoldingsPage、WatchlistPage、DashboardPage（useMarketQuotes）；
 *    components/Layout.tsx（getAggregateMarketStatus、forceRefreshAllQuotes）；
 *    pages/Analysis/AnalysisCard.tsx（inferMarket）
 *  - 下游（本文件调用谁）：../api/http（GET /api/quote/batch）、utils/logger、
 *    utils/ticker（tickerVariants 生成等价键）
 * 关键约定：
 *  - quotes 缓存同时按"原始符号"与"归一化符号"等多个等价拼写存一份，
 *    保证持仓里存的写法（如 '0700' vs '00700'）都能命中
 *  - 诊断快照挂在 window.__pt.getMarketStatus，便于生产环境排查
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import http from '../api/http';
import { logger } from '../utils/logger';
import { tickerVariants } from '../utils/ticker';
import type { QuoteResponse, Market } from '@shared/api.interface';

/**
 * 市场交易阶段，用于选择轮询节奏。
 */
export type MarketPhase = 'trading' | 'pre' | 'post' | 'closed';

// 各阶段轮询间隔（毫秒）。
const TRADING_INTERVAL = 60 * 1000; // 交易中 60s
const PRE_POST_INTERVAL = 5 * 60 * 1000; // 盘前/盘后 5min
const IDLE_INTERVAL = 10 * 60 * 1000; // 收市 10min

/** 把 UTC 时间换算成各市场当地墙钟时间所用的 IANA 时区。 */
const MARKET_TIMEZONES: Record<Market, string> = {
  US: 'America/New_York',
  HK: 'Asia/Hong_Kong',
  CN: 'Asia/Shanghai',
};

/** 一个交易时段窗口，以"市场当地的分钟数"表示。 */
type TimeSession = { start: number; end: number; phase: MarketPhase };

// 各市场的时段范围（市场当地时间，分钟数）。
const MARKET_SESSIONS: Record<Market, TimeSession[]> = {
  US: [
    { start: 4 * 60, end: 9 * 60 + 30, phase: 'pre' },
    { start: 9 * 60 + 30, end: 16 * 60, phase: 'trading' },
    { start: 16 * 60, end: 20 * 60, phase: 'post' },
  ],
  HK: [
    { start: 9 * 60 + 30, end: 12 * 60, phase: 'trading' },
    { start: 13 * 60, end: 16 * 60, phase: 'trading' },
  ],
  CN: [
    { start: 9 * 60 + 30, end: 11 * 60 + 30, phase: 'trading' },
    { start: 13 * 60, end: 15 * 60, phase: 'trading' },
  ],
};

/** 调度器跟踪的全部市场。 */
const ALL_MARKETS: Market[] = ['US', 'HK', 'CN'];

/**
 * 按 ticker 的形状推断其所属市场。
 *  - `.HK` 后缀或 5 位数字 → 港股
 *  - 6 位数字 → A 股
 *  - 其余 → 美股
 * @param ticker - 持仓/自选里存的原始 ticker 字符串。
 * @returns 解析出的 `Market`。
 */
export function inferMarket(ticker: string): Market {
  const clean = ticker.trim().toUpperCase();
  if (/\.HK$/.test(clean)) return 'HK';
  if (/^\d{5,6}$/.test(clean)) return clean.length === 6 ? 'CN' : 'HK';
  return 'US';
}

/**
 * 把 UTC 日期换算成市场当地的星期/时/分。
 * 使用带 IANA 时区的 `Intl.DateTimeFormat`，保证夏令时切换时计算仍正确。
 * @param market - 目标市场。
 * @param date - 待换算的 UTC Date。
 * @returns 当地星期（0=周日）、24 小时制的时与分。
 */
function getMarketLocalTime(
  market: Market,
  date: Date,
): {
  weekday: number;
  hour: number;
  minute: number;
} {
  // 步骤 1：用市场时区格式化出各时间部件。
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIMEZONES[market],
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';

  // 步骤 2：把英文星期缩写映射成数字（0=周日）。
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  // 步骤 3：组装返回值；解析失败时回退 0 值。
  return {
    weekday: weekdayMap[get('weekday')] ?? 0,
    hour: parseInt(get('hour'), 10) || 0,
    minute: parseInt(get('minute'), 10) || 0,
  };
}

/**
 * 计算某个市场当前的交易阶段。
 * @param market - 要评估的市场。
 * @param date - 可选日期（默认当前时间）；主要供测试用。
 * @returns `trading | pre | post | closed` 之一。
 */
export function isMarketTrading(market: Market, date?: Date): MarketPhase {
  // 步骤 1：取市场当地时间。
  const now = date ?? new Date();
  const { weekday, hour, minute } = getMarketLocalTime(market, now);

  // 步骤 2：周末直接收市。
  if (weekday === 0 || weekday === 6) return 'closed';

  // 步骤 3：落在任一交易时段窗口内则返回该窗口的阶段。
  const minuteOfDay = hour * 60 + minute;
  const sessions = MARKET_SESSIONS[market];

  for (const session of sessions) {
    if (minuteOfDay >= session.start && minuteOfDay < session.end) {
      return session.phase;
    }
  }

  // 步骤 4：窗口之外（午休/清晨/深夜）一律视为收市。
  return 'closed';
}

/**
 * 按市场阶段选择合适的轮询间隔。
 * @param phase - 当前市场阶段。
 * @returns 间隔毫秒数。
 */
function intervalForPhase(phase: MarketPhase): number {
  if (phase === 'trading') return TRADING_INTERVAL;
  if (phase === 'pre' || phase === 'post') return PRE_POST_INTERVAL;
  return IDLE_INTERVAL;
}

/** 每次行情刷新时投递给订阅者回调的数据载荷。 */
type SubscribeCallback = (data: {
  quotes: Record<string, QuoteResponse>;
  marketStatus: Record<Market, MarketPhase>;
  marketErrors: Record<Market, boolean>;
  lastUpdated: Date | null;
}) => void;

/**
 * 所有 `useMarketQuotes` 消费者共享的单例行情调度器。
 * 跨订阅者去重 ticker、按市场分批请求，并驱动带页签可见性感知的
 * 阶段感知定时器。
 */
class QuoteScheduler {
  private tickers = new Set<string>();
  private subscribers = new Map<SubscribeCallback, string[]>();
  private quotes: Record<string, QuoteResponse> = {};
  private marketStatus: Record<Market, MarketPhase> = {
    US: 'closed',
    HK: 'closed',
    CN: 'closed',
  };
  private marketErrors: Record<Market, boolean> = {
    US: false,
    HK: false,
    CN: false,
  };
  private marketLastUpdated: Record<Market, Date | null> = {
    US: null,
    HK: null,
    CN: null,
  };
  private lastUpdated: Date | null = null;
  private marketTimers: Record<Market, number | null> = { US: null, HK: null, CN: null };
  private marketNextRefresh: Record<Market, number> = { US: 0, HK: 0, CN: 0 };
  private visibilityHandler: (() => void) | null = null;
  private visible = true;
  private marketFetching: Record<Market, boolean> = { US: false, HK: false, CN: false };

  /**
   * 为给定 ticker 注册一个订阅者。
   * 立即把当前缓存推给调用方（保证同步首帧渲染），对新增覆盖的市场
   * 立即发起一次拉取，并（惰性）启动页签可见性监听。
   * @param tickers - 本消费者关心的 ticker。
   * @param callback - 之后每次行情刷新都会被调用。
   */
  subscribe(tickers: string[], callback: SubscribeCallback): void {
    // 步骤 1：登记 ticker 与订阅者（ticker 去重）。
    const prevSize = this.tickers.size;
    const uniqueTickers = Array.from(new Set(tickers));
    for (const t of uniqueTickers) this.tickers.add(t);
    this.subscribers.set(callback, uniqueTickers);

    // 步骤 2：重算所有市场的交易阶段。
    this.refreshMarketStatus();

    // 步骤 3：立刻推一次当前缓存，调用方可同步渲染。
    callback({
      quotes: this.quotes,
      marketStatus: { ...this.marketStatus },
      marketErrors: { ...this.marketErrors },
      lastUpdated: this.lastUpdated,
    });

    // 步骤 4：启动可见性监听并调度所有市场的定时器。
    if (this.visibilityHandler === null) this.startVisibilityListener();
    this.scheduleAllMarkets();

    // 步骤 5：若有新 ticker 且页签可见，立即拉取"此前没有覆盖到"的市场。
    if (this.tickers.size > prevSize && this.visible) {
      const grouped = this.groupTickersByMarket();
      for (const m of ALL_MARKETS) {
        if (grouped[m].length > 0 && this.marketLastUpdated[m] === null) {
          void this.fetchMarketBatch(m);
        }
      }
    }
  }

  /**
   * 移除一个订阅者。若已无订阅者，则拆除全部定时器与可见性监听并清空
   * ticker 集合。
   * @param callback - 之前传给 `subscribe` 的回调。
   */
  unsubscribe(callback: SubscribeCallback): void {
    // 步骤 1：删除订阅者；若没有剩余订阅者则整体关停。
    this.subscribers.delete(callback);
    if (this.subscribers.size === 0) {
      this.tickers.clear();
      this.stopAllTimers();
      this.stopVisibilityListener();
      return;
    }

    // 步骤 2：从剩余订阅者重建全局 ticker 并集，并重排定时器。
    this.rebuildTickers();
    this.scheduleAllMarkets();
  }

  /** 从活跃订阅者的 ticker 列表重建全局 ticker 并集。 */
  private rebuildTickers(): void {
    this.tickers.clear();
    for (const ts of this.subscribers.values()) {
      for (const t of ts) this.tickers.add(t);
    }
  }

  /** 对当前有订阅者的每个市场强制立即刷新一次。 */
  refresh(): void {
    // 逐个市场发起拉取（无 ticker 的市场自动跳过）。
    const grouped = this.groupTickersByMarket();
    for (const m of ALL_MARKETS) {
      if (grouped[m].length > 0) void this.fetchMarketBatch(m);
    }
  }

  // ---- 内部实现 ----

  /** 把全局 ticker 并集按市场分桶。 */
  private groupTickersByMarket(): Record<Market, string[]> {
    const result: Record<Market, string[]> = { US: [], HK: [], CN: [] };
    for (const t of this.tickers) result[inferMarket(t)].push(t);
    return result;
  }

  /** 重算每个市场的交易阶段（订阅/刷新时调用）。 */
  private refreshMarketStatus(): void {
    for (const m of ALL_MARKETS) {
      this.marketStatus[m] = isMarketTrading(m);
    }
  }

  /**
   * 启动 `visibilitychange` 监听。页签重新可见时立即刷新全部市场并重排
   * 定时器；隐藏时停掉定时器，避免后台轮询。
   */
  private startVisibilityListener(): void {
    if (typeof document === 'undefined') return;
    this.visibilityHandler = () => {
      this.visible = document.visibilityState === 'visible';
      if (this.visible) {
        // 页签变为可见 —— 立即刷新并重启全部定时器。
        this.stopAllTimers();
        const grouped = this.groupTickersByMarket();
        const fetches: Promise<void>[] = [];
        for (const m of ALL_MARKETS) {
          if (grouped[m].length > 0) {
            fetches.push(this.fetchMarketBatch(m));
          }
        }
        Promise.all(fetches).finally(() => this.scheduleAllMarkets());
      } else {
        // 页签隐藏 —— 停掉所有定时器。
        this.stopAllTimers();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.visible = document.visibilityState === 'visible';
  }

  /** 解绑 `visibilitychange` 监听（订阅者清零时调用）。 */
  private stopVisibilityListener(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  /** 清掉所有市场的待触发定时器。 */
  private stopAllTimers(): void {
    for (const m of ALL_MARKETS) {
      if (this.marketTimers[m] !== null) {
        window.clearTimeout(this.marketTimers[m]);
        this.marketTimers[m] = null;
      }
    }
  }

  /** 清掉单个市场的待触发定时器（若有）。 */
  private stopMarketTimer(market: Market): void {
    if (this.marketTimers[market] !== null) {
      window.clearTimeout(this.marketTimers[market]);
      this.marketTimers[market] = null;
    }
  }

  /** 为当前至少有一个 ticker 的每个市场（重）启定时器。 */
  private scheduleAllMarkets(): void {
    // 页签隐藏时不调度。
    if (!this.visible) return;
    const grouped = this.groupTickersByMarket();
    for (const m of ALL_MARKETS) {
      if (grouped[m].length > 0) {
        this.scheduleMarket(m);
      } else {
        this.stopMarketTimer(m);
      }
    }
  }

  /**
   * 按单个市场当前阶段安排下一次轮询。
   * 拉取完成后本方法会自我重排，让节奏随市场在 pre/trading/post/closed
   * 之间切换而自适应。
   */
  private scheduleMarket(market: Market): void {
    // 步骤 1：清掉旧定时器；页签隐藏则直接返回。
    this.stopMarketTimer(market);
    if (!this.visible) return;

    // 步骤 2：按当前阶段取间隔，同时更新缓存的阶段（可能与上次不同）。
    const phase = isMarketTrading(market);
    this.marketStatus[market] = phase;
    const interval = intervalForPhase(phase);
    this.marketNextRefresh[market] = Date.now() + interval;

    // 步骤 3：定时报拉取；拉完自我重排，保证下一轮间隔重新按阶段计算。
    this.marketTimers[market] = window.setTimeout(() => {
      void this.fetchMarketBatch(market).finally(() => {
        this.scheduleMarket(market);
      });
    }, interval);
  }

  /**
   * 拉取一个市场的一批行情。并发调用会被 `marketFetching` 守卫折叠。
   * 成功时同时更新"原始符号"与"归一化符号"两套缓存键；失败时保留上次
   * 价格并把 `marketErrors` 置真，让 UI 能显示"数据可能过期"的提示。
   */
  private async fetchMarketBatch(market: Market): Promise<void> {
    // 步骤 1：守卫 —— 页签隐藏或该市场已有请求在飞则直接返回。
    if (!this.visible) return;
    if (this.marketFetching[market]) return;

    const grouped = this.groupTickersByMarket();
    const symbols = grouped[market];
    if (symbols.length === 0) return;

    this.marketFetching[market] = true;

    // 步骤 2：无论请求结果如何都先重算市场阶段。
    this.marketStatus[market] = isMarketTrading(market);

    try {
      // 步骤 3：按逗号拼接 symbols 请求批量行情。
      const resp = await http.get<{ items: QuoteResponse[] }>('/api/quote/batch', {
        params: { symbols: symbols.join(',') },
      });
      const items = resp.data?.items;
      if (!Array.isArray(items)) {
        // 响应格式异常：置错误位，但不覆盖已有缓存。
        logger.warn(`行情响应格式异常 (${market})`, resp.data);
        this.marketErrors[market] = true;
      } else {
        // 步骤 4：逐条写入缓存 —— 无有效价格的条目跳过。
        let gotAny = false;
        for (const q of items) {
          if (!q || typeof q.price === 'undefined' || q.price === null) continue;
          // 把每个等价拼写都存一份键，保证按持仓里自己的存储写法查询
          // （如 '0700' vs 供应商 '00700'、'600519' vs '600519.SH'）总能命中。
          for (const key of tickerVariants(q.symbol, q.market ?? market)) {
            this.quotes[key] = q;
          }
          gotAny = true;
        }

        // 步骤 5：一条有效行情都没有视为错误；有则更新该市场的最后成功时间。
        this.marketErrors[market] = !gotAny;
        if (gotAny) {
          this.marketLastUpdated[market] = new Date();
        }
      }
    } catch (err) {
      // 请求失败：保留上次价格，阶段不变，只置错误位。
      logger.warn(`行情请求失败 (${market})`, err);
      this.marketErrors[market] = true;
    } finally {
      // 步骤 6：无论成败，释放并发守卫并广播一次快照。
      this.marketFetching[market] = false;
      this.updateGlobalLastUpdated();
      this.emit();
    }
  }

  /** 从各市场的最后成功时间向上汇总出全局 `lastUpdated`。 */
  private updateGlobalLastUpdated(): void {
    let latest: Date | null = null;
    for (const m of ALL_MARKETS) {
      const t = this.marketLastUpdated[m];
      if (t !== null && (latest === null || t > latest)) latest = t;
    }
    this.lastUpdated = latest;
  }

  /** 把当前缓存的快照广播给每一个订阅者。 */
  private emit(): void {
    // 没有订阅者就不广播。
    if (this.subscribers.size === 0) return;

    // 组装快照（浅拷贝，避免订阅者直接改内部状态）。
    const payload = {
      quotes: { ...this.quotes },
      marketStatus: { ...this.marketStatus },
      marketErrors: { ...this.marketErrors },
      lastUpdated: this.lastUpdated,
    };

    // 逐个回调；单个回调抛错不影响其他订阅者。
    for (const cb of this.subscribers.keys()) {
      try {
        cb(payload);
      } catch (err) {
        logger.error('行情订阅回调异常', err);
      }
    }
  }

  // ---- 诊断 ----

  /**
   * 返回每个市场的阶段、当地时间、下次刷新、最后更新与错误状态的诊断
   * 快照。挂在 `window.__pt.getMarketStatus` 上，用于生产环境排查实时
   * 行为问题。
   */
  getMarketStatus(): {
    utcNow: string;
    markets: Record<
      Market,
      {
        phase: MarketPhase;
        timezone: string;
        localTime: string;
        weekday: number;
        nextRefresh: number;
        lastUpdated: Date | null;
        error: boolean;
        tickerCount: number;
      }
    >;
  } {
    // 步骤 1：取当前时间与 ticker 分桶。
    const now = new Date();
    const grouped = this.groupTickersByMarket();
    const markets = {} as Record<
      Market,
      {
        phase: MarketPhase;
        timezone: string;
        localTime: string;
        weekday: number;
        nextRefresh: number;
        lastUpdated: Date | null;
        error: boolean;
        tickerCount: number;
      }
    >;

    // 步骤 2：逐市场拼装诊断字段（当地时间补零成 HH:mm）。
    for (const m of ALL_MARKETS) {
      const local = getMarketLocalTime(m, now);
      const hh = local.hour < 10 ? `0${local.hour}` : String(local.hour);
      const mm = local.minute < 10 ? `0${local.minute}` : String(local.minute);
      markets[m] = {
        phase: isMarketTrading(m, now),
        timezone: MARKET_TIMEZONES[m],
        localTime: `${hh}:${mm}`,
        weekday: local.weekday,
        nextRefresh: this.marketNextRefresh[m],
        lastUpdated: this.marketLastUpdated[m],
        error: this.marketErrors[m],
        tickerCount: grouped[m].length,
      };
    }

    // 步骤 3：附带 UTC 时间戳便于跨时区对照。
    return { utcNow: now.toISOString(), markets };
  }
}

/** 全部市场（再导出一份，供需要遍历的调用方使用）。 */
const ALL_MARKETS_EXPORT: Market[] = ['US', 'HK', 'CN'];

// 模块级单例：所有 useMarketQuotes 消费者共享。
const scheduler = new QuoteScheduler();

/**
 * 不订阅行情、只计算当前每个市场的阶段。
 * 适合只需要知道"是否有市场在交易"的角标类组件。
 * @returns `anyTrading`（至少一个市场处于连续交易则为 true）与逐市场阶段表。
 */
export function getAggregateMarketStatus(): {
  anyTrading: boolean;
  statuses: Record<Market, MarketPhase>;
} {
  // 步骤 1：逐市场计算阶段。
  const statuses = {} as Record<Market, MarketPhase>;
  let anyTrading = false;
  for (const m of ALL_MARKETS_EXPORT) {
    const phase = isMarketTrading(m);
    statuses[m] = phase;
    if (phase === 'trading') anyTrading = true;
  }

  // 步骤 2：返回聚合结果。
  return { anyTrading, statuses };
}

/**
 * 强制对所有已订阅市场立即刷新一次行情。
 * 绑定在带行情页面上的"刷新"按钮。
 */
export function forceRefreshAllQuotes(): void {
  scheduler.refresh();
}

// 把诊断 API 挂到 window 上（若已有 __pt 则扩展，不覆盖）。
if (typeof window !== 'undefined') {
  const w = window as unknown as { __pt?: Record<string, unknown> };
  if (!w.__pt) w.__pt = {};
  w.__pt.getMarketStatus = () => scheduler.getMarketStatus();
}

// ---- Hook ----

/**
 * 把调用组件订阅到给定 ticker 的实时行情上。所有消费者共享模块级
 * `QuoteScheduler`，因此 N 个组件渲染同样的 ticker 只会产生一次网络批量请求。
 *
 * ticker 列表（按顺序）变化时会重建订阅：依赖数组用 join 后的字符串，
 * 避免数组引用抖动。
 *
 * @param tickers - 要订阅行情的 ticker 列表。
 * @returns 缓存的 quotes 表（同时按原始与归一化符号为键）、逐市场的阶段与
 *          错误表、最后成功时间，以及强制立即重拉的 `refresh` 回调。
 */
export function useMarketQuotes(tickers: string[]): {
  quotes: Record<string, QuoteResponse>;
  marketStatus: Record<Market, MarketPhase>;
  marketErrors: Record<Market, boolean>;
  lastUpdated: Date | null;
  refresh: () => void;
} {
  // 步骤 1：四份本地状态镜像调度器的快照。
  const [quotes, setQuotes] = useState<Record<string, QuoteResponse>>({});
  const [marketStatus, setMarketStatus] = useState<Record<Market, MarketPhase>>({
    US: 'closed',
    HK: 'closed',
    CN: 'closed',
  });
  const [marketErrors, setMarketErrors] = useState<Record<Market, boolean>>({
    US: false,
    HK: false,
    CN: false,
  });
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const tickersRef = useRef<string[]>([]);

  // 步骤 2：订阅回调句柄（用于清理）与稳定 refresh 回调。
  const callbackRef = useRef<SubscribeCallback | null>(null);

  const refresh = useCallback(() => {
    scheduler.refresh();
  }, []);

  useEffect(() => {
    // 步骤 1：拷贝本轮 ticker 列表。
    const next = tickers.slice();

    // 步骤 2：已有订阅先清掉。
    if (callbackRef.current) {
      scheduler.unsubscribe(callbackRef.current);
      callbackRef.current = null;
    }

    // 步骤 3：空列表只清引用、不订阅。
    if (next.length === 0) {
      tickersRef.current = [];
      return;
    }

    // 步骤 4：创建回调 —— 把调度器快照写进本地 state。
    const cb: SubscribeCallback = ({
      quotes: qs,
      marketStatus: ms,
      marketErrors: me,
      lastUpdated: lu,
    }) => {
      setQuotes(qs);
      setMarketStatus(ms);
      setMarketErrors(me);
      setLastUpdated(lu);
    };

    // 步骤 5：登记回调并订阅调度器。
    callbackRef.current = cb;
    tickersRef.current = next;
    scheduler.subscribe(next, cb);

    // 步骤 6：卸载时退订。
    return () => {
      if (callbackRef.current) {
        scheduler.unsubscribe(callbackRef.current);
        callbackRef.current = null;
      }
      tickersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers.join(',')]);

  // 步骤 7：返回快照与手动刷新入口。
  return { quotes, marketStatus, marketErrors, lastUpdated, refresh };
}
