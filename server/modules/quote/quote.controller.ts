/**
 * quote.controller.ts — 行情（Quote）只读 REST 控制器，挂载于 /api/quote。
 *
 * 职责边界：
 *  - 只暴露行情读取与搜索端点：批量报价、ticker 搜索、单条报价、价格刷新。
 *  - 上游第三方行情源的抓取与缓存全部在 QuoteService 内实现，控制器不触碰缓存。
 * 上下游：
 *  - 上游：客户端行情展示/搜索调用；agent-gateway 等（经由 QuoteService）不经此控制器。
 *  - 下游：调用 QuoteService（getBatchQuotes/searchStocks/getQuote/batchRefreshPrices）。
 * 关键约定：
 *  - 鉴权分层：batch 与单条报价路由公开（无需登录），因为只返回通用市场数据；
 *    search 与 refresh 要求登录——search 需要过滤调用者自己的持仓/自选，
 *    refresh 只写调用者自己的行。
 */
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';

import { QuoteService } from './quote.service';
import type { QuoteResponse, StockSearchResult } from '@shared/api.interface';

/**
 * 获取股票行情与搜索 ticker 的 REST 控制器，委托给带缓存的
 * 第三方行情抓取器 QuoteService。
 */
@Controller('api/quote')
export class QuoteController {
  constructor(private readonly quoteService: QuoteService) {}

  /**
   * 返回逗号分隔 ticker 列表的批量报价（公开，无需登录）。
   *
   * 方法+路径：GET /api/quote/batch?symbols=AAPL,0700.HK（公开）。
   *
   * @param symbols 逗号分隔的 ticker 列表，如 `AAPL,0700.HK,600519`
   * @throws BadRequestException 列表缺失或为空时返回 400
   */
  @Get('batch')
  async getBatchQuotes(@Query('symbols') symbols: string): Promise<{ items: QuoteResponse[] }> {
    if (!symbols || typeof symbols !== 'string') {
      throw new BadRequestException('symbols query parameter is required');
    }
    const symbolList = symbols
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (symbolList.length === 0) {
      throw new BadRequestException('symbols query parameter cannot be empty');
    }
    const items = await this.quoteService.getBatchQuotes(symbolList);
    return { items };
  }

  /**
   * 搜索 ticker：优先匹配调用者自己的持仓/自选，其次再查外部行情源。
   * 需要登录（内部使用 `req.userContext.userId`）。
   *
   * 方法+路径：GET /api/quote/search?q=（需登录）。
   *
   * @param q   搜索文本
   * @param req 已认证请求
   */
  @Get('search')
  @NeedLogin()
  async search(
    @Query('q') q: string,
    @Req() req: Request,
  ): Promise<{ items: StockSearchResult[] }> {
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return { items: [] };
    }
    const { userId } = req.userContext;
    const items = await this.quoteService.searchStocks(q.trim(), userId);
    return { items };
  }

  /**
   * 返回单个 ticker 的最新报价（公开，无需登录）。
   *
   * 方法+路径：GET /api/quote?symbol=AAPL（公开）。
   *
   * @param symbol 要查询的 ticker
   * @throws NotFoundException 无法解析出报价时返回 404
   */
  @Get()
  async getQuote(@Query('symbol') symbol: string): Promise<QuoteResponse> {
    const result = await this.quoteService.getQuote(symbol);
    if (!result) {
      throw new NotFoundException(`Quote not found for symbol: ${symbol}`);
    }
    return result;
  }

  /**
   * 刷新调用者全部持仓与自选项的当前价格。
   * 需要登录；只写回调用者自己的行。
   *
   * 方法+路径：POST /api/quote/refresh（需登录）。
   *
   * @param req 已认证请求
   * @returns 成功刷新价格的 ticker 数量
   */
  @Post('refresh')
  @NeedLogin()
  async refresh(@Req() req: Request): Promise<{ refreshed: number }> {
    const { userId } = req.userContext;
    const refreshed = await this.quoteService.batchRefreshPrices(userId);
    return { refreshed };
  }
}
