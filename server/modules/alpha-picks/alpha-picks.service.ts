/**
 * Alpha-picks service（精选推荐服务）。
 *
 * 职责边界：承载 alpha picks 的业务逻辑与 PostgreSQL（Drizzle）数据访问；
 * 行按 owner 隔离，数值字段以 Postgres `numeric` 存储、以字符串往返
 * （DTO number ↔ DB string 的转换集中在此处）。不管鉴权与路由。
 *
 * 上下游：import @nestjs/common（NotFoundException）、drizzle-orm 操作符、
 * DRIZZLE_DATABASE/PostgresJsDatabase（common/platform 注入）、
 * @server/database/schema 的 alphaPicks 表、@shared/api.interface 类型；
 * 由 alpha-picks.controller.ts 调用。
 *
 * 关键约定：returnPct/weightPct 写库前 String() 转字符串；update/remove
 * 的 where 条件同时匹配 id 与 owner，未命中（0 行返回）抛
 * NotFoundException（文案'推荐记录不存在'，既有中文行为）。
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, desc, and } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';

import { alphaPicks } from '@server/database/schema';
import type { AlphaPick, CreateAlphaPickDto, ListResponse } from '@shared/api.interface';

/** Alpha pick 的部分更新载荷（所有字段均可选）。 */
export interface UpdateAlphaPickDto {
  company?: string;
  sector?: string;
  datePicked?: string;
  returnPct?: number;
  rating?: string;
  weightPct?: number;
}

/**
 * 提供 alpha pick 的 CRUD。依赖注入的 Drizzle 数据库连接。
 */
@Injectable()
export class AlphaPicksService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * 列出某用户的全部 alpha picks，按选入日期倒序（最新在前）。
   *
   * @param userId 属主 id。
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
   * 新建一条属于该用户的 alpha pick。
   *
   * @param dto    推荐载荷。
   * @param userId 属主 id。
   */
  async create(dto: CreateAlphaPickDto, userId: string): Promise<AlphaPick> {
    const rows = await this.db
      .insert(alphaPicks)
      .values({
        ticker: dto.ticker,
        company: dto.company,
        sector: dto.sector,
        datePicked: dto.datePicked,
        // Postgres numeric 以字符串存储：DTO 的 number 先转字符串再入库。
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
   * 更新一条属于该用户的 alpha pick。
   *
   * @param id     推荐主键。
   * @param dto    部分更新载荷。
   * @param userId 属主 id。
   * @throws NotFoundException 当记录不存在或不属于该用户时抛出。
   */
  async update(id: string, dto: UpdateAlphaPickDto, userId: string): Promise<AlphaPick> {
    // 仅收集 DTO 中显式给出的字段，构成部分更新 patch。
    const patch: Partial<typeof alphaPicks.$inferInsert> = {};
    if (dto.company !== undefined) patch.company = dto.company;
    if (dto.sector !== undefined) patch.sector = dto.sector;
    if (dto.datePicked !== undefined) patch.datePicked = dto.datePicked;
    if (dto.returnPct !== undefined) patch.returnPct = String(dto.returnPct);
    if (dto.rating !== undefined) patch.rating = dto.rating;
    if (dto.weightPct !== undefined) patch.weightPct = String(dto.weightPct);

    // 系统字段：任何更新都要刷新时间戳与更新人。
    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    const rows = await this.db
      .update(alphaPicks)
      .set(patch)
      .where(and(eq(alphaPicks.id, id), eq(alphaPicks.owner, userId)))
      .returning();
    if (rows.length === 0)
      // 中文用户可见文案（既有行为，非乱码）。
      throw new NotFoundException('推荐记录不存在');
    return this.mapRow(rows[0]);
  }

  /**
   * 删除一条属于该用户的 alpha pick。
   *
   * @param id     推荐主键。
   * @param userId 属主 id。
   * @throws NotFoundException 当记录不存在或不属于该用户时抛出。
   */
  async remove(id: string, userId: string): Promise<{ success: true }> {
    const rows = await this.db
      .delete(alphaPicks)
      .where(and(eq(alphaPicks.id, id), eq(alphaPicks.owner, userId)))
      .returning({ id: alphaPicks.id });
    if (rows.length === 0)
      // 中文用户可见文案（既有行为，非乱码）。
      throw new NotFoundException('推荐记录不存在');
    return { success: true };
  }

  /**
   * 把原始 alphaPicks 行映射为 API 的 `AlphaPick` 形状。
   *
   * @param row alphaPicks 表原始行。
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
