import { and, eq, gt } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { paperAccounts, paperOrders, paperPositions } from '../../database/schema';
import { simulationCash } from '../../database/simulation-experiments.schema';
import { strategyReservations } from '../../database/strategy-mandates.schema';
import { strategySignals } from '../../database/strategy.schema';
import type { StrategyMandateInput } from '../../../shared/strategy-mandate.interface';
import type { TradingMarketSnapshot } from '../../../shared/trading-market.interface';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';
import type { TradingMarketService } from './trading-market.service';
import type { FxService } from '../fx/fx.service';
import { executionEconomics } from './simulation-experiments.rules';
import { lastCompletedTradingDate, tradingMarketDate, tradingMarketSchedule } from './trading-market.calendar';
import { readCorporateActionGaps } from './simulation-corporate-actions';

type Database = PostgresJsDatabase | Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
const symbol = (ticker: string) => resolveTradingTicker(ticker)?.ticker ?? ticker.toUpperCase();
export interface PortfolioRiskInputs {
  fetchedAt: string;
  quotes: Record<string, TradingMarketSnapshot | undefined>;
  fxToUsd: Record<string, number | undefined>;
}
export interface PortfolioRiskLedger {
  account: { createdAt: Date; ledgerMode: string; cashBalance: string; executionModel?: { feeBps: number; slippageBps: number } };
  positions: Array<{ ticker: string; currency: string; shares: string; openedAt?: Date }>;
  cash: Array<{ currency: string; available: string; frozen: string; unsettled: string }>;
  pending: Array<{ signalId: string; ticker: string; currency: string; quantity: number; reservedCash?: number }>;
  reconciliationGaps?: string[];
}
export interface PortfolioRiskSnapshot {
  equityUsd: number | null; availableCashUsd: number | null; grossExposureUsd: number | null;
  holdings: Array<{ ticker: string; valueUsd: number }>;
  pending: Array<{ signalId: string; ticker: string; valueUsd: number; cashUsd: number }>;
  unitPricesUsd: Record<string, number>; gaps: string[];
}
export interface PortfolioRiskDecision {
  hardBlock: string | null; councilReason: string | null; postGrossPct: number | null; postCashPct: number | null;
  groupExposures: Array<{ id: string; label: string; exposurePct: number }>;
}

async function readLedger(db: Database, owner: string, accountId: string, now: Date): Promise<PortfolioRiskLedger> {
  const [[account], positions, cash, reservations, orders, actionGaps] = await Promise.all([
    db.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId))),
    db.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, accountId))),
    db.select().from(simulationCash).where(and(eq(simulationCash.owner, owner), eq(simulationCash.accountId, accountId))),
    db.select({ reservation: strategyReservations, candidate: strategySignals.candidate, orderId: strategySignals.orderId })
      .from(strategyReservations).leftJoin(strategySignals, eq(strategyReservations.signalId, strategySignals.id))
      .where(and(eq(strategyReservations.owner, owner), eq(strategyReservations.accountId, accountId),
        eq(strategyReservations.status, 'active'), eq(strategyReservations.side, 'buy'), gt(strategyReservations.expiresAt, now))),
    db.select().from(paperOrders).where(and(eq(paperOrders.owner, owner), eq(paperOrders.accountId, accountId),
      eq(paperOrders.side, 'buy'), eq(paperOrders.status, 'pending_approval'))),
    readCorporateActionGaps(db, owner, accountId),
  ]);
  if (!account) throw new Error('Portfolio risk account not found');
  const reservedOrderIds = new Set(reservations.map(row => row.orderId).filter(Boolean));
  return { account, positions, cash, reconciliationGaps: actionGaps.map(gap => `Corporate action requires reconciliation:${gap.ticker}`), pending: [
    ...reservations.map(({ reservation, candidate }) => ({ signalId: reservation.signalId, ticker: reservation.ticker,
      currency: reservation.currency, quantity: candidate?.quantity ?? Number.NaN, reservedCash: Number(reservation.cash) })),
    ...orders.filter(order => !reservedOrderIds.has(order.id)).map(order => ({ signalId: `order:${order.id}`, ticker: order.ticker,
      currency: account.ledgerMode === 'native_currency' ? order.currency : 'USD', quantity: Number(order.quantity) })),
  ] };
}

/** Network calls occur before locking the account; the final reader revalues the current locked ledger. */
export async function preparePortfolioRiskInputs(db: Database, owner: string, accountId: string,
  market: Pick<TradingMarketService, 'getSnapshot'>, fx: Pick<FxService, 'convert'>, now = new Date(), extraTickers: string[] = []): Promise<PortfolioRiskInputs> {
  const ledger = await readLedger(db, owner, accountId, now);
  const tickers = [...new Set([...ledger.positions.map(p => p.ticker), ...ledger.pending.map(p => p.ticker), ...extraTickers].map(symbol))];
  const entries = await Promise.all(tickers.map(async ticker => {
    try { return [ticker, await market.getSnapshot(ticker, now, true)] as const; }
    catch { return [ticker, undefined] as const; }
  }));
  const currencies = [...new Set(['USD', ...ledger.positions.map(p => p.currency), ...ledger.cash.map(c => c.currency),
    ...ledger.pending.map(p => p.currency), ...entries.flatMap(([, quote]) => quote?.currency ? [quote.currency] : [])])];
  const rates = await Promise.all(currencies.map(async currency => {
    try { return [currency, currency === 'USD' ? 1 : await fx.convert(1, currency, 'USD')] as const; }
    catch { return [currency, undefined] as const; }
  }));
  return { fetchedAt: now.toISOString(), quotes: Object.fromEntries(entries), fxToUsd: Object.fromEntries(rates) };
}

export function usableValuationQuote(quote: TradingMarketSnapshot | undefined, now: Date): quote is TradingMarketSnapshot & { price: number; currency: string } {
  if (!quote || !quote.market || !quote.currency || !Number.isFinite(quote.price) || Number(quote.price) <= 0
    || !quote.quoteTimestamp || !quote.schedule?.calendarVerified || quote.halted || quote.corporateActionsChecked === false) return false;
  const at = Date.parse(quote.quoteTimestamp);
  if (!Number.isFinite(at) || at > now.getTime() + 60_000) return false;
  const schedule = tradingMarketSchedule(quote.market, now);
  if (!schedule.calendarVerified) return false;
  if (schedule.isOpen) return quote.quoteUsable && now.getTime() - at <= quote.maxQuoteAgeSeconds * 1000;
  // Other markets can be closed while this candidate trades. Use only their last verified closing mark.
  if (quote.quoteReason !== 'market_closed') return false;
  const completed = lastCompletedTradingDate(quote.market, now);
  const quoteDay = tradingMarketDate(quote.market, new Date(at));
  const sourceSession = tradingMarketSchedule(quote.market, new Date(at));
  return Boolean(completed && quoteDay >= completed && sourceSession.closesAt
    && at >= Date.parse(sourceSession.closesAt) - quote.maxQuoteAgeSeconds * 1000);
}

export function valuePortfolioLedger(ledger: PortfolioRiskLedger, inputs: PortfolioRiskInputs, now = new Date()): PortfolioRiskSnapshot {
  const gaps: string[] = [...(ledger.reconciliationGaps ?? [])];
  if (!Number.isFinite(Date.parse(inputs.fetchedAt)) || Math.abs(now.getTime() - Date.parse(inputs.fetchedAt)) > 300_000) gaps.push('Prepared portfolio valuation expired');
  const rate = (currency: string) => {
    const value = inputs.fxToUsd[currency];
    if (!Number.isFinite(value) || Number(value) <= 0) { gaps.push(`FX unavailable:${currency}`); return 0; }
    return Number(value);
  };
  const unitPricesUsd: Record<string, number> = {};
  for (const [ticker, quote] of Object.entries(inputs.quotes)) {
    if (!usableValuationQuote(quote, now)) continue;
    unitPricesUsd[symbol(ticker)] = quote.price * rate(quote.currency);
  }
  const unit = (ticker: string, currency?: string, acquiredAt?: Date) => {
    const key = symbol(ticker); const quote = inputs.quotes[key];
    if (!unitPricesUsd[key] || currency && quote?.currency !== currency) { gaps.push(`Quote unavailable:${key}`); return 0; }
    if (acquiredAt && quote?.corporateActions?.some(event => Date.parse(event.occurredAt) >= acquiredAt.getTime()
      && Date.parse(event.occurredAt) <= now.getTime())) gaps.push(`Corporate action requires reconciliation:${key}`);
    return unitPricesUsd[key];
  };
  const holdings = ledger.positions.map(position => {
    const shares = Number(position.shares);
    if (!Number.isFinite(shares) || shares < 0) gaps.push(`Invalid shares:${position.ticker}`);
    return { ticker: symbol(position.ticker), valueUsd: shares * unit(position.ticker, position.currency, position.openedAt ?? ledger.account.createdAt) };
  });
  let totalCash = 0; let availableCash = 0;
  if (ledger.account.ledgerMode === 'native_currency') for (const cash of ledger.cash) {
    const values = [cash.available, cash.frozen, cash.unsettled].map(Number);
    if (!values.every(value => Number.isFinite(value) && value >= 0)) gaps.push(`Invalid cash:${cash.currency}`);
    const fx = rate(cash.currency);
    totalCash += values.reduce((sum, value) => sum + value, 0) * fx;
    availableCash += values[0] * fx;
  } else {
    totalCash = availableCash = Number(ledger.account.cashBalance);
    if (!Number.isFinite(totalCash) || totalCash < 0) gaps.push('Invalid legacy cash');
  }
  const pending = ledger.pending.map(order => {
    const key = symbol(order.ticker); const priceUsd = unit(key);
    if (!Number.isFinite(order.quantity) || order.quantity <= 0) gaps.push(`Invalid pending quantity:${key}`);
    const valueUsd = order.quantity * priceUsd;
    const model = ledger.account.executionModel ?? { feeBps: 0, slippageBps: 0 };
    let cashUsd = 0;
    try { cashUsd = executionEconomics(priceUsd, order.quantity, 'buy', model.feeBps, model.slippageBps).cashAmount; }
    catch { gaps.push(`Pending execution model unavailable:${key}`); }
    if (order.reservedCash !== undefined) {
      if (!Number.isFinite(order.reservedCash) || order.reservedCash < 0) gaps.push(`Invalid pending cash:${key}`);
      cashUsd = Math.max(cashUsd, order.reservedCash * rate(order.currency));
    }
    return { signalId: order.signalId, ticker: key, valueUsd, cashUsd };
  });
  const gross = holdings.reduce((sum, holding) => sum + holding.valueUsd, 0);
  return { equityUsd: gaps.length ? null : totalCash + gross, availableCashUsd: gaps.length ? null : availableCash,
    grossExposureUsd: gaps.length ? null : gross, holdings, pending, unitPricesUsd, gaps: [...new Set(gaps)] };
}

/** Passing prepared inputs performs no network requests, suitable for the final account-lock transaction. */
export async function readPortfolioRiskSnapshot(db: Database, owner: string, accountId: string,
  market: Pick<TradingMarketService, 'getSnapshot'>, fx: Pick<FxService, 'convert'>, now = new Date(), preparedInputs?: PortfolioRiskInputs): Promise<PortfolioRiskSnapshot> {
  const inputs = preparedInputs ?? await preparePortfolioRiskInputs(db, owner, accountId, market, fx, now);
  return valuePortfolioLedger(await readLedger(db, owner, accountId, now), inputs, now);
}

export function evaluatePortfolioRisk(snapshot: PortfolioRiskSnapshot, config: StrategyMandateInput,
  candidate: { ticker: string; side: 'buy' | 'sell'; quantity: number; signalId: string }, executedUnitUsd: number, feeUsd = 0, now = new Date()): PortfolioRiskDecision {
  const result: PortfolioRiskDecision = { hardBlock: null, councilReason: null, postGrossPct: null, postCashPct: null, groupExposures: [] };
  if (candidate.side === 'sell') {
    const event = config.eventWindows?.find(window => window.tickers.map(symbol).includes(symbol(candidate.ticker))
      && Date.parse(window.startsAt) <= now.getTime() && now.getTime() < Date.parse(window.endsAt));
    if (event) result.councilReason = `Major event window:${event.label}`;
    return result;
  }
  if (snapshot.gaps.length || snapshot.equityUsd === null || snapshot.equityUsd <= 0
    || snapshot.availableCashUsd === null || snapshot.grossExposureUsd === null
    || !Number.isFinite(executedUnitUsd) || executedUnitUsd <= 0 || !Number.isFinite(feeUsd) || feeUsd < 0
    || !Number.isFinite(candidate.quantity) || candidate.quantity <= 0) {
    result.hardBlock = `Portfolio valuation unavailable:${snapshot.gaps.join('; ')}`; return result;
  }
  const pending = snapshot.pending.filter(order => order.signalId !== candidate.signalId);
  const pendingValue = pending.reduce((sum, order) => sum + order.valueUsd, 0);
  const pendingCost = pending.reduce((sum, order) => sum + order.cashUsd, 0);
  const cost = candidate.quantity * executedUnitUsd + feeUsd;
  const mark = candidate.quantity * (snapshot.unitPricesUsd[symbol(candidate.ticker)] ?? executedUnitUsd);
  const equityAfterCosts = snapshot.equityUsd - Math.max(0, cost - mark) - Math.max(0, pendingCost - pendingValue);
  if (equityAfterCosts <= 0) { result.hardBlock = 'Portfolio equity exhausted by execution costs'; return result; }
  result.postGrossPct = (snapshot.grossExposureUsd + pendingValue + mark) / equityAfterCosts * 100;
  result.postCashPct = (snapshot.availableCashUsd - pendingCost - cost) / equityAfterCosts * 100;
  if (cost / snapshot.equityUsd * 100 > (config.limits.maxOrderPct ?? 100) + 1e-8) result.hardBlock = 'Portfolio single-order limit exceeded';
  if (result.postGrossPct > (config.limits.maxGrossExposurePct ?? 100) + 1e-8) result.hardBlock ??= 'Portfolio gross exposure limit exceeded';
  if (result.postCashPct < (config.limits.minCashPct ?? 0) - 1e-8) result.hardBlock ??= 'Portfolio minimum available cash limit exceeded';
  for (const group of config.exposureGroups ?? []) {
    const members = new Set(group.tickers.map(symbol));
    const exposure = snapshot.holdings.filter(holding => members.has(holding.ticker)).reduce((sum, holding) => sum + holding.valueUsd, 0)
      + pending.filter(order => members.has(order.ticker)).reduce((sum, order) => sum + order.valueUsd, 0)
      + (members.has(symbol(candidate.ticker)) ? mark : 0);
    const exposurePct = exposure / equityAfterCosts * 100;
    result.groupExposures.push({ id: group.id, label: group.label, exposurePct });
    if (exposurePct > group.maxExposurePct + 1e-8) result.hardBlock ??= `Exposure group limit exceeded:${group.label}`;
    else if (exposurePct >= group.maxExposurePct * config.routePolicy.councilPositionCapRatio - 1e-8) result.councilReason ??= `Exposure group near limit:${group.label}`;
  }
  const event = config.eventWindows?.find(window => window.tickers.map(symbol).includes(symbol(candidate.ticker))
    && Date.parse(window.startsAt) <= now.getTime() && now.getTime() < Date.parse(window.endsAt));
  if (event) result.councilReason ??= `Major event window:${event.label}`;
  return result;
}
