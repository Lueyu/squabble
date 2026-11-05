import { and, eq } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { paperAccounts, paperTrades, paperPositions } from '../../database/schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
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
  now = new Date()): Promise<{ policy: PolicyRow | null; block: string | null }> {
  const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
  if (!account?.isActive) return { policy: null, block: 'INVESTMENT_ARCHIVED_ACCOUNT' };
  const [found] = await tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId))).for('update');
  if (!found || source === 'manual') return { policy: found ?? null, block: null };
  const policy = await expireInvestmentConstraints(tx as InvestmentTx, found, now);
  if (policy.status !== 'running' || !account.botEnabled) return { policy, block: 'INVESTMENT_PAUSED' };
  if (!candidate || candidate.parentPolicyId !== policy.id || candidate.parentPolicyRevision !== policy.revision) return { policy, block: 'INVESTMENT_AUTHORIZATION_CHANGED' };
  const block = investmentOrderBlock(policy.effectiveConfig, { ...order, protectiveStop: candidate.protectiveStop });
  if (block) return { policy, block };
  if (candidate.protectiveStop) return { policy, block: null };
  const [mandate] = candidate.mandateId ? await tx.select().from(strategyMandates).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.id, candidate.mandateId))).for('share') : [];
  const config = mandate?.config as AutonomousMandateInput | undefined;
  if (!config || config.parentPolicyId !== policy.id || config.parentPolicyRevision !== policy.revision) return { policy, block: 'INVESTMENT_PARENT_BINDING_REQUIRED' };
  const rule = config.rules.find(r => r.id === candidate.ruleId);
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
