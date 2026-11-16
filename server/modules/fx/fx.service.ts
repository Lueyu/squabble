/**
 * FX service.
 *
 * Stores and serves currency exchange rates (USD->HKD, USD->CNY) and converts
 * amounts between currencies. Rates are cached in the `fxRates` table and refreshed
 * from Frankfurter. Lookups support both the direct pair and the inverse
 * (taking 1/rate), falling back to the latest rate when a date-specific one is
 * missing.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, desc, sql } from 'drizzle-orm';
import { firstValueFrom } from 'rxjs';
import { fxRates } from '@server/database/schema';
import type { FxRate, Currency } from '@shared/api.interface';

/**
 * Provides FX rate lookup and currency conversion. Depends on the Drizzle database
 * and the Axios `HttpService`.
 */
@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private refreshAfter = 0;
  private refreshInFlight: Promise<number> | null = null;

  private recentRateDate(value: string | Date): boolean {
    const date = typeof value === 'string' ? value : value.toISOString().slice(0, 10);
    const age = Date.now() - Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(age) && age >= -86_400_000 && age <= 7 * 86_400_000;
  }

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly httpService: HttpService,
  ) {}

  /**
   * Returns the latest rate for a base/quote pair. Same-currency returns '1'.
   * Tries the direct pair first, then the inverse pair (1/rate).
   *
   * @param base  Base currency.
   * @param quote Quote currency.
   * @returns Rate string, or null if none is stored.
   */
  async getLatestRate(base: string, quote: string): Promise<string | null> {
    if (
      typeof base !== 'string' ||
      typeof quote !== 'string' ||
      !/^[A-Za-z]{3}$/.test(base) ||
      !/^[A-Za-z]{3}$/.test(quote)
    )
      return null;
    const baseUpper = base.toUpperCase();
    const quoteUpper = quote.toUpperCase();

    if (baseUpper === quoteUpper) return '1';
    if (Date.now() >= this.refreshAfter) {
      this.refreshInFlight ??= this.refreshRates().finally(() => {
        this.refreshInFlight = null;
      });
      await this.refreshInFlight;
    }

    // Try the direct pair (base -> quote).
    const directRow = await this.db
      .select({ rate: fxRates.rate, date: fxRates.rateDate })
      .from(fxRates)
      .where(sql`${fxRates.base} = ${baseUpper} AND ${fxRates.quote} = ${quoteUpper}`)
      .orderBy(desc(fxRates.rateDate))
      .limit(1);

    if (
      directRow.length > 0 &&
      this.recentRateDate(directRow[0].date) &&
      directRow[0].rate !== null &&
      directRow[0].rate !== undefined
    ) {
      return String(directRow[0].rate);
    }

    // Try the reverse pair (quote -> base) and invert.
    const reverseRow = await this.db
      .select({ rate: fxRates.rate, date: fxRates.rateDate })
      .from(fxRates)
      .where(sql`${fxRates.base} = ${quoteUpper} AND ${fxRates.quote} = ${baseUpper}`)
      .orderBy(desc(fxRates.rateDate))
      .limit(1);

    if (
      reverseRow.length > 0 &&
      this.recentRateDate(reverseRow[0].date) &&
      reverseRow[0].rate !== null &&
      reverseRow[0].rate !== undefined
    ) {
      const rate = parseFloat(String(reverseRow[0].rate));
      if (rate > 0) {
        return (1 / rate).toString();
      }
    }

    return null;
  }

  /**
   * Lists all FX rates recorded for a given date.
   *
   * @param date Rate date (YYYY-MM-DD).
   */
  async getRatesForDate(date: string): Promise<FxRate[]> {
    const rows = await this.db
      .select({
        date: fxRates.rateDate,
        base: fxRates.base,
        quote: fxRates.quote,
        rate: fxRates.rate,
      })
      .from(fxRates)
      .where(eq(fxRates.rateDate, date))
      .orderBy(fxRates.base, fxRates.quote);

    return rows.map((row) => ({
      date: typeof row.date === 'string' ? row.date : (row.date as Date).toISOString().slice(0, 10),
      base: row.base as Currency,
      quote: row.quote as Currency,
      rate: String(row.rate),
    }));
  }

  /**
   * Fetches the provider's dated USD->HKD and USD->CNY rates and upserts
   * them into `fxRates` (keyed by date+base+quote). Failures are logged and return 0.
   *
   * @returns The number of rates successfully upserted.
   */
  async refreshRates(): Promise<number> {
    if (Date.now() < this.refreshAfter) return 0;
    this.refreshAfter = Date.now() + 5 * 60 * 1000;
    try {
      const url = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=HKD,CNY';
      const response = await firstValueFrom(this.httpService.get(url, { timeout: 8000 }));

      const data = response.data;
      if (
        !data ||
        !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ||
        !data.rates ||
        typeof data.rates !== 'object'
      ) {
        this.logger.warn('refreshRates: invalid response from Frankfurter');
        return 0;
      }
      const providerDate = data.date as string;
      const providerAge = Date.now() - Date.parse(`${providerDate}T00:00:00Z`);
      if (
        !Number.isFinite(providerAge) ||
        providerAge < -86_400_000 ||
        providerAge > 7 * 86_400_000
      )
        return 0;
      const rates: Array<{ base: string; quote: string; rate: string }> = [];

      const hkdRate = data.rates.HKD;
      const cnyRate = data.rates.CNY;

      if (typeof hkdRate === 'number' && !isNaN(hkdRate) && hkdRate > 0) {
        rates.push({ base: 'USD', quote: 'HKD', rate: hkdRate.toString() });
      }
      if (typeof cnyRate === 'number' && !isNaN(cnyRate) && cnyRate > 0) {
        rates.push({ base: 'USD', quote: 'CNY', rate: cnyRate.toString() });
      }

      if (rates.length === 0) return 0;

      // Upsert each rate on the (date, base, quote) key.
      let updated = 0;
      for (const r of rates) {
        try {
          await this.db
            .insert(fxRates)
            .values({
              rateDate: providerDate,
              base: r.base,
              quote: r.quote,
              rate: r.rate,
            })
            .onConflictDoUpdate({
              target: [fxRates.rateDate, fxRates.base, fxRates.quote],
              set: { rate: r.rate },
            });
          updated += 1;
        } catch (insertError) {
          this.logger.warn(
            `refreshRates: upsert failed for ${r.base}/${r.quote}: ${insertError instanceof Error ? insertError.message : String(insertError)}`,
          );
        }
      }

      if (updated > 0) this.refreshAfter = Date.now() + 60 * 60 * 1000;
      return updated;
    } catch (error) {
      this.logger.warn(
        `refreshRates failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /**
   * Converts an amount from one currency to another. If a date is given, prefers
   * that date's rate (direct, then inverse); otherwise uses the latest rate.
   *
   * @param amount Amount to convert.
   * @param from   Source currency.
   * @param to     Target currency.
   * @param date   Optional rate date (YYYY-MM-DD).
   * @returns Converted amount.
   * @throws Error if no usable rate is available.
   */
  async convert(amount: number, from: string, to: string, date?: string): Promise<number> {
    const fromUpper = from.toUpperCase();
    const toUpper = to.toUpperCase();

    if (fromUpper === toUpper) return amount;

    let rateStr: string | null = null;

    if (date) {
      // Try the direct pair on the given date.
      const directRow = await this.db
        .select({ rate: fxRates.rate })
        .from(fxRates)
        .where(
          sql`${fxRates.base} = ${fromUpper} AND ${fxRates.quote} = ${toUpper} AND ${fxRates.rateDate} = ${date}`,
        )
        .limit(1);

      if (directRow.length > 0 && directRow[0].rate != null) {
        rateStr = String(directRow[0].rate);
      } else {
        // Try the inverse pair on the given date.
        const reverseRow = await this.db
          .select({ rate: fxRates.rate })
          .from(fxRates)
          .where(
            sql`${fxRates.base} = ${toUpper} AND ${fxRates.quote} = ${fromUpper} AND ${fxRates.rateDate} = ${date}`,
          )
          .limit(1);

        if (reverseRow.length > 0 && reverseRow[0].rate != null) {
          const r = parseFloat(String(reverseRow[0].rate));
          if (r > 0) rateStr = (1 / r).toString();
        }
      }
    }

    // Fall back to the latest available rate.
    if (rateStr === null) {
      rateStr = await this.getLatestRate(fromUpper, toUpper);
    }

    if (rateStr === null) {
      throw new Error(`No exchange rate available for ${fromUpper} -> ${toUpper}`);
    }

    const rate = parseFloat(rateStr);
    if (isNaN(rate)) {
      throw new Error(`Invalid exchange rate for ${fromUpper} -> ${toUpper}`);
    }

    return amount * rate;
  }
}
