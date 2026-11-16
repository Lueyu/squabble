/**
 * Alpha-picks service.
 *
 * Business logic and PostgreSQL (Drizzle) data access for the user's curated alpha
 * picks. Rows are owner-scoped; numeric fields are stored as Postgres `numeric`
 * and round-tripped as strings.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, desc, and } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';

import { alphaPicks } from '@server/database/schema';
import type { AlphaPick, CreateAlphaPickDto, ListResponse } from '@shared/api.interface';

/** Partial update payload for an alpha pick (all fields optional). */
export interface UpdateAlphaPickDto {
  company?: string;
  sector?: string;
  datePicked?: string;
  returnPct?: number;
  rating?: string;
  weightPct?: number;
}

/**
 * Provides alpha-pick CRUD. Depends on the Drizzle database connection.
 */
@Injectable()
export class AlphaPicksService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * Lists all alpha picks for a user, newest pick first.
   *
   * @param userId Owner id.
   */
  async findAll(userId: string): Promise<ListResponse<AlphaPick>> {
    const rows = await this.db
      .select()
      .from(alphaPicks)
      .where(eq(alphaPicks.owner, userId))
      .orderBy(desc(alphaPicks.datePicked));
    return { items: rows.map((r) => this.mapRow(r)) };
  }

  /**
   * Creates a new alpha pick owned by the user.
   *
   * @param dto    Pick payload.
   * @param userId Owner id.
   */
  async create(dto: CreateAlphaPickDto, userId: string): Promise<AlphaPick> {
    const rows = await this.db
      .insert(alphaPicks)
      .values({
        ticker: dto.ticker,
        company: dto.company,
        sector: dto.sector,
        datePicked: dto.datePicked,
        returnPct: dto.returnPct !== undefined ? String(dto.returnPct) : undefined,
        rating: dto.rating,
        weightPct: dto.weightPct !== undefined ? String(dto.weightPct) : undefined,
        owner: userId,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    return this.mapRow(rows[0]);
  }

  /**
   * Updates an owned alpha pick.
   *
   * @param id     Pick primary key.
   * @param dto    Partial update payload.
   * @param userId Owner id.
   * @throws NotFoundException if the pick does not belong to the user.
   */
  async update(id: string, dto: UpdateAlphaPickDto, userId: string): Promise<AlphaPick> {
    const patch: Partial<typeof alphaPicks.$inferInsert> = {};
    if (dto.company !== undefined) patch.company = dto.company;
    if (dto.sector !== undefined) patch.sector = dto.sector;
    if (dto.datePicked !== undefined) patch.datePicked = dto.datePicked;
    if (dto.returnPct !== undefined) patch.returnPct = String(dto.returnPct);
    if (dto.rating !== undefined) patch.rating = dto.rating;
    if (dto.weightPct !== undefined) patch.weightPct = String(dto.weightPct);

    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    const rows = await this.db
      .update(alphaPicks)
      .set(patch)
      .where(and(eq(alphaPicks.id, id), eq(alphaPicks.owner, userId)))
      .returning();
    if (rows.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('推荐记录不存在');
    return this.mapRow(rows[0]);
  }

  /**
   * Deletes an owned alpha pick.
   *
   * @param id     Pick primary key.
   * @param userId Owner id.
   * @throws NotFoundException if the pick does not belong to the user.
   */
  async remove(id: string, userId: string): Promise<{ success: true }> {
    const rows = await this.db
      .delete(alphaPicks)
      .where(and(eq(alphaPicks.id, id), eq(alphaPicks.owner, userId)))
      .returning({ id: alphaPicks.id });
    if (rows.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('推荐记录不存在');
    return { success: true };
  }

  /**
   * Maps a raw alpha-picks row to the API `AlphaPick` shape.
   *
   * @param row Raw alphaPicks table row.
   */
  private mapRow(row: typeof alphaPicks.$inferSelect): AlphaPick {
    return {
      id: row.id,
      ticker: row.ticker,
      company: row.company,
      sector: row.sector,
      datePicked: row.datePicked,
      returnPct: row.returnPct,
      rating: row.rating,
      weightPct: row.weightPct,
    };
  }
}
