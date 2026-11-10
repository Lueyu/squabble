import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { portfolioHistoryFetches, portfolioHistoryFx, portfolioHistoryPrices } from '../../database/portfolio-history.schema';
import { PortfolioHistoryProvider } from './portfolio-history.provider';
import { historySymbol, utcDay, type HistoryPosition } from './portfolio-history.rules';

interface Resource { key: string; ticker?: string; market?: string }

@Injectable()
export class PortfolioHistoryCache {
  private readonly logger = new Logger(PortfolioHistoryCache.name);
  private readonly pending = new Map<string, Promise<void>>();
  private readonly queue: Array<() => Promise<void>> = [];
  private active = 0;
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase, private readonly provider: PortfolioHistoryProvider) {}

  private resources(positions: HistoryPosition[], currencies: string[] = []): Resource[] {
    const values = new Map<string, Resource>();
    if (currencies.some(currency => currency === 'HKD' || currency === 'CNY')) values.set('fx:USD', { key: 'fx:USD' });
    for (const position of positions.filter(row => Number(row.shares) !== 0)) {
      const identity = historySymbol(position.ticker, position.market);
      if (!identity) continue;
      const key = `price:${identity.symbol}`;
      values.set(key, { key, ticker: position.ticker, market: identity.market });
      if (identity.currency !== 'USD') values.set('fx:USD', { key: 'fx:USD' });
    }
    return [...values.values()];
  }

  async read(positions: HistoryPosition[], from: string, to: string, at: Date, currencies: string[] = []) {
    const resources = this.resources(positions, currencies), keys = resources.map(row => row.key);
    const symbols = resources.filter(row => row.ticker).map(row => row.key.slice(6));
    const [prices, fx, fetches] = await Promise.all([
      symbols.length ? this.db.select().from(portfolioHistoryPrices).where(and(inArray(portfolioHistoryPrices.symbol, symbols), gte(portfolioHistoryPrices.priceDate, from), lte(portfolioHistoryPrices.priceDate, to))) : [],
      this.db.select().from(portfolioHistoryFx).where(and(gte(portfolioHistoryFx.rateDate, from), lte(portfolioHistoryFx.rateDate, to))),
      keys.length ? this.db.select().from(portfolioHistoryFetches).where(inArray(portfolioHistoryFetches.resource, keys)) : [],
    ]);
    return { prices, fx, refreshing: resources.some(resource => {
      const entry = fetches.find(row => row.resource === resource.key);
      return !entry || Boolean(entry.leaseUntil && entry.leaseUntil > at) || entry.nextAttemptAt <= at;
    }), gaps: fetches.filter(row => row.error).map(row => `HISTORY_FETCH_FAILED:${row.resource}`) };
  }

  /** Bounded in-process queue plus persisted resource leases deduplicate concurrent pages/imports/processes. */
  async prefetch(positions: HistoryPosition[], at = new Date(), currencies: string[] = []): Promise<void> {
    const jobs = this.resources(positions, currencies).map(resource => {
      const existing = this.pending.get(resource.key);
      if (existing) return existing;
      let finish!: () => void;
      const job = new Promise<void>(resolve => { finish = resolve; });
      this.pending.set(resource.key, job);
      this.queue.push(async () => {
        try { await this.fetch(resource, at); }
        catch { this.logger.warn(`Historical cache could not settle ${resource.key}`); }
        finally { this.pending.delete(resource.key); finish(); }
      });
      return job;
    });
    this.drain(); await Promise.all(jobs);
  }

  private drain(): void {
    while (this.active < 4 && this.queue.length) {
      const run = this.queue.shift()!; this.active++;
      void run().finally(() => { this.active--; this.drain(); });
    }
  }

  private async fetch(resource: Resource, at: Date): Promise<void> {
    const token = randomUUID(), now = new Date(), leaseUntil = new Date(now.getTime() + 60_000);
    await this.db.insert(portfolioHistoryFetches).values({ resource: resource.key, nextAttemptAt: now }).onConflictDoNothing();
    const [claim] = await this.db.update(portfolioHistoryFetches).set({ leaseToken: token, leaseUntil }).where(and(
      eq(portfolioHistoryFetches.resource, resource.key), lte(portfolioHistoryFetches.nextAttemptAt, now),
      or(isNull(portfolioHistoryFetches.leaseUntil), lte(portfolioHistoryFetches.leaseUntil, now)))).returning();
    if (!claim) return;
    const from = utcDay(new Date(at.getTime() - 373 * 86_400_000)), to = utcDay(at);
    try {
      const observations = resource.ticker
        ? await this.provider.prices(resource.ticker, resource.market!, from, to, at)
        : await this.provider.fx(from, to, at);
      if (!observations.length) throw new Error('HISTORY_PROVIDER_EMPTY');
      await this.db.transaction(async tx => {
        const [owned] = await tx.select().from(portfolioHistoryFetches).where(and(eq(portfolioHistoryFetches.resource, resource.key), eq(portfolioHistoryFetches.leaseToken, token))).for('update');
        if (!owned) return;
        if (resource.ticker) await tx.insert(portfolioHistoryPrices)
          .values((observations as Awaited<ReturnType<PortfolioHistoryProvider['prices']>>).map(row => ({ ...row, fetchedAt: now })))
          .onConflictDoUpdate({ target: [portfolioHistoryPrices.symbol, portfolioHistoryPrices.priceDate],
            set: { close: sql`excluded.close`, source: sql`excluded.source`, fetchedAt: now } });
        else await tx.insert(portfolioHistoryFx)
          .values((observations as Awaited<ReturnType<PortfolioHistoryProvider['fx']>>).map(row => ({ ...row, fetchedAt: now })))
          .onConflictDoUpdate({ target: [portfolioHistoryFx.currency, portfolioHistoryFx.rateDate],
            set: { usdRate: sql`excluded.usd_rate`, source: sql`excluded.source`, fetchedAt: now } });
        await tx.update(portfolioHistoryFetches).set({ leaseToken: null, leaseUntil: null, completedAt: now, error: null,
          nextAttemptAt: new Date(now.getTime() + 6 * 3_600_000), coverage: { from, to, observations: observations.length } }).where(eq(portfolioHistoryFetches.resource, resource.key));
      });
    } catch {
      await this.db.update(portfolioHistoryFetches).set({ leaseToken: null, leaseUntil: null, error: 'PROVIDER_UNAVAILABLE',
        nextAttemptAt: new Date(now.getTime() + 5 * 60_000) }).where(and(eq(portfolioHistoryFetches.resource, resource.key), eq(portfolioHistoryFetches.leaseToken, token)));
    }
  }
}
