/**
 * groups.service.ts — 持仓分组（Groups）的业务逻辑与 PostgreSQL（Drizzle）数据访问。
 *
 * 职责边界：
 *  - 负责分组的增删改查，以及 Drizzle 行 → API Group 形状的映射。
 *  - 不做行情/汇率换算，也不关心分组被哪些持仓引用。
 * 上下游：
 *  - 上游：GroupsController（/api/portfolio/groups 的 CRUD 路由）。
 *  - 下游：Drizzle 数据库连接（注入 DRIZZLE_DATABASE），操作 groups 表。
 * 关键约定：
 *  - 所有查询都以 owner = <userId> 过滤，天然按登录用户隔离数据。
 *  - 列表按用户自定义的 sort 字段升序返回；sort 为空的行映射时默认 0。
 *  - 归属校验失败抛 NotFoundException('分组不存在')——面向用户的中文文案（既有行为，非乱码）。
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, asc, and } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';

import { groups } from '@server/database/schema';
import type { Group, CreateGroupDto, UpdateGroupDto, ListResponse } from '@shared/api.interface';

/**
 * 提供分组的增删改查。依赖 Drizzle 数据库连接。
 */
@Injectable()
export class GroupsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * 返回某用户的全部分组，按该用户的 sort 字段升序排列。
   *
   * @param userId 来自已认证请求的归属用户 id
   */
  async findAll(userId: string): Promise<ListResponse<Group>> {
    // 按 owner 过滤并按 sort 升序取全部分组。
    const rows = await this.db
      .select()
      .from(groups)
      .where(eq(groups.owner, userId))
      .orderBy(asc(groups.sort));
    // 逐行映射为 API 形状后包装成列表响应。
    return { items: rows.map((r) => this.mapRow(r)) };
  }

  /**
   * 为某用户创建分组。
   *
   * @param dto    创建载荷
   * @param userId 写入 owner/createdBy/updatedBy 的归属用户 id
   */
  async create(dto: CreateGroupDto, userId: string): Promise<Group> {
    // 插入新行：名称/颜色/排序来自载荷，三个归属字段统一打上当前用户。
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
   * 部分更新一个归属该用户的分组；同时刷新 updatedAt/updatedBy。
   *
   * @param id     分组主键
   * @param dto    部分更新载荷
   * @param userId 用于归属过滤与审计字段的用户 id
   * @throws NotFoundException 当分组不属于该用户时抛出
   */
  async update(id: string, dto: UpdateGroupDto, userId: string): Promise<Group> {
    // 仅收集载荷中显式提供的字段，构造部分更新补丁。
    const patch: Partial<typeof groups.$inferInsert> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.color !== undefined) patch.color = dto.color;
    if (dto.sort !== undefined) patch.sort = dto.sort;

    // 每次更新都刷新审计字段（updatedAt/updatedBy）。
    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    // 以 (id, owner) 双条件更新，天然防止跨用户改写。
    const rows = await this.db
      .update(groups)
      .set(patch)
      .where(and(eq(groups.id, id), eq(groups.owner, userId)))
      .returning();
    if (rows.length === 0)
      // 注意：此处是面向用户的中文文案（既有行为，并非乱码）。
      throw new NotFoundException('分组不存在');
    return this.mapRow(rows[0]);
  }

  /**
   * 删除一个归属该用户的分组。
   *
   * @param id     分组主键
   * @param userId 用于归属过滤的用户 id
   * @throws NotFoundException 当分组不属于该用户时抛出
   */
  async remove(id: string, userId: string): Promise<{ success: true }> {
    // 以 (id, owner) 双条件删除；仅返回被删行的 id 用于判断是否命中。
    const rows = await this.db
      .delete(groups)
      .where(and(eq(groups.id, id), eq(groups.owner, userId)))
      .returning({ id: groups.id });
    if (rows.length === 0)
      // 注意：此处是面向用户的中文文案（既有行为，并非乱码）。
      throw new NotFoundException('分组不存在');
    return { success: true };
  }

  /**
   * 把 Drizzle 原始行映射为 API 的 Group 形状，sort 缺省时取 0。
   *
   * @param row groups 表的原始行
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
