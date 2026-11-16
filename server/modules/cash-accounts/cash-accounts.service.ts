/**
 * cash-accounts.service.ts — 现金账户服务。
 *
 * 职责边界：
 *  - 承载多币种现金余额的业务规则与 PostgreSQL（Drizzle）数据访问；
 *    不做 HTTP 校验（那是控制器的事），也不生成用户可见文案以外的报错。
 * 上下游：
 *  - 上游（谁调用本服务）：CashAccountsController（存取款/查询）、transactions 模块的记账逻辑。
 *  - 下游（本文件调用谁）：Drizzle 数据库（cashAccounts 表）、shared 契约类型 CashAccount/Currency。
 * 关键约定：
 *  - 余额以字符串数值（numeric）存储与返回，如 '123.45'；入参 delta 为 number。
 *  - 首次使用时会为 USD/HKD/CNY 三种币种惰性建立零余额账户（幂等 upsert）。
 *  - 负增量（取款）会把余额打负，必须先做非负校验。
 */
import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';

import { cashAccounts } from '@server/database/schema';
import type { CashAccount, Currency } from '@shared/api.interface';

/** 应用支持现金记账的币种清单。 */
const ALL_CURRENCIES: Currency[] = ['USD', 'HKD', 'CNY'];

/**
 * 提供现金余额的读取与调整操作，依赖注入的 Drizzle 数据库。
 */
@Injectable()
export class CashAccountsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * 列出用户全部现金账户（缺失的币种会先补建）。
   *
   * @param userId 账户所有者的用户 id。
   * @returns 按币种排序的 CashAccount 数组。
   */
  async list(userId: string): Promise<CashAccount[]> {
    // 先保证账户存在，再读取，避免首次使用返回空列表。
    await this.ensureAccounts(userId);
    const rows = await this.db
      .select()
      .from(cashAccounts)
      .where(eq(cashAccounts.owner, userId))
      .orderBy(cashAccounts.currency);
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 查询单一币种余额，返回字符串数值；账户不存在时返回 '0'。
   *
   * @param userId   账户所有者的用户 id。
   * @param currency 币种代码（如 'USD'）。
   * @returns 字符串形式的余额（如 '123.45'），未建立时为 '0'。
   */
  async getBalance(userId: string, currency: string): Promise<string> {
    await this.ensureAccounts(userId);
    const rows = await this.db
      .select()
      .from(cashAccounts)
      .where(and(eq(cashAccounts.owner, userId), eq(cashAccounts.currency, currency)));
    // 账户行缺失时按零余额处理，而非报错。
    if (rows.length === 0) return '0';
    return rows[0].balance;
  }

  /**
   * 对某币种账户应用带符号的余额增量（负数即取款）。负增量会先校验余额充足
   * （非负风险闸门），否则拒绝。
   *
   * @param userId   账户所有者的用户 id。
   * @param currency 币种代码。
   * @param delta    带符号增量金额（number，负数表示取款）。
   * @param _reason  可选备注（当前未落库，仅保留参数位）。
   * @returns 调整后的账户快照。
   * @throws BadRequestException 当余额会变负、或账户行不存在时。
   */
  async adjust(
    userId: string,
    currency: string,
    delta: number,
    _reason?: string,
  ): Promise<CashAccount> {
    await this.ensureAccounts(userId);

    // 取款路径：先核对当前余额是否足以扣减，防止余额变负。
    if (delta < 0) {
      const current = await this.getBalance(userId, currency);
      if (Number(current) + delta < 0) {
        // NOTE: 用户可见文案为中文，属既有行为而非乱码。
        throw new BadRequestException('现金不足');
      }
    }

    // 用 SQL 表达式做原子自增，避免读改写竞态。
    const rows = await this.db
      .update(cashAccounts)
      .set({
        balance: sql`${cashAccounts.balance} + ${delta}::numeric`,
      })
      .where(and(eq(cashAccounts.owner, userId), eq(cashAccounts.currency, currency)))
      .returning();

    // WHERE 未命中说明账户行不存在（ensureAccounts 正常时不应发生）。
    if (rows.length === 0) {
      // NOTE: 用户可见文案为中文，属既有行为而非乱码。
      throw new BadRequestException('账户不存在');
    }

    return this.mapRow(rows[0]);
  }

  /**
   * 为用户尚未持有的受支持币种补建零余额账户；用 `onConflictDoNothing`
   * 保证重复调用幂等。
   *
   * @param userId 账户所有者的用户 id。
   */
  async ensureAccounts(userId: string): Promise<void> {
    const values = ALL_CURRENCIES.map((currency: Currency) => ({
      currency,
      balance: '0',
      owner: userId,
      createdBy: userId,
      updatedBy: userId,
    }));

    await this.db.insert(cashAccounts).values(values).onConflictDoNothing();
  }

  /**
   * 将 Drizzle 原始行映射为 API 契约的 CashAccount 形状。
   *
   * @param row cashAccounts 表的原始行。
   * @returns 供前端使用的 CashAccount 对象。
   */
  private mapRow(row: typeof cashAccounts.$inferSelect): CashAccount {
    return {
      id: row.id,
      currency: row.currency as Currency,
      balance: row.balance,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
