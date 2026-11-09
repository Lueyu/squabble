const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../..');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith('@server/')) {
    request = path.join(root, 'server', request.slice('@server/'.length));
  } else if (request.startsWith('@shared/')) {
    request = path.join(root, 'shared', request.slice('@shared/'.length));
  }
  return resolveFilename.call(this, request, parent, isMain, options);
};
require.extensions['.ts'] = (module, filename) => {
  const source = require('node:fs').readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
    },
  });
  module._compile(output.outputText, filename);
};

const { PortfolioContextService } = require('./portfolio-context.service.ts');

function holding(ticker, shares, currentPrice, currency = 'USD', extras = {}) {
  return {
    ticker,
    company: ticker,
    sector: null,
    market: currency === 'HKD' ? 'HK' : 'US',
    currency,
    shares: String(shares),
    currentPrice: String(currentPrice),
    buyPrice: String(currentPrice),
    ...extras,
  };
}

function rule(ruleKey, threshold, ruleType = 'hard') {
  return {
    id: ruleKey,
    ruleKey,
    ruleName: ruleKey,
    ruleType,
    threshold: threshold === null ? null : String(threshold),
    unit: '%',
    enabled: true,
    description: null,
    category: null,
    severity: ruleType === 'hard' ? 'hard_block' : 'warning',
    sort: 0,
    createdAt: '',
    updatedAt: '',
  };
}

function portfolio(holdings, cashRatio = 0) {
  const companyExposures = {};
  for (const item of holdings) {
    companyExposures[item.companyGroup] =
      (companyExposures[item.companyGroup] ?? 0) + item.weightPct;
  }
  return {
    totalValue: 100,
    totalMv: 100 - cashRatio,
    cash: cashRatio,
    cashRatio,
    holdings,
    companyExposures,
  };
}

function contextHolding(ticker, weightPct, extras = {}) {
  return {
    ticker,
    company: ticker,
    sector: null,
    market: 'US',
    currency: 'USD',
    shares: 1,
    currentPrice: weightPct,
    costPrice: weightPct,
    marketValue: weightPct,
    weightPct,
    pnlPct: 0,
    companyGroup: ticker,
    ...extras,
  };
}

function serviceWithRows(holdingRows = [], cashRows = [], convert = async (value) => value) {
  const rows = [holdingRows, cashRows];
  const db = {
    select: () => ({
      from: () => ({ where: async () => rows.shift() }),
    }),
  };
  return new PortfolioContextService(db, { convert });
}

test('converts mixed-currency holdings and cash to USD before calculating weights', async () => {
  const service = serviceWithRows(
    [holding('A', 1, 100), holding('1810.HK', 800, 1, 'HKD')],
    [{ currency: 'USD', balance: '100' }, { currency: 'CNY', balance: '700' }],
    async (value, from, to) => {
      assert.equal(to, 'USD');
      return value * { USD: 1, HKD: 0.125, CNY: 1 / 7 }[from];
    },
  );

  const result = await service.getPortfolioContext('owner');
  assert.equal(result.totalMv, 200);
  assert.equal(result.cash, 200);
  assert.equal(result.totalValue, 400);
  assert.equal(result.cashRatio, 50);
  assert.equal(result.holdings[1].marketValue, 100);
  assert.equal(result.holdings[1].weightPct, 25);
});

test('refuses a mixed-currency risk snapshot when the actual FX pair is unavailable', async () => {
  const service = serviceWithRows(
    [holding('1810.HK', 800, 1, 'HKD')],
    [],
    async () => { throw new Error('No exchange rate available for HKD -> USD'); },
  );
  await assert.rejects(
    service.getPortfolioContext('owner'),
    /HKD.*USD/,
  );
});

test('does not require FX rates for a USD-only portfolio', async () => {
  const service = serviceWithRows(
    [holding('A', 1, 100)],
    [{ currency: 'USD', balance: '50' }, { currency: 'HKD', balance: '0' }],
    async () => { throw new Error('FX unavailable'); },
  );
  const result = await service.getPortfolioContext('owner');
  assert.equal(result.totalValue, 150);
});

test('refuses to infer zero exposure from a missing price on a held position', async () => {
  const service = serviceWithRows([
    holding('A', 10, 20, 'USD', { currentPrice: null }),
  ]);
  await assert.rejects(service.getPortfolioContext('owner'), /A.*现价/);
});

test('refuses a zero price on a nonzero holding instead of passing exposure rules', async () => {
  const service = serviceWithRows([holding('AAPL', 10, 0)], []);
  await assert.rejects(service.getPortfolioContext('owner'), /现价无效/);
});

test('refuses a nonnumeric cash balance instead of returning NaN ratios', async () => {
  const service = serviceWithRows([], [{ currency: 'USD', balance: 'invalid' }]);
  await assert.rejects(service.getPortfolioContext('owner'), /现金.*余额/);
});

test('uses the configured cash minimum rather than a fixed range', () => {
  const service = serviceWithRows();
  const check = (cashRatio, threshold) => service.checkRiskRules(
    'A', portfolio([], cashRatio), [rule('cash_ratio', threshold, 'soft')],
  )[0];
  assert.equal(check(10, 12).passed, false);
  assert.equal(check(12, 12).passed, true);
  assert.equal(check(20, 12).passed, true);
});

test('returns a blocking result for an unknown enabled hard rule', () => {
  const service = serviceWithRows();
  const result = service.checkRiskRules('A', portfolio([]), [rule('future_rule', 1)]);
  assert.equal(result.length, 1);
  assert.equal(result[0].passed, false);
  assert.match(result[0].detail, /无法|未实现|未核实/);
});

test('reports every seeded rule and fails closed when verification data is missing', () => {
  const service = serviceWithRows();
  const keys = [
    'single_company_exposure', 'single_stock_limit', 'small_cap_weight',
    'loss_maker_weight', 'leverage_etf', 'cash_ratio', 'drawdown_check',
    'stop_loss_pct', 'take_profit_pct', 'new_buy_checklist',
    'position_building_days', 'sector_exposure',
  ];
  const results = service.checkRiskRules(
    'A', portfolio([contextHolding('A', 10)]),
    keys.map((key) => rule(key, 10)),
  );
  assert.equal(results.length, keys.length);
  for (const key of ['small_cap_weight', 'loss_maker_weight', 'new_buy_checklist']) {
    assert.equal(results.find((item) => item.ruleKey === key).passed, false);
  }
});

test('does not treat a low share price as proof of small market capitalization', () => {
  const service = serviceWithRows();
  const item = contextHolding('A', 10, { currentPrice: 1 });
  const result = service.checkRiskRules('A', portfolio([item]), [rule('small_cap_weight', 5)])[0];
  assert.equal(result.passed, false);
  assert.equal(result.currentValue, null);
  assert.match(result.detail, /市值/);
});

test('sums all leveraged ETFs against the shared exposure limit', () => {
  const service = serviceWithRows();
  const result = service.checkRiskRules('TQQQ', portfolio([
    contextHolding('TQQQ', 2), contextHolding('SOXL', 2),
  ]), [rule('leverage_etf', 3)])[0];
  assert.equal(result.currentValue, 4);
  assert.equal(result.passed, false);
});

test('sums holdings in the same sector against the sector limit', () => {
  const service = serviceWithRows();
  const result = service.checkRiskRules('A', portfolio([
    contextHolding('A', 20, { sector: 'Technology' }),
    contextHolding('B', 20, { sector: 'Technology' }),
  ]), [rule('sector_exposure', 30, 'soft')])[0];
  assert.equal(result.currentValue, 40);
  assert.equal(result.passed, false);
});

test('evaluates stop-loss and take-profit thresholds from actual unrealized PnL', () => {
  const service = serviceWithRows();
  const loss = service.checkRiskRules('A', portfolio([
    contextHolding('A', 10, { pnlPct: -30 }),
  ]), [rule('stop_loss_pct', 25, 'soft')])[0];
  const gain = service.checkRiskRules('A', portfolio([
    contextHolding('A', 10, { pnlPct: 60 }),
  ]), [rule('take_profit_pct', 50, 'soft')])[0];
  assert.equal(loss.passed, false);
  assert.equal(loss.currentValue, 30);
  assert.equal(gain.passed, false);
  assert.equal(gain.currentValue, 60);
});
