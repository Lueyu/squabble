/**
 * Groups service.
 *
 * Business logic and PostgreSQL (Drizzle) data access for portfolio groups
 * (user-defined labels that organize holdings). All queries are owner-scoped
 * (`owner = <userId>`), and lists are returned in the user-defined `sort` order.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, asc, and } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';

import { groups } from '@server/database/schema';
import type { Group, CreateGroupDto, UpdateGroupDto, ListResponse } from '@shared/api.interface';

/**
 * Provides group CRUD. Depends on the Drizzle database connection.
 */
@Injectable()
export class GroupsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * Returns all groups for a user, ordered by the user's sort field ascending.
   *
   * @param userId Owner id from the authenticated request.
   */
  async findAll(userId: string): Promise<ListResponse<Group>> {
    const rows = await this.db
      .select()
      .from(groups)
      .where(eq(groups.owner, userId))
      .orderBy(asc(groups.sort));
    return { items: rows.map((r) => this.mapRow(r)) };
  }

  /**
   * Creates a group for the user.
   *
   * @param dto    Create payload.
   * @param userId Owner id stamped onto owner/createdBy/updatedBy.
   */
  async create(dto: CreateGroupDto, userId: string): Promise<Group> {
    const rows = await this.db
      .insert(groups)
      .values({
        name: dto.name,
        color: dto.color,
        sort: dto.sort,
        owner: userId,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    return this.mapRow(rows[0]);
  }

  /**
   * Partially updates an owned group; refreshes `updatedAt`/`updatedBy`.
   *
   * @param id     Group primary key.
   * @param dto    Partial update payload.
   * @param userId Owner id used for the ownership filter and audit stamp.
   * @throws NotFoundException if the group does not belong to the user.
   */
  async update(id: string, dto: UpdateGroupDto, userId: string): Promise<Group> {
    const patch: Partial<typeof groups.$inferInsert> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.color !== undefined) patch.color = dto.color;
    if (dto.sort !== undefined) patch.sort = dto.sort;

    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    const rows = await this.db
      .update(groups)
      .set(patch)
      .where(and(eq(groups.id, id), eq(groups.owner, userId)))
      .returning();
    if (rows.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('分组不存在');
    return this.mapRow(rows[0]);
  }

  /**
   * Deletes an owned group.
   *
   * @param id     Group primary key.
   * @param userId Owner id used for the ownership filter.
   * @throws NotFoundException if the group does not belong to the user.
   */
  async remove(id: string, userId: string): Promise<{ success: true }> {
    const rows = await this.db
      .delete(groups)
      .where(and(eq(groups.id, id), eq(groups.owner, userId)))
      .returning({ id: groups.id });
    if (rows.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('分组不存在');
    return { success: true };
  }

  /**
   * Maps a raw Drizzle row to the API `Group` shape, defaulting sort to 0.
   *
   * @param row Raw groups table row.
   */
  private mapRow(row: typeof groups.$inferSelect): Group {
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      sort: row.sort ?? 0,
    };
  }
}
