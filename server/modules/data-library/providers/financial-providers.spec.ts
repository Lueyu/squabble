import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AktoolsProvider } from './aktools.provider';
import { TushareProvider } from './tushare.provider';
import { normalizeFinancialValue, normalizeInstrument, parseFinancialJson } from './financial-normalization';

test('financial normalization keeps decimal strings, unknown units, times and exchange ambiguity', () => {
  assert.deepEqual(parseFinancialJson('{"code":0,"items":[10000000000000001.23,1.2300]}'),
    { code: 0, items: ['10000000000000001.23', '1.2300'] });
  assert.equal(normalizeFinancialValue('10000000000000001.23').value, '10000000000000001.23');
  assert.equal(normalizeFinancialValue('1,200').value, null);
  assert.equal(normalizeFinancialValue('12').currency, null);
  assert.equal(normalizeFinancialValue('-2').accountingBasis, 'unknown');
  assert.throws(() => normalizeInstrument({ symbol: '000001', market: 'CN' }), /EXCHANGE/);
  assert.notEqual(normalizeInstrument({ symbol: '000001', market: 'CN', exchange: 'SZSE' }).id,
    normalizeInstrument({ symbol: '000001', market: 'CN', exchange: 'SSE' }).id);
  assert.equal(normalizeInstrument({ symbol: 'EXAMPLE', market: 'US', exchange: 'NASDAQ' }).exchange, 'NASDAQ');
  assert.equal(normalizeInstrument({ symbol: '00700', market: 'HK', exchange: 'HKEX' }).exchange, 'HKEX');
});
test('financial pagination cannot report completeness after a repeated provider page', async () => {
  const provider = new TushareProvider('fictional', async () => ({ code: 0, data: { fields: ['ts_code', 'trade_date', 'close'],
    items: Array.from({ length: 1000 }, () => ['000001.SZ', '20260101', '10.01']) } }));
  const result = await provider.query({ operation: 'daily-history', market: 'CN', exchange: 'SZSE', symbol: '000001',
    from: '2026-01-01', to: '2026-02-01' });
  assert.equal(result.coverage.status, 'partial'); assert.equal(result.rows.length, 1000);
});
test('AKTools obtains complete pages through fixed MCP operation and retains interrupted coverage', async () => {
  const calls: string[] = [];
  const provider = new AktoolsProvider(async (name, input) => {
    calls.push(name); assert.equal(input.name, 'stock_zh_a_hist'); assert.equal(input.max_rows, 1000);
    if (input.offset === 1000) throw new Error('fictional interruption');
    return { name: 'stock_zh_a_hist', total_rows: 1205, offset: input.offset, returned_rows: 1000,
      rows: Array.from({ length: 1000 }, (_, i) => ({ 日期: '2026-01-01', 收盘: String(i) })) };
  });
  const result = await provider.query({ operation: 'daily-history', market: 'CN', exchange: 'SZSE', symbol: '000001',
    from: '2026-01-01', to: '2026-02-01', adjustment: 'forward' });
  assert.equal(result.rows.length, 1000); assert.equal(result.coverage.status, 'partial');
  assert.deepEqual(calls, ['get_data', 'get_data']);
  await assert.rejects(provider.query({ operation: 'execute-anything', market: 'CN' } as never), /OPERATION/);
});
test('Tushare uses official POST payload, application permission errors and explicit calendar coverage', async () => {
  let payload: Record<string, unknown> | undefined;
  const provider = new TushareProvider('private-token', async (url, init) => {
    assert.equal(url.toString(), 'https://api.tushare.pro/'); assert.equal(init.method, 'POST');
    payload = JSON.parse(String(init.body));
    return { code: 0, data: { fields: ['exchange', 'cal_date', 'is_open'], items: [['SSE', '20260101', 0]] } };
  });
  const result = await provider.query({ operation: 'trading-calendar', market: 'CN', exchange: 'SSE', from: '2026-01-01', to: '2026-01-02' });
  assert.equal(payload?.api_name, 'trade_cal'); assert.equal(payload?.token, 'private-token');
  assert.equal(result.coverage.status, 'partial'); assert.equal(result.rows[0].is_open, '0');
  const denied = new TushareProvider('private-token', async () => ({ code: 2002, msg: 'secret denied' }));
  await assert.rejects(denied.query({ operation: 'daily-history', market: 'CN', exchange: 'SZSE', symbol: '000001',
    from: '2026-01-01', to: '2026-02-01' }), /TUSHARE_PERMISSION_DENIED/);
});
test('HK financial queries filter report periods without fabricating currency, unit or accounting basis', async () => {
  const provider = new AktoolsProvider(async (_name, input) => ({ name: 'stock_financial_hk_report_em', offset: input.offset,
    total_rows: 3, returned_rows: 3, rows: [{ REPORT_DATE: '2024-12-31', AMOUNT: '10' },
      { REPORT_DATE: '2025-12-31', AMOUNT: '20', CURRENCY: 'HKD', UNIT: '万元', NOTICE_DATE: '2026-03-01' },
      { REPORT_DATE: '2026-06-30', AMOUNT: '30' }] }));
  const result = await provider.query({ operation: 'financials', market: 'HK', exchange: 'HKEX', symbol: '00700',
    from: '2025-01-01', to: '2025-12-31' });
  assert.equal(result.rows.length, 1); assert.equal(result.coverage.rowCount, 1);
  const provenance = result.rows[0]._provenance as { accountingBasis: string; currency: string; unit: string; timing: { availableAt: string } };
  assert.equal(provenance.accountingBasis, 'unknown'); assert.equal(provenance.currency, 'HKD');
  assert.equal(provenance.unit, '万元'); assert.equal(provenance.timing.availableAt, '2026-03-01');
});
test('provider rows cannot be silently relabeled as a different requested instrument', async () => {
  const provider = new TushareProvider('fictional', async () => ({ code: 0,
    data: { fields: ['ts_code', 'trade_date', 'close'], items: [['600000.SH', '20260101', '10']] } }));
  await assert.rejects(provider.query({ operation: 'daily-history', market: 'CN', exchange: 'SZSE', symbol: '000001',
    from: '2026-01-01', to: '2026-02-01' }), /SYMBOL_MISMATCH/);
});
