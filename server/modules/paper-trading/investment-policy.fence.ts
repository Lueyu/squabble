import { and, eq } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { paperAccounts, paperTrades, paperPositions } from '../../database/schema';
import { strategyMandates, strategyRouteReviews } from '../../database/strategy-mandates.schema';
import { strategySignals } from '../../database/strategy.schema';
import { councilSessions } from '../../database/council.schema';
import { councilIndependentSubmissions } from '../../database/simple-council.schema';
import { simulationSeeds } from '../../database/simulation-experiments.schema';
import type { MemoryFenceTransaction } from '../research-memory/research-memory.fence';
import { expireInvestmentConstraints, type InvestmentTx, type PolicyRow } from './investment-policy.service';
import { investmentOrderBlock, investmentSecurityKey } from './investment-policy.rules';
import type { StrategyCandidate } from '../../../shared/strategy.interface';
import type { AutonomousMandateInput } from '../../../shared/investment-policy.interface';

/** Runs after owner/account lock, before every automatic execution including protective/MCP/pending approvals.
 * Return a block instead of throwing so expiry invalidation can commit with the rejected execution. */
export async function investmentExecutionFence(tx: MemoryFenceTransaction, owner: string, accountId: string,
  order: { ticker: string; side: string; market: string }, source: string, candidate?: StrategyCandidate,
  now = new Date(), reviewComplete = true): Promise<{ policy: PolicyRow | null; block: string | null }> {
  const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
  if (!account?.isActive) return { policy: null, block: 'INVESTMENT_ARCHIVED_ACCOUNT' };
  const [found] = await tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId))).for('update');
  if (!found) return { policy: null, block: null };
  if (source === 'manual') return { policy: found, block: 'USER_STRATEGY_CONFIRMED_SCOPE_REQUIRED' };
  const policy = await expireInvestmentConstraints(tx as InvestmentTx, found, now);
  if (policy.status !== 'running' || !account.botEnabled) return { policy, block: 'INVESTMENT_PAUSED' };
  if (!candidate || candidate.parentPolicyId !== policy.id || candidate.parentPolicyRevision !== policy.revision) return { policy, block: 'INVESTMENT_AUTHORIZATION_CHANGED' };
  const block = investmentOrderBlock(policy.effectiveConfig, { ...order, protectiveStop: candidate.protectiveStop });
  if (block) return { policy, block };
  const investor = policy.baseConfig.userStrategy;
  if (candidate.protectiveStop) return { policy, block: investor && !investor.preview.directives.some(d => d.entryId === candidate.ruleId && d.ticker === order.ticker && d.stopLossPrice
    && now.getTime() >= Date.parse(investor.content.startsAt) && now.getTime() < Date.parse(investor.content.endsAt)
    && now.getTime() >= Date.parse(d.startsAt) && now.getTime() < Date.parse(d.endsAt)) ? 'USER_STRATEGY_PROTECTION_NOT_AUTHORIZED' : null };
  const [mandate] = candidate.mandateId ? await tx.select().from(strategyMandates).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.id, candidate.mandateId))).for('share') : [];
  const config = mandate?.config as AutonomousMandateInput | undefined;
  if (!config || config.parentPolicyId !== policy.id || config.parentPolicyRevision !== policy.revision) return { policy, block: 'INVESTMENT_PARENT_BINDING_REQUIRED' };
  const rule = config.rules.find(r => r.id === candidate.ruleId);
  if (investor) {
    const directive = investor.preview.directives.find(d => d.entryId === candidate.ruleId);
    if (config.userStrategyId !== investor.id || config.userStrategyRevision !== investor.revision || candidate.userStrategyId !== investor.id || candidate.userStrategyRevision !== investor.revision
      || !rule || !directive || JSON.stringify(rule.userDirective) !== JSON.stringify(directive) || directive.ticker !== order.ticker || directive.side !== order.side
      || now.getTime() < Date.parse(directive.startsAt) || now.getTime() >= Date.parse(directive.endsAt)
      || directive.quantity !== undefined && candidate.quantity > directive.quantity) return { policy, block: 'USER_STRATEGY_SCOPE_OR_PERIOD_CHANGED' };
    const filled = await tx.select().from(strategySignals).where(and(eq(strategySignals.owner, owner), eq(strategySignals.state, 'filled'), eq(strategySignals.ruleId, directive.entryId)));
    if (filled.some(signal => signal.candidate.accountId === accountId && signal.candidate.userStrategyId === investor.id)) return { policy, block: 'USER_STRATEGY_ENTRY_ALREADY_EXECUTED' };
    if (!rule.security || rule.security.market !== order.market || rule.security.ticker !== order.ticker || rule.security.leveraged !== false || rule.security.inverse !== false
      || !policy.effectiveConfig.assetTypes.includes(rule.security.assetType) || now.getTime() - Date.parse(rule.security.observedAt) > 24 * 3600000) return { policy, block: 'WAITING_VERIFIED_SECURITY' };
    if (reviewComplete && order.side === 'buy' && !policy.baseConfig.initialTickers?.some(ticker => investmentSecurityKey(ticker) === investmentSecurityKey(order.ticker))) {
      const [trade] = await tx.select().from(paperTrades).where(and(eq(paperTrades.owner, owner), eq(paperTrades.accountId, accountId), eq(paperTrades.ticker, order.ticker))).limit(1);
      if (!trade) {
        const [review] = await tx.select().from(strategyRouteReviews).where(and(eq(strategyRouteReviews.owner, owner), eq(strategyRouteReviews.signalId, candidate.signalId)));
        const [session] = review?.councilSessionId && review.councilReportId ? await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, review.councilSessionId))) : [];
        const completed = session?.status === 'completed' && session.checkpoint?.simple ? await tx.select().from(councilIndependentSubmissions).where(and(eq(councilIndependentSubmissions.owner, owner), eq(councilIndependentSubmissions.sessionId, session.id), eq(councilIndependentSubmissions.cycleId, session.checkpoint.cycleId))) : [];
        const identities = completed.filter(submission => submission.releasedAt && submission.executorIdentity.identityVerified === true).map(submission => submission.executorIdentity.identity);
        if (new Set(identities).size < 2) return { policy, block: 'INVESTMENT_INDEPENDENT_REVIEW_REQUIRED' };
      }
    }
    return { policy, block: null };
  }

  if (!rule || rule.market !== order.market || rule.security?.ticker !== order.ticker || Date.parse(rule.validUntil) <= now.getTime()
    || !policy.effectiveConfig.assetTypes.includes(rule.security.assetType) || rule.security.leveraged !== false || rule.security.inverse !== false) return { policy, block: 'INVESTMENT_SECURITY_OR_RULE_INVALID' };
  if (order.side === 'buy') {
    const prior = await tx.select({ ticker: paperTrades.ticker }).from(paperTrades).where(and(eq(paperTrades.owner, owner), eq(paperTrades.accountId, accountId)));
    const [seed] = await tx.select().from(simulationSeeds).where(and(eq(simulationSeeds.owner, owner), eq(simulationSeeds.accountId, accountId)));
    const same = (ticker: string) => investmentSecurityKey(ticker) === investmentSecurityKey(order.ticker);
    const startingSecurity = seed?.seed.positions.some(p => same(p.ticker)) || policy.baseConfig.initialTickers?.some(same);
    if (!prior.some(p => same(p.ticker)) && !startingSecurity && new Set(rule.executorIdentities).size < 2) return { policy, block: 'INVESTMENT_INDEPENDENT_REVIEW_REQUIRED' };
    const positions = await tx.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, accountId)));
    if (positions.some(p => Number(p.shares) > 0 && p.ticker !== order.ticker && same(p.ticker))) return { policy, block: 'INVESTMENT_SECURITY_ALIAS_REQUIRES_RECONCILIATION' };
  }
  return { policy, block: null };
}

/** Existing Builder/experiment write paths must not reactivate a migrated account. */
export async function assertLegacyInvestmentWrite(tx: Pick<MemoryFenceTransaction, 'select'>, owner: string, accountId?: string): Promise<void> {
  const policies = await tx.select().from(investmentPolicies).where(eq(investmentPolicies.owner, owner));
  if (policies.some(p => !accountId || p.accountId === accountId)) throw new BadRequestException('INVESTMENT_MANAGED_ACCOUNT_USE_AI_INVESTMENT');
}
