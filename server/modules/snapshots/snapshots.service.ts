/**
 * snapshots.service.ts — 每日资产快照（Snapshots）的业务逻辑与 PostgreSQL（Drizzle）数据访问。
 *
 * 职责边界：
 *  - 负责快照的读取/按日 upsert/删除，以及在写入时推导现金流派生指标。
 *  - 不直接读行情；汇率换算全部委托 FxService（forwardRef 注入以打破循环模块依赖）。
 * 上下游：
 *  - 上游：SnapshotsController（/api/portfolio/snapshots 的 CRUD 路由）与
 *    agent-gateway 的 agent.controller / agent.service。
 *  - 下游：Drizzle 数据库（snapshots、transactions 表）与 FxService.convert。
 * 关键约定：
 *  - 基准币种固定为 USD（upsert 内 const base = 'USD'）。
 *  - list() 默认返回 90 条、上限 365 条（Math.min(limit, 365)）。
 *  - 当日净入金 = 当日 Deposit(+)/Withdrawal(-) 交易按币种求和（金额取
 *    shares*price，numeric(16,4)），再按快照日汇率折成 USD。
 *  - 累计净入金 = 上一份快照的累计值 + 当日净入金（逐日链式累加）。
 *  - 日盈亏 = 账户总值变动 − 当日净入金（把外部转账从收益中剔除）；
 *    日盈亏百分比 = 日盈亏 / 前一日账户总值 × 100（前值为 0 时记 0）。
 *  - 金额列是 Postgres numeric，Drizzle 以 JS 字符串返回：写入 String(...)、
 *    读取原样透传。
 *  - 所有查询都以 owner = <userId> 过滤，按登录用户隔离数据。
 */
import { Injectable, Inject, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and, desc, sql } from 'drizzle-orm';
import { snapshots, transactions } from '@server/database/schema';
import type { Snapshot, CreateSnapshotDto, ListResponse } from '@shared/api.interface';
import { FxService } from '../fx/fx.service';

/** 买入流程自动生成的合成入金交易所使用的备注前缀标记。 */
const AUTO_DEPOSIT_MARKER = '__AUTO_DEPOSIT_FOR_BUY__';

/** 按币种分组的净入金金额（已知币种 + 动态出现的其他币种）。 */
interface NetDepositByCurrency {
  USD: number;
  HKD: number;
  CNY: number;
  [key: string]: number;
}

/**
 * 提供每日快照的读取/按日 upsert/删除，以及现金流派生指标的计算。
 * 依赖 Drizzle 数据库与 FxService（forwardRef 注入以避免循环模块依赖）。
 */
@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Inject(forwardRef(() => FxService)) private readonly fxService: FxService,
  ) {}

  /**
   * 按快照日期倒序列出某用户的快照，最多返回 365 条。
   *
   * @param userId 归属用户 id
   * @param limit  请求的最大条数（会被钳制到 365）
   */
  async list(userId: string, limit = 90): Promise<ListResponse<Snapshot>> {
    // 上限钳制到 365，防止一次性拉取过多行。
    const safeLimit = Math.min(limit, 365);
    // 按 owner 过滤并按 snapshotDate 倒序取数。
    const rows = await this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.owner, userId))
      .orderBy(desc(snapshots.snapshotDate))
      .limit(safeLimit);

    // 逐行映射为 API 形状后包装成列表响应。
    return {
      items: rows.map((row) => this.mapRow(row)),
    };
  }

  /**
   * 返回该用户最近的一份快照；没有任何快照时返回 null。
   *
   * @param userId 归属用户 id
   */
  async latest(userId: string): Promise<Snapshot | null> {
    // 按 owner 过滤并按 snapshotDate 倒序取 1 行。
    const rows = await this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.owner, userId))
      .orderBy(desc(snapshots.snapshotDate))
      .limit(1);

    if (rows.length === 0) return null;
    return this.mapRow(rows[0]);
  }

  /**
   * 把 snapshots 表原始行映射为 API 的 Snapshot 形状：数值转字符串、
   * 日期规整为 YYYY-MM-DD。
   *
   * @param row snapshots 表原始行
   */
  private mapRow(row: typeof snapshots.$inferSelect): Snapshot {
    // snapshotDate 可能是字符串或 Date：统一规整为 YYYY-MM-DD。
    const dateStr =
      typeof row.snapshotDate === 'string'
        ? row.snapshotDate
        : (row.snapshotDate as unknown as Date).toISOString().slice(0, 10);
    // 数值列逐个转字符串；null 保持 null。
    return {
      id: row.id,
      snapshotDate: dateStr,
      accountValue: row.accountValue != null ? String(row.accountValue) : null,
      totalMv: row.totalMv != null ? String(row.totalMv) : null,
      cost: row.cost != null ? String(row.cost) : null,
      cash: row.cash != null ? String(row.cash) : null,
      totalPl: row.totalPl != null ? String(row.totalPl) : null,
      dailyPl: row.dailyPl != null ? String(row.dailyPl) : null,
      dailyPct: row.dailyPct != null ? String(row.dailyPct) : null,
      netDeposit: row.netDeposit != null ? String(row.netDeposit) : null,
      cumulativeNetDeposit:
        row.cumulativeNetDeposit != null ? String(row.cumulativeNetDeposit) : null,
    };
  }

  /**
   * 汇总某用户在指定日期的入金/出金交易，按币种分组求净额。
   *
   * @param userId  归属用户 id
   * @param dateStr 目标日期（YYYY-MM-DD）
   */
  private async getNetDepositByCurrency(
    userId: string,
    dateStr: string,
  ): Promise<NetDepositByCurrency> {
    // 初始化已知币种的净额桶；其他币种动态追加。
    const byCurrency: NetDepositByCurrency = { USD: 0, HKD: 0, CNY: 0 };

    // 取当日全部 Deposit/Withdrawal 交易：现金流行的金额 = shares*price。
    const rows = await this.db
      .select({
        txType: transactions.txType,
        // shares*price 是现金流行的入金/出金金额。
        amount: sql<number>`(${transactions.shares} * ${transactions.price})::numeric(16,4)`,
        currency: transactions.currency,
        notes: transactions.notes,
      })
      .from(transactions)
      .where(
        and(
          sql`${transactions.owner} = ${userId}`,
          sql`${transactions.txDate} = ${dateStr}::date`,
          sql`${transactions.txType} IN ('Deposit', 'Withdrawal')`,
        ),
      );

    // 按币种累加：Deposit 记正、Withdrawal 记负。
    for (const row of rows) {
      const cur = (row.currency || 'USD').toUpperCase();
      const amt = Number(row.amount) || 0;
      const sign = row.txType === 'Deposit' ? 1 : -1;
      if (byCurrency[cur] !== undefined) {
        byCurrency[cur] += sign * amt;
      } else {
        byCurrency[cur] = sign * amt;
      }
    }

    return byCurrency;
  }

  /**
   * 用快照日汇率把各币种净入金折算成基准币种；单笔换算失败时记录
   * 警告并按 1:1 原值计入（不中断整笔汇总）。
   *
   * @param byCurrency 按币种分组的净入金
   * @param base       目标基准币种（USD）
   * @param dateStr    汇率取值日期（YYYY-MM-DD）
   */
  private async convertNetDepositToBase(
    byCurrency: NetDepositByCurrency,
    base: string,
    dateStr: string,
  ): Promise<number> {
    let total = 0;
    // 逐币种换算；金额为 0 的币种直接跳过。
    for (const cur of Object.keys(byCurrency)) {
      const amt = byCurrency[cur];
      if (amt === 0) continue;
      try {
        const converted = await this.fxService.convert(amt, cur, base, dateStr);
        total += converted;
      } catch (err) {
        // 换算失败时按 1:1 兜底，保证快照仍可写入。
        this.logger.warn(
          `fx convert failed for net deposit ${cur}->${base} @${dateStr}, fallback to 1: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        total += amt;
      }
    }
    return total;
  }

  /**
   * 按日期 upsert 快照。计算基准币种的当日净入金/累计净入金，并推导
   * 日盈亏（账户总值变动 − 净入金，相对已投入本金）。整个过程在事务内执行。
   *
   * @param userId 归属用户 id
   * @param dto    以 snapshotDate 为键的快照载荷
   */
  async upsert(userId: string, dto: CreateSnapshotDto): Promise<Snapshot> {
    // 基准币种固定 USD；日期取载荷里的 snapshotDate。
    const base = 'USD';
    const dateStr = dto.snapshotDate;

    // 取最近一份更早的快照，用于链式累计累计净入金等数值。
    const prevRows = await this.db
      .select({
        accountValue: snapshots.accountValue,
        cumulativeNetDeposit: snapshots.cumulativeNetDeposit,
      })
      .from(snapshots)
      .where(and(eq(snapshots.owner, userId), sql`${snapshots.snapshotDate} < ${dateStr}::date`))
      .orderBy(desc(snapshots.snapshotDate))
      .limit(1);

    // 前一日账户总值；无前值时为 null。
    const prevAv = prevRows[0]?.accountValue != null ? Number(prevRows[0].accountValue) : null;
    // 累计净入金链式基数；无前值时从 0 起算。
    const prevCumulativeNetDeposit =
      prevRows[0]?.cumulativeNetDeposit != null ? Number(prevRows[0].cumulativeNetDeposit) : 0;

    // 计算当日净入金（按币种汇总后折成基准币种）并累加到累计值。
    const netDepositByCurrency = await this.getNetDepositByCurrency(userId, dateStr);
    const netDepositBase = await this.convertNetDepositToBase(netDepositByCurrency, base, dateStr);
    const cumulativeNetDepositBase = prevCumulativeNetDeposit + netDepositBase;

    const accountValueNum = dto.accountValue ?? 0;

    // 日盈亏剔除净入金，避免外部转账抬高收益。
    let dailyPl: number | null = null;
    let dailyPct: number | null = null;
    if (prevAv != null && dto.accountValue !== undefined) {
      const grossDelta = accountValueNum - prevAv;
      dailyPl = grossDelta - netDepositBase;
      dailyPct = prevAv > 0 ? (dailyPl / prevAv) * 100 : 0;
    } else if (dto.dailyPl !== undefined) {
      // 无前值时退回客户端提供的日盈亏。
      dailyPl = dto.dailyPl;
      dailyPct = dto.dailyPct ?? 0;
    }

    // 事务内完成"已存在则更新、否则插入"的按日 upsert。
    const result = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(snapshots)
        .where(and(eq(snapshots.owner, userId), eq(snapshots.snapshotDate, dto.snapshotDate)))
        .limit(1);

      if (existing.length > 0) {
        // 更新分支：只写载荷中显式提供的字段；净入金两列总是覆盖。
        const patch: Record<string, unknown> = {};
        if (dto.accountValue !== undefined) patch.accountValue = String(dto.accountValue);
        if (dto.totalMv !== undefined) patch.totalMv = String(dto.totalMv);
        if (dto.cost !== undefined) patch.cost = String(dto.cost);
        if (dto.cash !== undefined) patch.cash = String(dto.cash);
        if (dto.totalPl !== undefined) patch.totalPl = String(dto.totalPl);
        if (dailyPl !== null) patch.dailyPl = String(dailyPl);
        if (dailyPct !== null) patch.dailyPct = String(dailyPct);
        patch.netDeposit = String(netDepositBase);
        patch.cumulativeNetDeposit = String(cumulativeNetDepositBase);
        patch.updatedAt = new Date();
        patch.updatedBy = userId;

        const [updated] = await tx
          .update(snapshots)
          .set(patch)
          .where(eq(snapshots.id, existing[0].id))
          .returning();
        return updated;
      }

      // 插入分支：未提供的数值列落 null。
      const [inserted] = await tx
        .insert(snapshots)
        .values({
          snapshotDate: dto.snapshotDate,
          accountValue: dto.accountValue !== undefined ? String(dto.accountValue) : null,
          totalMv: dto.totalMv !== undefined ? String(dto.totalMv) : null,
          cost: dto.cost !== undefined ? String(dto.cost) : null,
          cash: dto.cash !== undefined ? String(dto.cash) : null,
          totalPl: dto.totalPl !== undefined ? String(dto.totalPl) : null,
          dailyPl: dailyPl != null ? String(dailyPl) : null,
          dailyPct: dailyPct != null ? String(dailyPct) : null,
          netDeposit: String(netDepositBase),
          cumulativeNetDeposit: String(cumulativeNetDepositBase),
          owner: userId,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
      return inserted;
    });

    return this.mapRow(result);
  }

  /**
   * 批量 upsert 多份快照。按日期从旧到新处理，使每份快照的累计值都能
   * 链到前一份；返回结果按日期从新到旧排序。
   *
   * @param userId 归属用户 id
   * @param items  快照载荷列表
   */
  async batchUpsert(userId: string, items: CreateSnapshotDto[]): Promise<ListResponse<Snapshot>> {
    // 从旧到新逐份 upsert，保证累计值链式正确。
    const sorted = [...items].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
    const results: Snapshot[] = [];
    for (const item of sorted) {
      const r = await this.upsert(userId, item);
      results.push(r);
    }
    // 返回时从新到旧排序。
    return { items: results.sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate)) };
  }

  /**
   * 删除一条属于该用户的快照。
   *
   * @param userId 归属用户 id
   * @param id     快照主键
   * @throws NotFoundException 当快照不属于该用户时抛出
   */
  async remove(userId: string, id: string): Promise<{ success: boolean }> {
    // 以 (id, owner) 双条件删除；仅返回被删行的 id 用于判断是否命中。
    const deleted = await this.db
      .delete(snapshots)
      .where(and(eq(snapshots.id, id), eq(snapshots.owner, userId)))
      .returning({ id: snapshots.id });

    if (deleted.length === 0)
      // 注意：此处是面向用户的中文文案（既有行为，并非乱码）。
      throw new NotFoundException('快照记录不存在');
    return { success: true };
  }
}
