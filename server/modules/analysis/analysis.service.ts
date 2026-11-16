/**
 * Analysis service（个股研究笔记服务）。
 *
 * 职责边界：承载研究笔记的业务逻辑与 PostgreSQL（Drizzle）数据访问；
 * 笔记按 owner 隔离，业务键为 (owner, analysisDate, ticker)。列表会过滤
 * 掉内部测试/deep-run 行（ticker 含 "testdeep"）。不管鉴权与路由。
 *
 * 上下游：import @nestjs/common（Logger/NotFoundException）、
 * DRIZZLE_DATABASE/PostgresJsDatabase（common/platform 注入）、drizzle-orm
 * 操作符、@server/database/schema 的 analysis 表、@shared/api.interface
 * 类型；由 analysis.controller.ts 调用。
 *
 * 关键约定：列表上限 50 行，按日期倒序+ticker 正序；upsert 在事务内先查
 * 后更/插（依赖表上 (owner,analysis_date,ticker) 唯一约束兜底）；targetPrice
 * 写库前 String() 转字符串；未命中删除抛 NotFoundException（文案'分析记录
 * 不存在'，既有中文行为）。
 */
import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and, desc, asc, notIlike } from 'drizzle-orm';
import { analysis } from '@server/database/schema';
import type { Analysis, CreateAnalysisDto, ListResponse } from '@shared/api.interface';

/**
 * 提供研究笔记的读/upsert/删除。依赖注入的 Drizzle 数据库。
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * 列出某用户的研究笔记，按日期倒序 / ticker 正序（最多 50 行），可按
   * 日期和/或 ticker 过滤；排除内部测试行。
   *
   * @param userId 属主 id。
   * @param date   可选的研究日期过滤。
   * @param ticker 可选的 ticker 过滤。
   */
  async list(userId: string, date?: string, ticker?: string): Promise<ListResponse<Analysis>> {
    // 基础条件：owner 必匹配；date/ticker 仅在传入时追加。
    const conditions = [eq(analysis.owner, userId)];
    if (date) conditions.push(eq(analysis.analysisDate, date));
    if (ticker) conditions.push(eq(analysis.ticker, ticker));

    // 公开列表排除内部 test/deep-run 行（ticker 含 testdeep）。
    const allConditions = [...conditions, notIlike(analysis.ticker, '%testdeep%')];

    const rows = await this.db
      .select()
      .from(analysis)
      .where(and(...allConditions))
      .orderBy(desc(analysis.analysisDate), asc(analysis.ticker))
      .limit(50);

    return {
      items: rows.map((row) => ({
        id: row.id,
        analysisDate: row.analysisDate,
        ticker: row.ticker,
        rating: row.rating,
        action: row.action,
        analysis: row.analysis,
        targetPrice: row.targetPrice,
        catalysts: row.catalysts,
        risks: row.risks,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * 返回存在研究笔记的 distinct 日期，最新在前。
   *
   * @param userId 属主 id。
   */
  async listDates(userId: string): Promise<ListResponse<{ date: string }>> {
    const rows = await this.db
      .select({ date: analysis.analysisDate })
      .from(analysis)
      .where(eq(analysis.owner, userId))
      .groupBy(analysis.analysisDate)
      .orderBy(desc(analysis.analysisDate));

    return { items: rows.map((row: { date: string }) => ({ date: row.date })) };
  }

  /**
   * Upsert 某（owner, date, ticker）的研究笔记：已存在则更新，否则插入。
   * 全程在事务内执行。
   *
   * @param userId 属主 id。
   * @param dto    以 `analysisDate` 与 `ticker` 定位的研究笔记载荷。
   */
  async upsert(userId: string, dto: CreateAnalysisDto): Promise<Analysis> {
    const result = await this.db.transaction(async (tx) => {
      // 先按业务键（owner+date+ticker）查找既有行。
      const existing = await tx
        .select()
        .from(analysis)
        .where(
          and(
            eq(analysis.owner, userId),
            eq(analysis.analysisDate, dto.analysisDate),
            eq(analysis.ticker, dto.ticker),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        // 命中：仅更新 DTO 中显式给出的字段。
        const patch: Record<string, unknown> = {};
        if (dto.rating !== undefined) patch.rating = dto.rating;
        if (dto.action !== undefined) patch.action = dto.action;
        if (dto.analysis !== undefined) patch.analysis = dto.analysis;
        if (dto.targetPrice !== undefined) patch.targetPrice = String(dto.targetPrice);
        if (dto.catalysts !== undefined) patch.catalysts = dto.catalysts;
        if (dto.risks !== undefined) patch.risks = dto.risks;
        patch.updatedAt = new Date();
        patch.updatedBy = userId;

        const [updated] = await tx
          .update(analysis)
          .set(patch)
          .where(eq(analysis.id, existing[0].id))
          .returning();
        return updated;
      }

      // 未命中：插入新行；DTO 未提供的可空字段落 null。
      const [inserted] = await tx
        .insert(analysis)
        .values({
          analysisDate: dto.analysisDate,
          ticker: dto.ticker,
          rating: dto.rating ?? null,
          action: dto.action ?? null,
          analysis: dto.analysis ?? null,
          targetPrice: dto.targetPrice !== undefined ? String(dto.targetPrice) : null,
          catalysts: dto.catalysts ?? null,
          risks: dto.risks ?? null,
          owner: userId,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
      return inserted;
    });

    // 统一映射为 API 形状（createdAt 由 Date 转 ISO 字符串）。
    return {
      id: result.id,
      analysisDate: result.analysisDate,
      ticker: result.ticker,
      rating: result.rating,
      action: result.action,
      analysis: result.analysis,
      targetPrice: result.targetPrice,
      catalysts: result.catalysts,
      risks: result.risks,
      createdAt: result.createdAt.toISOString(),
    };
  }

  /**
   * 在事务内并发 upsert 多条研究笔记。
   *
   * @param userId 属主 id。
   * @param items  研究笔记载荷数组。
   */
  async batchUpsert(userId: string, items: CreateAnalysisDto[]): Promise<ListResponse<Analysis>> {
    const results: Analysis[] = await this.db.transaction(async () => {
      // 事务内并发执行各条 upsert，Promise.all 全部完成后一起提交。
      const promises = items.map((item: CreateAnalysisDto) => this.upsert(userId, item));
      return Promise.all(promises);
    });
    return { items: results };
  }

  /**
   * 删除一条属于该用户的研究笔记。
   *
   * @param userId 属主 id。
   * @param id     analysis 行主键。
   * @throws NotFoundException 当笔记不存在或不属于该用户时抛出。
   */
  async remove(userId: string, id: string): Promise<{ success: boolean }> {
    const deleted = await this.db
      .delete(analysis)
      .where(and(eq(analysis.id, id), eq(analysis.owner, userId)))
      .returning({ id: analysis.id });

    if (deleted.length === 0)
      // 中文用户可见文案（既有行为，非乱码）。
      throw new NotFoundException('分析记录不存在');
    return { success: true };
  }
}
