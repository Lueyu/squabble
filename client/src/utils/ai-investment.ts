export function displayInvestmentStatus(status: string, heartbeat: string | null, now = Date.now()): string {
  if (status !== 'running') return status;
  const last = heartbeat ? Date.parse(heartbeat) : NaN;
  return Number.isFinite(last) && now - last <= 120_000 && last <= now + 30_000 ? 'running' : 'offline';
}
export function validCashSeed(amount: string, currency: string): boolean {
  return amount.trim() !== '' && Number.isFinite(Number(amount)) && Number(amount) > 0 && ['USD', 'HKD', 'CNY'].includes(currency);
}
export function returnLabel(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}
import type { InvestmentConstraint } from '@shared/investment-policy.interface';
import type { Market } from '@shared/api.interface';


export function constraintDraft(input: { kind: InvestmentConstraint['kind']; ticker?: string; percent?: string; markets?: Market[]; expiresAt?: string }, now = Date.now()): InvestmentConstraint | null {
  const expires = input.expiresAt ? Date.parse(input.expiresAt) : null;
  if (expires !== null && (!Number.isFinite(expires) || expires <= now)) return null;
  const expiresAt = expires == null ? null : new Date(expires).toISOString();
  const ticker = input.ticker?.trim().toUpperCase();
  if (['no_buy', 'no_sell', 'position_cap'].includes(input.kind) && (!ticker || !/^[A-Z0-9.^][A-Z0-9.^/_-]{0,19}$/u.test(ticker))) return null;
  if (input.kind === 'no_buy' || input.kind === 'no_sell') return { kind: input.kind, ticker: ticker!, expiresAt };
  if (input.kind === 'no_increase') return { kind: 'no_increase', expiresAt };
  if (input.kind === 'markets') {
    const markets = [...new Set(input.markets || [])];
    return markets.length && markets.every(value => ['US', 'HK', 'CN'].includes(value)) ? { kind: 'markets', markets, expiresAt } : null;
  }
  const percent = Number(input.percent);
  if (!input.percent?.trim() || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return input.kind === 'position_cap' ? { kind: 'position_cap', ticker: ticker!, percent, expiresAt } : { kind: 'cash_floor', percent, expiresAt };
}
