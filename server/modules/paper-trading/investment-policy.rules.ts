import { z } from 'zod';
import type { InvestmentConfig, InvestmentConstraintRecord } from '../../../shared/investment-policy.interface';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';

export const DEFAULT_INVESTMENT_CONFIG: InvestmentConfig = {
  markets: ['US'], assetTypes: ['stock', 'etf'], timezone: 'Asia/Shanghai',
  limits: { maxPositionPct: 10, maxOrderPct: 5, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20,
    maxGrossExposurePct: 90, minCashPct: 10, dailyLossLimitPct: 3 },
  budget: { dailyTasks: 6, maxCallsPerTask: 12, maxDiscoveryCandidates: 10, maxDeepResearchCandidates: 3 },
  noBuy: [], noSell: [], noIncrease: false, positionCaps: {},
};
const requestKey = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/u);
const percent = z.number().finite().min(0).max(100);
const market = z.enum(['US', 'HK', 'CN']);
const ticker = z.string().min(1).max(20).refine(value => Boolean(resolveTradingTicker(value))).transform(value => resolveTradingTicker(value)!.ticker);
const expiresAt = z.string().datetime().nullable();
export const investmentConstraintSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no_buy'), ticker, expiresAt }).strict(),
  z.object({ kind: z.literal('no_sell'), ticker, expiresAt }).strict(),
  z.object({ kind: z.literal('no_increase'), expiresAt }).strict(),
  z.object({ kind: z.literal('position_cap'), ticker, percent, expiresAt }).strict(),
  z.object({ kind: z.literal('cash_floor'), percent, expiresAt }).strict(),
  z.object({ kind: z.literal('markets'), markets: z.array(market).min(1).max(3), expiresAt }).strict(),
]);
const limits = z.object({ maxPositionPct: percent.optional(), maxOrderPct: percent.optional(),
  maxDailyIncreasePct: percent.optional(), maxDailyTurnoverPct: z.number().min(0).max(200).optional(),
  maxGrossExposurePct: percent.optional(), minCashPct: percent.optional(), dailyLossLimitPct: percent.optional() }).strict();
const start = z.object({ previewId: z.string().uuid(), requestKey, markets: z.array(market).min(1).max(3).optional(), limits: limits.optional(),
  confirmNoCash: z.boolean().optional(), cashAvailable: z.record(z.string(), z.number().finite().nonnegative()).optional(),
  sellableShares: z.record(z.string(), z.number().finite().nonnegative()).optional(), adoptAccountId: z.string().uuid().optional() }).strict();
export const investmentRequests = {
  preview: z.object({ origin: z.enum(['holdings', 'cash']), cash: z.object({ amount: z.number().finite().positive(), currency: z.enum(['USD', 'HKD', 'CNY']) }).strict().optional(), requestKey }).strict()
    .refine(value => value.origin === 'cash' ? Boolean(value.cash) : !value.cash, 'Cash start requires an explicit amount and currency'),
  start, restart: start.extend({ expectedAccountId: z.string().uuid() }).strict(),
  pause: z.object({ expectedRevision: z.number().int().positive(), requestKey }).strict(),
  resume: z.object({ expectedRevision: z.number().int().positive(), requestKey }).strict(),
  propose: z.object({ text: z.string().trim().min(1).max(3000), sessionId: z.string().uuid().optional(), requestKey,
    constraint: investmentConstraintSchema.optional() }).strict(),
  confirm: z.object({ expectedPolicyRevision: z.number().int().positive(), requestKey }).strict(),
  revoke: z.object({ expectedPolicyRevision: z.number().int().positive(), requestKey }).strict(),
};
export function normalizeInvestmentRequest<K extends keyof typeof investmentRequests>(kind: K, input: unknown): z.infer<(typeof investmentRequests)[K]> {
  return investmentRequests[kind].parse(input) as z.infer<(typeof investmentRequests)[K]>;
}
export function effectiveInvestmentConfig(base: InvestmentConfig, records: InvestmentConstraintRecord[], now = new Date()): InvestmentConfig {
  const config = structuredClone(base);
  for (const record of records.filter(record => record.status === 'active' && !record.revokedAt
    && (!record.constraint.expiresAt || Date.parse(record.constraint.expiresAt) > now.getTime()))) {
    const c = investmentConstraintSchema.parse(record.constraint);
    switch (c.kind) {
      case 'no_buy': config.noBuy.push(c.ticker); break;
      case 'no_sell': config.noSell.push(c.ticker); break;
      case 'no_increase': config.noIncrease = true; break;
      case 'position_cap': config.positionCaps[c.ticker] = c.percent; break;
      case 'cash_floor': config.limits.minCashPct = c.percent; config.limits.maxGrossExposurePct = Math.min(base.limits.maxGrossExposurePct, 100 - c.percent); break;
      case 'markets': config.markets = [...new Set(c.markets)]; break;
    }
  }
  if (!config.markets.length || config.limits.maxGrossExposurePct + config.limits.minCashPct > 100 + 1e-8) throw new Error('CONTRADICTORY_CONSTRAINTS');
  config.noBuy = [...new Set(config.noBuy)]; config.noSell = [...new Set(config.noSell)];
  return config;
}
export function investmentOrderBlock(config: InvestmentConfig, order: { ticker: string; side: string; market: string; protectiveStop?: boolean }): string | null {
  const same = (ticker: string) => investmentSecurityKey(ticker) === investmentSecurityKey(order.ticker);
  if (order.side === 'sell' && config.noSell.some(same)) return 'INVESTMENT_NO_SELL_INCLUDES_PROTECTION';
  if (order.side === 'buy' && (config.noIncrease || config.noBuy.some(same))) return 'INVESTMENT_NO_BUY';
  if (order.side === 'buy' && !config.markets.includes(order.market as InvestmentConfig['markets'][number])) return 'INVESTMENT_MARKET_NOT_AUTHORIZED';
  return null;
}
export function investmentSecurityKey(ticker: string): string {
  const resolved = resolveTradingTicker(ticker);
  return resolved ? `${resolved.market}:${resolved.providerSymbol}` : ticker.toUpperCase();
}
