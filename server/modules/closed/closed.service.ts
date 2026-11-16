/**
 * Closed positions service.
 *
 * Business logic and PostgreSQL (Drizzle) data access for realized, closed-out
 * positions. Most closed rows are derived automatically by the transactions
 * reconciliation, but this service also supports manual create/update/delete.
 * All queries are owner-scoped. The `getRealizedSummary` aggregates realized P&L
 * per ticker and per currency (currency is looked up from the transactions table,
 * since closed rows themselves store no currency).
 */
import { Injectable, Inject, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { closed, transactions } from '@server/database/schema';
import type {
  ClosedPosition,
  CreateClosedDto,
  RealizedPlSummary,
  RealizedPlItem,
} from '@shared/api.interface';

/** Partial-update variant of the create DTO. */
type UpdateClosedDto = Partial<CreateClosedDto>;

/**
 * Provides closed-position CRUD and realized-P&L aggregation. Depends on the
 * Drizzle database connection.
 */
@Injectable()
export class ClosedService {
  private readonly logger = new Logger(ClosedService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * Lists all closed positions for a user, most recently closed first.
   *
   * @param userId Owner id from the authenticated request.
   */
  async list(userId: string): Promise<ClosedPosition[]> {
    const rows = await this.db
      .select()
      .from(closed)
      .where(eq(closed.owner, userId))
      .orderBy(desc(closed.closeDate));

    return rows.map((row) => ({
      id: row.id,
      ticker: row.ticker,
      company: row.company ?? null,
      openDate: row.openDate ?? null,
      closeDate: row.closeDate ?? null,
      buyPrice: row.buyPrice ? String(row.buyPrice) : null,
      sellPrice: row.sellPrice ? String(row.sellPrice) : null,
      shares: row.shares ? String(row.shares) : null,
      realizedPl: row.realizedPl ? String(row.realizedPl) : null,
      returnPct: row.returnPct ? String(row.returnPct) : null,
      notes: row.notes ?? null,
    }));
  }

  /**
   * Manually creates a closed-position record.
   *
   * @param userId Owner id.
   * @param dto    Create payload.
   */
  async create(userId: string, dto: CreateClosedDto): Promise<ClosedPosition> {
    const rows = await this.db
      .insert(closed)
      .values({
        ticker: dto.ticker,
        company: dto.company,
        openDate: dto.openDate,
        closeDate: dto.closeDate,
        buyPrice: dto.buyPrice !== undefined ? String(dto.buyPrice) : undefined,
        sellPrice: dto.sellPrice !== undefined ? String(dto.sellPrice) : undefined,
        shares: dto.shares !== undefined ? String(dto.shares) : undefined,
        realizedPl: dto.realizedPl !== undefined ? String(dto.realizedPl) : undefined,
        returnPct: dto.returnPct !== undefined ? String(dto.returnPct) : undefined,
        notes: dto.notes,
        owner: userId,
      })
      .returning();

    const row = rows[0];
    return {
      id: row.id,
      ticker: row.ticker,
      company: row.company ?? null,
      openDate: row.openDate ?? null,
      closeDate: row.closeDate ?? null,
      buyPrice: row.buyPrice ? String(row.buyPrice) : null,
      sellPrice: row.sellPrice ? String(row.sellPrice) : null,
      shares: row.shares ? String(row.shares) : null,
      realizedPl: row.realizedPl ? String(row.realizedPl) : null,
      returnPct: row.returnPct ? String(row.returnPct) : null,
      notes: row.notes ?? null,
    };
  }

  /**
   * Partially updates an owned closed position; refreshes `updatedAt`/`updatedBy`.
   *
   * @param userId Owner id used for the ownership filter and audit stamp.
   * @param id     Closed-position primary key.
   * @param dto    Partial update payload.
   * @throws BadRequestException if no updatable field is supplied.
   * @throws NotFoundException if the row does not belong to the user.
   */
  async update(userId: string, id: string, dto: UpdateClosedDto): Promise<ClosedPosition> {
    const patch: Record<string, unknown> = {};
    if (dto.ticker !== undefined) patch.ticker = dto.ticker;
    if (dto.company !== undefined) patch.company = dto.company;
    if (dto.openDate !== undefined) patch.openDate = dto.openDate;
    if (dto.closeDate !== undefined) patch.closeDate = dto.closeDate;
    if (dto.buyPrice !== undefined) patch.buyPrice = String(dto.buyPrice);
    if (dto.sellPrice !== undefined) patch.sellPrice = String(dto.sellPrice);
    if (dto.shares !== undefined) patch.shares = String(dto.shares);
    if (dto.realizedPl !== undefined) patch.realizedPl = String(dto.realizedPl);
    if (dto.returnPct !== undefined) patch.returnPct = String(dto.returnPct);
    if (dto.notes !== undefined) patch.notes = dto.notes;

    if (Object.keys(patch).length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new BadRequestException('未提供可更新字段');

    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    const rows = await this.db
      .update(closed)
      .set(patch)
      .where(and(eq(closed.id, id), eq(closed.owner, userId)))
      .returning();

    if (rows.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('已平仓记录不存在');

    const row = rows[0];
    return {
      id: row.id,
      ticker: row.ticker,
      company: row.company ?? null,
      openDate: row.openDate ?? null,
      closeDate: row.closeDate ?? null,
      buyPrice: row.buyPrice ? String(row.buyPrice) : null,
      sellPrice: row.sellPrice ? String(row.sellPrice) : null,
      shares: row.shares ? String(row.shares) : null,
      realizedPl: row.realizedPl ? String(row.realizedPl) : null,
      returnPct: row.returnPct ? String(row.returnPct) : null,
      notes: row.notes ?? null,
    };
  }

  /**
   * Deletes an owned closed position.
   *
   * @param userId Owner id used for the ownership filter.
   * @param id     Closed-position primary key.
   * @throws NotFoundException if the row does not belong to the user.
   */
  async remove(userId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(closed)
      .where(and(eq(closed.id, id), eq(closed.owner, userId)))
      .returning({ id: closed.id });

    if (rows.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('已平仓记录不存在');
  }

  /**
   * Aggregates realized P&L for the user's closed positions: totals per currency,
   * winner/loser counts, and a per-ticker breakdown sorted by P&L. Currency per
   * ticker is resolved from the transactions table (closed rows carry no currency).
   *
   * @param userId Owner id.
   */
  async getRealizedSummary(userId: string): Promise<RealizedPlSummary> {
    const closedRows = await this.db
      .select()
      .from(closed)
      .where(eq(closed.owner, userId))
      .orderBy(desc(closed.closeDate));

    if (closedRows.length === 0) {
      return {
        totalByCurrency: { USD: '0.00', HKD: '0.00', CNY: '0.00' },
        totalWinners: 0,
        totalLosers: 0,
        items: [],
      };
    }

    const tickers: string[] = [];
    const tickerSet = new Set<string>();
    for (const row of closedRows) {
      if (!tickerSet.has(row.ticker)) {
        tickerSet.add(row.ticker);
        tickers.push(row.ticker);
      }
    }

    // Look up distinct ticker -> currency from the transactions table.
    const currencyRows = await this.db
      .select({
        ticker: transactions.ticker,
        currency: transactions.currency,
      })
      .from(transactions)
      .where(and(eq(transactions.owner, userId), inArray(transactions.ticker, tickers)))
      .groupBy(transactions.ticker, transactions.currency);

    const currencyMap = new Map<string, string>();
    for (const row of currencyRows) {
      if (!currencyMap.has(row.ticker) && row.currency) {
        currencyMap.set(row.ticker, row.currency);
      }
    }

    // Aggregate closed rows by ticker.
    const byTicker = new Map<
      string,
      {
        company: string | null;
        totalPl: number;
        totalCost: number;
        totalShares: number;
        closeCount: number;
        lastCloseDate: string | null;
        currency: string;
      }
    >();

    for (const row of closedRows) {
      const existing = byTicker.get(row.ticker);
      const pl = row.realizedPl != null ? Number(row.realizedPl) : 0;
      const shares = row.shares != null ? Number(row.shares) : 0;
      // Cost basis for this closed lot = buyPrice * shares.
      const cost =
        row.buyPrice != null && row.shares != null ? Number(row.buyPrice) * Number(row.shares) : 0;

      if (existing) {
        existing.totalPl += pl;
        existing.totalCost += cost;
        existing.totalShares += shares;
        existing.closeCount += 1;
        const closeDate = row.closeDate ? String(row.closeDate) : null;
        if (closeDate && (!existing.lastCloseDate || closeDate > existing.lastCloseDate)) {
          existing.lastCloseDate = closeDate;
        }
      } else {
        byTicker.set(row.ticker, {
          company: row.company ?? null,
          totalPl: pl,
          totalCost: cost,
          totalShares: shares,
          closeCount: 1,
          lastCloseDate: row.closeDate ? String(row.closeDate) : null,
          currency: currencyMap.get(row.ticker) || 'USD',
        });
      }
    }

    const items: RealizedPlItem[] = [];
    const totalByCurrency: Record<string, number> = { USD: 0, HKD: 0, CNY: 0 };
    let totalWinners = 0;
    let totalLosers = 0;

    for (const [ticker, data] of byTicker) {
      const returnPct =
        data.totalCost > 0 ? ((data.totalPl / data.totalCost) * 100).toFixed(2) : null;

      items.push({
        ticker,
        company: data.company,
        realizedPl: data.totalPl.toFixed(2),
        returnPct,
        totalShares: data.totalShares.toFixed(4),
        closeCount: data.closeCount,
        lastCloseDate: data.lastCloseDate ?? '',
        currency: data.currency,
      });

      const cur = data.currency.toUpperCase();
      if (totalByCurrency[cur] !== undefined) {
        totalByCurrency[cur] += data.totalPl;
      } else {
        totalByCurrency[cur] = data.totalPl;
      }

      if (data.totalPl > 0) {
        totalWinners += 1;
      } else if (data.totalPl < 0) {
        totalLosers += 1;
      }
    }

    // Sort by realized P&L descending (best performers first).
    items.sort((a, b) => parseFloat(b.realizedPl) - parseFloat(a.realizedPl));

    const totalByCurrencyStr: Record<string, string> = {};
    for (const cur of Object.keys(totalByCurrency)) {
      totalByCurrencyStr[cur] = totalByCurrency[cur].toFixed(2);
    }

    return {
      totalByCurrency: totalByCurrencyStr,
      totalWinners,
      totalLosers,
      items,
    };
  }
}
