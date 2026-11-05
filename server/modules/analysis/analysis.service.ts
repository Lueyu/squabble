/**
 * Analysis service.
 *
 * Business logic and PostgreSQL (Drizzle) data access for stock research notes.
 * Notes are owner-scoped and keyed by (owner, analysisDate, ticker). Test/deep-run
 * rows (ticker containing "testdeep") are filtered out of listings.
 */
import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { eq, and, desc, asc, notIlike } from 'drizzle-orm';
import { analysis } from '@server/database/schema';
import type { Analysis, CreateAnalysisDto, ListResponse } from '@shared/api.interface';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';

/**
 * Provides analysis-note read/upsert/delete. Depends on the Drizzle database.
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * Lists analysis notes for a user, newest date / ticker order (max 50 rows),
   * optionally filtered by date and/or ticker. Excludes internal test rows.
   *
   * @param userId Owner id.
   * @param date   Optional analysis date filter.
   * @param ticker Optional ticker filter.
   */
  async list(userId: string, date?: string, ticker?: string): Promise<ListResponse<Analysis>> {
    const conditions = [eq(analysis.owner, userId)];
    if (date) conditions.push(eq(analysis.analysisDate, date));
    if (ticker) conditions.push(eq(analysis.ticker, ticker));

    // Exclude internal test/deep-run rows from the public listing.
    const allConditions = [...conditions, notIlike(analysis.ticker, '%testdeep%')];

    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, userId);
      const rows = await tx
        .select()
        .from(analysis)
        .where(and(...allConditions))
        .orderBy(desc(analysis.analysisDate), asc(analysis.ticker))
        .limit(50);

      const versionIds = new Map<string, string>();
      const deepVersionIds = new Map<string, string>();
      const documents = new ResearchDocumentsService(this.db);
      for (const row of rows) {
        const version = await documents.importSourceInTransaction(tx, userId, { type: 'daily', id: row.id });
        versionIds.set(row.id, version.id);
        const sourceId = version.snapshot?.sourceReportVersionId;
        if (typeof sourceId === 'string') {
          try {
            const deep = await documents.getVersionInTransaction(tx, userId, sourceId);
            if (deep.kind === 'deep' && deep.ticker === row.ticker) deepVersionIds.set(row.id, deep.id);
          } catch { /* Unknown or inaccessible legacy associations stay unknown. */ }
        }
      }
      return {
        items: rows.map((row) => ({
          id: row.id,
          researchVersionId: versionIds.get(row.id),
          deepReportVersionId: deepVersionIds.get(row.id) ?? null,
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
    });
  }

  /**
   * Returns the distinct dates that have analysis notes, newest first.
   *
   * @param userId Owner id.
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
   * Upserts the analysis note for a (owner, date, ticker): updates the existing row
   * if present, otherwise inserts a new one. Runs in a transaction.
   *
   * @param userId Owner id.
   * @param dto    Analysis payload keyed by `analysisDate` and `ticker`.
   */
  async upsert(userId: string, dto: CreateAnalysisDto): Promise<Analysis> {
    const result = await new ResearchDocumentsService(this.db).writeDaily(userId, {
      analysisDate: dto.analysisDate, ticker: dto.ticker, rating: dto.rating, action: dto.action, analysis: dto.analysis,
      targetPrice: dto.targetPrice !== undefined ? String(dto.targetPrice) : undefined, catalysts: dto.catalysts, risks: dto.risks,
    });

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
   * Upserts the whole batch and its immutable versions in one transaction.
   *
   * @param userId Owner id.
   * @param items  Analysis payloads.
   */
  async batchUpsert(userId: string, items: CreateAnalysisDto[]): Promise<ListResponse<Analysis>> {
    const documents = new ResearchDocumentsService(this.db);
    const results: Analysis[] = await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, userId);
      const results: Analysis[] = [];
      for (const dto of items) {
        const row = await documents.writeDailyInTransaction(tx, userId, { analysisDate: dto.analysisDate, ticker: dto.ticker,
          rating: dto.rating, action: dto.action, analysis: dto.analysis, targetPrice: dto.targetPrice !== undefined ? String(dto.targetPrice) : undefined,
          catalysts: dto.catalysts, risks: dto.risks });
        results.push({ id: row.id, analysisDate: row.analysisDate, ticker: row.ticker, rating: row.rating,
          action: row.action, analysis: row.analysis, targetPrice: row.targetPrice, catalysts: row.catalysts,
          risks: row.risks, createdAt: row.createdAt.toISOString() });
      }
      return results;
    });
    return { items: results };
  }

  /**
   * Deletes an owned analysis note.
   *
   * @param userId Owner id.
   * @param id     Analysis row primary key.
   * @throws NotFoundException if the note does not belong to the user.
   */
  async remove(userId: string, id: string): Promise<{ success: boolean }> {
    const deleted = await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, userId);
      const documents = new ResearchDocumentsService(this.db);
      await documents.importSourceInTransaction(tx, userId, { type: 'daily', id });
      return tx
        .delete(analysis)
        .where(and(eq(analysis.id, id), eq(analysis.owner, userId)))
        .returning({ id: analysis.id });
    });

    if (deleted.length === 0)
      // NOTE: Chinese user-facing message (existing behavior; not mojibake).
      throw new NotFoundException('分析记录不存在');
    return { success: true };
  }
}
