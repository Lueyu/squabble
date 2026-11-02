/**
 * Snapshots service.
 *
 * Business logic and PostgreSQL (Drizzle) data access for daily portfolio
 * snapshots. On upsert it recomputes the day's net deposits (from Deposit/Withdrawal
 * transactions), converts them to the base currency (USD) via `FxService`, chains a
 * cumulative net-deposit balance from the previous snapshot, and derives daily P&L
 * as (account value change) minus (net deposits) so external cash flows don't count
 * as performance. All rows are owner-scoped.
 */
import { Injectable, Inject, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and, desc, sql } from 'drizzle-orm';
import { snapshots, transactions } from '@server/database/schema';
import type { Snapshot, CreateSnapshotDto, ListResponse } from '@shared/api.interface';
import { FxService } from '../fx/fx.service';

/** Marker prefix for synthetic auto-deposit transactions created by the buy flow. */
const AUTO_DEPOSIT_MARKER = '__AUTO_DEPOSIT_FOR_BUY__';

/** Net deposit amounts grouped by currency (known currencies plus dynamic others). */
interface NetDepositByCurrency {
  USD: number;
  HKD: number;
  CNY: number;
  [key: string]: number;
}

/**
 * Provides daily snapshot read/upsert/delete and derived cash-flow metrics.
 * Depends on the Drizzle database and `FxService` (injected with `forwardRef` to
 * avoid a circular module dependency).
 */
@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Inject(forwardRef(() => FxService)) private readonly fxService: FxService,
  ) {}

  /**
   * Lists snapshots for a user, newest first, capped at 365 rows.
   *
   * @param userId Owner id.
   * @param limit  Requested max rows (clamped to 365).
   */
  async list(userId: string, limit = 90): Promise<ListResponse<Snapshot>> {
    const safeLimit = Math.min(limit, 365);
    const rows = await this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.owner, userId))
      .orderBy(desc(snapshots.snapshotDate))
      .limit(safeLimit);

    return {
      items: rows.map((row) => this.mapRow(row)),
    };
  }

  /**
   * Returns the most recent snapshot for the user, or null if none.
   *
   * @param userId Owner id.
   */
  async latest(userId: string): Promise<Snapshot | null> {
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
   * Maps a raw snapshots row to the API `Snapshot` shape, stringifying numerics and
   * normalizing the date to YYYY-MM-DD.
   *
   * @param row Raw snapshots table row.
   */
  private mapRow(row: typeof snapshots.$inferSelect): Snapshot {
    const dateStr =
      typeof row.snapshotDate === 'string'
        ? row.snapshotDate
        : (row.snapshotDate as unknown as Date).toISOString().slice(0, 10);
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
   * Sums the day's Deposit/Withdrawal transactions by currency for a user.
   *
   * @param userId  Owner id.
   * @param dateStr Target date (YYYY-MM-DD).
   */
  private async getNetDepositByCurrency(
    userId: string,
    dateStr: string,
  ): Promise<NetDepositByCurrency> {
    const byCurrency: NetDepositByCurrency = { USD: 0, HKD: 0, CNY: 0 };

    const rows = await this.db
      .select({
        txType: transactions.txType,
        // shares*price is the deposit/withdrawal amount for cash-flow rows.
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
   * Converts net deposits from each currency into the base currency using the
   * rate for the snapshot date; on conversion failure it logs and falls back to a
   * 1:1 pass-through.
   *
   * @param byCurrency Net deposits keyed by currency.
   * @param base       Target base currency (USD).
   * @param dateStr    Rate date (YYYY-MM-DD).
   */
  private async convertNetDepositToBase(
    byCurrency: NetDepositByCurrency,
    base: string,
    dateStr: string,
  ): Promise<number> {
    let total = 0;
    for (const cur of Object.keys(byCurrency)) {
      const amt = byCurrency[cur];
      if (amt === 0) continue;
      try {
        const converted = await this.fxService.convert(amt, cur, base, dateStr);
        total += converted;
      } catch (err) {
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
   * Upserts the snapshot for a date. Computes net/cumulative net deposits in the
   * base currency and derives daily P&L (account value change minus net deposits,
   * relative to previously invested capital). Runs in a transaction.
   *
   * @param userId Owner id.
   * @param dto    Snapshot payload keyed by `snapshotDate`.
   */
  async upsert(userId: string, dto: CreateSnapshotDto): Promise<Snapshot> {
    const base = 'USD';
    const dateStr = dto.snapshotDate;

    // Pull the most recent earlier snapshot to chain cumulative values.
    const prevRows = await this.db
      .select({
        accountValue: snapshots.accountValue,
        cumulativeNetDeposit: snapshots.cumulativeNetDeposit,
      })
      .from(snapshots)
      .where(
        and(
          eq(snapshots.owner, userId),
          sql`${snapshots.snapshotDate} < ${dateStr}::date`,
        ),
      )
      .orderBy(desc(snapshots.snapshotDate))
      .limit(1);

    const prevAv = prevRows[0]?.accountValue != null ? Number(prevRows[0].accountValue) : null;
    const prevCumulativeNetDeposit =
      prevRows[0]?.cumulativeNetDeposit != null
        ? Number(prevRows[0].cumulativeNetDeposit)
        : 0;

    const netDepositByCurrency = await this.getNetDepositByCurrency(userId, dateStr);
    const netDepositBase = await this.convertNetDepositToBase(
      netDepositByCurrency,
      base,
      dateStr,
    );
    const cumulativeNetDepositBase = prevCumulativeNetDeposit + netDepositBase;

    const accountValueNum = dto.accountValue ?? 0;

    // Daily P&L strips out net deposits so they don't inflate returns.
    let dailyPl: number | null = null;
    let dailyPct: number | null = null;
    if (prevAv != null && dto.accountValue !== undefined) {
      const grossDelta = accountValueNum - prevAv;
      dailyPl = grossDelta - netDepositBase;
      dailyPct = prevAv > 0 ? (dailyPl / prevAv) * 100 : 0;
    } else if (dto.dailyPl !== undefined) {
      dailyPl = dto.dailyPl;
      dailyPct = dto.dailyPct ?? 0;
    }

    const result = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(snapshots)
        .where(and(eq(snapshots.owner, userId), eq(snapshots.snapshotDate, dto.snapshotDate)))
        .limit(1);

      if (existing.length > 0) {
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
   * Upserts many snapshots at once. Items are processed oldest-first so each
   * snapshot's cumulative values chain off the previous one; results are returned
   * newest-first.
   *
   * @param userId Owner id.
   * @param items  Snapshot payloads.
   */
  async batchUpsert(userId: string, items: CreateSnapshotDto[]): Promise<ListResponse<Snapshot>> {
    const sorted = [...items].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
    const results: Snapshot[] = [];
    for (const item of sorted) {
      const r = await this.upsert(userId, item);
      results.push(r);
    }
    return { items: results.sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate)) };
  }

  /**
   * Deletes an owned snapshot.
   *
   * @param userId Owner id.
   * @param id     Snapshot primary key.
   * @throws NotFoundException if the snapshot does not belong to the user.
   */
  async remove(userId: string, id: string): Promise<{ success: boolean }> {
    const deleted = await this.db
      .delete(snapshots)
      .where(and(eq(snapshots.id, id), eq(snapshots.owner, userId)))
      .returning({ id: snapshots.id });

    if (deleted.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('快照记录不存在');
    return { success: true };
  }
}
