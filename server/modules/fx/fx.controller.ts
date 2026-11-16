/**
 * FX controller.
 *
 * Exposes foreign-exchange rate endpoints under `/api/fx`: latest rate for a
 * currency pair, rates for a given date, and a manual refresh from the upstream
 * provider. Routes require a signed-in user to avoid anonymous provider abuse.
 */
import { Controller, Get, Post, Query, NotFoundException } from '@nestjs/common';

import { FxService } from './fx.service';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import type { FxRate } from '@shared/api.interface';

/** Generic list response wrapper. */
interface ListResponse<T> {
  items: T[];
}

/**
 * REST controller for FX rates. Delegates to `FxService`.
 */
@Controller('api/fx')
@NeedLogin()
export class FxController {
  constructor(private readonly fxService: FxService) {}

  /**
   * Returns the latest available rate for a base/quote currency pair.
   *
   * @param base  Base currency code.
   * @param quote Quote currency code.
   * @throws NotFoundException if no rate can be resolved.
   */
  @Get('latest')
  async getLatest(
    @Query('base') base: string,
    @Query('quote') quote: string,
  ): Promise<{ rate: string }> {
    const rate = await this.fxService.getLatestRate(base, quote);
    if (rate === null) {
      throw new NotFoundException(`Exchange rate not found for ${base}/${quote}`);
    }
    return { rate };
  }

  /**
   * Lists all FX rates recorded for a specific date.
   *
   * @param date Rate date (YYYY-MM-DD).
   */
  @Get('list')
  async getList(@Query('date') date: string): Promise<ListResponse<FxRate>> {
    const items = await this.fxService.getRatesForDate(date);
    return { items };
  }

  /**
   * Manually refreshes today's rates from the upstream provider.
   *
   * @returns The number of rates upserted.
   */
  @Post('refresh')
  async refresh(): Promise<{ updated: number }> {
    const updated = await this.fxService.refreshRates();
    return { updated };
  }
}
