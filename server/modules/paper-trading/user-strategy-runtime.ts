import { and, desc, eq, inArray } from 'drizzle-orm';
import { ConflictException } from '@nestjs/common';
import { builderProfiles } from '../../database/schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { strategyPlans, strategyProtections } from '../../database/strategy.schema';
import { roundStrategyLot } from './strategy-sizing';
import { executionEconomics } from './simulation-experiments.rules';
import type { Market } from '../../../shared/api.interface';
import { normalizeBuilderConfig } from './agent-builder.rules';
import { DEFAULT_ROUTE_POLICY } from './strategy-route.rules';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';
import type { ConfirmedInvestmentStrategy } from '../../../shared/user-investment-strategy.interface';
import type { InvestmentConfig } from '../../../shared/investment-policy.interface';
import type { MandateRule, StrategyMandateInput } from '../../../shared/strategy-mandate.interface';
import type { InvestmentTx, PolicyRow } from './investment-policy.service';

/** No invented target or stop: zero disables legacy protection; bounds only constrain execution. */
export function compileInvestorRules(snapshot: ConfirmedInvestmentStrategy, config: InvestmentConfig): MandateRule[] {
  return snapshot.preview.directives.map(directive => ({
    id: directive.entryId, ticker: directive.ticker, side: directive.side,
    trigger: { kind: directive.trigger.kind === 'price_lte' ? 'price_below' : 'price_above', value: directive.trigger.price ?? 1e-8 },
    referencePrice: directive.trigger.price ?? 1,
    minPrice: directive.minPrice ?? (directive.side === 'sell' && directive.trigger.kind === 'price_gte' ? directive.trigger.price! : 1e-8), maxPrice: directive.maxPrice ?? (directive.side === 'buy' && directive.trigger.kind === 'price_lte' ? directive.trigger.price! : 1e12),
    maxPositionPct: Math.min(config.limits.maxPositionPct, config.positionCaps[directive.ticker] ?? 100),
    stopLossPrice: directive.stopLossPrice ?? 0, expiresAt: directive.endsAt,
    evidenceIds: snapshot.sources.filter(source => directive.sourceKeys.includes(source.key) && source.versionId).map(source => source.versionId!),
    rationale: directive.reviewedText, reviewMode: directive.route === 'ai' ? 'ai' : 'deterministic',
    semanticCondition: directive.trigger.kind === 'semantic' ? directive.trigger.text : undefined,
    requiresIndependentReview: directive.side === 'buy' && !config.initialTickers?.includes(directive.ticker),
    userDirective: directive, userStrategyId: snapshot.id, userStrategyRevision: snapshot.revision,
  }));
}

/** Caller holds owner/account/policy locks. Every activation uses a fresh immutable execution identity. */
export async function installInvestorMandate(tx: InvestmentTx, owner: string, policy: PolicyRow, snapshot: ConfirmedInvestmentStrategy) {
  const now = new Date();
  const [previous] = await tx.select().from(strategyMandates).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, policy.accountId))).orderBy(desc(strategyMandates.createdAt));
  await tx.update(strategyMandates).set({ status: 'superseded', updatedAt: now }).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, policy.accountId), inArray(strategyMandates.status, ['published', 'paused'])));
  await tx.update(strategyPlans).set({ status: 'superseded' }).where(and(eq(strategyPlans.owner, owner), eq(strategyPlans.accountId, policy.accountId), inArray(strategyPlans.status, ['active', 'protection'])));
  // Protection must be explicitly present in this same user snapshot after a replacement.
  await tx.delete(strategyProtections).where(and(eq(strategyProtections.owner, owner), eq(strategyProtections.accountId, policy.accountId)));
  await tx.update(builderProfiles).set({ status: 'paused', updatedAt: now }).where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.status, 'active')));
  const config = normalizeBuilderConfig({ name: snapshot.content.title.slice(0, 40), template: 'balanced', tickers: [...new Set(snapshot.preview.directives.map(d => d.ticker))], minimumRating: 'Buy',
    customPrompt: `Execute only confirmed investor strategy ${snapshot.id}. Research cannot change intent.`,
    maxOrderPct: Math.max(0.1, Math.min(20, policy.effectiveConfig.limits.maxOrderPct)), dailyLossLimitPct: Math.max(0.1, Math.min(20, policy.effectiveConfig.limits.dailyLossLimitPct)), maxOrdersPerDay: 20,
    notifyOnProposal: false, language: 'zh-CN', automation: { enabled: false, preOpenMinutes: 60, monitorSeconds: 30, eventReplanCooldownMinutes: 120, maxEventReplansPerDay: 0, notifyClosingSummary: false } });
  // An absent configured reviewer remains an explicit wait at the existing AI/Council gate.
  config.council = policy.baseConfig.reviewMembers?.length ? { enabled: true, members: policy.baseConfig.reviewMembers, webResearch: false } : { ...config.council!, enabled: true };
  if (policy.baseConfig.reviewMembers?.length) config.automation = { ...config.automation!, fastReviewer: policy.baseConfig.reviewMembers[0] };
  config.automation = { ...config.automation!, enabled: true };
  const [profile] = await tx.insert(builderProfiles).values({ owner, config, status: 'active' }).returning();
  const rules = compileInvestorRules(snapshot, policy.effectiveConfig);
  if (rules.some(rule => !resolveTradingTicker(rule.ticker))) throw new ConflictException('STRATEGY_SECURITY_INVALID');
  const mandateConfig: StrategyMandateInput = { accountId: policy.accountId, profileId: profile.id,
    userStrategyId: snapshot.id, userStrategyRevision: snapshot.revision, parentPolicyId: policy.id, parentPolicyRevision: policy.revision,
    title: snapshot.content.title, objective: snapshot.content.body || snapshot.content.entries.map(entry => entry.text).join('\n'),
    period: 'custom', timezone: snapshot.content.timezone, startsAt: snapshot.content.startsAt, endsAt: snapshot.content.endsAt,
    rules, limits: policy.effectiveConfig.limits, references: snapshot.sources.filter(source => source.versionId).map(source => ({ versionId: source.versionId!, ...(source.sectionId ? { sectionId: source.sectionId } : {}) })),
    routePolicy: DEFAULT_ROUTE_POLICY, dailyPlanMode: 'fixed_rules' };
  const [mandate] = await tx.insert(strategyMandates).values({ owner, accountId: policy.accountId, profileId: profile.id, profileVersion: profile.version,
    parentPolicyId: policy.id, parentPolicyRevision: policy.revision, parentId: previous?.id, version: (previous?.version ?? 0) + 1,
    status: 'published', publishedAt: now, config: mandateConfig }).returning();
  return mandate;
}

/** Approach the approved TOTAL account exposure, with costs and lots rounding toward that target. */
export function investorTargetQuantity(input: { ticker: string; market: Market; side: 'buy' | 'sell'; heldShares: number;
  equityUsd: number; price: number; fx: number; positionPct: number; feeBps?: number; slippageBps?: number; lotSize?: number | null }): number {
  if (![input.equityUsd, input.price, input.fx].every(value => Number.isFinite(value) && value > 0)
    || !Number.isFinite(input.heldShares) || input.heldShares < 0 || !Number.isFinite(input.positionPct) || input.positionPct <= 0 || input.positionPct > 100) return 0;
  const target = input.positionPct / 100; const mark = input.price * input.fx;
  const execution = executionEconomics(input.price, 1, input.side, input.feeBps ?? 0, input.slippageBps ?? 0);
  const drag = (input.side === 'buy' ? execution.cashAmount - input.price : input.price - execution.cashAmount) * input.fx;
  const gap = input.side === 'buy' ? target * input.equityUsd - input.heldShares * mark : input.heldShares * mark - target * input.equityUsd;
  const denominator = input.side === 'buy' ? mark + target * drag : mark - target * drag;
  if (gap <= 0 || denominator <= 0) return 0;
  return roundStrategyLot(input.ticker, input.market, input.side, gap / denominator + 1e-10, input.lotSize);
}
