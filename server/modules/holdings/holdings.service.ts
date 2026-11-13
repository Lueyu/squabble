/**
 * Holdings service.
 *
 * Owns all business logic and PostgreSQL (Drizzle) data access for stock holdings.
 * Every query is owner-scoped by appending `owner = <userId>` so users can only
 * see and modify their own rows. Monetary/shares columns are declared as Postgres
 * `numeric`, which Drizzle returns as JS strings; they are converted with
 * `String(...)` on write and passed through on read to avoid floating-point drift.
 * On create, market/currency display metadata is auto-detected from the ticker via
 * `QuoteService.detectMarket`.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, desc, and } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';

import { holdings } from '@server/database/schema';
import { QuoteService } from './../quote/quote.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import type {
  Holding,
  CreateHoldingDto,
  UpdateHoldingDto,
  ListResponse,
  BatchPriceUpdateDto,
} from '@shared/api.interface';

/**
 * Provides holdings CRUD and batch price updates. Depends on the Drizzle database
 * connection and `QuoteService` (for market detection).
 */
@Injectable()
export class HoldingsService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly quoteService: QuoteService,
  ) {}

  /**
   * Returns all holdings for a user, ordered by most recently updated.
   *
   * @param userId Owner id from the authenticated request.
   */
  async findAll(userId: string): Promise<ListResponse<Holding>> {
    const rows = await this.db
      .select()
      .from(holdings)
      .where(eq(holdings.owner, userId))
      .orderBy(desc(holdings.updatedAt));
    return { items: rows.map((r) => this.mapRow(r)) };
  }

  /**
   * Fetches a single holding by id, but only when it belongs to the caller.
   *
   * @param id     Holding primary key.
   * @param userId Owner id; used both as the ownership filter.
   * @throws NotFoundException if no matching (id, owner) row exists.
   */
  async findOne(id: string, userId: string): Promise<Holding> {
    const rows = await this.db
      .select()
      .from(holdings)
      .where(and(eq(holdings.id, id), eq(holdings.owner, userId)));
    if (rows.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('持仓不存在');
    return this.mapRow(rows[0]);
  }

  /**
   * Creates a holding for the user. Market/currency/symbol fields are derived from
   * the ticker rather than supplied by the client.
   *
   * @param dto    Create payload.
   * @param userId Owner id; stamped onto owner/createdBy/updatedBy.
   */
  async create(dto: CreateHoldingDto, userId: string): Promise<Holding> {
    const marketInfo = this.quoteService.detectMarket(dto.ticker);
    const rows = await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, userId);
      return tx
        .insert(holdings)
        .values({
          ticker: dto.ticker,
          company: dto.company,
          sector: dto.sector,
          buyDate: dto.buyDate,
          // numeric columns are written as strings to preserve exact decimal values.
          buyPrice: dto.buyPrice !== undefined ? String(dto.buyPrice) : undefined,
          shares: String(dto.shares),
          currentPrice: dto.currentPrice !== undefined ? String(dto.currentPrice) : undefined,
          rating: dto.rating,
          action: dto.action,
          analysis: dto.analysis,
          targetPrice: dto.targetPrice !== undefined ? String(dto.targetPrice) : undefined,
          groupId: dto.groupId,
          market: marketInfo.market,
          currency: marketInfo.currency,
          symbolNative: marketInfo.symbolNative,
          displaySymbol: marketInfo.displaySymbol,
          owner: userId,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
    });
    return this.mapRow(rows[0]);
  }

  /**
   * Partially updates an owned holding. Only fields present in the DTO are
   * changed; `updatedAt`/`updatedBy` are always refreshed.
   *
   * @param id     Holding primary key.
   * @param dto    Partial update payload.
   * @param userId Owner id; required for the ownership filter and audit stamp.
   * @throws NotFoundException if the holding does not belong to the user.
   */
  async update(id: string, dto: UpdateHoldingDto, userId: string): Promise<Holding> {
    const patch: Partial<typeof holdings.$inferInsert> = {};
    if (dto.company !== undefined) patch.company = dto.company;
    if (dto.sector !== undefined) patch.sector = dto.sector;
    if (dto.buyDate !== undefined) patch.buyDate = dto.buyDate;
    if (dto.buyPrice !== undefined) patch.buyPrice = String(dto.buyPrice);
    if (dto.shares !== undefined) patch.shares = String(dto.shares);
    if (dto.currentPrice !== undefined) patch.currentPrice = String(dto.currentPrice);
    if (dto.rating !== undefined) patch.rating = dto.rating;
    if (dto.action !== undefined) patch.action = dto.action;
    if (dto.analysis !== undefined) patch.analysis = dto.analysis;
    if (dto.targetPrice !== undefined) patch.targetPrice = String(dto.targetPrice);
    if (dto.groupId !== undefined) patch.groupId = dto.groupId;
    if (dto.market !== undefined) patch.market = dto.market;
    if (dto.currency !== undefined) patch.currency = dto.currency;
    if (dto.symbolNative !== undefined) patch.symbolNative = dto.symbolNative;
    if (dto.displaySymbol !== undefined) patch.displaySymbol = dto.displaySymbol;

    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    const rows = await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, userId);
      return tx
        .update(holdings)
        .set(patch)
        .where(and(eq(holdings.id, id), eq(holdings.owner, userId)))
        .returning();
    });
    if (rows.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('持仓不存在');
    return this.mapRow(rows[0]);
  }

  /**
   * Deletes an owned holding.
   *
   * @param id     Holding primary key.
   * @param userId Owner id; required for the ownership filter.
   * @throws NotFoundException if the holding does not belong to the user.
   */
  async remove(id: string, userId: string): Promise<{ success: true }> {
    const rows = await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, userId);
      return tx
        .delete(holdings)
        .where(and(eq(holdings.id, id), eq(holdings.owner, userId)))
        .returning({ id: holdings.id });
    });
    if (rows.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('持仓不存在');
    return { success: true };
  }

  /**
   * Batch-updates the current price of multiple holdings, matched by
   * (ticker, owner). Runs inside a single transaction so all updates commit or
   * roll back together.
   *
   * @param items  Ticker/price pairs to apply.
   * @param userId Owner id; scopes which rows may be updated.
   */
  async updatePrices(items: BatchPriceUpdateDto[], userId: string): Promise<{ success: true }> {
    await this.db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .update(holdings)
          .set({
            currentPrice: String(item.price),
            updatedAt: new Date(),
            updatedBy: userId,
          })
          .where(and(eq(holdings.ticker, item.ticker), eq(holdings.owner, userId)));
      }
    });
    return { success: true };
  }

  /**
   * Maps a raw Drizzle row to the API `Holding` shape. Coerces defaults for
   * nullable market/currency and serializes the timestamp.
   *
   * @param row Raw holdings table row.
   */
  private mapRow(row: typeof holdings.$inferSelect): Holding {
    return {
      id: row.id,
      ticker: row.ticker,
      company: row.company,
      sector: row.sector,
      buyDate: row.buyDate,
      buyPrice: row.buyPrice,
      shares: row.shares,
      currentPrice: row.currentPrice,
      rating: row.rating,
      action: row.action,
      analysis: row.analysis,
      targetPrice: row.targetPrice,
      groupId: row.groupId,
      // Default to US market / USD for legacy rows created before market detection.
      market: (row.market as Holding['market']) || 'US',
      currency: (row.currency as Holding['currency']) || 'USD',
      symbolNative: row.symbolNative ?? null,
      displaySymbol: row.displaySymbol ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
