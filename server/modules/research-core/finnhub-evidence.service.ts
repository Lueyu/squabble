import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import type { EvidenceInput } from './evidence.service';
import { finiteFinnhubNumber, parseFinnhubFinancials, type FinnhubFinancialsResult } from './finnhub-financials';

type FinnhubFailureCode = 'missing_key' | 'disabled' | 'unsupported_market' | 'unauthorized' | 'forbidden'
  | 'rate_limited' | 'timeout' | 'network_error' | 'invalid_response' | 'provider_error'
  | 'no_data' | 'stale_data' | 'incomplete_data';

/** Safe, actionable categories only: never preserve a raw provider error or URL. */
export class FinnhubEvidenceError extends Error {
  constructor(readonly code: FinnhubFailureCode) {
    super(`Finnhub ${code}`);
    this.name = 'FinnhubEvidenceError';
  }
}

export function finnhubGapReason(error: unknown): string {
  const code: FinnhubFailureCode = error instanceof FinnhubEvidenceError ? error.code : 'provider_error';
  const reasons: Record<FinnhubFailureCode, string> = {
    disabled: '当前账户已在数据中心停用 Finnhub 研究数据源。',
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

interface FinnhubMetricsResult {
  items: EvidenceInput[];
  hasValuation: boolean;
}

interface FinnhubArticle {
  headline?: unknown;
  summary?: unknown;
  source?: unknown;
  url?: unknown;
  datetime?: unknown;
}

const FINNHUB_API = 'https://api.finnhub.io/api/v1';
const MAX_NEWS_ITEMS = 5;

/** Only U.S. symbols are queried: Finnhub's company news covers North America. */
function isSupportedSymbol(ticker: string): boolean {
  const upper = ticker.toUpperCase().trim();
  return /^[A-Z][A-Z0-9.-]{0,19}$/.test(upper)
    && !/\.(HK|SH|SS|SZ|BJ)$/.test(upper);
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

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

  private async callerToken(userId: string, ticker: string): Promise<string> {
    if (!isSupportedSymbol(ticker)) throw new FinnhubEvidenceError('unsupported_market');
    const token: string | null = await this.settings.getFinnhubKey(userId);
    if (!token && this.settings.isFinancialProviderEnabled && !await this.settings.isFinancialProviderEnabled(userId, 'finnhub')) {
      throw new FinnhubEvidenceError('disabled');
    }
    if (!token?.trim()) throw new FinnhubEvidenceError('missing_key');
    return token.trim();
  }

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
      if (!response.ok) {
        const code: FinnhubFailureCode = response.status === 401 ? 'unauthorized'
          : response.status === 403 ? 'forbidden' : response.status === 429 ? 'rate_limited' : 'provider_error';
        throw new FinnhubEvidenceError(code);
      }
      let payload: unknown;
      try { payload = await response.json(); }
      catch { throw new FinnhubEvidenceError('invalid_response'); }
      if (payload && typeof payload === 'object' && 'error' in payload) {
        throw new FinnhubEvidenceError('provider_error');
      }
      return payload;
    } catch (error) {
      if (error instanceof FinnhubEvidenceError) throw error;
      const timeout: boolean = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
      throw new FinnhubEvidenceError(timeout ? 'timeout' : 'network_error');
    }
  }

  async getMetrics(userId: string, ticker: string): Promise<FinnhubMetricsResult | null> {
    const token = await this.callerToken(userId, ticker);

    const raw = await this.request('/stock/metric', token, {
      symbol: ticker.toUpperCase(), metric: 'all',
    });
    const metric = raw && typeof raw === 'object' && 'metric' in raw
      ? raw.metric : null;
    if (!metric || typeof metric !== 'object') {
      throw new FinnhubEvidenceError('invalid_response');
    }

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
    if (values.length === 0) return { items: [], hasValuation: false };
    return {
      hasValuation: true,
      items: [{
        role: 'fundamental',
        evidenceType: 'financial',
        title: `${ticker.toUpperCase()} Finnhub valuation metrics`,
        content: values.join('; '),
        sourceName: 'Finnhub API',
        sourceUrl: 'https://finnhub.io/docs/api/company-basic-financials',
        relevanceScore: 0.8,
      }],
    };
  }

  async getFinancials(userId: string, ticker: string): Promise<FinnhubFinancialsResult> {
    const token: string = await this.callerToken(userId, ticker);
    const now: Date = new Date();
    const from: string = new Date(now.getTime() - 550 * 86_400_000).toISOString().slice(0, 10);
    for (const frequency of ['quarterly', 'annual'] as const) {
      const raw: unknown = await this.request('/stock/financials-reported', token, {
        symbol: ticker.toUpperCase().trim(), freq: frequency, from, to: now.toISOString().slice(0, 10),
      });
      const result: FinnhubFinancialsResult = parseFinnhubFinancials(raw, ticker, frequency, now);
      if (result.issue === 'no_data' && frequency === 'quarterly') continue;
      if (result.issue) throw new FinnhubEvidenceError(result.issue);
      return result;
    }
    throw new FinnhubEvidenceError('no_data');
  }

  async getNews(userId: string, ticker: string): Promise<EvidenceInput[] | null> {
    const token = await this.callerToken(userId, ticker);

    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const raw = await this.request('/company-news', token, {
      symbol: ticker.toUpperCase(),
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    });
    if (!Array.isArray(raw)) throw new FinnhubEvidenceError('invalid_response');

    return (raw as FinnhubArticle[])
      .filter((article) => cleanText(article.headline, 300).length > 0
        && typeof article.datetime === 'number'
        && Number.isFinite(article.datetime)
        && article.datetime * 1000 >= from.getTime()
        && article.datetime * 1000 <= to.getTime())
      .slice(0, MAX_NEWS_ITEMS)
      .map((article): EvidenceInput => {
        const headline = cleanText(article.headline, 300);
        const summary = cleanText(article.summary, 500);
        const publisher = cleanText(article.source, 80);
        const publishedAt = new Date((article.datetime as number) * 1000).toISOString();
        const sourceUrl = safeArticleUrl(article.url);
        return {
          role: 'news' as const,
          evidenceType: 'news' as const,
          title: headline,
          content: `Published: ${publishedAt}. ${publisher ? `Publisher: ${publisher}. ` : ''}${summary || 'Headline only; no article summary supplied.'}`,
          sourceUrl,
          sourceName: 'Finnhub API',
          relevanceScore: 0.65,
          metadata: { sources: [{ origin: 'provider', verification: 'server-verified', provider: 'Finnhub API',
            kind: 'news', sourceUrl: sourceUrl ?? null, publishedAt, publicationPrecision: 'instant',
            observedAt: null, observationBasis: 'unknown', sourceRevision: null,
            supersedesSourceRevision: null, revisionReason: null, facts: [] }] },
        };
      });
  }
}
