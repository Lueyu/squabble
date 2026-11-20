/**
 * Trading journal service（交易日志服务）。
 *
 * 职责边界：承载逐日交易日志的业务逻辑与 PostgreSQL（Drizzle）数据访问；
 * 日志按 owner 隔离，业务键为 (owner, journalDate)；`upsert` 对该日期的
 * 既有条目更新、缺失则新建。不管鉴权与路由。
 *
 * 上下游：import @nestjs/common（Logger/NotFoundException）、
 * DRIZZLE_DATABASE/PostgresJsDatabase（common/platform 注入）、drizzle-orm
 * 操作符、@server/database/schema 的 journal 表、@shared/api.interface
 * 类型；由 journal.controller.ts 调用。
 *
 * 关键约定：列表按 journalDate 倒序；upsert 在事务内先查后更/插（依赖表上
 * (owner,journal_date) 唯一约束兜底）；未命中删除抛 NotFoundException
 * （文案'日志记录不存在'，既有中文行为）。
 */
import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and, desc } from 'drizzle-orm';
import { journal } from '@server/database/schema';
import type { JournalEntry, CreateJournalDto, ListResponse } from '@shared/api.interface';

/**
 * 提供日志的读/upsert/删除。依赖注入的 Drizzle 数据库连接。
 */
@Injectable()
export class JournalService {
  private readonly logger = new Logger(JournalService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * 列出某用户的日志，最新在前，可按日期过滤。
   *
   * @param userId 属主 id。
   * @param date   可选的日志日期过滤。
   */
  async list(userId: string, date?: string): Promise<ListResponse<JournalEntry>> {
    // 基础条件：owner 必匹配；date 仅在传入时追加。
    const conditions = [eq(journal.owner, userId)];
    if (date) conditions.push(eq(journal.journalDate, date));

    const rows = await this.db
      .select()
      .from(journal)
      .where(and(...conditions))
      .orderBy(desc(journal.journalDate));

    return {
      items: rows.map((row) => ({
        id: row.id,
        journalDate: row.journalDate,
        marketSummary: row.marketSummary,
        portfolioSummary: row.portfolioSummary,
        actions: row.actions,
        plan: row.plan,
        lessons: row.lessons,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * 返回该用户最近一条日志，无记录时返回 null。
   *
   * @param userId 属主 id。
   */
  async latest(userId: string): Promise<JournalEntry | null> {
    const rows = await this.db
      .select()
      .from(journal)
      .where(eq(journal.owner, userId))
      .orderBy(desc(journal.journalDate))
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      journalDate: row.journalDate,
      marketSummary: row.marketSummary,
      portfolioSummary: row.portfolioSummary,
      actions: row.actions,
      plan: row.plan,
      lessons: row.lessons,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Upsert 指定日期的日志：(owner, date) 已存在则更新，否则插入新条目。
   * 全程在事务内执行。
   *
   * @param userId 属主 id。
   * @param dto    以 `journalDate` 为键的日志载荷。
   */
  async upsert(userId: string, dto: CreateJournalDto): Promise<JournalEntry> {
    const result = await this.db.transaction(async (tx) => {
      // 先按业务键（owner+date）查找既有条目。
      const existing = await tx
        .select()
        .from(journal)
        .where(and(eq(journal.owner, userId), eq(journal.journalDate, dto.journalDate)))
        .limit(1);

      if (existing.length > 0) {
        // 命中：仅更新 DTO 中显式给出的字段。
        const patch: Record<string, unknown> = {};
        if (dto.marketSummary !== undefined) patch.marketSummary = dto.marketSummary;
        if (dto.portfolioSummary !== undefined) patch.portfolioSummary = dto.portfolioSummary;
        if (dto.actions !== undefined) patch.actions = dto.actions;
        if (dto.plan !== undefined) patch.plan = dto.plan;
        if (dto.lessons !== undefined) patch.lessons = dto.lessons;
        patch.updatedAt = new Date();
        patch.updatedBy = userId;

        const [updated] = await tx
          .update(journal)
          .set(patch)
          .where(eq(journal.id, existing[0].id))
          .returning();
        return updated;
      }

      // 未命中：插入新条目；DTO 未提供的可空字段落 null。
      const [inserted] = await tx
        .insert(journal)
        .values({
          journalDate: dto.journalDate,
          marketSummary: dto.marketSummary ?? null,
          portfolioSummary: dto.portfolioSummary ?? null,
          actions: dto.actions ?? null,
          plan: dto.plan ?? null,
          lessons: dto.lessons ?? null,
          owner: userId,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
      return inserted;
    });

    // 统一映射为 API 形状（updatedAt 由 Date 转 ISO 字符串）。
    return {
      id: result.id,
      journalDate: result.journalDate,
      marketSummary: result.marketSummary,
      portfolioSummary: result.portfolioSummary,
      actions: result.actions,
      plan: result.plan,
      lessons: result.lessons,
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  /**
   * 删除一条属于该用户的日志。
   *
   * @param userId 属主 id。
   * @param id     日志主键。
   * @throws NotFoundException 当条目不存在或不属于该用户时抛出。
   */
  async remove(userId: string, id: string): Promise<{ success: boolean }> {
    const deleted = await this.db
      .delete(journal)
      .where(and(eq(journal.id, id), eq(journal.owner, userId)))
      .returning({ id: journal.id });

    if (deleted.length === 0)
      // 中文用户可见文案（既有行为，非乱码）。
      throw new NotFoundException('日志记录不存在');
    return { success: true };
  }
}
