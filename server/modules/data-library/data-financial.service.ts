import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { financialDataConnections } from '../../database/data-library.schema';
import { SettingsService } from '../settings/settings.service';
import { QuoteService } from '../quote/quote.service';
import { FinnhubEvidenceService } from '../research-core/finnhub-evidence.service';
import { SecEvidenceService } from '../research-core/sec-evidence.service';
import { decodeDataSecret, encodeDataSecret } from './data-library.secrets';
import { DataLibraryError } from './data-library.fetch';
import { dataFinancialProviders, dataFinancialOperations, type DataFinancialProvider, type DataFinancialConnection,
  type DataFinancialQuery, type DataFinancialQueryResult, type DataFinancialTestResult } from '../../../shared/data-library.interface';
const catalog: Array<Omit<DataFinancialConnection, 'enabled' | 'configured' | 'needsReentry' | 'hasApiKey' | 'lastTestAt' | 'lastTestOk' | 'lastTestCode'>> = [
  { provider: 'public', name: '公共行情', description: 'Tencent / Sina / Yahoo 的现有公开行情；来源与时间随结果显示。', capabilities: ['quote'], markets: ['US', 'HK', 'CN'], requiresKey: false },
  { provider: 'sec', name: 'SEC EDGAR', description: '公开申报和财报，适用于 SEC 申报公司；不是交易报价源。', capabilities: ['financials'], markets: ['US'], requiresKey: false },
  { provider: 'finnhub', name: 'Finnhub', description: '美股新闻与基本面；沿用当前账户已保存的密钥，权限按套餐决定。', capabilities: ['financials', 'news'], markets: ['US'], requiresKey: true },
  { provider: 'alpha-vantage', name: 'Alpha Vantage', description: '日终报价与历史日线，用于研究查询；不会替代模拟盘实时成交报价。', capabilities: ['quote', 'daily-history'], markets: ['US'], requiresKey: true },
];
const querySchema = z.object({ provider: z.enum(dataFinancialProviders), symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9.^-]{0,19}$/u),
  operation: z.enum(dataFinancialOperations) }).strict();
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const positive = (v: unknown) => typeof v === 'number' || typeof v === 'string' && v.trim() ? Number.isFinite(Number(v)) && Number(v) > 0 : false;
const validDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(v)
  && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v && v <= new Date().toISOString().slice(0, 10);
export async function boundedProviderJson(url: URL): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new DataLibraryError(response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR');
  if (!response.body) throw new DataLibraryError('INVALID_RESPONSE');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      total += value.length; if (total > 4 * 1024 * 1024) throw new DataLibraryError('RESPONSE_TOO_LARGE'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => undefined); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DataLibraryError('INVALID_RESPONSE'); }
}
/** Normalize only known fields. Provider bodies and keys never enter traces or errors. */
export function parseAlphaVantage(raw: unknown, symbol: string, operation: 'quote' | 'daily-history') {
  const object = record(raw);
  if (object.Note || object.Information) throw new DataLibraryError('RATE_LIMIT_OR_ENTITLEMENT');
  if (object['Error Message']) throw new DataLibraryError('INVALID_SYMBOL_OR_KEY');
  if (operation === 'quote') {
    const quote = record(object['Global Quote']);
    if (quote['01. symbol'] !== symbol || !positive(quote['05. price']) || !validDay(quote['07. latest trading day'])) throw new DataLibraryError('NO_DATA');
    return { data: { symbol, price: Number(quote['05. price']), date: quote['07. latest trading day'],
      previousClose: positive(quote['08. previous close']) ? Number(quote['08. previous close']) : null }, asOf: quote['07. latest trading day'] };
  }
  const meta = record(object['Meta Data']);
  if (meta['2. Symbol'] !== symbol) throw new DataLibraryError('SYMBOL_MISMATCH');
  const prices = Object.entries(record(object['Time Series (Daily)'])).filter(([date, value]) => validDay(date) && positive(record(value)['4. close']))
    .sort(([a], [b]) => b.localeCompare(a)).slice(0, 100).map(([date, value]) => ({ date, close: Number(record(value)['4. close']) })).reverse();
  if (!prices.length) throw new DataLibraryError('NO_DATA');
  return { data: { symbol, points: prices, adjusted: false }, asOf: prices.at(-1)!.date };
}
@Injectable()
export class DataFinancialService {
  private usage = new Map<string, { since: number; calls: number; active: number }>();
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly settings: SettingsService, private readonly quotes: QuoteService,
    private readonly finnhub: FinnhubEvidenceService, private readonly sec: SecEvidenceService) {}
  private owner(owner: string) { if (!owner?.trim()) throw new BadRequestException('OWNER_REQUIRED'); }
  private provider(provider: string): DataFinancialProvider {
    if (!dataFinancialProviders.includes(provider as DataFinancialProvider)) throw new BadRequestException('UNSUPPORTED_PROVIDER');
    return provider as DataFinancialProvider;
  }
  private async row(owner: string, provider: string) {
    this.owner(owner); const [row] = await this.db.select().from(financialDataConnections)
      .where(and(eq(financialDataConnections.owner, owner), eq(financialDataConnections.provider, provider))); return row;
  }
  async list(owner: string): Promise<{ providers: DataFinancialConnection[] }> {
    this.owner(owner);
    const [rows, settings] = await Promise.all([this.db.select().from(financialDataConnections).where(eq(financialDataConnections.owner, owner)), this.settings.getSettings(owner)]);
    return { providers: catalog.map(entry => {
      const row = rows.find(r => r.provider === entry.provider), key = row?.secretEnc ? decodeDataSecret(row.secretEnc) : null;
      const legacy = entry.provider === 'finnhub' ? settings.financial : null;
      const configured = !entry.requiresKey || Boolean(legacy?.hasApiKey || key);
      return { ...entry, enabled: row?.enabled ?? true, configured, hasApiKey: Boolean(legacy?.hasApiKey || key),
        ...(legacy?.maskedApiKey ? { maskedApiKey: legacy.maskedApiKey } : key ? { maskedApiKey: `••••${key.slice(-4)}` } : {}),
        needsReentry: Boolean(legacy?.needsReentry || row?.secretEnc && !key), lastTestAt: row?.lastTestAt?.toISOString() ?? null,
        lastTestOk: row?.lastTestOk ?? null, lastTestCode: row?.lastTestCode ?? null };
    }) };
  }
  async save(owner: string, providerInput: string, input: { apiKey?: string; enabled?: boolean }) {
    const provider = this.provider(providerInput), parsed = z.object({ apiKey: z.string().trim().max(4096).regex(/^[^\r\n\u0000]*$/u).optional(), enabled: z.boolean().optional() }).strict().safeParse(input);
    if (!parsed.success) throw new BadRequestException('INVALID_PROVIDER_SETTINGS');
    const current = await this.row(owner, provider), p = parsed.data;
    if (provider === 'finnhub' && p.apiKey) await this.settings.saveFinancial(owner, { provider: 'finnhub', apiKey: p.apiKey });
    if (provider === 'alpha-vantage' && !p.apiKey && !decodeDataSecret(current?.secretEnc ?? null)) throw new BadRequestException('API_KEY_REQUIRED');
    if (!catalog.find(c => c.provider === provider)!.requiresKey && p.apiKey) throw new BadRequestException('PROVIDER_REQUIRES_NO_KEY');
    await this.db.insert(financialDataConnections).values({ owner, provider, enabled: p.enabled ?? current?.enabled ?? true,
      secretEnc: provider === 'alpha-vantage' && p.apiKey ? encodeDataSecret(p.apiKey) : current?.secretEnc ?? null })
      .onConflictDoUpdate({ target: [financialDataConnections.owner, financialDataConnections.provider], set: {
        enabled: p.enabled ?? current?.enabled ?? true, secretEnc: provider === 'alpha-vantage' && p.apiKey ? encodeDataSecret(p.apiKey) : current?.secretEnc ?? null,
        lastTestAt: null, lastTestOk: null, lastTestCode: null, updatedAt: new Date() } });
    return this.list(owner);
  }
  async remove(owner: string, providerInput: string) {
    const provider = this.provider(providerInput); this.owner(owner);
    if (provider === 'finnhub') await this.settings.clearFinancial(owner);
    await this.db.delete(financialDataConnections).where(and(eq(financialDataConnections.owner, owner), eq(financialDataConnections.provider, provider)));
    return this.list(owner);
  }
  async query(owner: string, input: DataFinancialQuery): Promise<DataFinancialQueryResult> {
    this.owner(owner); const parsed = querySchema.safeParse(input); if (!parsed.success) throw new BadRequestException('INVALID_FINANCIAL_QUERY');
    const p = parsed.data, observedAt = new Date().toISOString(), entry = catalog.find(c => c.provider === p.provider)!;
    const base: DataFinancialQueryResult = { ...p, observedAt, asOf: observedAt, data: null, status: 'unavailable',
      freshness: p.provider === 'alpha-vantage' ? 'end-of-day' : p.operation === 'financials' ? 'filing' : 'provider-timestamp', sources: [] };
    if (!entry.capabilities.includes(p.operation)) return { ...base, errorCode: 'UNSUPPORTED_CAPABILITY' };
    const row = await this.row(owner, p.provider);
    if (row?.enabled === false) return { ...base, errorCode: 'PROVIDER_DISABLED' };
    const now = Date.now();
    for (const [key, value] of this.usage) if (!value.active && now - value.since >= 60_000) this.usage.delete(key);
    const usage = this.usage.get(owner) ?? { since: now, calls: 0, active: 0 };
    if (usage.calls >= 30 || usage.active >= 2 || this.usage.size >= 1000 && !this.usage.has(owner)) return { ...base, errorCode: 'QUERY_RATE_LIMITED' };
    usage.calls++; usage.active++; this.usage.set(owner, usage);
    try {
      if (p.provider === 'alpha-vantage') {
        const key = decodeDataSecret(row?.secretEnc ?? null); if (!key) return { ...base, errorCode: row?.secretEnc ? 'CREDENTIAL_UNREADABLE' : 'KEY_REQUIRED' };
        if (!/^[A-Z][A-Z0-9.-]{0,15}$/u.test(p.symbol) || /\.(?:HK|SH|SZ|SS|BJ)$/u.test(p.symbol)) return { ...base, errorCode: 'UNSUPPORTED_MARKET' };
        const url = new URL('https://www.alphavantage.co/query');
        url.searchParams.set('function', p.operation === 'quote' ? 'GLOBAL_QUOTE' : 'TIME_SERIES_DAILY');
        url.searchParams.set('symbol', p.symbol); url.searchParams.set('apikey', key); url.searchParams.set('outputsize', 'compact');
        const normalized = parseAlphaVantage(await boundedProviderJson(url), p.symbol, p.operation as 'quote' | 'daily-history');
        return { ...base, ...normalized, status: 'succeeded', sources: [{ title: 'Alpha Vantage · end-of-day', url: 'https://www.alphavantage.co/documentation/', fetchedAt: observedAt }] };
      }
      if (p.provider === 'public') {
        const quote = await this.quotes.getQuote(p.symbol); if (!quote || !positive(quote.price)) return { ...base, errorCode: 'NO_DATA' };
        return { ...base, status: 'succeeded', data: quote, asOf: quote.quoteAt ?? observedAt,
          sources: [{ title: quote.source ?? 'Public quote', fetchedAt: observedAt }] };
      }
      const financials = p.operation === 'news' ? await this.finnhub.getNews(owner, p.symbol)
        : p.provider === 'sec' ? await this.sec.getFinancials(p.symbol) : await this.finnhub.getFinancials(owner, p.symbol);
      const items = Array.isArray(financials) ? financials : financials?.items ?? [];
      if (!items.length) return { ...base, errorCode: 'NO_DATA' };
      const dates = items.flatMap(item => item.metadata?.sources.flatMap(source => source.publishedAt ? [source.publishedAt] : []) ?? []).sort();
      return { ...base, status: 'succeeded', data: { evidence: items }, asOf: dates.at(-1) ?? observedAt,
        sources: items.map(item => ({ title: item.sourceName ?? entry.name, ...(item.sourceUrl ? { url: item.sourceUrl } : {}), fetchedAt: observedAt })) };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code).toUpperCase() : 'PROVIDER_UNAVAILABLE';
      return { ...base, status: 'failed', errorCode: /^[A-Z_]{1,60}$/u.test(code) ? code : 'PROVIDER_UNAVAILABLE' };
    } finally { usage.active--; }
  }
  async test(owner: string, providerInput: string): Promise<DataFinancialTestResult> {
    const provider = this.provider(providerInput), operation = catalog.find(c => c.provider === provider)!.capabilities[0];
    const sample = await this.query(owner, { provider, symbol: 'AAPL', operation }), ok = sample.status === 'succeeded';
    const code = sample.errorCode ?? 'CONNECTED', testedAt = new Date();
    await this.db.insert(financialDataConnections).values({ owner, provider, lastTestAt: testedAt, lastTestOk: ok, lastTestCode: code })
      .onConflictDoUpdate({ target: [financialDataConnections.owner, financialDataConnections.provider], set: { lastTestAt: testedAt, lastTestOk: ok, lastTestCode: code } });
    return { ok, code, testedAt: testedAt.toISOString(), sample };
  }
}
