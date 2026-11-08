import { Injectable } from '@nestjs/common';
import type { FinnhubFinancialsResult } from './finnhub-financials';
import { parseSecFinancials, secRecord, secTicker } from './sec-financials';

type SecFailureCode = 'unsupported_market' | 'no_data' | 'invalid_response' | 'stale_data'
  | 'forbidden' | 'rate_limited' | 'timeout' | 'network_error' | 'provider_error' | 'response_too_large';

export class SecEvidenceError extends Error {
  constructor(readonly code: SecFailureCode) {
    super(`SEC ${code}`);
    this.name = 'SecEvidenceError';
  }
}

export interface SecFinancialsResult extends FinnhubFinancialsResult { cacheHit: boolean }

interface CachedResult {
  expiresAt: number;
  result?: FinnhubFinancialsResult;
  error?: SecEvidenceError;
}

const RESULT_TTL = 60 * 60_000;
const FAILURE_TTL = 60_000;
const TICKER_TTL = 24 * 60 * 60_000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const TICKER_URL = 'https://www.sec.gov/files/company_tickers.json';

/** Public-source cache contains issuer data only, never account keys or portfolio records. */
@Injectable()
export class SecEvidenceService {
  private readonly cache = new Map<string, CachedResult>();
  private readonly inFlight = new Map<string, Promise<FinnhubFinancialsResult>>();
  private tickerCache: { expiresAt: number; values: Map<string, string> } | null = null;
  private tickerInFlight: Promise<Map<string, string>> | null = null;
  private nextRequestAt: number = 0;

  async getFinancials(ticker: string): Promise<SecFinancialsResult> {
    const normalized: string | undefined = secTicker(ticker);
    if (!normalized) throw new SecEvidenceError('unsupported_market');
    const cached: CachedResult | undefined = this.cache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.error) throw cached.error;
      if (cached.result) return { ...structuredClone(cached.result), cacheHit: true };
    }
    const active: Promise<FinnhubFinancialsResult> | undefined = this.inFlight.get(normalized);
    if (active) return { ...structuredClone(await active), cacheHit: true };
    if (this.inFlight.size >= 16) throw new SecEvidenceError('rate_limited');
    const work: Promise<FinnhubFinancialsResult> = this.collect(normalized);
    this.inFlight.set(normalized, work);
    try {
      const result: FinnhubFinancialsResult = await work;
      this.remember(normalized, { expiresAt: Date.now() + RESULT_TTL, result });
      return { ...structuredClone(result), cacheHit: false };
    } catch (error) {
      const safe: SecEvidenceError = error instanceof SecEvidenceError ? error : new SecEvidenceError('provider_error');
      this.remember(normalized, { expiresAt: Date.now() + FAILURE_TTL, error: safe });
      throw safe;
    } finally {
      this.inFlight.delete(normalized);
    }
  }

  private remember(ticker: string, value: CachedResult): void {
    this.cache.delete(ticker);
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest: string | undefined = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(ticker, value);
  }

  private async collect(ticker: string): Promise<FinnhubFinancialsResult> {
    const tickers: Map<string, string> = await this.tickers();
    const cik: string | undefined = tickers.get(ticker);
    if (!cik) throw new SecEvidenceError('no_data');
    const [submissions, facts] = await Promise.all([
      this.request(`https://data.sec.gov/submissions/CIK${cik}.json`),
      this.request(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`),
    ]);
    const result: FinnhubFinancialsResult = parseSecFinancials(facts, submissions, ticker);
    if (result.issue) throw new SecEvidenceError(result.issue);
    return result;
  }

  private async tickers(): Promise<Map<string, string>> {
    if (this.tickerCache && this.tickerCache.expiresAt > Date.now()) return this.tickerCache.values;
    if (this.tickerInFlight) return this.tickerInFlight;
    this.tickerInFlight = this.loadTickers();
    try {
      const values: Map<string, string> = await this.tickerInFlight;
      this.tickerCache = { values, expiresAt: Date.now() + TICKER_TTL };
      return values;
    } finally { this.tickerInFlight = null; }
  }

  private async loadTickers(): Promise<Map<string, string>> {
    const raw: Record<string, unknown> | undefined = secRecord(await this.request(TICKER_URL));
    if (!raw) throw new SecEvidenceError('invalid_response');
    const result: Map<string, string> = new Map();
    for (const value of Object.values(raw).slice(0, 30000)) {
      const row: Record<string, unknown> | undefined = secRecord(value);
      const ticker: string | undefined = typeof row?.ticker === 'string' ? secTicker(row.ticker) : undefined;
      const cik: string = String(row?.cik_str ?? '');
      if (ticker && /^\d{1,10}$/.test(cik) && Number(cik) > 0) result.set(ticker, cik.padStart(10, '0'));
    }
    if (!result.size) throw new SecEvidenceError('invalid_response');
    return result;
  }

  private async request(url: string): Promise<unknown> {
    // Paths are constructed from verified numeric CIKs; caller-supplied URLs are never accepted.
    if (url !== TICKER_URL && !/^https:\/\/data\.sec\.gov\/(?:submissions|api\/xbrl\/companyfacts)\/CIK\d{10}\.json$/.test(url)) {
      throw new SecEvidenceError('invalid_response');
    }
    const scheduled: number = Math.max(Date.now(), this.nextRequestAt);
    const wait: number = scheduled - Date.now();
    if (wait > 3000) throw new SecEvidenceError('rate_limited');
    this.nextRequestAt = scheduled + 300;
    if (wait > 0) await new Promise<void>((resolve: () => void) => setTimeout(resolve, wait));
    const configuredAgent: string = process.env.SEC_USER_AGENT?.trim() ?? '';
    const userAgent: string = configuredAgent && configuredAgent.length <= 200 && !/[\r\n]/.test(configuredAgent)
      ? configuredAgent : 'Squabble/2.0 (public financial research)';
    try {
      const response: Response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': userAgent },
        redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new SecEvidenceError(response.status === 403 ? 'forbidden'
        : response.status === 429 ? 'rate_limited' : response.status === 404 ? 'no_data' : 'provider_error');
      if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new SecEvidenceError('response_too_large');
      }
      const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
      if (!reader) throw new SecEvidenceError('invalid_response');
      const chunks: Uint8Array[] = [];
      let size: number = 0;
      for (;;) {
        const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new SecEvidenceError('response_too_large'); }
        chunks.push(chunk.value);
      }
      const bytes: Uint8Array = new Uint8Array(size);
      let offset: number = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
      catch { throw new SecEvidenceError('invalid_response'); }
    } catch (error) {
      if (error instanceof SecEvidenceError) throw error;
      throw new SecEvidenceError(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
        ? 'timeout' : 'network_error');
    }
  }
}
