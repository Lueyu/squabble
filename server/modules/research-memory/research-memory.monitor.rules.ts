import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveTradingTicker, type TradingMarketSnapshot } from '@shared/trading-market.interface';
import type { MonitorCondition, MonitorObservation } from '@shared/research-monitor.interface';
import { lastCompletedTradingDate, tradingMarketDate } from '../paper-trading/trading-market.calendar';

export const monitorConditionSchema = z.object({
  conditionIndex: z.number().int().min(0).max(19), metric: z.enum(['price', 'sma20', 'rsi14', 'volumeRatio']),
  unit: z.enum(['USD', 'HKD', 'CNY', 'points', 'ratio']), operator: z.enum(['lt', 'lte', 'gt', 'gte']),
  threshold: z.number().finite().min(0).max(1e12), validFrom: z.iso.datetime(), validUntil: z.iso.datetime(),
  evidenceIds: z.array(z.string().trim().min(1).max(100)).min(1).max(20), rationale: z.string().trim().min(1).max(1000),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.validFrom) >= Date.parse(value.validUntil)) ctx.addIssue({ code: 'custom', message: 'Invalid condition period' });
  if ((value.metric === 'price' || value.metric === 'sma20') && (!['USD', 'HKD', 'CNY'].includes(value.unit) || value.threshold <= 0)
    || value.metric === 'rsi14' && (value.unit !== 'points' || value.threshold > 100)
    || value.metric === 'volumeRatio' && value.unit !== 'ratio') ctx.addIssue({ code: 'custom', message: 'Invalid metric unit or threshold' });
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate evidence' });
});
export const monitorWriteSchema = z.object({ expectedVersion: z.number().int().min(1), condition: monitorConditionSchema,
  ruleId: z.string().uuid().optional(), ruleVersion: z.number().int().min(1).optional(), enabled: z.boolean().optional() }).strict();

export function sameMonitorSymbol(left: string, right: string): boolean {
  const a = resolveTradingTicker(left); const b = resolveTradingTicker(right);
  return Boolean(a && b && a.ticker === b.ticker && a.market === b.market);
}
export function evaluateMonitor(condition: MonitorCondition, ticker: string, snapshot: TradingMarketSnapshot,
  now = new Date()): MonitorObservation {
  const info = resolveTradingTicker(ticker);
  const priceMetric = condition.metric === 'price';
  const observedAt = priceMetric ? snapshot.quoteTimestamp : snapshot.indicators?.asOf ?? null;
  const value = priceMetric ? snapshot.price : snapshot.indicators?.[condition.metric as 'sma20' | 'rsi14' | 'volumeRatio'] ?? null;
  const key = createHash('sha256').update(JSON.stringify([snapshot.source, info?.ticker, condition.metric, observedAt, snapshot.quoteTimestamp, value,
    snapshot.currency, snapshot.quoteUsable, snapshot.usable, snapshot.reason])).digest('hex');
  const unknown = (reason: string): MonitorObservation => ({ state: 'unknown', reason, observedAt, value, observationKey: `${key}:${reason}` });
  if (!monitorConditionSchema.safeParse(condition).success) return unknown('invalid_rule');
  if (!info || !sameMonitorSymbol(ticker, snapshot.ticker) || info.market !== snapshot.market) return unknown('symbol_mismatch');
  if (now.getTime() < Date.parse(condition.validFrom) || now.getTime() >= Date.parse(condition.validUntil)) return unknown('outside_validity');
  if (snapshot.source !== 'yahoo-chart' || !snapshot.sourceUrl) return unknown('source_unavailable');
  if ((condition.metric === 'price' || condition.metric === 'sma20') && (condition.unit !== snapshot.currency || condition.unit !== info.currency)) return unknown('unit_mismatch');
  if (!observedAt || !Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) > now.getTime() + 60000
    || value === null || !Number.isFinite(value) || value < 0) return unknown('invalid_observation');
  if (!snapshot.quoteUsable || !snapshot.quoteTimestamp || now.getTime() - Date.parse(snapshot.quoteTimestamp) > snapshot.maxQuoteAgeSeconds * 1000
    || !priceMetric && (!snapshot.usable || snapshot.indicators?.timeframe !== '1d')) return unknown('stale_or_missing_data');
  if (!priceMetric && (snapshot.indicators!.sampleSize < 50
    || tradingMarketDate(info.market, new Date(observedAt)) !== lastCompletedTradingDate(info.market, now))) return unknown('history_stale');
  if (condition.metric === 'rsi14' && value > 100) return unknown('invalid_observation');
  const breached = condition.operator === 'lt' ? value < condition.threshold : condition.operator === 'lte' ? value <= condition.threshold
    : condition.operator === 'gt' ? value > condition.threshold : value >= condition.threshold;
  return { state: breached ? 'breached' : 'clear', reason: null, observedAt, value, observationKey: key };
}
