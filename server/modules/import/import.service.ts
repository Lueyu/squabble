/**
 * Import service（导入提交引擎）。
 *
 * 职责边界：把客户端规范化后的持仓行校验并写入 holdings；三种来源共用
 * 同一条提交路径——
 *  - 'csv'       通用 CSV（客户端 papaparse 解析+列映射）
 *  - 'robinhood' Robinhood CSV（同一流程上的已保存列映射）
 *  - 'ocr'       券商截图 OCR（由用户自己的多模态 LLM Key 提取，见
 *                ocr.service.ts）
 * 提交语义（刻意保守）：已存在 ticker 的行一律跳过（绝不静默合并——请去
 * 持仓页编辑）；每行结果与原因都写入 import_logs。不管 OCR 上游调用。
 *
 * 上下游：import @nestjs/common、drizzle-orm、DRIZZLE_DATABASE
 * （common/platform 注入）、holdings 与 importLogs（database/schema）、
 * QuoteService（quote 模块的市场/币种检测）、@shared/api.interface 类型；
 * 由 import.controller.ts 调用。
 *
 * 关键约定：单次导入上限 MAX_ROWS_PER_IMPORT=200 行；ticker 归一化与
 * canonicalKey 规则见文件底部工具函数（HK 4 位补零、CN 6 位、US 原样
 * 大写；比较键统一为 `HK:700` / `CN:600519` / `US:AAPL` 形态）；数值经
 * shrinkNumber 消除浮点噪声（保留 6 位小数精度）后以字符串落 numeric 列。
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { holdings, importLogs } from '../../database/schema';
import { QuoteService } from '../quote/quote.service';
import type { ImportCommitDto, ImportHistoryItem, ImportRowCandidate } from '@shared/api.interface';

/** 单次导入接受的行数上限（防止一次提交打爆数据库）。 */
const MAX_ROWS_PER_IMPORT = 200;

@Injectable()
export class ImportService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly quoteService: QuoteService,
  ) {}

  /**
   * 校验并从映射后的行创建持仓。
   * 已存在的 ticker 会被跳过（带原因），导入从不静默重复或合并既有持仓。
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
    // 第一步：入口校验——行数非空、不超上限、来源合法。
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

    // 第二步：取该用户全部既有 ticker 构建"已存在"集合。比较用 canonical
    // 键，'0700'、'700.HK'、'00700' 都识别为同一只股票。
    const existing = await this.db
      .select({ ticker: holdings.ticker })
      .from(holdings)
      .where(eq(holdings.owner, userId));
    const existingSet = new Set(existing.map((h) => canonicalKey(h.ticker)));

    // 第三步：逐行校验，收集失败原因；通过的行进入 valid 待插入清单。
    const failures: Array<{ ticker: string; reason: string }> = [];
    const seen = new Set<string>();
    const valid: Array<{ row: ImportRowCandidate; ticker: string }> = [];

    for (const row of rows) {
      const raw = (row.ticker ?? '').toString().trim();
      if (!raw) {
        failures.push({ ticker: '(空)', reason: 'Missing ticker' });
        continue;
      }
      // 市场检测失败 = 无法识别该 ticker 属于哪个市场。
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
      // 与持仓库比对：已存在则拒绝（引导用户去编辑而非重复导入）。
      const ticker = normalizeTickerForStorage(raw, info.market);
      if (existingSet.has(canonicalKey(ticker))) {
        failures.push({ ticker: raw, reason: '持仓已存在，请在持仓页编辑而非重复导入' });
        continue;
      }
      // 与本次导入比对：同一 ticker 重复出现也拒绝。
      if (seen.has(canonicalKey(ticker))) {
        failures.push({ ticker: raw, reason: '本次导入中重复' });
        continue;
      }
      seen.add(canonicalKey(ticker));
      valid.push({ row, ticker });
    }

    // 第四步：逐条插入通过的行；每股成本与股数先 shrinkNumber 消浮点噪声。
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

    // 第五步：无论成败都写一条 import_logs（含总行数/成功数/逐行失败原因）。
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

  /** 当前用户最近的导入历史（默认 20 条，限制在 1..100 之间）。 */
  async history(userId: string, limit = 20): Promise<ImportHistoryItem[]> {
    const rows = await this.db
      .select()
      .from(importLogs)
      .where(eq(importLogs.owner, userId))
      .orderBy(desc(importLogs.createdAt))
      // limit 夹取到 [1,100]，防恶意大分页。
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

/** 消除浮点噪声的数字渲染（如 1e-7 -> '0'）；四舍五入到 6 位小数。 */
function shrinkNumber(value: number | string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 1e6) / 1e6);
}

/**
 * ticker 的规范比较键：'0700'、'700.HK'、'00700' 都折叠为 'HK:700'；
 * US 代码大写；CN 保留 6 位数字。
 */
function canonicalKey(rawTicker: string): string {
  const raw = rawTicker.trim().toUpperCase();
  // 港股：1-5 位数字（可带 .HK 后缀）；4-5 位数字视为港股代码。
  const hkMatch = /^(\d{1,5})(?:\.HK)?$/.exec(raw);
  if (hkMatch && (raw.endsWith('.HK') || /^\d{4,5}$/.test(raw))) {
    return `HK:${Number(hkMatch[1])}`;
  }
  // A 股：6 位数字（可带 .SH/.SZ/.BJ 后缀）。
  if (/^\d{6}(?:\.(?:SH|SZ|BJ))?$/.test(raw)) return `CN:${raw.slice(0, 6)}`;
  return `US:${raw}`;
}

/**
 * ticker 的存储形态：HK 为 4 位补零代码（'700' -> '0700'，与应用自身页面
 * 存储港股的方式一致）；CN 为 6 位数字；US 按输入大写。
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
