import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePortfolioRisk, valuePortfolioLedger, type PortfolioRiskLedger } from './strategy-portfolio-risk';
import { simulationMarketFixture } from './simulation-market.fixture';
import type { StrategyMandateInput } from '../../../shared/strategy-mandate.interface';
import { tradingMarketSchedule } from './trading-market.calendar';

const now = new Date('2026-11-05T15:30:00Z');
const config = { limits: { maxPositionPct: 50, maxDailyIncreasePct: 100, maxDailyTurnoverPct: 200,
  maxGrossExposurePct: 80, minCashPct: 20, maxOrderPct: 20 }, routePolicy: { councilPositionCapRatio: 0.8 },
  exposureGroups: [{ id: 'technology', label: 'Technology', tickers: ['AAPL', 'MSFT'], maxExposurePct: 50 }],
  eventWindows: [] } as unknown as StrategyMandateInput;
const candidate = { ticker: 'AAPL', side: 'buy' as const, quantity: 1, signalId: 'own' };
function fixture() {
  const quote = { ...simulationMarketFixture({ price: '100', market: 'US', currency: 'USD', timestamp: now.getTime() }, true),
    quoteUsable: true, quoteTimestamp: now.toISOString(), fetchedAt: now.toISOString() };
  const ledger: PortfolioRiskLedger = { account: { createdAt: new Date('2026-11-01'), ledgerMode: 'native_currency', cashBalance: '99999',
    executionModel: { feeBps: 0, slippageBps: 0 } },
    positions: [{ ticker: 'MSFT', currency: 'USD', shares: '3' }],
    cash: [{ currency: 'USD', available: '700', frozen: '0', unsettled: '0' }], pending: [] };
  return { ledger, inputs: { fetchedAt: now.toISOString(), quotes: { AAPL: quote, MSFT: quote }, fxToUsd: { USD: 1 } } };
}
test('portfolio caps count other-symbol live reservations and exclude only the current candidate', () => {
  const { ledger, inputs } = fixture();
  ledger.pending = [{ signalId: 'other', ticker: 'MSFT', currency: 'USD', quantity: 2, reservedCash: 200 },
    { signalId: 'own', ticker: 'AAPL', currency: 'USD', quantity: 1, reservedCash: 100 }];
  const snapshot = valuePortfolioLedger(ledger, inputs, now);
  const risk = evaluatePortfolioRisk(snapshot, config, candidate, 100, 0, now);
  assert.match(risk.hardBlock ?? '', /group.*Technology/i);
  assert.equal(risk.postGrossPct, 60);
  assert.equal(risk.postCashPct, 40);
});
test('fees, frozen/unsettled cash and adverse fills cannot satisfy the available-cash floor', () => {
  const { ledger, inputs } = fixture();
  ledger.cash = [{ currency: 'USD', available: '300', frozen: '200', unsettled: '200' }];
  const snapshot = valuePortfolioLedger(ledger, inputs, now);
  const risk = evaluatePortfolioRisk(snapshot, config, candidate, 100, 1, now);
  assert.match(risk.hardBlock ?? '', /cash/i);
  assert.ok(risk.postCashPct! < 20);
});
test('single-order and total exposure hard caps reject buys while ordinary sells ignore buy limits', () => {
  const { ledger, inputs } = fixture();
  const snapshot = valuePortfolioLedger(ledger, inputs, now);
  assert.match(evaluatePortfolioRisk(snapshot, config, { ...candidate, quantity: 3 }, 100, 0, now).hardBlock ?? '', /single.order/i);
  assert.match(evaluatePortfolioRisk(snapshot, { ...config, limits: { ...config.limits, maxGrossExposurePct: 35 } }, candidate, 100, 0, now).hardBlock ?? '', /gross/i);
  const sale = evaluatePortfolioRisk({ ...snapshot, gaps: ['Unrelated quote missing'], equityUsd: null }, config,
    { ...candidate, side: 'sell' }, 100, 0, now);
  assert.equal(sale.hardBlock, null);
});
test('group near-cap and explicit event windows escalate even a measurable small candidate', () => {
  const { ledger, inputs } = fixture();
  const snapshot = valuePortfolioLedger(ledger, inputs, now);
  assert.match(evaluatePortfolioRisk(snapshot, config, candidate, 100, 0, now).councilReason ?? '', /group/i);
  const eventConfig = { ...config, exposureGroups: [], eventWindows: [{ id: 'earnings', label: 'Earnings', tickers: ['AAPL'],
    startsAt: '2026-11-05T00:00:00Z', endsAt: '2026-11-06T00:00:00Z' }] };
  assert.match(evaluatePortfolioRisk(snapshot, eventConfig, candidate, 100, 0, now).councilReason ?? '', /event.*Earnings/i);
});
test('new locked-ledger holdings, missing FX and stale prepared quotes block increased risk', () => {
  const { ledger, inputs } = fixture();
  ledger.positions.push({ ticker: 'NEW', currency: 'HKD', shares: '100' });
  const snapshot = valuePortfolioLedger(ledger, inputs, now);
  assert.equal(snapshot.equityUsd, null);
  assert.match(evaluatePortfolioRisk(snapshot, config, candidate, 100, 0, now).hardBlock ?? '', /valuation/i);
  ledger.positions.pop();
  const stale = valuePortfolioLedger(ledger, inputs, new Date(now.getTime() + 3600_000));
  assert.equal(stale.equityUsd, null);
});
test('native FX and all pending quantities use their own currency and price', () => {
  const { ledger, inputs } = fixture();
  ledger.cash = [{ currency: 'HKD', available: '7800', frozen: '0', unsettled: '0' }];
  inputs.fxToUsd = { USD: 1, HKD: 1 / 7.8 } as typeof inputs.fxToUsd;
  ledger.pending = [{ signalId: 'other', ticker: 'MSFT', currency: 'HKD', quantity: 1, reservedCash: 780 }];
  const snapshot = valuePortfolioLedger(ledger, inputs, now);
  assert.equal(snapshot.equityUsd, 1300);
  assert.ok(Math.abs(snapshot.availableCashUsd! - 1000) < 1e-8);
  assert.ok(Math.abs(snapshot.pending[0].cashUsd - 100) < 1e-8);
});
test('another closed market uses only its verified recent closing mark', () => {
  const { ledger, inputs } = fixture();
  ledger.positions = [{ ticker: '0700.HK', currency: 'HKD', shares: '10' }];
  const closing = { ...inputs.quotes.MSFT, ticker: '0700.HK', market: 'HK' as const, currency: 'HKD' as const,
    price: 780, quoteTimestamp: '2026-11-05T08:00:00Z', quoteUsable: false, quoteReason: 'market_closed',
    schedule: tradingMarketSchedule('HK', now) };
  const mixedInputs = { ...inputs, quotes: { ...inputs.quotes, '0700.HK': closing }, fxToUsd: { USD: 1, HKD: 1 / 7.8 } };
  assert.equal(valuePortfolioLedger(ledger, mixedInputs, now).equityUsd, 1700);
  mixedInputs.quotes['0700.HK'].quoteTimestamp = '2026-11-04T08:00:00Z';
  assert.equal(valuePortfolioLedger(ledger, mixedInputs, now).equityUsd, null, 'a stale previous close cannot masquerade as current risk input');
});
