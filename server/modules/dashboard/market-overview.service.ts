/**
 * market-overview.service.ts — 市场概览服务：抓取三大市场核心指数并聚合为公开概览。
 *
 * 职责边界：
 *  - 只负责"指数观察值 + 市场情绪"这类非个人化的公开市场数据，与任何用户无关。
 *  - 不读取数据库；上游为腾讯行情（qt.gtimg.cn）。
 * 上下游：
 *  - 上游：DashboardController 的 GET /api/portfolio/dashboard/market-overview。
 *  - 下游：调用 market-overview.logic.ts 的 INDEX_DEFINITIONS / parseIndexQuote / calculateMarketMood。
 * 关键约定：
 *  - 进程内缓存 60 秒（CACHE_MS = 60_000），响应中的 refreshAfterSeconds = 60。
 *  - 抓取失败/解析失败时回退缓存：上次成功取数在 24 小时内
 *    （STALE_MAX_MS = 24 * 60 * 60_000）的旧值标记 status: 'stale' 返回。
 *  - 上游响应为 GBK 编码，须用 TextDecoder('gbk') 解码；单次抓取 8 秒超时，
 *    User-Agent 为 'Squabble/2.0'。
 */
import { Injectable } from '@nestjs/common';
import type { Market, MarketOverviewResponse, MarketIndexQuote } from '@shared/api.interface';
import { INDEX_DEFINITIONS, parseIndexQuote, calculateMarketMood } from './market-overview.logic';

// 进程内缓存有效期：60 秒。
const CACHE_MS = 60_000;
// 缓存回退上限：距上次成功取数超过 24 小时的旧值不再作为 stale 返回。
const STALE_MAX_MS = 24 * 60 * 60_000;
// 覆盖的三大市场。
const MARKETS: Market[] = ['US', 'HK', 'CN'];

/** 面向所有已登录请求共享的公开、非个人化市场数据。 */
@Injectable()
export class MarketOverviewService {
  private cached: MarketOverviewResponse | null = null;
  private expiresAt = 0;
  private inFlight: Promise<MarketOverviewResponse> | null = null;

  // 返回市场概览；60 秒缓存 + single-flight 合并并发请求。
  getOverview(): Promise<MarketOverviewResponse> {
    // 缓存未过期：直接返回缓存结果。
    if (this.cached && Date.now() < this.expiresAt) return Promise.resolve(this.cached);
    // 已有抓取进行中：复用同一个 Promise，避免并发重复请求上游。
    if (this.inFlight) return this.inFlight;
    // 发起新抓取；完成后清空进行中标记。
    this.inFlight = this.fetchOverview().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  // 从上游抓取全部指数并解析；解析失败的指数用缓存回退（24 小时内标记 stale）。
  private async fetchOverview(): Promise<MarketOverviewResponse> {
    // 抓取上游指数行情（GBK 编码，8 秒超时）；任何异常只置 failed 标记，不向外抛。
    let body = '';
    let failed = false;
    try {
      const response = await fetch(
        `https://qt.gtimg.cn/q=${INDEX_DEFINITIONS.map((item) => item.symbol).join(',')}`,
        {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'Squabble/2.0', Accept: 'text/plain' },
        },
      );
      if (!response.ok) throw new Error('Index source unavailable');
      body = new TextDecoder('gbk').decode(await response.arrayBuffer());
    } catch {
      failed = true;
    }
    // 逐个指数解析；解析不出（unavailable）时尝试用上一次缓存值回退。
    const now = new Date();
    const indices = INDEX_DEFINITIONS.map((definition) => {
      const quote = parseIndexQuote(body, definition, now);
      if (quote.status !== 'unavailable') return quote;
      const previous = this.cached?.indices.find((item) => item.id === definition.id);
      if (
        previous?.retrievedAt &&
        previous.value !== null &&
        now.getTime() - Date.parse(previous.retrievedAt) <= STALE_MAX_MS
      ) {
        // 上次取数在 24 小时内：沿用旧值，标记 stale 并注明原因（抓取失败或报价无效）。
        return {
          ...previous,
          status: 'stale',
          issue: failed ? 'fetch_failed' : 'invalid_quote',
        } as MarketIndexQuote;
      }
      // 无可用缓存：保持 unavailable，仅当整体抓取失败时把 issue 改写为 fetch_failed。
      return { ...quote, issue: failed ? 'fetch_failed' : quote.issue } as MarketIndexQuote;
    });
    // 组装概览并写入进程内缓存（refreshAfterSeconds 告知客户端 60 秒后再来刷新）。
    const overview: MarketOverviewResponse = {
      checkedAt: now.toISOString(),
      refreshAfterSeconds: CACHE_MS / 1000,
      indices,
      moods: MARKETS.map((market) => calculateMarketMood(market, indices)),
    };
    this.cached = overview;
    this.expiresAt = Date.now() + CACHE_MS;
    return overview;
  }
}
