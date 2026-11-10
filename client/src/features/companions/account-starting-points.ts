import type { InvestmentPreviewRequest } from '@shared/investment-policy.interface';
import { resolveTradingTicker } from '@shared/trading-market.interface';

export type AccountSeedOrigin = InvestmentPreviewRequest['origin'];
export type SeedCurrency = 'USD' | 'HKD' | 'CNY';
export interface SeedPositionInput { id: string; ticker: string; shares: string; cost: string }
export type AccountSeedInput = {
  [K in AccountSeedOrigin]: Omit<Extract<InvestmentPreviewRequest, { origin: K }>, 'requestKey'>
}[AccountSeedOrigin];

/** The preview contract accepts quantities and reference costs; quotes stay server-owned. */
export function accountSeedInput(input: {
  origin: AccountSeedOrigin; amount: string; currency: SeedCurrency; sourceAccountId: string;
  positions: SeedPositionInput[]; cash: Partial<Record<SeedCurrency, string>>;
}): AccountSeedInput | null {
  const bounded = (value: string, positive = false) => value.trim() !== '' && Number.isFinite(Number(value))
    && Number(value) >= (positive ? Number.MIN_VALUE : 0) && Number(value) <= 1e12;
  if (input.origin === 'holdings') return { origin: 'holdings' };
  if (input.origin === 'cash') return bounded(input.amount, true)
    ? { origin: 'cash', cash: { currency: input.currency, amount: Number(input.amount) } } : null;
  if (input.origin === 'account') return input.sourceAccountId
    ? { origin: 'account', sourceAccountId: input.sourceAccountId } : null;
  if (!input.positions.length || input.positions.length > 100) return null;
  const holdings = [];
  const symbols = new Set<string>();
  for (const position of input.positions) {
    const security = resolveTradingTicker(position.ticker);
    if (!security || symbols.has(security.ticker) || !bounded(position.shares, true)
      || position.cost.trim() !== '' && !bounded(position.cost)) return null;
    symbols.add(security.ticker);
    holdings.push({ ticker: security.ticker, shares: Number(position.shares),
      ...(position.cost.trim() ? { historicalCost: Number(position.cost) } : {}) });
  }
  const cash = [];
  for (const currency of ['USD', 'HKD', 'CNY'] as const) {
    const value = input.cash[currency] ?? '';
    if (!value.trim()) continue;
    if (!bounded(value)) return null;
    cash.push({ currency, amount: Number(value) });
  }
  // Empty cash fields explicitly mean zero opening cash in a custom experiment.
  return { origin: 'custom', holdings, cash: cash.length ? cash : [{ currency: 'USD', amount: 0 }] };
}
