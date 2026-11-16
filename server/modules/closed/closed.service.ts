/**
 * closed.service.ts — 已平仓服务。
 *
 * 职责边界：
 *  - 承载已实现（平仓）持仓的业务规则与 PostgreSQL（Drizzle）数据访问；
 *    大多数已平仓记录由 transactions 的对账逻辑自动派生，本服务另外支持手工增删改。
 * 上下游：
 *  - 上游（谁调用本服务）：ClosedController（CRUD 与汇总）、transactions 模块的对账逻辑。
 *  - 下游（本文件调用谁）：Drizzle 数据库（closed、transactions 两张表）、shared 契约类型。
 * 关键约定：
 *  - 所有查询都按 owner（userId）过滤，跨用户不可见。
 *  - closed 表本身不存币种；汇总时从 transactions 表反查每个 ticker 的币种。
 *  - 价格/股数/盈亏字段：DB 内为 numeric，API 层一律转换为字符串数值返回。
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

/** 新建 DTO 的部分更新变体。 */
type UpdateClosedDto = Partial<CreateClosedDto>;

/**
 * 提供已平仓记录的 CRUD 与已实现盈亏聚合，依赖注入的 Drizzle 数据库连接。
 */
@Injectable()
export class ClosedService {
  private readonly logger = new Logger(ClosedService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * 列出用户全部已平仓记录，按平仓日期倒序（最近平仓的在前）。
   *
   * @param userId 来自鉴权请求的 owner id。
   * @returns 转换为 API 形状的 ClosedPosition 数组。
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
   * 手工新建一条已平仓记录。
   *
   * @param userId owner id。
   * @param dto    新建载荷。
   * @returns 新建后的 ClosedPosition。
   */
  async create(userId: string, dto: CreateClosedDto): Promise<ClosedPosition> {
    // 数值字段在 DTO 里可为 number，落库前统一转字符串（numeric 列）。
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
   * 部分更新一条属于当前用户的已平仓记录；同时刷新 `updatedAt`/`updatedBy` 审计字段。
   *
   * @param userId 用于 owner 过滤与审计落款的用户 id。
   * @param id     已平仓记录主键。
   * @param dto    部分更新载荷。
   * @returns 更新后的 ClosedPosition。
   * @throws BadRequestException 当未提供任何可更新字段时。
   * @throws NotFoundException 当记录不存在或不属于该用户时。
   */
  async update(userId: string, id: string, dto: UpdateClosedDto): Promise<ClosedPosition> {
    // 只把 payload 中显式给出的字段搬进 patch，未提及的字段保持原值。
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
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new BadRequestException('未提供可更新字段');

    // 补齐审计字段：修改时间与修改人。
    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    const rows = await this.db
      .update(closed)
      .set(patch)
      .where(and(eq(closed.id, id), eq(closed.owner, userId)))
      .returning();

    if (rows.length === 0)
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
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
   * 删除一条属于当前用户的已平仓记录。
   *
   * @param userId 用于 owner 过滤的用户 id。
   * @param id     已平仓记录主键。
   * @throws NotFoundException 当记录不存在或不属于该用户时。
   */
  async remove(userId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(closed)
      .where(and(eq(closed.id, id), eq(closed.owner, userId)))
      .returning({ id: closed.id });

    if (rows.length === 0)
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new NotFoundException('已平仓记录不存在');
  }

  /**
   * 聚合用户已平仓记录的已实现盈亏：按币种合计、盈/亏标的数、按标的分组明细（按盈亏排序）。
   * 每个 ticker 的币种从 transactions 表反查（closed 行本身不存币种）。
   *
   * @param userId owner id。
   * @returns RealizedPlSummary 汇总对象。
   */
  async getRealizedSummary(userId: string): Promise<RealizedPlSummary> {
    const closedRows = await this.db
      .select()
      .from(closed)
      .where(eq(closed.owner, userId))
      .orderBy(desc(closed.closeDate));

    // 无任何平仓记录时直接返回零值汇总，避免后续空集合运算。
    if (closedRows.length === 0) {
      return {
        totalByCurrency: { USD: '0.00', HKD: '0.00', CNY: '0.00' },
        totalWinners: 0,
        totalLosers: 0,
        items: [],
      };
    }

    // 收集出现过的 ticker 去重清单，保持首见顺序。
    const tickers: string[] = [];
    const tickerSet = new Set<string>();
    for (const row of closedRows) {
      if (!tickerSet.has(row.ticker)) {
        tickerSet.add(row.ticker);
        tickers.push(row.ticker);
      }
    }

    // 从 transactions 表反查 ticker -> 币种（去重组合）。
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

    // 按 ticker 聚合平仓行：累加盈亏、成本、股数与平仓次数。
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
      // 该平仓批次的成本基础 = 买入价 × 股数。
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

    // 汇总初始化：明细列表、按币种合计（number 形态）、盈亏标的计数。
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

    // 按已实现盈亏降序排序（表现最好的在前）。
    items.sort((a, b) => parseFloat(b.realizedPl) - parseFloat(a.realizedPl));

    // 币种合计从 number 转回字符串数值，对齐 API 契约。
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
