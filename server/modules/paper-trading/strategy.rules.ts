import { DEFAULT_STRATEGY_AUTOMATION, STRATEGY_TRIGGER_KINDS, type StrategyAutomationConfig,
  type StrategyRule, type StrategyTriggerKind } from '../../../shared/strategy.interface';

export function normalizeAutomation(input?: StrategyAutomationConfig): StrategyAutomationConfig {
  if (input === undefined) return { ...DEFAULT_STRATEGY_AUTOMATION };
  if (!input || typeof input.enabled !== 'boolean') throw new Error('Invalid automation preference');
  const config = { ...DEFAULT_STRATEGY_AUTOMATION, ...input };
  for (const [key, minimum, maximum] of [
    ['preOpenMinutes', 15, 240], ['monitorSeconds', 30, 900],
    ['eventReplanCooldownMinutes', 30, 1440], ['maxEventReplansPerDay', 0, 3],
  ] as const) {
    if (!Number.isInteger(config[key]) || config[key] < minimum || config[key] > maximum) {
      throw new Error(`Invalid ${key}: expected ${minimum}–${maximum}`);
    }
  }
  if (typeof config.notifyClosingSummary !== 'boolean') throw new Error('Invalid closing summary preference');
  return config;
}

export interface PlanValidationContext {
  tickers: string[]; evidenceIds: string[]; expiresAt: Date; now: Date; maxPositionPct: number;
  evidenceIdsByTicker?: Record<string, string[]>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid strategy object');
  return value as Record<string, unknown>;
};
const positive = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('Invalid strategy number');
  return value;
};

/** Untrusted model output can only narrow the investor's fixed execution limits. */
export function validateStrategyRules(value: unknown, context: PlanValidationContext): StrategyRule[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('A strategy must contain at most 20 rules');
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    const rule = object(entry);
    const trigger = object(rule.trigger);
    if (typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(rule.id) || ids.has(rule.id)) throw new Error('Invalid strategy rule id');
    ids.add(rule.id);
    if (typeof rule.ticker !== 'string' || !context.tickers.includes(rule.ticker)) throw new Error('Strategy ticker outside allowlist');
    if (rule.side !== 'buy' && rule.side !== 'sell') throw new Error('Invalid strategy direction');
    if (!(STRATEGY_TRIGGER_KINDS as readonly unknown[]).includes(trigger.kind)) throw new Error('Unsupported strategy trigger');
    const triggerValue = positive(trigger.value);
    if (String(trigger.kind).startsWith('rsi14') && triggerValue > 100) throw new Error('Invalid RSI threshold');
    const referencePrice = positive(rule.referencePrice);
    const minPrice = positive(rule.minPrice);
    const maxPrice = positive(rule.maxPrice);
    const maxPositionPct = positive(rule.maxPositionPct);
    const stopLossPrice = positive(rule.stopLossPrice);
    if (minPrice > maxPrice || referencePrice < minPrice || referencePrice > maxPrice
      || maxPositionPct > context.maxPositionPct || stopLossPrice >= minPrice) throw new Error('Strategy violates price or exposure limits');
    if (typeof rule.expiresAt !== 'string' || !Number.isFinite(Date.parse(rule.expiresAt))
      || Date.parse(rule.expiresAt) <= context.now.getTime() || Date.parse(rule.expiresAt) > context.expiresAt.getTime()) throw new Error('Invalid strategy expiry');
    if (!Array.isArray(rule.evidenceIds) || rule.evidenceIds.length === 0 || rule.evidenceIds.length > 20
      || rule.evidenceIds.some((id: unknown) => typeof id !== 'string' || !context.evidenceIds.includes(id)
        || context.evidenceIdsByTicker && !context.evidenceIdsByTicker[rule.ticker as string]?.includes(id))) throw new Error('Strategy needs verified report evidence');
    if (typeof rule.rationale !== 'string' || !rule.rationale.trim() || rule.rationale.length > 1000) throw new Error('Invalid strategy rationale');
    return { id: rule.id, ticker: rule.ticker, side: rule.side,
      trigger: { kind: trigger.kind as StrategyTriggerKind, value: triggerValue }, referencePrice,
      minPrice, maxPrice, maxPositionPct, stopLossPrice, expiresAt: new Date(rule.expiresAt).toISOString(),
      evidenceIds: rule.evidenceIds as string[], rationale: rule.rationale.trim() };
  });
}

/** Missing, stale or non-finite indicators never satisfy a trigger. */
export function strategyTriggerMatches(rule: StrategyRule, price: number,
  indicators: Partial<{ sma20: number; rsi14: number; volumeRatio: number }> | null, now = new Date()): boolean {
  if (!Number.isFinite(price) || price < rule.minPrice || price > rule.maxPrice) return false;
  if (rule.userDirective) {
    const d = rule.userDirective;
    if (now.getTime() < Date.parse(d.startsAt) || now.getTime() >= Date.parse(d.endsAt)) return false;
    if (d.trigger.kind === 'always' || d.trigger.kind === 'semantic') return true;
    const threshold = Number(d.trigger.price);
    if (!Number.isFinite(threshold)) return false;
    switch (d.trigger.kind) {
      case 'price_lt': return price < threshold;
      case 'price_lte': return price <= threshold;
      case 'price_gt': return price > threshold;
      case 'price_gte': return price >= threshold;
      default: return false;
    }
  }
  const value = rule.trigger.value;
  switch (rule.trigger.kind) {
    case 'price_above': return price >= value;
    case 'price_below': return price <= value;
    case 'sma20_above': return Number.isFinite(indicators?.sma20) && price >= Number(indicators?.sma20) * value;
    case 'sma20_below': return Number.isFinite(indicators?.sma20) && price <= Number(indicators?.sma20) * value;
    case 'rsi14_above': return Number.isFinite(indicators?.rsi14) && Number(indicators?.rsi14) >= value;
    case 'rsi14_below': return Number.isFinite(indicators?.rsi14) && Number(indicators?.rsi14) <= value;
    case 'volume_ratio_above': return Number.isFinite(indicators?.volumeRatio) && Number(indicators?.volumeRatio) >= value;
  }
}
