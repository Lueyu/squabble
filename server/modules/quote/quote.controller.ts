/**
 * Quote controller.
 *
 * Read-only market-data endpoints under `/api/quote`. The batch and single-quote
 * routes are public (no login) because they only return generic market data; the
 * `search` and `refresh` routes require login because `search` filters against the
 * caller's own holdings/watchlist and `refresh` writes prices for the caller's rows.
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
 * REST controller for fetching stock quotes and searching tickers. Delegates to
 * `QuoteService`, which scrapes third-party quote providers with caching.
 */
@Controller('api/quote')
export class QuoteController {
  constructor(private readonly quoteService: QuoteService) {}

  /**
   * Returns quotes for a comma-separated list of symbols (public, no login).
   *
   * @param symbols Comma-delimited ticker list, e.g. `AAPL,0700.HK,600519`.
   * @throws BadRequestException if the list is missing or empty.
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
   * Searches tickers, prioritizing the caller's own holdings/watchlist, then an
   * external provider. Requires login (uses `req.userContext.userId`).
   *
   * @param q   Search text.
   * @param req Authenticated request.
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
   * Returns the latest quote for a single symbol (public, no login).
   *
   * @param symbol Ticker to look up.
   * @throws NotFoundException if no quote could be resolved.
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
   * Refreshes current prices for all of the caller's holdings and watchlist items.
   * Requires login; writes back into the caller's rows only.
   *
   * @param req Authenticated request.
   * @returns The number of tickers whose prices were successfully refreshed.
   */
  @Post('refresh')
  @NeedLogin()
  async refresh(@Req() req: Request): Promise<{ refreshed: number }> {
    const { userId } = req.userContext;
    const refreshed = await this.quoteService.batchRefreshPrices(userId);
    return { refreshed };
  }
}
