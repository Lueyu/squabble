import { Inject, Injectable, ConflictException } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { builderProfiles, paperAccounts } from '../../database/schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { investmentCycles, investmentPolicies } from '../../database/investment-policy.schema';
import { strategyPlans } from '../../database/strategy.schema';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { cancelInvestmentCandidates, expireInvestmentConstraints } from './investment-policy.service';
import { validateStrategyRules } from './strategy.rules';
import { DEFAULT_ROUTE_POLICY } from './strategy-route.rules';
import { investmentOrderBlock } from './investment-policy.rules';
import type { AutonomousMandateInput, AutonomousMandateRule, InvestmentConfig, InvestmentResearchReview, VerifiedInvestmentSecurity } from '../../../shared/investment-policy.interface';
import type { Market } from '../../../shared/api.interface';

export interface CompileAutonomousInput {
  config: InvestmentConfig; security: VerifiedInvestmentSecurity; reviews: InvestmentResearchReview[]; isNew: boolean;
  marketDate: string; validUntil: string; cycleId: string; evidenceIds: string[]; now?: Date;
}
export function compileAutonomousRules(input: CompileAutonomousInput): AutonomousMandateRule[] {
  const { config, security, reviews } = input; const now = input.now ?? new Date();
  if (!config.markets.includes(security.market)) throw new Error('INVESTMENT_MARKET_NOT_AUTHORIZED');
  if (!config.assetTypes.includes(security.assetType) || security.leveraged !== false || security.inverse !== false) throw new Error('INVESTMENT_ASSET_NOT_AUTHORIZED');
  const identities = [...new Set(reviews.filter(r => r.executorVerified && r.conclusion === 'approve').map(r => r.executorIdentity))];
  if (input.isNew && identities.length < 2) throw new Error('INVESTMENT_INDEPENDENT_REVIEW_REQUIRED');
  if (reviews.some(r => r.conclusion !== 'approve' || r.unresolvedDisagreements.length)) throw new Error('INVESTMENT_UNRESOLVED_DISAGREEMENT');
  const proposed = reviews[0]?.rules ?? [];
  const rules = validateStrategyRules(proposed, { tickers: [security.ticker], evidenceIds: input.evidenceIds, now,
    expiresAt: new Date(input.validUntil), maxPositionPct: Math.min(config.limits.maxPositionPct, config.positionCaps[security.ticker] ?? 100) });
  if (rules.some(r => investmentOrderBlock(config, { ...r, market: security.market }))) throw new Error('INVESTMENT_RULE_EXCEEDS_CONSTRAINT');
  return rules.map((rule, index) => {
    const extra = proposed[index] as { reviewMode?: unknown; semanticCondition?: unknown };
    if (extra.reviewMode !== undefined && !['ai', 'deterministic'].includes(String(extra.reviewMode))
      || extra.semanticCondition !== undefined && (typeof extra.semanticCondition !== 'string' || extra.semanticCondition.length > 1000)) throw new Error('INVESTMENT_INVALID_SEMANTIC_CONDITION');
    return { ...rule, id: `${security.market}_${security.ticker.replace(/\W/gu, '_')}_${rule.id}`.slice(0, 40),
    reviewMode: extra.reviewMode === 'ai' ? 'ai' as const : 'deterministic' as const, semanticCondition: typeof extra.semanticCondition === 'string' ? extra.semanticCondition.trim() : '',
    market: security.market, marketSessionDate: input.marketDate, validUntil: rule.expiresAt, sourceCycleId: input.cycleId,
    security, executorIdentities: identities, requiresIndependentReview: input.isNew }; });
}
export function mergeAutonomousRules(existing: AutonomousMandateRule[], incoming: AutonomousMandateRule[], market: Market, now = new Date()): AutonomousMandateRule[] {
  const rules = [...existing.filter(rule => rule.market !== market && Date.parse(rule.validUntil) > now.getTime()), ...incoming];
  const unique = new Map(rules.map(rule => [`${rule.ticker}:${rule.side}:${rule.id}`, rule]));
  if (unique.size > 20) throw new Error('INVESTMENT_COMPOSITE_RULE_LIMIT');
  return [...unique.values()];
}

/** Publication merges under the same owner/account/policy lock used by fills. No network lives in this transaction. */
@Injectable()
export class AutonomousPlanCompiler {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase, private readonly documents: ResearchDocumentsService) {}
  async activate(owner: string, cycleId: string, leaseToken: string, profileId: string, incoming: AutonomousMandateRule[]) {
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [foundCycle] = await tx.select().from(investmentCycles).where(and(eq(investmentCycles.owner, owner), eq(investmentCycles.id, cycleId)));
      if (!foundCycle) throw new ConflictException('INVESTMENT_CYCLE_NOT_FOUND');
      const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, foundCycle.accountId))).for('update');
      const [unexpired] = await tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.id, foundCycle.policyId))).for('update');
      if (!unexpired) throw new ConflictException('INVESTMENT_POLICY_MISSING');
      const policy = await expireInvestmentConstraints(tx, unexpired);
      const [cycle] = await tx.select().from(investmentCycles).where(eq(investmentCycles.id, cycleId)).for('update');
      if (!account?.isActive || !account.botEnabled || policy.status !== 'running' || policy.revision !== cycle.policyRevision
        || cycle.state !== 'researching' || cycle.leaseToken !== leaseToken || !cycle.leaseUntil || cycle.leaseUntil.getTime() <= Date.now()) throw new ConflictException('INVESTMENT_POLICY_OR_LEASE_CHANGED');
      const [profile] = await tx.select().from(builderProfiles).where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.id, profileId))).for('update');
      if (!profile) throw new ConflictException('INVESTMENT_RESEARCH_TEAM_CHANGED');
      if (profile.status === 'paused') throw new ConflictException('INVESTMENT_RESEARCH_TEAM_CHANGED');
      const [current] = await tx.select().from(strategyMandates).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, account.id), eq(strategyMandates.status, 'published'))).for('update');
      const existing = (current?.config as AutonomousMandateInput | undefined)?.rules ?? [];
      const rules = mergeAutonomousRules(existing, incoming, cycle.market as Market);
      for (const rule of rules) {
        if (investmentOrderBlock(policy.effectiveConfig, { ...rule, market: rule.market }) || rule.maxPositionPct > Math.min(policy.effectiveConfig.limits.maxPositionPct, policy.effectiveConfig.positionCaps[rule.ticker] ?? 100)) throw new ConflictException('INVESTMENT_RULE_EXCEEDS_CURRENT_POLICY');
      }
      if (!rules.length) { await tx.update(investmentCycles).set({ state: 'completed', result: { reason: 'Observe; no valid execution rule' }, updatedAt: new Date() }).where(eq(investmentCycles.id, cycle.id)); return null; }
      const references = [...new Set(rules.flatMap(rule => rule.evidenceIds))].map(versionId => ({ versionId }));
      await this.documents.assertExecutionSourcesInTransaction(tx, owner, references, new Date());
      const config: AutonomousMandateInput = { parentPolicyId: policy.id, parentPolicyRevision: policy.revision, cycleId,
        accountId: account.id, profileId, title: 'Current AI investment plan', objective: rules.map(r => `${r.ticker}: ${r.rationale}`).join('\n'),
        period: 'custom', timezone: policy.effectiveConfig.timezone, startsAt: new Date().toISOString(), endsAt: new Date(Math.max(...rules.map(r => Date.parse(r.validUntil)))).toISOString(),
        references, rules, limits: policy.effectiveConfig.limits, routePolicy: DEFAULT_ROUTE_POLICY, dailyPlanMode: 'fixed_rules' };
      if (current) await tx.update(strategyMandates).set({ status: 'superseded', updatedAt: new Date() }).where(eq(strategyMandates.id, current.id));
      // Only old candidates are cancelled; concurrently researched other-market cycles retain their lease.
      await cancelInvestmentCandidates(tx, owner, account.id, 'Current AI plan replaced; candidates require fresh identity', false);
      await tx.update(strategyPlans).set({ status: 'superseded' }).where(and(eq(strategyPlans.owner, owner), eq(strategyPlans.accountId, account.id), eq(strategyPlans.status, 'active')));
      const [mandate] = await tx.insert(strategyMandates).values({ owner, accountId: account.id, profileId, profileVersion: profile.version,
        parentPolicyId: policy.id, parentPolicyRevision: policy.revision, cycleId, parentId: current?.id, version: (current?.version ?? 0) + 1, status: 'published', config, publishedAt: new Date() }).returning();
      await tx.update(builderProfiles).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.status, 'active'), ne(builderProfiles.id, profileId)));
      await tx.update(builderProfiles).set({ status: 'active', updatedAt: new Date() }).where(eq(builderProfiles.id, profileId));
      await tx.update(investmentCycles).set({ state: 'completed', mandateId: mandate.id, result: { ...cycle.result, ruleCount: incoming.length }, updatedAt: new Date() }).where(eq(investmentCycles.id, cycleId));
      for (const ref of references) await this.documents.recordStrategyUseInTransaction(tx, owner, ref.versionId, mandate.id);
      return mandate;
    });
  }
}
