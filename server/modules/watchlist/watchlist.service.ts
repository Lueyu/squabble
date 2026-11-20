/**
 * watchlist.service.ts — 自选列表（Watchlist）的业务逻辑与 PostgreSQL（Drizzle）数据访问。
 *
 * 职责边界：
 *  - 负责自选项的增删改查与批量价格更新，以及 Drizzle 行 → API WatchItem 形状的映射。
 *  - 不调用上游行情源；ticker 的市场/币种识别复用 QuoteService.detectMarket。
 * 上下游：
 *  - 上游：WatchlistController（/api/portfolio/watchlist 的 CRUD 路由）。
 *  - 下游：Drizzle 数据库（watchlist 表）与 QuoteService（仅 detectMarket）。
 * 关键约定：
 *  - 所有查询都以 owner = <userId> 过滤，天然按登录用户隔离数据。
 *  - 价格类列是 Postgres numeric，Drizzle 以 JS 字符串返回：写入用 String(...)
 *    转换、读取原样透传，避免浮点精度漂移。
 *  - 新增自选时 market/currency 由服务端从 ticker 推导，不由客户端提供。
 *  - 归属校验失败抛 NotFoundException('关注项不存在')——面向用户的中文文案（既有行为，非乱码）。
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, desc, and } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';

import { watchlist } from '@server/database/schema';
import { QuoteService } from './../quote/quote.service';
import type {
  WatchItem,
  CreateWatchItemDto,
  UpdateWatchItemDto,
  ListResponse,
  BatchPriceUpdateDto,
} from '@shared/api.interface';

/**
 * 提供自选项的增删改查与批量价格更新。依赖 Drizzle 数据库连接，
 * 并用 QuoteService 做 ticker 市场识别。
 */
@Injectable()
export class WatchlistService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly quoteService: QuoteService,
  ) {}

  /**
   * 返回某用户的全部自选项，按最近更新时间倒序。
   *
   * @param userId 来自已认证请求的归属用户 id
   */
  async findAll(userId: string): Promise<ListResponse<WatchItem>> {
    // 按 owner 过滤并按 updatedAt 倒序取全部自选项。
    const rows = await this.db
      .select()
      .from(watchlist)
      .where(eq(watchlist.owner, userId))
      .orderBy(desc(watchlist.updatedAt));
    // 逐行映射为 API 形状后包装成列表响应。
    return { items: rows.map((r) => this.mapRow(r)) };
  }

  /**
   * 按 id 获取单条自选项，且仅当它属于调用者时返回。
   *
   * @param id     自选项主键
   * @param userId 用作归属过滤的用户 id
   * @throws NotFoundException 当 (id, owner) 无匹配行时抛出
   */
  async findOne(id: string, userId: string): Promise<WatchItem> {
    // 以 (id, owner) 双条件查询，天然防止跨用户读取。
    const rows = await this.db
      .select()
      .from(watchlist)
      .where(and(eq(watchlist.id, id), eq(watchlist.owner, userId)));
    if (rows.length === 0)
      // 注意：此处是面向用户的中文文案（既有行为，并非乱码）。
      throw new NotFoundException('关注项不存在');
    return this.mapRow(rows[0]);
  }

  /**
   * 为某用户新增自选项。market/currency 字段由 ticker 推导，而非客户端提供。
   *
   * @param dto    创建载荷
   * @param userId 写入 owner/createdBy/updatedBy 的归属用户 id
   */
  async create(dto: CreateWatchItemDto, userId: string): Promise<WatchItem> {
    // 用 ticker 推导市场/币种元数据。
    const marketInfo = this.quoteService.detectMarket(dto.ticker);
    // 插入新行：价格类列统一 String(...) 后落库以保留精确小数。
    const rows = await this.db
      .insert(watchlist)
      .values({
        ticker: dto.ticker,
        company: dto.company,
        sector: dto.sector,
        dateAdded: dto.dateAdded,
        // numeric 价格列以字符串写入，保留精确小数。
        entryPrice: dto.entryPrice !== undefined ? String(dto.entryPrice) : undefined,
        currentPrice: dto.currentPrice !== undefined ? String(dto.currentPrice) : undefined,
        rating: dto.rating,
        signal: dto.signal,
        targetBuy: dto.targetBuy !== undefined ? String(dto.targetBuy) : undefined,
        analysis: dto.analysis,
        market: marketInfo.market,
        currency: marketInfo.currency,
        owner: userId,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    return this.mapRow(rows[0]);
  }

  /**
   * 部分更新一条归属该用户的自选项；同时刷新 updatedAt/updatedBy。
   *
   * @param id     自选项主键
   * @param dto    部分更新载荷
   * @param userId 用于归属过滤与审计字段的用户 id
   * @throws NotFoundException 当该项不属于该用户时抛出
   */
  async update(id: string, dto: UpdateWatchItemDto, userId: string): Promise<WatchItem> {
    // 仅收集载荷中显式提供的字段；价格类字段转换成字符串落库。
    const patch: Partial<typeof watchlist.$inferInsert> = {};
    if (dto.company !== undefined) patch.company = dto.company;
    if (dto.sector !== undefined) patch.sector = dto.sector;
    if (dto.entryPrice !== undefined) patch.entryPrice = String(dto.entryPrice);
    if (dto.currentPrice !== undefined) patch.currentPrice = String(dto.currentPrice);
    if (dto.rating !== undefined) patch.rating = dto.rating;
    if (dto.signal !== undefined) patch.signal = dto.signal;
    if (dto.targetBuy !== undefined) patch.targetBuy = String(dto.targetBuy);
    if (dto.analysis !== undefined) patch.analysis = dto.analysis;

    // 每次更新都刷新审计字段（updatedAt/updatedBy）。
    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    // 以 (id, owner) 双条件更新，天然防止跨用户改写。
    const rows = await this.db
      .update(watchlist)
      .set(patch)
      .where(and(eq(watchlist.id, id), eq(watchlist.owner, userId)))
      .returning();
    if (rows.length === 0)
      // 注意：此处是面向用户的中文文案（既有行为，并非乱码）。
      throw new NotFoundException('关注项不存在');
    return this.mapRow(rows[0]);
  }

  /**
   * 删除一条归属该用户的自选项。
   *
   * @param id     自选项主键
   * @param userId 用于归属过滤的用户 id
   * @throws NotFoundException 当该项不属于该用户时抛出
   */
  async remove(id: string, userId: string): Promise<{ success: true }> {
    // 以 (id, owner) 双条件删除；仅返回被删行的 id 用于判断是否命中。
    const rows = await this.db
      .delete(watchlist)
      .where(and(eq(watchlist.id, id), eq(watchlist.owner, userId)))
      .returning({ id: watchlist.id });
    if (rows.length === 0)
      // 注意：此处是面向用户的中文文案（既有行为，并非乱码）。
      throw new NotFoundException('关注项不存在');
    return { success: true };
  }

  /**
   * 在单个事务内按 (ticker, owner) 批量更新当前价格。
   *
   * @param items  待应用的 ticker/价格对
   * @param userId 限定可更新行的归属用户 id
   */
  async updatePrices(items: BatchPriceUpdateDto[], userId: string): Promise<{ success: true }> {
    // 整批放在一个事务里：任一条失败则全部回滚。
    await this.db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .update(watchlist)
          .set({
            currentPrice: String(item.price),
            updatedAt: new Date(),
            updatedBy: userId,
          })
          .where(and(eq(watchlist.ticker, item.ticker), eq(watchlist.owner, userId)));
      }
    });
    return { success: true };
  }

  /**
   * 把 Drizzle 原始行映射为 API 的 WatchItem 形状：为遗留行补默认的
   * market/currency，并序列化时间戳。
   *
   * @param row watchlist 表的原始行
   */
  private mapRow(row: typeof watchlist.$inferSelect): WatchItem {
    return {
      id: row.id,
      ticker: row.ticker,
      company: row.company,
      sector: row.sector,
      dateAdded: row.dateAdded,
      entryPrice: row.entryPrice,
      currentPrice: row.currentPrice,
      rating: row.rating,
      signal: row.signal,
      targetBuy: row.targetBuy,
      analysis: row.analysis,
      // 早于市场识别功能创建的遗留行，默认按美股 / USD 处理。
      market: (row.market as WatchItem['market']) || 'US',
      currency: (row.currency as WatchItem['currency']) || 'USD',
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
