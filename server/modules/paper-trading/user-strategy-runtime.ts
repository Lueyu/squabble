import { and, desc, eq, inArray } from 'drizzle-orm';
import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
import type { PortfolioStrategyAssignment } from '../../../shared/portfolio-workspace.interface';

export function investorSnapshotHash(snapshot: ConfirmedInvestmentStrategy): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .filter(([, item]) => item !== undefined).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash('sha256').update(JSON.stringify(canonical({ id: snapshot.id, revision: snapshot.revision,
    content: snapshot.content, sources: snapshot.sources, directives: snapshot.preview.directives }))).digest('hex');
}

export function investorRuleId(strategyId: string, entryId: string): string {
  return `${strategyId}:${entryId}`;
}

export function investorAssignments(config: InvestmentConfig): PortfolioStrategyAssignment[] {
  return config.portfolio ?? (config.userStrategy ? [{ strategyId: config.userStrategy.id,
    strategyRevision: config.userStrategy.revision, allocationPct: 100, enabled: true, snapshot: config.userStrategy }] : []);
}

/** Original source entries remain consumed even when their runtime mandate is replaced. */
export function isSameInvestorEntry(candidate: { accountId?: string; userStrategyId?: string; userEntryId?: string; ruleId: string },
  accountId: string, strategyId: string, entryId: string): boolean {
  return candidate.accountId === accountId && candidate.userStrategyId === strategyId
    && (candidate.userEntryId ?? (candidate.ruleId.startsWith(`${strategyId}:`) ? candidate.ruleId.slice(strategyId.length + 1) : candidate.ruleId)) === entryId;
}

/** No invented target or stop: zero disables legacy protection; bounds only constrain execution. */
export function compileInvestorRules(snapshot: ConfirmedInvestmentStrategy, config: InvestmentConfig, allocationPct = 100): MandateRule[] {
  return snapshot.preview.directives.map(directive => ({
    id: investorRuleId(snapshot.id, directive.entryId), ticker: directive.ticker, side: directive.side,
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
    userEntryId: directive.entryId, userStrategySnapshotHash: investorSnapshotHash(snapshot), allocationPct,
  }));
}

/** Compatibility entrypoint for one immutable investor strategy. */
export async function installInvestorMandate(tx: InvestmentTx, owner: string, policy: PolicyRow, snapshot: ConfirmedInvestmentStrategy) {
  return installInvestorCombinationMandate(tx, owner, policy, [{ strategyId: snapshot.id,
    strategyRevision: snapshot.revision, allocationPct: 100, enabled: true, snapshot }]);
}

/** Caller holds owner/account/policy locks; source identity remains stable across new runtime versions. */
export async function installInvestorCombinationMandate(tx: InvestmentTx, owner: string, policy: PolicyRow,
  assignments: PortfolioStrategyAssignment[]) {
  const enabled = assignments.filter(item => item.enabled);
  if (!enabled.length) throw new ConflictException('PORTFOLIO_NO_ENABLED_STRATEGY');
  if (enabled.some(item => item.snapshot.id !== item.strategyId || item.snapshot.revision !== item.strategyRevision
    || !Number.isFinite(item.allocationPct) || item.allocationPct <= 0 || item.allocationPct > 100)
    || enabled.reduce((sum, item) => sum + item.allocationPct, 0) > 100 + 1e-8) throw new ConflictException('PORTFOLIO_ASSIGNMENT_INVALID');
  const snapshot = enabled[0].snapshot;
  const title = enabled.map(item => item.snapshot.content.title).join(' + ').slice(0, 200);
  const now = new Date();
  const [previous] = await tx.select().from(strategyMandates).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, policy.accountId))).orderBy(desc(strategyMandates.createdAt));
  await tx.update(strategyMandates).set({ status: 'superseded', updatedAt: now }).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, policy.accountId), inArray(strategyMandates.status, ['published', 'paused'])));
  await tx.update(strategyPlans).set({ status: 'superseded' }).where(and(eq(strategyPlans.owner, owner), eq(strategyPlans.accountId, policy.accountId), inArray(strategyPlans.status, ['active', 'protection'])));
  // Protection must be explicitly present in this same user snapshot after a replacement.
  await tx.delete(strategyProtections).where(and(eq(strategyProtections.owner, owner), eq(strategyProtections.accountId, policy.accountId)));
  await tx.update(builderProfiles).set({ status: 'paused', updatedAt: now }).where(and(eq(builderProfiles.owner, owner),
    eq(builderProfiles.accountId, policy.accountId), eq(builderProfiles.status, 'active')));
  const config = normalizeBuilderConfig({ name: title.slice(0, 40), template: 'balanced', tickers: [...new Set(enabled.flatMap(item => item.snapshot.preview.directives.map(d => d.ticker)))], minimumRating: 'Buy',
    customPrompt: `Execute only confirmed account strategy assignments ${enabled.map(item => item.strategyId).join(', ')}. Research cannot change intent.`,
    maxOrderPct: Math.max(0.1, Math.min(20, policy.effectiveConfig.limits.maxOrderPct)), dailyLossLimitPct: Math.max(0.1, Math.min(20, policy.effectiveConfig.limits.dailyLossLimitPct)), maxOrdersPerDay: 20,
    notifyOnProposal: false, language: 'zh-CN', automation: { enabled: false, preOpenMinutes: 60, monitorSeconds: 30, eventReplanCooldownMinutes: 120, maxEventReplansPerDay: 0, notifyClosingSummary: false } });
  // An absent configured reviewer remains an explicit wait at the existing AI/Council gate.
  config.council = policy.baseConfig.reviewMembers?.length ? { enabled: true, members: policy.baseConfig.reviewMembers, webResearch: false } : { ...config.council!, enabled: true };
  if (policy.baseConfig.reviewMembers?.length) config.automation = { ...config.automation!, fastReviewer: policy.baseConfig.reviewMembers[0] };
  config.automation = { ...config.automation!, enabled: true };
  const [profile] = await tx.insert(builderProfiles).values({ owner, accountId: policy.accountId, config, status: 'active' }).returning();
  const rules = enabled.flatMap(item => compileInvestorRules(item.snapshot, policy.effectiveConfig, item.allocationPct));
  if (rules.some(rule => !resolveTradingTicker(rule.ticker))) throw new ConflictException('STRATEGY_SECURITY_INVALID');
  const mandateConfig: StrategyMandateInput = { accountId: policy.accountId, profileId: profile.id,
    ...(enabled.length === 1 ? { userStrategyId: snapshot.id, userStrategyRevision: snapshot.revision } : {}),
    parentPolicyId: policy.id, parentPolicyRevision: policy.revision,
    title, objective: enabled.map(item => item.snapshot.content.body || item.snapshot.content.entries.map(entry => entry.text).join('\n')).join('\n\n'),
    period: 'custom', timezone: policy.effectiveConfig.timezone,
    startsAt: new Date(Math.min(...enabled.map(item => Date.parse(item.snapshot.content.startsAt)))).toISOString(),
    endsAt: new Date(Math.max(...enabled.map(item => Date.parse(item.snapshot.content.endsAt)))).toISOString(),
    rules, limits: policy.effectiveConfig.limits, references: enabled.flatMap(item => item.snapshot.sources.filter(source => source.versionId).map(source => ({ versionId: source.versionId!, ...(source.sectionId ? { sectionId: source.sectionId } : {}) }))),
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
