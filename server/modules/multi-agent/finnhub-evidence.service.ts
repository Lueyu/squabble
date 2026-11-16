/**
 * finnhub-evidence.service.ts — 通过 Finnhub API 获取估值指标、财报与公司新闻三类证据。
 *
 * 职责边界：
 *  - 负责：Finnhub 密钥/市场支持校验、API 请求与错误码归一化、
 *    估值指标（getMetrics）、财报（getFinancials，quarterly→annual 回退）、
 *    公司新闻（getNews）的抓取与清洗。
 *  - 不负责：财报解析细节（parseFinnhubFinancials 在 finnhub-financials.ts）、
 *    证据源的最终取舍（由 EvidenceService 决定）。
 * 上下游：
 *  - 上游（谁调用这里）：EvidenceService 调用 getMetrics / getFinancials / getNews，
 *    并用 finnhubGapReason 把失败码翻译为用户可读的缺口说明。
 *  - 下游（本文件调用谁）：SettingsService（读取用户 Finnhub 密钥）、
 *    finnhub-financials.ts（finiteFinnhubNumber / parseFinnhubFinancials）、Finnhub REST API。
 * 关键约定：
 *  - 只查询美股代码：公司新闻覆盖范围仅北美（HK/SH/SS/SZ/BJ 后缀被排除）。
 *  - 对外错误只暴露安全的语义化 code（如 unauthorized/rate_limited），
 *    绝不透传原始 provider 错误文本或 URL。
 */
import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import type { EvidenceInput } from './evidence.service';
import {
  finiteFinnhubNumber,
  parseFinnhubFinancials,
  type FinnhubFinancialsResult,
} from './finnhub-financials';

/** Finnhub 证据获取的失败原因码。 */
type FinnhubFailureCode =
  | 'missing_key'
  | 'unsupported_market'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'timeout'
  | 'network_error'
  | 'invalid_response'
  | 'provider_error'
  | 'no_data'
  | 'stale_data'
  | 'incomplete_data';

/** 只暴露安全、可操作的分类 code：绝不保留原始 provider 错误文本或 URL。 */
export class FinnhubEvidenceError extends Error {
  constructor(readonly code: FinnhubFailureCode) {
    super(`Finnhub ${code}`);
    this.name = 'FinnhubEvidenceError';
  }
}

// 把 Finnhub 失败码翻译为面向用户的中文缺口说明（未识别异常一律归为 provider_error）。
export function finnhubGapReason(error: unknown): string {
  const code: FinnhubFailureCode =
    error instanceof FinnhubEvidenceError ? error.code : 'provider_error';
  const reasons: Record<FinnhubFailureCode, string> = {
    missing_key: '当前账户未配置 Finnhub 密钥；请在设置中保存密钥后刷新研究数据。',
    unsupported_market: '当前 Finnhub 证据接入仅支持美股代码，暂不支持该市场。',
    unauthorized: 'Finnhub 拒绝认证（HTTP 401）；请检查当前账户保存的密钥。',
    forbidden: 'Finnhub 拒绝访问（HTTP 403）；请检查密钥和此接口的订阅权限。',
    rate_limited: 'Finnhub 请求频率受限（HTTP 429）；请稍后刷新研究数据。',
    timeout: 'Finnhub 请求超时；请检查网络后刷新研究数据。',
    network_error: '无法连接 Finnhub；请检查网络后刷新研究数据。',
    invalid_response: 'Finnhub 返回的数据格式、报告日期或标的校验未通过。',
    provider_error: 'Finnhub 请求失败；请稍后刷新研究数据。',
    no_data: 'Finnhub 请求成功，但没有返回该标的所需的有效数据。',
    stale_data: 'Finnhub 返回的最新财报已超过可用时效，需补充更新的报告。',
    incomplete_data: 'Finnhub 最新财报缺少必需科目或币种单位，仍需补齐。',
  };
  return `[Finnhub:${code}] ${reasons[code]}`;
}

/** Finnhub 基础指标（metric）证据的结构：证据条目 + 是否拿到估值数据。 */
interface FinnhubMetricsResult {
  items: EvidenceInput[];
  hasValuation: boolean;
}

/** Finnhub 公司新闻条目的宽松形状（字段类型未验证，使用前必须清洗）。 */
interface FinnhubArticle {
  headline?: unknown;
  summary?: unknown;
  source?: unknown;
  url?: unknown;
  datetime?: unknown;
}

// Finnhub API 基址与新闻条数上限。
const FINNHUB_API = 'https://api.finnhub.io/api/v1';
const MAX_NEWS_ITEMS = 5;

/** 只查询美股代码：Finnhub 的公司新闻覆盖范围仅限北美。 */
function isSupportedSymbol(ticker: string): boolean {
  const upper = ticker.toUpperCase().trim();
  return /^[A-Z][A-Z0-9.-]{0,19}$/.test(upper) && !/\.(HK|SH|SS|SZ|BJ)$/.test(upper);
}

// 文本清洗：剥 HTML 标签、折叠空白、截断；非字符串一律空串。
function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// 新闻来源 URL 只接受合法的 https 链接，其余一律丢弃。
function safeArticleUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

@Injectable()
export class FinnhubEvidenceService {
  constructor(private readonly settings: SettingsService) {}

  // 校验市场支持与用户密钥，返回可用的 trimmed token；二者缺一即抛对应错误
  private async callerToken(userId: string, ticker: string): Promise<string> {
    if (!isSupportedSymbol(ticker)) throw new FinnhubEvidenceError('unsupported_market');
    const token: string | null = await this.settings.getFinnhubKey(userId);
    if (!token?.trim()) throw new FinnhubEvidenceError('missing_key');
    return token.trim();
  }

  // 统一的 Finnhub GET 请求：拼 URL 与参数、10s 超时、状态码/JSON/错误体三种校验
  private async request(
    path: string,
    token: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${FINNHUB_API}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('token', token);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      // HTTP 状态码映射：401/403/429 有专属码，其余归 provider_error
      if (!response.ok) {
        const code: FinnhubFailureCode =
          response.status === 401
            ? 'unauthorized'
            : response.status === 403
              ? 'forbidden'
              : response.status === 429
                ? 'rate_limited'
                : 'provider_error';
        throw new FinnhubEvidenceError(code);
      }
      // JSON 解析失败或响应体携带 error 字段都视为不可信
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new FinnhubEvidenceError('invalid_response');
      }
      if (payload && typeof payload === 'object' && 'error' in payload) {
        throw new FinnhubEvidenceError('provider_error');
      }
      return payload;
    } catch (error) {
      // 语义化错误原样抛出；超时/中止归为 timeout，其余网络层异常归为 network_error
      if (error instanceof FinnhubEvidenceError) throw error;
      const timeout: boolean =
        error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
      throw new FinnhubEvidenceError(timeout ? 'timeout' : 'network_error');
    }
  }

  async getMetrics(userId: string, ticker: string): Promise<FinnhubMetricsResult | null> {
    const token = await this.callerToken(userId, ticker);

    // 请求公司基础指标（metric=all）
    const raw = await this.request('/stock/metric', token, {
      symbol: ticker.toUpperCase(),
      metric: 'all',
    });
    const metric = raw && typeof raw === 'object' && 'metric' in raw ? raw.metric : null;
    if (!metric || typeof metric !== 'object') {
      throw new FinnhubEvidenceError('invalid_response');
    }

    // 只提取白名单估值字段（PE/PB/PS），且必须是正的有限数值
    const fields: Array<[string, string]> = [
      ['peBasicExclExtraTTM', 'P/E (TTM, excluding extraordinary items)'],
      ['pbAnnual', 'P/B (annual)'],
      ['psTTM', 'P/S (TTM)'],
    ];
    const values: string[] = [];
    for (const [key, label] of fields) {
      const rawValue = (metric as Record<string, unknown>)[key];
      const numeric: number | undefined = finiteFinnhubNumber(rawValue);
      if (numeric !== undefined && numeric > 0) {
        values.push(`${label}: ${numeric.toFixed(2)}`);
      }
    }
    // 一个估值字段都没拿到 → 明确上报"无估值数据"
    if (values.length === 0) return { items: [], hasValuation: false };
    return {
      hasValuation: true,
      items: [
        {
          role: 'fundamental',
          evidenceType: 'financial',
          title: `${ticker.toUpperCase()} Finnhub valuation metrics`,
          content: values.join('; '),
          sourceName: 'Finnhub API',
          sourceUrl: 'https://finnhub.io/docs/api/company-basic-financials',
          relevanceScore: 0.8,
        },
      ],
    };
  }

  async getFinancials(userId: string, ticker: string): Promise<FinnhubFinancialsResult> {
    const token: string = await this.callerToken(userId, ticker);
    // 查询窗口固定 550 天（对应年报的最大时效），from/to 都按 UTC 日期
    const now: Date = new Date();
    const from: string = new Date(now.getTime() - 550 * 86_400_000).toISOString().slice(0, 10);
    // 先试季报；仅当季报明确 no_data 时才回退年报，其余 issue 直接抛出
    for (const frequency of ['quarterly', 'annual'] as const) {
      const raw: unknown = await this.request('/stock/financials-reported', token, {
        symbol: ticker.toUpperCase().trim(),
        freq: frequency,
        from,
        to: now.toISOString().slice(0, 10),
      });
      const result: FinnhubFinancialsResult = parseFinnhubFinancials(raw, ticker, frequency, now);
      if (result.issue === 'no_data' && frequency === 'quarterly') continue;
      if (result.issue) throw new FinnhubEvidenceError(result.issue);
      return result;
    }
    // 季报与年报都没有可用数据
    throw new FinnhubEvidenceError('no_data');
  }

  async getNews(userId: string, ticker: string): Promise<EvidenceInput[] | null> {
    const token = await this.callerToken(userId, ticker);

    // 抓取最近 7 天的公司新闻（from/to 按 UTC 日期）
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const raw = await this.request('/company-news', token, {
      symbol: ticker.toUpperCase(),
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    });
    if (!Array.isArray(raw)) throw new FinnhubEvidenceError('invalid_response');

    // 过滤：标题非空且 datetime 为有效秒级时间戳、落在抓取窗口内；最多取 5 条
    return (raw as FinnhubArticle[])
      .filter(
        (article) =>
          cleanText(article.headline, 300).length > 0 &&
          typeof article.datetime === 'number' &&
          Number.isFinite(article.datetime) &&
          article.datetime * 1000 >= from.getTime() &&
          article.datetime * 1000 <= to.getTime(),
      )
      .slice(0, MAX_NEWS_ITEMS)
      .map((article) => {
        const headline = cleanText(article.headline, 300);
        const summary = cleanText(article.summary, 500);
        const publisher = cleanText(article.source, 80);
        const publishedAt = new Date((article.datetime as number) * 1000).toISOString();
        return {
          role: 'news' as const,
          evidenceType: 'news' as const,
          title: headline,
          content: `Published: ${publishedAt}. ${publisher ? `Publisher: ${publisher}. ` : ''}${summary || 'Headline only; no article summary supplied.'}`,
          sourceUrl: safeArticleUrl(article.url),
          sourceName: 'Finnhub API',
          relevanceScore: 0.65,
        };
      });
  }
}
