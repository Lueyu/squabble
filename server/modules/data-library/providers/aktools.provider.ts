import type { AktoolsMcpCall, FinancialProvider, FinancialProviderQuery, FinancialProviderResult } from './financial-provider.interface';
import { normalizeInstrument, normalizeProviderRows, parseFinancialJson, resultCoverage, unknownTiming, validateFinancialQuery } from './financial-normalization';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function unwrap(value: unknown): Record<string, unknown> {
  const result = object(value);
  if (result.isError) throw new Error('AKTOOLS_PROVIDER_ERROR');
  if (Array.isArray(result.content)) {
    const entry = result.content.find(block => object(block).type === 'text');
    if (typeof object(entry).text === 'string') {
      try { return object(parseFinancialJson(String(object(entry).text))); } catch { throw new Error('AKTOOLS_INVALID_RESPONSE'); }
    }
  }
  if (result.structuredContent) return object(result.structuredContent);
  return result;
}
/** Fixed application operations wrap the official three-tool MCP; remote discovery never expands this allowlist. */
export class AktoolsProvider implements FinancialProvider {
  readonly id = 'aktools';
  constructor(private readonly call: AktoolsMcpCall) {}
  async query(input: FinancialProviderQuery): Promise<FinancialProviderResult> {
    validateFinancialQuery(input);
    const adjustment = input.adjustment ?? 'unadjusted';
    const params: Record<string, string> = {};
    let name: string;
    if (input.operation === 'daily-history' && input.market === 'CN' && input.exchange !== 'BSE') {
      // The generic AKShare call routes stock codes itself. Require explicit exchange and reject contradictory routing.
      const route = input.exchange === 'SSE' ? /^(?:600|601|603|605|688|689)\d{3}$/u : /^(?:000|001|002|003|300|301)\d{3}$/u;
      if (!route.test(input.symbol!)) throw new Error('AKTOOLS_EXCHANGE_SYMBOL_MAPPING_UNAVAILABLE');
      name = 'stock_zh_a_hist'; Object.assign(params, { symbol: input.symbol!, period: 'daily', start_date: input.from!.replaceAll('-', ''),
        end_date: input.to!.replaceAll('-', ''), adjust: { unadjusted: '', forward: 'qfq', backward: 'hfq' }[adjustment] });
    } else if (input.operation === 'financials' && input.market === 'HK') {
      name = 'stock_financial_hk_report_em'; Object.assign(params, { stock: input.symbol!, symbol: '利润表', indicator: '报告期' });
    } else throw new Error('UNSUPPORTED_OPERATION_OR_MARKET');
    const rows: Record<string, unknown>[] = [], missing: string[] = []; let total: number | null = null;
    for (let page = 0; page < 100; page++) {
      try {
        const raw = unwrap(await this.call('get_data', { name, params, max_rows: 1000, offset: rows.length }));
        if (raw.name !== name || raw.offset !== rows.length || !Array.isArray(raw.rows) || raw.returned_rows !== raw.rows.length ||
          !Number.isSafeInteger(raw.total_rows) || Number(raw.total_rows) < 0) throw new Error('AKTOOLS_INVALID_RESPONSE');
        if (total !== null && total !== raw.total_rows) throw new Error('AKTOOLS_PAGE_COUNT_CHANGED');
        total = Number(raw.total_rows);
        if (raw.rows.length > 1000 || rows.length + raw.rows.length > total ||
          raw.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('AKTOOLS_INVALID_RESPONSE');
        rows.push(...raw.rows as Record<string, unknown>[]);
        if (rows.length === total) break;
        if (!raw.rows.length || page === 99) { missing.push('PAGINATION_INCOMPLETE'); break; }
      } catch (error) { if (!rows.length) throw error; missing.push('PAGE_INTERRUPTED'); break; }
    }
    const selected = input.operation === 'financials' ? rows.filter(row => {
      const day = typeof row.REPORT_DATE === 'string' ? row.REPORT_DATE.slice(0,10) : null;
      if (!day || !/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isFinite(Date.parse(day))) {
        missing.push('REPORT_PERIOD_UNKNOWN'); return true;
      }
      return day >= input.from! && day <= input.to!;
    }) : rows;
    const now = new Date().toISOString();
    return { provider: this.id, operation: name, parameterVersion: 'aktools-0.1.5-v1',
      instrument: normalizeInstrument(input), rows: normalizeProviderRows(selected, input, this.id, name, now), timing: unknownTiming(now),
      coverage: resultCoverage(selected, input, input.operation === 'financials' ? missing.length ? null : selected.length : total, missing), adjustment: input.operation === 'daily-history' ? adjustment : 'unknown',
      sourceUrl: 'https://aktools.akfamily.xyz/guide/mcp/' };
  }
}
