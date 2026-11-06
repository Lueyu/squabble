import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '../../common/platform';
import { holdings, importLogs } from '../../database/schema';
import { importCommitReceipts } from '../../database/import-batches.schema';
import { QuoteService } from '../quote/quote.service';
import { ImportAnalysisHandoffService } from '../experience/import-analysis-handoff.service';
import type {
  ImportCommitDto,
  ImportCommitResult,
  ImportHistoryItem,
} from '@shared/api.interface';
import type { ImportCommitReceipt } from '../../../shared/screenshot-import.interface';
import { securityIdentity } from './screenshot-merge';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { recordPositionCheckpoint } from './position-checkpoint';
export type ConfirmImportDto = ImportCommitDto & {
  requestKey?: string;
  analyze?: boolean;
};
export type ConfirmImportResult = ImportCommitResult & {
  receiptId: string;
  updated: number;
  analysisRequestId?: string;
};
/** All entry points upsert a reviewed snapshot atomically and leave unmentioned positions alone. */
@Injectable()
export class ImportService {
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
    private readonly quoteService: QuoteService,
    @Optional()
    private readonly handoff?: ImportAnalysisHandoffService,
  ) {}
  async commit(
    owner: string,
    dto: ConfirmImportDto,
  ): Promise<ConfirmImportResult> {
    if (
      !dto ||
      !Array.isArray(dto.rows) ||
      !dto.rows.length ||
      dto.rows.length > 200 ||
      !['csv', 'robinhood', 'ocr'].includes(dto.source)
    )
      throw new BadRequestException('INVALID_ROWS');
    if (
      dto.requestKey !== undefined &&
      (typeof dto.requestKey !== 'string' ||
        !dto.requestKey ||
        dto.requestKey.length > 150)
    )
      throw new BadRequestException('INVALID_REQUEST');
    const seen = new Set<string>();
    const rows = dto.rows.map((row) => {
      if (
        !row ||
        typeof row.ticker !== 'string' ||
        (row.company != null && typeof row.company !== 'string') ||
        !['number', 'string'].includes(typeof row.shares) ||
        (row.avgCost != null &&
          !['number', 'string'].includes(typeof row.avgCost))
      )
        throw new BadRequestException('INVALID_ROWS');
      const identity = securityIdentity(String(row.ticker ?? '')),
        shares = Number(row.shares),
        cost =
          row.avgCost == null || row.avgCost === ''
            ? null
            : Number(row.avgCost);
      if (
        !identity ||
        !Number.isFinite(shares) ||
        shares <= 0 ||
        shares > Number.MAX_SAFE_INTEGER ||
        (cost !== null && (!Number.isFinite(cost) || cost < 0)) ||
        (row.currency && !['USD', 'HKD', 'CNY'].includes(row.currency)) ||
        (row.company && row.company.length > 200)
      )
        throw new BadRequestException('INVALID_ROWS');
      if (seen.has(identity.key))
        throw new BadRequestException('DUPLICATE_TICKER');
      seen.add(identity.key);
      return { row, identity, shares, cost };
    });
    const requestKey = dto.requestKey ?? randomUUID(),
      inputHash = createHash('sha256')
        .update(JSON.stringify(dto))
        .digest('hex');
    return this.db.transaction(async (tx) => {
      await lockMemoryOwner(tx, owner);
      const [prior] = await tx
        .select()
        .from(importCommitReceipts)
        .where(
          and(
            eq(importCommitReceipts.owner, owner),
            eq(importCommitReceipts.requestKey, requestKey),
          ),
        );
      if (prior) {
        if (prior.inputHash !== inputHash)
          throw new ConflictException('IDEMPOTENCY_CONFLICT');
        return {
          logId: prior.id,
          receiptId: prior.id,
          created: prior.receipt.created,
          updated: prior.receipt.updated,
          skipped: 0,
          failed: [],
          analysisRequestId: prior.receipt.analysisRequestId,
        };
      }
      const positions = await tx
        .select()
        .from(holdings)
        .where(eq(holdings.owner, owner))
        .for('update');
      const receipt: ImportCommitReceipt = {
        id: randomUUID(),
        requestKey,
        rowIds: [],
        created: 0,
        updated: 0,
        createdAt: new Date().toISOString(),
      };
      for (const { row, identity, shares, cost } of rows) {
        const existing = positions.find(
          (position) =>
            securityIdentity(position.ticker, position.market ?? undefined)
              ?.key === identity.key,
        );
        const value = {
          ticker: identity.ticker,
          company: row.company?.trim() || null,
          shares: String(shares),
          buyPrice: cost === null ? null : String(cost),
          market: identity.market,
          currency: row.currency ?? identity.currency,
          buyDate: dto.buyDate || null,
          updatedAt: new Date(),
        };
        value.ticker = await recordPositionCheckpoint(tx, owner, value, existing, dto.source, receipt.id);
        if (existing) {
          await tx
            .update(holdings)
            .set(value)
            .where(
              and(eq(holdings.owner, owner), eq(holdings.id, existing.id)),
            );
          receipt.updated++;
        } else {
          await tx.insert(holdings).values({ owner, ...value });
          receipt.created++;
        }
      }
      await tx.insert(importLogs).values({
        id: receipt.id,
        owner,
        source: dto.source,
        filename: dto.filename?.slice(0, 255) ?? null,
        rowsTotal: rows.length,
        rowsImported: rows.length,
        errors: [],
      });
      if (dto.analyze) {
        if (!this.handoff) throw new ConflictException('ANALYSIS_UNAVAILABLE');
        receipt.analysisRequestId = (
          await this.handoff.enqueueInTransaction(tx, owner, receipt.id)
        ).id;
      }
      await tx
        .insert(importCommitReceipts)
        .values({ id: receipt.id, owner, requestKey, inputHash, receipt });
      return {
        logId: receipt.id,
        receiptId: receipt.id,
        created: receipt.created,
        updated: receipt.updated,
        skipped: 0,
        failed: [],
        analysisRequestId: receipt.analysisRequestId,
      };
    });
  }
  async history(owner: string, limit = 20): Promise<ImportHistoryItem[]> {
    const rows = await this.db
      .select()
      .from(importLogs)
      .where(eq(importLogs.owner, owner))
      .orderBy(desc(importLogs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((row) => ({
      id: row.id,
      source: row.source as ImportHistoryItem['source'],
      filename: row.filename,
      rowsTotal: row.rowsTotal,
      rowsImported: row.rowsImported,
      errors: (row.errors as ImportHistoryItem['errors']) ?? [],
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
