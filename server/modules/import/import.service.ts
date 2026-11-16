/**
 * @file server/modules/import/import.service.ts
 * @description Portfolio import engine.
 *
 * Three sources share one commit path:
 *  - 'csv'       generic CSV (parsed and mapped client-side with papaparse)
 *  - 'robinhood' Robinhood CSV (a saved column mapping over the same flow)
 *  - 'ocr'       broker screenshot OCR (rows extracted by the user's own
 *                multimodal LLM key, see ocr.service.ts)
 *
 * Commit semantics (deliberately conservative):
 *  - ticker is normalized and its market/currency auto-detected from shape
 *  - rows whose ticker already exists as a holding are SKIPPED (never
 *    silently merged — edit the holding instead)
 *  - every outcome is persisted to import_logs with per-row reasons
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { holdings, importLogs } from '../../database/schema';
import { QuoteService } from '../quote/quote.service';
import type { ImportCommitDto, ImportHistoryItem, ImportRowCandidate } from '@shared/api.interface';

/** Max rows accepted in one import. */
const MAX_ROWS_PER_IMPORT = 200;

@Injectable()
export class ImportService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly quoteService: QuoteService,
  ) {}

  /**
   * Validate and create holdings from mapped rows.
   * Existing tickers are skipped (with a reason) so an import never
   * silently duplicates or merges existing positions.
   */
  async commit(
    userId: string,
    dto: ImportCommitDto,
  ): Promise<{
    logId: string;
    created: number;
    skipped: number;
    failed: Array<{ ticker: string; reason: string }>;
  }> {
    const rows = dto.rows ?? [];
    if (rows.length === 0) throw new BadRequestException('No rows to import');
    if (rows.length > MAX_ROWS_PER_IMPORT) {
      throw new BadRequestException(
        `单次最多导入 ${MAX_ROWS_PER_IMPORT} 行（收到 ${rows.length} 行）`,
      );
    }
    if (!['csv', 'robinhood', 'ocr'].includes(dto.source)) {
      throw new BadRequestException('Unknown import source');
    }

    // Existing tickers -> skip list. Comparison happens on a canonical key
    // so '0700', '700.HK' and '00700' are all recognized as the same stock.
    const existing = await this.db
      .select({ ticker: holdings.ticker })
      .from(holdings)
      .where(eq(holdings.owner, userId));
    const existingSet = new Set(existing.map((h) => canonicalKey(h.ticker)));

    const failures: Array<{ ticker: string; reason: string }> = [];
    const seen = new Set<string>();
    const valid: Array<{ row: ImportRowCandidate; ticker: string }> = [];

    for (const row of rows) {
      const raw = (row.ticker ?? '').toString().trim();
      if (!raw) {
        failures.push({ ticker: '(空)', reason: 'Missing ticker' });
        continue;
      }
      let info: ReturnType<QuoteService['detectMarket']>;
      try {
        info = this.quoteService.detectMarket(raw);
      } catch {
        failures.push({ ticker: raw, reason: 'Cannot identify market for this ticker' });
        continue;
      }
      const shares = Number(row.shares);
      if (!Number.isFinite(shares) || shares <= 0) {
        failures.push({ ticker: raw, reason: 'Invalid share count (must be > 0)' });
        continue;
      }
      const avgCost = row.avgCost == null ? null : Number(row.avgCost);
      if (avgCost != null && (!Number.isFinite(avgCost) || avgCost < 0)) {
        failures.push({ ticker: raw, reason: 'Invalid cost price' });
        continue;
      }
      const ticker = normalizeTickerForStorage(raw, info.market);
      if (existingSet.has(canonicalKey(ticker))) {
        failures.push({ ticker: raw, reason: '持仓已存在，请在持仓页编辑而非重复导入' });
        continue;
      }
      if (seen.has(canonicalKey(ticker))) {
        failures.push({ ticker: raw, reason: '本次导入中重复' });
        continue;
      }
      seen.add(canonicalKey(ticker));
      valid.push({ row, ticker });
    }

    let created = 0;
    for (const { row, ticker } of valid) {
      const info = this.quoteService.detectMarket(row.ticker.trim());
      await this.db.insert(holdings).values({
        owner: userId,
        ticker,
        company: row.company?.trim() || null,
        shares: String(shrinkNumber(row.shares)),
        buyPrice: row.avgCost == null ? null : String(shrinkNumber(row.avgCost)),
        buyDate: dto.buyDate || null,
        market: info.market,
        currency: info.currency,
        symbolNative: info.symbolNative,
        displaySymbol: info.displaySymbol,
      });
      created += 1;
    }

    const [log] = await this.db
      .insert(importLogs)
      .values({
        owner: userId,
        source: dto.source,
        filename: dto.filename ?? null,
        rowsTotal: rows.length,
        rowsImported: created,
        errors: failures,
      })
      .returning({ id: importLogs.id });

    return {
      logId: log.id,
      created,
      skipped: failures.length,
      failed: failures,
    };
  }

  /** Recent import history for the caller. */
  async history(userId: string, limit = 20): Promise<ImportHistoryItem[]> {
    const rows = await this.db
      .select()
      .from(importLogs)
      .where(eq(importLogs.owner, userId))
      .orderBy(desc(importLogs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((r) => ({
      id: r.id,
      source: r.source as ImportHistoryItem['source'],
      filename: r.filename,
      rowsTotal: r.rowsTotal,
      rowsImported: r.rowsImported,
      errors: (r.errors as ImportHistoryItem['errors']) ?? [],
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

/** Render a number without float noise (e.g. 1e-7 -> '0'). */
function shrinkNumber(value: number | string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 1e6) / 1e6);
}

/**
 * Canonical comparison key for a ticker: '0700', '700.HK' and '00700' all
 * collapse to 'HK:700'; US tickers uppercase; CN codes keep 6 digits.
 */
function canonicalKey(rawTicker: string): string {
  const raw = rawTicker.trim().toUpperCase();
  const hkMatch = /^(\d{1,5})(?:\.HK)?$/.exec(raw);
  if (hkMatch && (raw.endsWith('.HK') || /^\d{4,5}$/.test(raw))) {
    return `HK:${Number(hkMatch[1])}`;
  }
  if (/^\d{6}(?:\.(?:SH|SZ|BJ))?$/.test(raw)) return `CN:${raw.slice(0, 6)}`;
  return `US:${raw}`;
}

/**
 * Storage form for a ticker: HK as 4-digit zero-padded code ('700' ->
 * '0700', matching how the app's own pages store HK tickers), CN as the
 * 6-digit code, US uppercased as typed.
 */
function normalizeTickerForStorage(rawTicker: string, market: 'US' | 'HK' | 'CN'): string {
  const raw = rawTicker.trim().toUpperCase();
  if (market === 'HK') {
    const digits = raw.replace(/\D/g, '');
    return digits.padStart(4, '0');
  }
  if (market === 'CN') {
    return raw.replace(/\D/g, '');
  }
  return raw;
}
