import { createHash } from 'node:crypto';
import type { SimulationSeed } from '../../../shared/simulation-experiment.interface';

export interface SeedSource {
  holdings: Array<{ id: string; ticker: string; market: string | null; currency: string | null; company: string | null;
    shares: string; buyPrice: string | null; currentPrice: string | null; updatedAt: Date }>;
  cash: Array<{ currency: string; balance: string; updatedAt: Date; reconciliationStatus?: string }>;
}
export function seedRevision(source: SeedSource): string {
  return createHash('sha256').update(JSON.stringify({
    holdings: source.holdings.slice().sort((a, b) => a.id.localeCompare(b.id)),
    cash: source.cash.slice().sort((a, b) => a.currency.localeCompare(b.currency)),
  })).digest('hex');
}
/** A read-only economic comparison, separate from the preview's stricter CAS revision. */
export function sourceLedgerRevision(source: SeedSource | SimulationSeed): string | null {
  const decimal = (value: unknown): string | null => {
    if (typeof value !== 'string' || !/^\+?\d+(?:\.\d+)?$/.test(value)) return null;
    const [whole, fraction = ''] = value.replace(/^\+/, '').split('.');
    const trimmed = fraction.replace(/0+$/, '');
    return `${whole.replace(/^0+(?=\d)/, '')}${trimmed ? `.${trimmed}` : ''}`;
  };
  const holdings = 'holdings' in source ? source.holdings.map((h) => ({ sourceHoldingId: h.id,
    ticker: h.ticker, market: h.market, currency: h.currency, shares: h.shares, historicalCost: h.buyPrice })) : source.positions;
  const cash = 'holdings' in source ? source.cash.map((c) => ({ currency: c.currency, total: c.balance })) : source.copiedCash ?? source.cash;
  if (!Array.isArray(holdings) || !Array.isArray(cash)) return null;
  const positions = holdings.map((p) => ({ id: p.sourceHoldingId, ticker: p.ticker, market: p.market,
    currency: p.currency, shares: decimal(p.shares), cost: p.historicalCost === null ? null : decimal(p.historicalCost),
    costKnown: p.historicalCost === null || decimal(p.historicalCost) !== null }));
  const balances = cash.map((c) => ({ currency: c.currency, total: decimal(c.total) }));
  if (positions.some((p) => !p.id || !p.ticker || !p.market || !p.currency || p.shares === null || !p.costKnown)
    || balances.some((c) => !c.currency || c.total === null)) return null;
  return createHash('sha256').update(JSON.stringify({
    positions: positions.filter((p) => p.shares !== '0').sort((a, b) => a.id.localeCompare(b.id)),
    cash: balances.sort((a, b) => a.currency.localeCompare(b.currency)),
  })).digest('hex');
}
export function buildOpeningSeed(source: SeedSource, quotes: Array<{ ticker: string; price: string; at: string }>,
  fx: SimulationSeed['fx'], capturedAt: string): SimulationSeed {
  const gaps = ['CORPORATE_ACTIONS_UNSUPPORTED', 'PUBLIC_QUOTES_MAY_BE_DELAYED'];
  if (!source.cash.length) gaps.push('CASH_UNKNOWN');
  if (source.holdings.some((h) => !Number.isFinite(Number(h.shares)) || Number(h.shares) < 0)
    || source.cash.some((c) => !Number.isFinite(Number(c.balance)) || Number(c.balance) < 0)) gaps.push('NEGATIVE_OR_INVALID_SOURCE_BALANCE');
  const positions = source.holdings.filter((h) => Number(h.shares) > 0).map((h) => {
    const quote = quotes.find((q) => q.ticker === h.ticker);
    if (!quote) gaps.push(`QUOTE_MISSING:${h.ticker}`);
    if (!['US', 'HK', 'CN'].includes(h.market ?? '') || !['USD', 'HKD', 'CNY'].includes(h.currency ?? '')) {
      gaps.push(`INSTRUMENT_UNKNOWN:${h.ticker}`);
    }
    gaps.push(`SELLABILITY_UNKNOWN:${h.ticker}`);
    return { sourceHoldingId: h.id, ticker: h.ticker, market: h.market as 'US' | 'HK' | 'CN',
      currency: h.currency as 'USD' | 'HKD' | 'CNY', company: h.company, shares: h.shares,
      historicalCost: h.buyPrice, initialPrice: quote?.price ?? null, quoteAt: quote?.at ?? null, sourceUpdatedAt: h.updatedAt.toISOString(),
      sellableShares: null, restriction: 'Unknown restrictions: opening shares cannot be sold until confirmed' };
  });
  const cash = source.cash.map((c) => {
    const known = c.reconciliationStatus === 'confirmed';
    if (!known) gaps.push(`CASH_AVAILABILITY_UNKNOWN:${c.currency}`);
    return { currency: c.currency, total: c.balance, available: known ? c.balance : '0', frozen: known ? '0' : c.balance, unsettled: '0', availabilityKnown: known, sourceUpdatedAt: c.updatedAt.toISOString() };
  });
  const currencies = new Set([...positions.map((p) => p.currency), ...cash.map((c) => c.currency)]);
  for (const currency of currencies) if (!fx.some((r) => r.currency === currency && Number(r.rate) > 0)) gaps.push(`FX_MISSING:${currency}`);
  const rate = (currency: string) => Number(fx.find((r) => r.currency === currency)?.rate ?? 0);
  const invalid = gaps.some((g) => /^(QUOTE_MISSING|FX_MISSING|INSTRUMENT_UNKNOWN|NEGATIVE_OR_INVALID)/.test(g));
  const value = positions.reduce((sum, p) => sum + Number(p.shares) * Number(p.initialPrice) * rate(p.currency), 0)
    + cash.reduce((sum, c) => sum + Number(c.total) * rate(c.currency), 0);
  return { sourceRevision: seedRevision(source), capturedAt, positions, cash, fx,
    initialEquityUsd: invalid || !Number.isFinite(value) ? null : value.toFixed(2), gaps,
    model: { version: 'paper-v1', feeBps: 5, slippageBps: 10, corporateActions: 'unsupported' } };
}
export function executionEconomics(referencePrice: number, quantity: number, side: 'buy' | 'sell', feeBps: number, slippageBps: number) {
  if (![feeBps, slippageBps].every((n) => Number.isFinite(n) && n >= 0 && n <= 100)) throw new Error('Invalid execution model basis points');
  const price = Number((referencePrice * (1 + (side === 'buy' ? 1 : -1) * slippageBps / 10000)).toFixed(8));
  const gross = price * quantity;
  const fee = gross * feeBps / 10000;
  if (!Number.isFinite(gross) || gross <= 0) throw new Error('Invalid execution model amount');
  return { price, gross, fee, cashAmount: side === 'buy' ? gross + fee : gross - fee };
}
export function validateCashTransfer(from: string, to: string, amount: number, available: number, rate: number): string {
  if (from === to) throw new Error('FX currencies must be different');
  if (!Number.isFinite(amount) || amount <= 0 || amount > available) throw new Error('Insufficient available currency cash');
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('FX rate unavailable');
  return (amount * rate).toFixed(8);
}
