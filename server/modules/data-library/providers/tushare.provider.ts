import type { FinancialProvider, FinancialProviderQuery, FinancialProviderResult, ProviderJsonRequest } from './financial-provider.interface';
import { normalizeInstrument, normalizeProviderRows, parseFinancialJson, resultCoverage, unknownTiming, validateFinancialQuery } from './financial-normalization';

export async function boundedFinancialJson(url: URL, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`PROVIDER_HTTP_${response.status}`);
  const chunks: Uint8Array[] = [], reader = response.body.getReader(); let size = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break;
    size += item.value.length; if (size > 8 * 1024 * 1024) throw new Error('PROVIDER_OUTPUT_TOO_LARGE'); chunks.push(item.value);
  } } finally { await reader.cancel().catch(() => undefined); }
  try { return parseFinancialJson(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('PROVIDER_INVALID_JSON'); }
}
export class TushareProvider implements FinancialProvider {
  readonly id = 'tushare';
  constructor(private readonly token: string, private readonly request: ProviderJsonRequest = boundedFinancialJson,
    private readonly endpoint = 'https://api.tushare.pro/') {
    // Official documentation shows HTTP; HTTPS is default. An operator must explicitly select documented HTTP.
    if (!['https://api.tushare.pro/', 'http://api.tushare.pro/'].includes(endpoint)) throw new Error('TUSHARE_ENDPOINT_REJECTED');
  }
  async query(input: FinancialProviderQuery): Promise<FinancialProviderResult> {
    validateFinancialQuery(input);
    if (input.market !== 'CN' || !['SSE', 'SZSE', 'BSE'].includes(input.exchange ?? '') ||
      input.adjustment && input.adjustment !== 'unadjusted') throw new Error('UNSUPPORTED_OPERATION_OR_MARKET');
    if (!this.token || this.token.length > 4096 || /[\r\n]/u.test(this.token)) throw new Error('TUSHARE_KEY_REQUIRED');
    const operation = { 'daily-history': 'daily', 'trading-calendar': 'trade_cal', financials: 'income' }[input.operation];
    const fields = { daily: 'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount',
      trade_cal: 'exchange,cal_date,is_open,pretrade_date',
      income: 'ts_code,ann_date,f_ann_date,end_date,report_type,comp_type,basic_eps,total_revenue,revenue,n_income' }[operation];
    const params: Record<string, string | number> = { start_date: input.from!.replaceAll('-', ''), end_date: input.to!.replaceAll('-', '') };
    if (input.operation === 'trading-calendar') params.exchange = input.exchange!;
    else params.ts_code = `${input.symbol}.${{ SSE: 'SH', SZSE: 'SZ', BSE: 'BJ' }[input.exchange!]}`;
    const rows: Record<string, unknown>[] = [], missing: string[] = [];
    const pageHashes = new Set<string>();
    for (let page = 0; page < 100; page++) {
      try {
        const raw = await this.request(new URL(this.endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_name: operation, token: this.token, params: { ...params, limit: 1000, offset: rows.length }, fields }) });
        if (!raw || typeof raw !== 'object') throw new Error('TUSHARE_INVALID_RESPONSE');
        const body = raw as { code?: unknown; data?: { fields?: unknown; items?: unknown } };
        if (body.code !== 0) throw new Error(body.code === 2002 ? 'TUSHARE_PERMISSION_DENIED' : 'TUSHARE_APPLICATION_ERROR');
        if (!Array.isArray(body.data?.fields) || !body.data.fields.every(field => typeof field === 'string') ||
          !Array.isArray(body.data.items) || body.data.items.length > 1000) throw new Error('TUSHARE_INVALID_RESPONSE');
        const names = body.data.fields as string[], items = body.data.items;
        if (new Set(names).size !== names.length || items.some(row => !Array.isArray(row) || row.length !== names.length)) throw new Error('TUSHARE_INVALID_RESPONSE');
        const signature = JSON.stringify(items);
        if (items.length && pageHashes.has(signature)) throw new Error('TUSHARE_REPEATED_PAGE');
        pageHashes.add(signature);
        const pageRows = items.map(row => Object.fromEntries(names.map((name, i) => [name, (row as unknown[])[i]])));
        if (pageRows.some(row => input.operation === 'trading-calendar' ? row.exchange !== input.exchange : row.ts_code !== params.ts_code)) {
          throw new Error('TUSHARE_SYMBOL_MISMATCH');
        }
        rows.push(...pageRows);
        if (items.length < 1000) break;
        if (page === 99) missing.push('PAGINATION_LIMIT');
      } catch (error) { if (!rows.length) throw error; missing.push('PAGE_INTERRUPTED'); break; }
    }
    const now = new Date().toISOString();
    return { provider: this.id, operation, parameterVersion: 'tushare-http-v1', instrument: input.operation === 'trading-calendar' ? null : normalizeInstrument(input),
      rows: normalizeProviderRows(rows, input, this.id, operation, now), timing: unknownTiming(now),
      coverage: resultCoverage(rows, input, null, missing), adjustment: input.operation === 'daily-history' ? 'unadjusted' : 'unknown',
      sourceUrl: 'https://tushare.pro/document/1?doc_id=40' };
  }
}
