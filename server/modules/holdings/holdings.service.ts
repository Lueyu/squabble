/**
 * holdings.service.ts — 持仓（Holdings）的全部业务逻辑与 PostgreSQL（Drizzle）数据访问。
 *
 * 职责边界：
 *  - 负责持仓的增删改查与批量价格更新，以及 Drizzle 行 → API Holding 形状的映射。
 *  - 不调用上游行情源；ticker 的市场/币种展示元数据复用 QuoteService.detectMarket 推导。
 * 上下游：
 *  - 上游：HoldingsController（/api/portfolio/holdings 的 CRUD 路由）。
 *  - 下游：Drizzle 数据库（holdings 表）与 QuoteService（仅 detectMarket）。
 * 关键约定：
 *  - 每条查询都以 owner = <userId> 过滤收尾，用户只能看到并修改自己的行。
 *  - 金额/股数列声明为 Postgres numeric，Drizzle 以 JS 字符串返回：写入用 String(...)
 *    转换、读取原样透传，避免浮点精度漂移。
 *  - 新增持仓时 market/currency/symbol 展示元数据由 ticker 推导，不由客户端提供。
 *  - 归属校验失败抛 NotFoundException('持仓不存在')——面向用户的中文文案（既有行为，非乱码）。
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, desc, and } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';

import { holdings } from '@server/database/schema';
import { QuoteService } from './../quote/quote.service';
import type {
  Holding,
  CreateHoldingDto,
  UpdateHoldingDto,
  ListResponse,
  BatchPriceUpdateDto,
} from '@shared/api.interface';

/**
 * 提供持仓的增删改查与批量价格更新。依赖 Drizzle 数据库连接
 * 与 QuoteService（用于市场识别）。
 */
@Injectable()
export class HoldingsService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly quoteService: QuoteService,
  ) {}

  /**
   * 返回某用户的全部持仓，按最近更新时间倒序。
   *
   * @param userId 来自已认证请求的归属用户 id
   */
  async findAll(userId: string): Promise<ListResponse<Holding>> {
    // 按 owner 过滤并按 updatedAt 倒序取全部持仓。
    const rows = await this.db
      .select()
      .from(holdings)
      .where(eq(holdings.owner, userId))
      .orderBy(desc(holdings.updatedAt));
    // 逐行映射为 API 形状后包装成列表响应。
    return { items: rows.map((r) => this.mapRow(r)) };
  }

  /**
   * 按 id 获取单条持仓，但仅当它属于调用者时返回。
   *
   * @param id     持仓主键
   * @param userId 归属用户 id（用作归属过滤）
   * @throws NotFoundException 当 (id, owner) 无匹配行时抛出
   */
  async findOne(id: string, userId: string): Promise<Holding> {
    // 以 (id, owner) 双条件查询，天然防止跨用户读取。
    const rows = await this.db
      .select()
      .from(holdings)
      .where(and(eq(holdings.id, id), eq(holdings.owner, userId)));
    if (rows.length === 0)
      // 注意：此处是面向用户的中文文案（既有行为，并非乱码）。
      throw new NotFoundException('持仓不存在');
    return this.mapRow(rows[0]);
  }

  /**
   * 为某用户新建持仓。market/currency/symbol 字段由 ticker 推导，而非客户端提供。
   *
   * @param dto    创建载荷
   * @param userId 写入 owner/createdBy/updatedBy 的归属用户 id
   */
  async create(dto: CreateHoldingDto, userId: string): Promise<Holding> {
    // 用 ticker 推导市场/币种/本地代码等展示元数据。
    const marketInfo = this.quoteService.detectMarket(dto.ticker);
    // 插入新行：numeric 列统一 String(...) 后落库以保留精确小数。
    const rows = await this.db
      .insert(holdings)
      .values({
        ticker: dto.ticker,
        company: dto.company,
        sector: dto.sector,
        buyDate: dto.buyDate,
        // numeric 列以字符串写入，保留精确小数值。
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
    return this.mapRow(rows[0]);
  }

  /**
   * 部分更新一条归属该用户的持仓。只改 DTO 中出现的字段；
   * updatedAt/updatedBy 总是刷新。
   *
   * @param id     持仓主键
   * @param dto    部分更新载荷
   * @param userId 用于归属过滤与审计字段的归属用户 id
   * @throws NotFoundException 当持仓不属于该用户时抛出
   */
  async update(id: string, dto: UpdateHoldingDto, userId: string): Promise<Holding> {
    // 仅收集载荷中显式提供的字段；金额/股数转换成字符串落库。
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

    // 每次更新都刷新审计字段（updatedAt/updatedBy）。
    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    // 以 (id, owner) 双条件更新，天然防止跨用户改写。
    const rows = await this.db
      .update(holdings)
      .set(patch)
      .where(and(eq(holdings.id, id), eq(holdings.owner, userId)))
      .returning();
    if (rows.length === 0)
      // 注意：此处是面向用户的中文文案（既有行为，并非乱码）。
      throw new NotFoundException('持仓不存在');
    return this.mapRow(rows[0]);
  }

  /**
   * 删除一条归属该用户的持仓。
   *
   * @param id     持仓主键
   * @param userId 用于归属过滤的归属用户 id
   * @throws NotFoundException 当持仓不属于该用户时抛出
   */
  async remove(id: string, userId: string): Promise<{ success: true }> {
    // 以 (id, owner) 双条件删除；仅返回被删行的 id 用于判断是否命中。
    const rows = await this.db
      .delete(holdings)
      .where(and(eq(holdings.id, id), eq(holdings.owner, userId)))
      .returning({ id: holdings.id });
    if (rows.length === 0)
      // 注意：此处是面向用户的中文文案（既有行为，并非乱码）。
      throw new NotFoundException('持仓不存在');
    return { success: true };
  }

  /**
   * 按 (ticker, owner) 批量更新多条持仓的当前价格。
   * 在单个事务内执行，全部更新要么一起提交、要么一起回滚。
   *
   * @param items  待应用的 ticker/价格对
   * @param userId 限定可更新行的归属用户 id
   */
  async updatePrices(items: BatchPriceUpdateDto[], userId: string): Promise<{ success: true }> {
    // 整批放在一个事务里：任一条失败则全部回滚。
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
   * 把 Drizzle 原始行映射为 API 的 Holding 形状：为可空的 market/currency
   * 补默认值，并序列化时间戳。
   *
   * @param row holdings 表的原始行
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
      // 早于市场识别功能创建的遗留行，默认按美股 / USD 处理。
      market: (row.market as Holding['market']) || 'US',
      currency: (row.currency as Holding['currency']) || 'USD',
      symbolNative: row.symbolNative ?? null,
      displaySymbol: row.displaySymbol ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
