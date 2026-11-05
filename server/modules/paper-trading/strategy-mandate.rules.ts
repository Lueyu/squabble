import { validateStrategyRules } from './strategy.rules';
import { DEFAULT_ROUTE_POLICY } from './strategy-route.rules';
import type { StrategyMandateInput, MandateRule } from '../../../shared/strategy-mandate.interface';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function assertMandateId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid strategy identifier');
}
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid strategy configuration');
  return v as Record<string, unknown>;
};
const bounded = (v: unknown, min: number, max: number) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error('Strategy limit is out of range');
  return v;
};
export function normalizeMandate(input: unknown, now = new Date(), forPublication = true): StrategyMandateInput {
  const v = record(input);
  assertMandateId(v.accountId); assertMandateId(v.profileId);
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 120
    || typeof v.objective !== 'string' || v.objective.length > 2000) throw new Error('A short strategy title and objective are required');
  if (!['day', 'month', 'custom'].includes(String(v.period))) throw new Error('Invalid strategy period');
  if (typeof v.timezone !== 'string') throw new Error('Timezone is required');
  new Intl.DateTimeFormat('en', { timeZone: v.timezone });
  const start = Date.parse(String(v.startsAt)); const end = Date.parse(String(v.endsAt));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 366 * 86400000
    || forPublication && end <= now.getTime()) throw new Error('Invalid strategy effective period');
  if (v.period === 'day' && end - start > 26 * 3600000 || v.period === 'month' && end - start > 32 * 86400000) {
    throw new Error('Period does not match its calendar label');
  }
  if (!['fixed_rules', 'bounded_ai'].includes(String(v.dailyPlanMode))) throw new Error('Invalid daily plan authorization');
  if (!Array.isArray(v.references) || !v.references.length || v.references.length > 20) throw new Error('Pin 1–20 source report versions');
  const references = v.references.map(ref => {
    const entry = record(ref); assertMandateId(entry.versionId);
    if (entry.sectionId !== undefined && (typeof entry.sectionId !== 'string' || entry.sectionId.length > 100)) throw new Error('Invalid report section');
    return { versionId: entry.versionId, ...(typeof entry.sectionId === 'string' ? { sectionId: entry.sectionId } : {}) };
  });
  if (v.sourceSessionId !== undefined) assertMandateId(v.sourceSessionId);
  const cap = record(v.limits);
  const limits = { maxPositionPct: bounded(cap.maxPositionPct, 0.1, 100),
    maxDailyIncreasePct: bounded(cap.maxDailyIncreasePct, 0.1, 100), maxDailyTurnoverPct: bounded(cap.maxDailyTurnoverPct, 0.1, 200),
    minCashPct: bounded(cap.minCashPct ?? 0, 0, 100), maxGrossExposurePct: bounded(cap.maxGrossExposurePct ?? 100, 0.1, 100),
    maxOrderPct: bounded(cap.maxOrderPct ?? 100, 0.1, 100) };
  const groupsInput = v.exposureGroups ?? []; const eventsInput = v.eventWindows ?? [];
  if (!Array.isArray(groupsInput) || groupsInput.length > 20 || !Array.isArray(eventsInput) || eventsInput.length > 30) throw new Error('Too many exposure groups or event windows');
  const namedBasket = (item: unknown) => {
    const row = record(item);
    if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) || typeof row.label !== 'string' || !row.label.trim() || row.label.length > 120
      || !Array.isArray(row.tickers) || !row.tickers.length || row.tickers.length > 100
      || row.tickers.some(ticker => typeof ticker !== 'string' || !resolveTradingTicker(ticker))) throw new Error('Invalid named exposure basket');
    return { id: row.id, label: row.label.trim(), tickers: [...new Set(row.tickers as string[])] };
  };
  const exposureGroups = groupsInput.map(item => ({ ...namedBasket(item), maxExposurePct: bounded(record(item).maxExposurePct, 0.1, 100) }));
  const eventWindows = eventsInput.map(item => {
    const row = record(item); const startsAt = Date.parse(String(row.startsAt)); const endsAt = Date.parse(String(row.endsAt));
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) throw new Error('Invalid event window');
    return { ...namedBasket(item), startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() };
  });
  if (new Set(exposureGroups.map(group => group.id)).size !== exposureGroups.length || new Set(eventWindows.map(event => event.id)).size !== eventWindows.length) throw new Error('Duplicate group or event identity');
  const policy = { ...DEFAULT_ROUTE_POLICY, ...record(v.routePolicy ?? {}) };
  const routePolicy = { councilPositionCapRatio: bounded(policy.councilPositionCapRatio, 0.1, 1),
    councilIncrementPct: bounded(policy.councilIncrementPct, 0.1, 100),
    rollingWindowMinutes: bounded(policy.rollingWindowMinutes, 1, 1440), candidateTtlSeconds: bounded(policy.candidateTtlSeconds, 30, 1800) };
  if (!Array.isArray(v.rules) || forPublication && !v.rules.length) throw new Error('At least one measurable execution rule is required');
  const tickers = [...new Set(v.rules.map(rule => String(record(rule).ticker)))];
  if (tickers.some(ticker => !resolveTradingTicker(ticker))) throw new Error('Unsupported strategy ticker');
  const rules = validateStrategyRules(v.rules, { tickers, evidenceIds: references.map(ref => ref.versionId),
    expiresAt: new Date(end), now: forPublication ? now : new Date(Math.min(start, now.getTime()) - 1), maxPositionPct: limits.maxPositionPct })
    .map((rule, index): MandateRule => {
      const extra = record((v.rules as unknown[])[index]);
      if (extra.reviewMode !== undefined && !['deterministic', 'ai'].includes(String(extra.reviewMode))) throw new Error('Invalid rule review mode');
      if (extra.semanticCondition !== undefined && (typeof extra.semanticCondition !== 'string' || extra.semanticCondition.length > 1000)) throw new Error('Invalid qualitative condition');
      return { ...rule, reviewMode: extra.reviewMode === 'ai' ? 'ai' : 'deterministic',
        semanticCondition: typeof extra.semanticCondition === 'string' ? extra.semanticCondition.trim() : '' };
    });
  return { title: v.title.trim(), objective: v.objective.trim(), period: v.period as StrategyMandateInput['period'],
    timezone: v.timezone, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(),
    accountId: v.accountId, profileId: v.profileId, references, rules, limits, routePolicy,
    exposureGroups, eventWindows, ...(v.sourceSessionId ? { sourceSessionId: String(v.sourceSessionId) } : {}), dailyPlanMode: v.dailyPlanMode as StrategyMandateInput['dailyPlanMode'] };
}
