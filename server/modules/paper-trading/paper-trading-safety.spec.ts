import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaperTradingService } from './paper-trading.service';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { simulationSeeds } from '../../database/simulation-experiments.schema';
import { simulationMarketFixture } from './simulation-market.fixture';

const account = {
  id: 'paper-account',
  owner: 'user',
  initialCash: '1000',
  cashBalance: '1000',
  botEnabled: true,
  guardrails: { maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 5 },
};

const order = { ticker: 'AAPL', side: 'buy' as const, quantity: 1, orderType: 'market' as const };

test('Builder order refuses stored-price fallback when the quote source is unavailable', async () => {
  let fallbackCalls = 0;
  const service = new PaperTradingService(
    {} as never,
    { getQuote: async () => null } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  Reflect.set(service, 'tradingMarket', { getSnapshot: async () => simulationMarketFixture(await Reflect.get(service, 'quoteService').getQuote('AAPL'), true) });
  Reflect.set(service, 'requireAccount', async () => account);
  Reflect.set(service, 'resolvePrice', async () => {
    fallbackCalls += 1;
    return { price: 100, fxToUsd: 1, market: 'US', currency: 'USD', company: null };
  });

  await assert.rejects(
    service.placeOrder('user', order, 'agent', undefined, true, true),
    /quote|报价/i,
  );
  assert.equal(fallbackCalls, 0);
});

test('Builder accepts a recently fetched delayed quote but rejects an old fetch', async () => {
  let timestamp = Date.now() - 10 * 60 * 1000;
  let transactionEntered = false;
  const service = new PaperTradingService(
    { transaction: async () => { transactionEntered = true; throw new Error('transaction reached'); } } as never,
    { getQuote: async () => ({
      symbol: 'AAPL', price: '100', market: 'US', currency: 'USD',
      timestamp, delayed: true,
    }) } as never,
    { convert: async () => 1 } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  Reflect.set(service, 'tradingMarket', { getSnapshot: async () => simulationMarketFixture(await Reflect.get(service, 'quoteService').getQuote('AAPL'), true) });
  Reflect.set(service, 'requireAccount', async () => account);
  Reflect.set(service, 'equityOf', async () => 1000);
  Reflect.set(service, 'dayStartEquity', async () => 1000);

  await assert.rejects(
    service.placeOrder('user', order, 'agent', undefined, true, true), /近期报价/,
  );
  assert.equal(transactionEntered, false);

  timestamp = Date.now();
  await assert.rejects(
    service.placeOrder('user', order, 'agent', undefined, true, true), /transaction reached/,
  );
  assert.equal(transactionEntered, true);
});

test('paper order enters a database transaction before writing the order ledger', async () => {
  let transactionEntered = false;
  const service = new PaperTradingService(
    { transaction: async () => { transactionEntered = true; throw new Error('transaction aborted'); } } as never,
    { getQuote: async () => ({ price: '100', market: 'US', currency: 'USD', timestamp: Date.now() }) } as never,
    { convert: async () => 1 } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  Reflect.set(service, 'tradingMarket', { getSnapshot: async () => simulationMarketFixture(await Reflect.get(service, 'quoteService').getQuote('AAPL'), true) });
  Reflect.set(service, 'requireAccount', async () => account);
  Reflect.set(service, 'resolvePrice', async () => ({
    price: 100, fxToUsd: 1, market: 'US', currency: 'USD', company: null,
  }));
  Reflect.set(service, 'equityOf', async () => 1000);
  Reflect.set(service, 'todayOrders', async () => []);
  Reflect.set(service, 'dayStartEquity', async () => 1000);

  await assert.rejects(
    service.placeOrder('user', order, 'manual'),
    /transaction aborted/,
  );
  assert.equal(transactionEntered, true);
});

test('approving a pending paper order enters a transaction before filling it', async () => {
  let transactionEntered = false;
  const pendingOrder = {
    id: 'order-1', accountId: account.id, owner: 'user', ticker: 'AAPL',
    side: 'buy', quantity: '1', status: 'pending_approval', agentName: 'agent',
  };
  const service = new PaperTradingService(
    {
      select: () => ({ from: () => ({ where: async () => [pendingOrder] }) }),
      transaction: async () => { transactionEntered = true; throw new Error('transaction aborted'); },
    } as never,
    { getQuote: async () => ({ price: '100', market: 'US', currency: 'USD', timestamp: Date.now() }) } as never,
    { convert: async () => 1 } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  Reflect.set(service, 'tradingMarket', { getSnapshot: async () => simulationMarketFixture(await Reflect.get(service, 'quoteService').getQuote('AAPL'), true) });
  Reflect.set(service, 'requireAccount', async () => account);
  Reflect.set(service, 'resolvePrice', async () => ({
    price: 100, fxToUsd: 1, market: 'US', currency: 'USD', company: null,
  }));
  Reflect.set(service, 'equityOf', async () => 1000);
  Reflect.set(service, 'dayStartEquity', async () => 1000);

  await assert.rejects(service.approveOrder('user', 'order-1'), /transaction aborted/);
  assert.equal(transactionEntered, true);
});

test('first daily-loss baseline uses current equity when an account has no snapshots', async () => {
  const service = new PaperTradingService(
    {
      select: () => ({
        from: (table: unknown) => table === investmentPolicies ? { where: async () => [] } : table === strategyMandates
          ? { where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }
          : ({ where: () => ({ orderBy: async () => [] }) }),
      }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  Reflect.set(service, 'equityOf', async () => 1_200_000);
  const baseline = Reflect.get(service, 'dayStartEquity') as (
    userId: string, accountId: string, initialCash: string
  ) => Promise<number>;

  assert.equal(await baseline.call(service, 'user', account.id, '1000000'), 1_200_000);
});

test('updating a daily snapshot keeps its original opening equity', async () => {
  let selects = 0;
  let saved: Record<string, unknown> | null = null;
  const service = new PaperTradingService(
    {
      select: () => ({
        from: (table: unknown) => table === investmentPolicies ? { where: async () => [] } : table === strategyMandates
          ? { where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }
          : ({
          where: async () => {
            if (table === simulationSeeds) return [];
            selects += 1;
            return selects === 1
              ? [{ id: 'snapshot', equity: '1100000', dailyPl: '100000' }]
              : [{ cashBalance: '500000' }];
          },
        }),
      }),
      update: () => ({
        set: (value: Record<string, unknown>) => {
          saved = value;
          return { where: async () => undefined };
        },
      }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  Reflect.set(service, 'equityOf', async () => 1_050_000);
  Reflect.set(service, 'dayStartEquity', async () => 1_000_000);

  await service.ensureDailySnapshot('user', account.id);
  assert.equal(saved?.dailyPl, '50000.00');
});

test('manual orders and approval paths cannot use stale stored prices', async () => {
  const service = new PaperTradingService({} as never,
    { getQuote: async () => ({ price: '100', currency: 'USD', market: 'US', timestamp: Date.now() - 600_000 }) } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never);
  Reflect.set(service, 'tradingMarket', { getSnapshot: async () => simulationMarketFixture(await Reflect.get(service, 'quoteService').getQuote('AAPL'), true) });
  Reflect.set(service, 'requireAccount', async () => account);
  Reflect.set(service, 'resolvePrice', async () => { throw new Error('Stored prices must never execute'); });
  await assert.rejects(service.placeOrder('user', order, 'manual'), /近期报价/);
  await assert.rejects(service.placeOrder('user', { ...order, quantity: 0.5 }, 'manual'), /positive integer/);
  await assert.rejects(service.placeOrder('user', order, 'manual', undefined, true, true,
    undefined, undefined, undefined, 'another-account'), /account changed/);
});

test('non-finite quotes and FX cannot enter the monetary ledger', async () => {
  let quotedPrice = 'NaN';
  const service = new PaperTradingService({} as never,
    { getQuote: async () => ({ price: quotedPrice, currency: 'USD', market: 'US', timestamp: Date.now() }) } as never,
    { convert: async () => Number.NaN } as never, {} as never, {} as never, {} as never, {} as never);
  Reflect.set(service, 'tradingMarket', { getSnapshot: async () => simulationMarketFixture(await Reflect.get(service, 'quoteService').getQuote('AAPL'), true) });
  Reflect.set(service, 'requireAccount', async () => account);
  await assert.rejects(service.placeOrder('user', order, 'manual'), /报价/);
  quotedPrice = '100';
  await assert.rejects(service.placeOrder('user', order, 'manual'), /汇率|FX/);
});
