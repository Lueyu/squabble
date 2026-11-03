// Financial regression checks against isolated in-memory database tables.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const names = ['transactions', 'holdings', 'closed', 'cashAccounts', 'snapshots', 'fxRates', 'paperAccounts', 'paperOrders', 'paperPositions', 'paperTrades', 'paperEvents'];
const tables = Object.fromEntries(names.map(name => [name, new Proxy({ table: name }, {
  get: (t, key) => key === 'table' ? t.table : { table: t.table, key },
})]));
const col = (value, row) => value?.key ? row[value.key] : value;
const orm = {
  eq: (a, b) => row => col(a, row) === col(b, row),
  and: (...items) => row => items.every(p => p(row)),
  inArray: (a, values) => row => values.includes(col(a, row)),
  asc: column => ({ column, dir: 1 }),
  desc: column => ({ column, dir: -1 }),
  gte: (a, b) => row => col(a, row) >= col(b, row),
  sql: (strings, ...values) => {
    const shape = strings.join('?');
    if (shape.includes(' + ')) return row => String(Number(col(values[0], row)) + values[1]);
    if (shape.includes(' * ')) return row => Number(col(values[0], row)) * Number(col(values[1], row));
    if (shape.includes(').user_id = ')) return row => col(values[0], row) === values[1];
    if (shape.includes("IN ('Deposit', 'Withdrawal')")) return row => ['Deposit', 'Withdrawal'].includes(col(values[0], row));
    if (shape.includes(' < ')) return row => col(values[0], row) < values[1];
    if (shape.includes(' = ') && values.length === 2) return row => col(values[0], row) === values[1];
    throw new Error('Unsupported SQL mock: ' + shape);
  },
};
const decorator = () => () => {};
const common = {
  Inject: decorator, Injectable: decorator, Optional: decorator, forwardRef: fn => fn,
  BadRequestException: class extends Error {}, NotFoundException: class extends Error {},
  Logger: class { warn() {} error() {} log() {} },
};
function loadService(relativePath, className, extraModules = {}) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    experimentalDecorators: true, emitDecoratorMetadata: false,
  }});
  const mod = { exports: {} };
  const mockRequire = name => {
    if (Object.hasOwn(extraModules, name)) return extraModules[name];
    if (name === '@nestjs/common') return common;
    if (name === '@lark-apaas/fullstack-nestjs-core' || name === '../../common/platform') return { DRIZZLE_DATABASE: Symbol('db') };
    if (name === 'drizzle-orm') return orm;
    if (name === '@server/database/schema') return tables;
    if (name.includes('fx.service')) return { FxService: class {} };
    if (name.includes('quote.service')) return { QuoteService: class {} };
    if (name === '@nestjs/axios') return { HttpService: class {} };
    if (name === 'rxjs') return { firstValueFrom: async x => x };
    throw new Error('Unexpected import: ' + name);
  };
  new Function('require', 'module', 'exports', outputText)(mockRequire, mod, mod.exports);
  return mod.exports[className];
}
class MemoryDb {
  constructor() { this.data = Object.fromEntries(names.map(n => [n, []])); this.nextId = 1; }
  select(fields) { return this.query('select', fields); }
  insert(table) { return this.query('insert').from(table); }
  update(table) { return this.query('update').from(table); }
  delete(table) { return this.query('delete').from(table); }
  async transaction(fn) {
    const before = structuredClone(this.data);
    try { return await fn(this); } catch (e) { this.data = before; throw e; }
  }
  query(mode, fields) {
    const db = this;
    let table, predicate = () => true, sorts = [], limit = Infinity, offset = 0, values, patch;
    const q = {
      from(t) { table = t.table; return q; },
      where(p) { predicate = p; return q; },
      orderBy(...s) { sorts = s; return q; },
      limit(n) { limit = n; return q; },
      offset(n) { offset = n; return q; },
      for() { return q; },
      values(v) { values = Array.isArray(v) ? v : [v]; return q; },
      set(v) { patch = v; return q; },
      returning(f) { fields = f; return q; },
      async then(resolve, reject) {
        try {
          if (db.beforeExecute) await db.beforeExecute({ mode, table, patch });
          let rows = db.data[table].filter(predicate);
          rows.sort((a, b) => { for (const s of sorts) { const x = col(s.column ?? s, a); const y = col(s.column ?? s, b); if (x !== y) return (x < y ? -1 : 1) * (s.dir ?? 1); } return 0; });
          rows = rows.slice(offset, offset + limit);
          if (mode === 'insert') {
            rows = values.map(v => ({
              id: String(db.nextId++).padStart(8, '0'),
              createdAt: new Date(), updatedAt: new Date(),
              ...(table === 'holdings' ? { market: 'US', currency: 'USD' } : {}),
              ...v,
            }));
            db.data[table].push(...rows);
          }
          if (mode === 'update') for (const row of rows) for (const [key, value] of Object.entries(patch)) row[key] = typeof value === 'function' ? value(row) : value;
          if (mode === 'delete') db.data[table] = db.data[table].filter(row => !rows.includes(row));
          const output = rows.map(row => fields ? Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === 'function' ? value(row) : col(value, row)])) : { ...row });
          resolve(output);
        } catch (error) { reject(error); }
      },
    };
    return q;
  }
}
const TransactionsService = loadService('server/modules/transactions/transactions.service.ts', 'TransactionsService');
const SnapshotsService = loadService('server/modules/snapshots/snapshots.service.ts', 'SnapshotsService');
const DashboardService = loadService('server/modules/dashboard/dashboard.service.ts', 'DashboardService');
const user = 'audit-user-memory-only';
const quote = { detectMarket: ticker => ticker.endsWith('.HK') ? { market: 'HK', currency: 'HKD' } : ticker.endsWith('.SH') ? { market: 'CN', currency: 'CNY' } : { market: 'US', currency: 'USD' } };
const dto = (txType, overrides = {}) => ({ txDate: '2026-10-01', ticker: 'AAPL', txType, shares: 10, price: 10, fees: 0, currency: 'USD', ...overrides });
const evidence = [];
function record(id, actual, expected, note) { evidence.push({ id, actual, expected, note }); }
async function main() {
  {
    const db = new MemoryDb(); const svc = new TransactionsService(db, quote);
    await svc.create(user, dto('Opening'));
    await assert.rejects(() => svc.create(user, dto('Sell', { txDate: '2026-10-02', shares: 20, price: 12 })));
    assert.equal(db.data.cashAccounts.length, 0);
    assert.equal(db.data.transactions.length, 1);
    record('oversell', 'rejected; ledger unchanged', 'rejected', 'Verified');
  }
  {
    const db = new MemoryDb(); const svc = new TransactionsService(db, quote);
    await svc.create(user, dto('Deposit', { ticker: '', shares: 1000, price: 1 }));
    const buy = await svc.create(user, dto('Buy', { txDate: '2026-10-02' }));
    await svc.remove(user, buy.id);
    assert.equal(db.data.transactions.length, 1);
    assert.equal(db.data.holdings.length, 0);
    const reconciled = await svc.reconcileAll(user);
    assert.equal(reconciled.holdingsCount, 0);
    record('delete-final-buy', { remainingTransactions: db.data.transactions.map(t => t.txType), cash: db.data.cashAccounts[0].balance, remainingHolding: db.data.holdings.length }, 0, 'Verified');
  }
  {
    const db = new MemoryDb(); const svc = new TransactionsService(db, quote);
    const deposit = await svc.create(user, dto('Deposit', { ticker: '', shares: 100, price: 1 }));
    const edited = await svc.update(user, deposit.id, { currency: 'HKD' });
    assert.equal(edited.currency, 'HKD');
    assert.equal(Number(db.data.cashAccounts.find(a => a.currency === 'USD').balance), 0);
    assert.equal(Number(db.data.cashAccounts.find(a => a.currency === 'HKD').balance), 100);
    record('change-transaction-currency', { editedCurrency: edited.currency, accounts: db.data.cashAccounts.map(a => ({ currency: a.currency, balance: a.balance })) }, 'USD 0; HKD 100', 'Verified');
  }
  {
    const db = new MemoryDb(); const svc = new TransactionsService(db, quote);
    await svc.create(user, dto('Deposit', { ticker: '', shares: 1000, price: 1, currency: 'HKD' }));
    await svc.create(user, dto('Buy', { txDate: '2026-10-02', ticker: '0700.HK', currency: 'HKD' }));
    const h = db.data.holdings[0];
    assert.equal(h.currency, 'HKD'); assert.equal(h.market, 'HK');
    await svc.reconcileAll(user);
    assert.equal(db.data.holdings[0].currency, 'HKD');
    record('non-us-derived-holding', { ticker: h.ticker, market: h.market, currency: h.currency }, 'HK/HKD', 'Incremental and full reconciliation');
  }
  {
    const db = new MemoryDb(); const tx = new TransactionsService(db, quote);
    const snapshots = new SnapshotsService(db, { convert: async amount => amount });
    await tx.create(user, dto('Deposit', { ticker: '', shares: 1000, price: 1 }));
    await snapshots.upsert(user, { snapshotDate: '2026-10-01', accountValue: 1000 });
    const day2 = await snapshots.upsert(user, { snapshotDate: '2026-10-02', accountValue: 1100 });
    const day3 = await snapshots.upsert(user, { snapshotDate: '2026-10-03', accountValue: 1210 });
    assert.equal(Number(day2.dailyPct), 10); assert.equal(Number(day3.dailyPct), 10);
    record('daily-return-denominator', { day2: { dailyPl: day2.dailyPl, dailyPct: day2.dailyPct }, day3: { dailyPl: day3.dailyPl, dailyPct: day3.dailyPct } }, 'With no subsequent cash flows, both daily returns are 10%.', 'Executed real SnapshotsService.upsert(); prior cumulative deposits equal 1000.');
  }
  {
    const db = new MemoryDb();
    db.data.snapshots.push({ owner: user, snapshotDate: '2026-10-01', accountValue: '1100', dailyPl: '100', dailyPct: '10' });
    const fxCalls = [];
    const dashboard = new DashboardService(db, { convert: async (amount, from, to) => { fxCalls.push([amount, from, to]); return amount * 7; } }, { batchRefreshPrices: async () => 0 });
    const overview = await dashboard.getOverview(user, 'CNY');
    assert.equal(overview.dailyPl, '700.00');
    record('dashboard-daily-pl-currency', { dailyPl: overview.dailyPl, baseCurrency: overview.baseCurrency, fxCalls }, 'A USD 100 snapshot P&L should render CNY 700 at the mocked rate 7.', 'Executed actual getOverview() with no holdings/cash and one USD snapshot.');
  }
  assert.equal(evidence.length, 6);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { MemoryDb, loadService, tables, orm, root };
