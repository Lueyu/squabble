/**
 * sec-evidence.service.ts — 从 SEC 公开数据源抓取并缓存美股发行人财报证据。
 *
 * 职责边界：
 *  - 负责 SEC submissions / companyfacts 两个端点的抓取、限速、响应大小校验、
 *    JSON 校验，以及结果/失败/ticker 目录三层缓存与在途请求去重。
 *  - 不负责财报字段的具体解析（parseSecFinancials 在 sec-financials.ts），
 *    也不负责证据源的取舍（由 EvidenceService 决定）。
 * 上下游：
 *  - 上游（谁调用这里）：EvidenceService 通过 getFinancials 取 SEC 财报证据。
 *  - 下游（本文件调用谁）：sec-financials.ts 的 secTicker / secRecord / parseSecFinancials，
 *    以及 SEC 公开 API（www.sec.gov 目录文件与 data.sec.gov 数据端点）。
 * 关键约定：
 *  - 缓存内容只包含公开数据源的发行人数据，绝不包含账户密钥或组合记录（既有安全约束）。
 *  - 请求 URL 走白名单校验：只接受目录文件 URL 与由已验证数字 CIK 构造的两个端点，
 *    绝不接受调用方传入的任意 URL。
 *  - 对 SEC 的请求全局间隔 300ms；需要等待超过 3s 时直接以 rate_limited 拒绝。
 */
import { Injectable } from '@nestjs/common';
import type { FinnhubFinancialsResult } from './finnhub-financials';
import { parseSecFinancials, secRecord, secTicker } from './sec-financials';

/** SEC 证据获取的失败原因码（对外作为 SecEvidenceError.code 暴露）。 */
type SecFailureCode =
  | 'unsupported_market'
  | 'no_data'
  | 'invalid_response'
  | 'stale_data'
  | 'forbidden'
  | 'rate_limited'
  | 'timeout'
  | 'network_error'
  | 'provider_error'
  | 'response_too_large';

/** 带 code 的 SEC 证据错误；错误消息固定为 `SEC ${code}`。 */
export class SecEvidenceError extends Error {
  constructor(readonly code: SecFailureCode) {
    super(`SEC ${code}`);
    this.name = 'SecEvidenceError';
  }
}

/** SEC 财报证据结果：与 Finnhub 财报结果同构，额外携带是否命中缓存的标记。 */
export interface SecFinancialsResult extends FinnhubFinancialsResult {
  cacheHit: boolean;
}

/** 缓存条目：到期时间戳，且"成功结果"与"失败错误"二选一。 */
interface CachedResult {
  expiresAt: number;
  result?: FinnhubFinancialsResult;
  error?: SecEvidenceError;
}

// 缓存与限额常量：成功结果缓存 1 小时、失败结果缓存 1 分钟、ticker 目录缓存 24 小时；
// 响应体上限 12MiB、结果缓存条目上限 128、SEC 官方 ticker 目录地址。
const RESULT_TTL = 60 * 60_000;
const FAILURE_TTL = 60_000;
const TICKER_TTL = 24 * 60 * 60_000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const TICKER_URL = 'https://www.sec.gov/files/company_tickers.json';

/**
 * SEC 财报证据服务。
 * 公共数据源缓存只包含发行人数据，绝不包含账户密钥或组合记录。
 */
@Injectable()
export class SecEvidenceService {
  // 结果缓存：ticker → 到期条目（配合 remember 实现近似 LRU）
  private readonly cache = new Map<string, CachedResult>();
  // 在途请求表：ticker → 正在进行的抓取 Promise，用于并发去重
  private readonly inFlight = new Map<string, Promise<FinnhubFinancialsResult>>();
  // ticker→CIK 目录缓存及其在途下载（独立于结果缓存，TTL 更长）
  private tickerCache: { expiresAt: number; values: Map<string, string> } | null = null;
  private tickerInFlight: Promise<Map<string, string>> | null = null;
  // 下一次允许发起 SEC 请求的时间戳（ms），用于实现 300ms 全局间隔
  private nextRequestAt: number = 0;

  async getFinancials(ticker: string): Promise<SecFinancialsResult> {
    // 规范化 ticker：secTicker 无法识别的市场直接以 unsupported_market 拒绝
    const normalized: string | undefined = secTicker(ticker);
    if (!normalized) throw new SecEvidenceError('unsupported_market');

    // 命中未过期缓存：失败与成功结果分别处理，返回的都是深拷贝副本（不共享可变对象）
    const cached: CachedResult | undefined = this.cache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.error) throw cached.error;
      if (cached.result) return { ...structuredClone(cached.result), cacheHit: true };
    }

    // 已有同 ticker 的在途请求：挂到该 Promise 上复用结果，避免重复抓取
    const active: Promise<FinnhubFinancialsResult> | undefined = this.inFlight.get(normalized);
    if (active) return { ...structuredClone(await active), cacheHit: true };

    // 在途请求并发上限 16，超出以 rate_limited 拒绝
    if (this.inFlight.size >= 16) throw new SecEvidenceError('rate_limited');

    // 发起新抓取并登记在途表；成功按 1 小时缓存，失败按 1 分钟缓存
    const work: Promise<FinnhubFinancialsResult> = this.collect(normalized);
    this.inFlight.set(normalized, work);
    try {
      const result: FinnhubFinancialsResult = await work;
      this.remember(normalized, { expiresAt: Date.now() + RESULT_TTL, result });
      return { ...structuredClone(result), cacheHit: false };
    } catch (error) {
      // 未知异常统一包装为 provider_error 后再缓存并抛出
      const safe: SecEvidenceError =
        error instanceof SecEvidenceError ? error : new SecEvidenceError('provider_error');
      this.remember(normalized, { expiresAt: Date.now() + FAILURE_TTL, error: safe });
      throw safe;
    } finally {
      // 无论成败都从在途表移除，释放并发额度
      this.inFlight.delete(normalized);
    }
  }

  /**
   * 写入缓存条目：先删后插把该 ticker 挪到 Map 队尾，容量满时淘汰队首
   * （Map 按插入序遍历，即近似 LRU）。
   */
  private remember(ticker: string, value: CachedResult): void {
    this.cache.delete(ticker);
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest: string | undefined = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(ticker, value);
  }

  // 抓取单只股票的 SEC 财报证据：查目录 → 并行请求递交记录与公司事实 → 解析校验
  private async collect(ticker: string): Promise<FinnhubFinancialsResult> {
    // 目录中查不到该 ticker 对应的 CIK，视为无数据
    const tickers: Map<string, string> = await this.tickers();
    const cik: string | undefined = tickers.get(ticker);
    if (!cik) throw new SecEvidenceError('no_data');

    // 递交记录（submissions）与 XBRL 公司事实（companyfacts）并行获取
    const [submissions, facts] = await Promise.all([
      this.request(`https://data.sec.gov/submissions/CIK${cik}.json`),
      this.request(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`),
    ]);

    // 解析结果若报告了 issue（如数据过期、缺必需科目），转成对应错误抛出
    const result: FinnhubFinancialsResult = parseSecFinancials(facts, submissions, ticker);
    if (result.issue) throw new SecEvidenceError(result.issue);
    return result;
  }

  // 获取 ticker→CIK 目录：带 24h 缓存，并发调用通过在途 Promise 共用同一次下载
  private async tickers(): Promise<Map<string, string>> {
    if (this.tickerCache && this.tickerCache.expiresAt > Date.now()) return this.tickerCache.values;
    if (this.tickerInFlight) return this.tickerInFlight;
    this.tickerInFlight = this.loadTickers();
    try {
      const values: Map<string, string> = await this.tickerInFlight;
      this.tickerCache = { values, expiresAt: Date.now() + TICKER_TTL };
      return values;
    } finally {
      // 无论成败都清空在途标记，让后续调用可以重试
      this.tickerInFlight = null;
    }
  }

  // 下载并解析 SEC 目录文件：最多取前 30000 条，CIK 须为 1-10 位正整数并左补零到 10 位
  private async loadTickers(): Promise<Map<string, string>> {
    const raw: Record<string, unknown> | undefined = secRecord(await this.request(TICKER_URL));
    if (!raw) throw new SecEvidenceError('invalid_response');

    // 逐条校验并归一化：ticker 规范化失败或 CIK 不合规的条目直接跳过
    const result: Map<string, string> = new Map();
    for (const value of Object.values(raw).slice(0, 30000)) {
      const row: Record<string, unknown> | undefined = secRecord(value);
      const ticker: string | undefined =
        typeof row?.ticker === 'string' ? secTicker(row.ticker) : undefined;
      const cik: string = String(row?.cik_str ?? '');
      if (ticker && /^\d{1,10}$/.test(cik) && Number(cik) > 0)
        result.set(ticker, cik.padStart(10, '0'));
    }

    // 一条有效条目都没有，说明目录响应本身有问题
    if (!result.size) throw new SecEvidenceError('invalid_response');
    return result;
  }

  private async request(url: string): Promise<unknown> {
    // URL 白名单：路径均由已验证的数字 CIK 构造，绝不接受调用方传入的任意 URL
    if (
      url !== TICKER_URL &&
      !/^https:\/\/data\.sec\.gov\/(?:submissions|api\/xbrl\/companyfacts)\/CIK\d{10}\.json$/.test(
        url,
      )
    ) {
      throw new SecEvidenceError('invalid_response');
    }

    // 限速调度：全局请求间隔 300ms；若本次需等待超过 3s 则直接以 rate_limited 拒绝
    const scheduled: number = Math.max(Date.now(), this.nextRequestAt);
    const wait: number = scheduled - Date.now();
    if (wait > 3000) throw new SecEvidenceError('rate_limited');
    this.nextRequestAt = scheduled + 300;
    if (wait > 0) await new Promise<void>((resolve: () => void) => setTimeout(resolve, wait));

    // UA 选择：优先环境变量 SEC_USER_AGENT（去空白、≤200 字符、不含换行），否则用固定默认值
    const configuredAgent: string = process.env.SEC_USER_AGENT?.trim() ?? '';
    const userAgent: string =
      configuredAgent && configuredAgent.length <= 200 && !/[\r\n]/.test(configuredAgent)
        ? configuredAgent
        : 'Squabble/2.0 (public financial research)';
    try {
      // 发起请求：10s 超时、禁止重定向
      const response: Response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': userAgent },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      // 非 2xx：按状态码映射为语义化失败码（403/429/404 有专属码，其余归 provider_error）
      if (!response.ok)
        throw new SecEvidenceError(
          response.status === 403
            ? 'forbidden'
            : response.status === 429
              ? 'rate_limited'
              : response.status === 404
                ? 'no_data'
                : 'provider_error',
        );
      // 响应体大小第一道闸：Content-Length 超过 12MiB 时取消读取
      if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new SecEvidenceError('response_too_large');
      }
      // 流式读取并累计字节数：读取过程中超过上限同样中断，防止超大响应拖垮内存
      const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
        response.body?.getReader();
      if (!reader) throw new SecEvidenceError('invalid_response');
      const chunks: Uint8Array[] = [];
      let size: number = 0;
      for (;;) {
        const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new SecEvidenceError('response_too_large');
        }
        chunks.push(chunk.value);
      }
      // 把分块拼接为完整字节序列
      const bytes: Uint8Array = new Uint8Array(size);
      let offset: number = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      // 解码并解析 JSON，格式非法视为 invalid_response
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch {
        throw new SecEvidenceError('invalid_response');
      }
    } catch (error) {
      // SEC 错误原样抛出；超时/中止类归为 timeout，其余网络层异常归为 network_error
      if (error instanceof SecEvidenceError) throw error;
      throw new SecEvidenceError(
        error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
          ? 'timeout'
          : 'network_error',
      );
    }
  }
}
