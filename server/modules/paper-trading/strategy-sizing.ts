import type { Market } from '../../../shared/api.interface';
import { executionEconomics } from './simulation-experiments.rules';

function roundLot(ticker: string, market: Market, side: 'buy' | 'sell', quantity: number, lotSize?: number | null): number {
  const whole = Math.max(0, Math.floor(quantity));
  if (market === 'US') return whole;
  if (market === 'HK') return Number.isSafeInteger(lotSize) && Number(lotSize) > 0 ? Math.floor(whole / Number(lotSize)) * Number(lotSize) : 0;
  if (/^68[89]/.test(ticker)) return whole >= 200 || side === 'sell' ? Math.min(whole, 50000) : 0;
  if (side === 'sell' && whole <= 1000000) return whole;
  return Math.min(1000000, Math.floor(whole / 100) * 100);
}
export function sizeStrategyBuy(input: { ticker: string; market: Market; budgetUsd: number; cashUsd: number;
  price: number; fx: number; feeBps?: number; slippageBps?: number; lotSize?: number | null }): number {
  if (![input.budgetUsd, input.cashUsd, input.price, input.fx].every(value => Number.isFinite(value) && value > 0)) return 0;
  const unit = executionEconomics(input.price, 1, 'buy', input.feeBps ?? 0, input.slippageBps ?? 0);
  const quantity = Math.min(input.budgetUsd / (unit.price * input.fx), input.cashUsd / (unit.cashAmount * input.fx));
  return roundLot(input.ticker, input.market, 'buy', quantity, input.lotSize);
}
export function sizeStrategySell(ticker: string, market: Market, shares: number, restricted: number,
  unavailableToday: number, lotSize?: number | null): number {
  if (![shares, restricted, unavailableToday].every(value => Number.isFinite(value) && value >= 0)) return 0;
  return roundLot(ticker, market, 'sell', Math.max(0, shares - restricted - unavailableToday), lotSize);
}
