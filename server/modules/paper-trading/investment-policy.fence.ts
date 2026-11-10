import { and, eq, isNull } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { investorAssignments, investorRuleId, investorSnapshotHash } from './user-strategy-runtime';
import { investorEntryFrequencyBlock } from './user-strategy-frequency';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import type { PostgresJsDatabase } from '../../common/platform';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { paperAccounts, paperTrades, paperPositions } from '../../database/schema';
import { strategyMandates, strategyRouteReviews } from '../../database/strategy-mandates.schema';
import { councilMessages, councilSessions } from '../../database/council.schema';
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
  const assignments = investorAssignments(policy.baseConfig);
  const assignment = assignments.find(item => item.enabled && item.strategyId === candidate.userStrategyId
    && item.strategyRevision === candidate.userStrategyRevision);
  const investor = assignment?.snapshot;
  if (assignments.length && !investor) return { policy, block: 'USER_STRATEGY_ASSIGNMENT_CHANGED' };
  if (candidate.protectiveStop && !assignments.length) return { policy, block: null };
  const [mandate] = candidate.mandateId ? await tx.select().from(strategyMandates).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.id, candidate.mandateId))).for('share') : [];
  const config = mandate?.config as AutonomousMandateInput | undefined;
  if (!config || mandate?.status !== 'published' || mandate.accountId !== accountId || candidate.accountId !== accountId
    || mandate.version !== candidate.mandateVersion || config.parentPolicyId !== policy.id || config.parentPolicyRevision !== policy.revision) return { policy, block: 'INVESTMENT_PARENT_BINDING_REQUIRED' };
  const rule = config.rules.find(r => r.id === candidate.ruleId);
  if (investor) {
    const entryId = candidate.userEntryId ?? rule?.userEntryId ?? rule?.userDirective?.entryId ?? candidate.ruleId;
    const directive = investor.preview.directives.find(d => d.entryId === entryId);
    const expectedRuleId = investorRuleId(investor.id, entryId);
    if (!rule || !directive || rule.userStrategyId !== investor.id || rule.userStrategyRevision !== investor.revision
      || candidate.ruleId !== expectedRuleId && candidate.ruleId !== directive.entryId
      || candidate.userStrategySnapshotHash && candidate.userStrategySnapshotHash !== investorSnapshotHash(investor)
      || rule.userStrategySnapshotHash && rule.userStrategySnapshotHash !== investorSnapshotHash(investor)
      || rule.allocationPct !== undefined && rule.allocationPct !== assignment!.allocationPct
      || JSON.stringify(rule.userDirective) !== JSON.stringify(directive) || directive.ticker !== order.ticker
      || !candidate.protectiveStop && directive.side !== order.side
      || now.getTime() < Date.parse(investor.content.startsAt) || now.getTime() >= Date.parse(investor.content.endsAt)
      || now.getTime() < Date.parse(directive.startsAt) || now.getTime() >= Date.parse(directive.endsAt)
      || !candidate.protectiveStop && directive.quantity !== undefined && candidate.quantity > directive.quantity) {
      return { policy, block: candidate.protectiveStop ? 'USER_STRATEGY_PROTECTION_NOT_AUTHORIZED' : 'USER_STRATEGY_SCOPE_OR_PERIOD_CHANGED' };
    }
    try {
      const sources = investor.sources.filter(item => directive.sourceKeys.includes(item.key));
      await new ResearchDocumentsService(tx as PostgresJsDatabase).assertExecutionSourcesInTransaction(tx, owner,
        sources.filter(item => item.versionId).map(item => ({ versionId: item.versionId!, ...(item.sectionId ? { sectionId: item.sectionId } : {}) })), now);
      for (const source of sources.filter(item => item.kind === 'message')) {
        const [sourceRow] = await tx.select({ message: councilMessages }).from(councilMessages)
          .innerJoin(councilSessions, and(eq(councilSessions.owner, owner), eq(councilSessions.id, councilMessages.sessionId), isNull(councilSessions.deletedAt)))
          .where(and(eq(councilMessages.owner, owner), eq(councilMessages.id, source.messageId!))).for('share');
        const message = sourceRow?.message;
        const content = message?.metadata?.response ? JSON.stringify({ content: message.content, response: message.metadata.response }) : message?.content;
        if (!content || createHash('sha256').update(content).digest('hex') !== source.contentHash) return { policy, block: 'USER_STRATEGY_SOURCE_CHANGED' };
      }
    } catch { return { policy, block: 'USER_STRATEGY_SOURCE_CHANGED' }; }
    if (candidate.protectiveStop) return { policy, block: directive.stopLossPrice && order.side === 'sell' ? null : 'USER_STRATEGY_PROTECTION_NOT_AUTHORIZED' };
    const frequencyBlock = await investorEntryFrequencyBlock(tx, owner, accountId, investor.id, directive, candidate, now);
    if (frequencyBlock) return { policy, block: frequencyBlock };
    if (!rule.security || rule.security.market !== order.market || rule.security.ticker !== order.ticker || rule.security.leveraged !== false || rule.security.inverse !== false
      || !policy.effectiveConfig.assetTypes.includes(rule.security.assetType) || now.getTime() - Date.parse(rule.security.observedAt) > 24 * 3600000) return { policy, block: 'WAITING_VERIFIED_SECURITY' };
    if (reviewComplete && order.side === 'buy' && !policy.baseConfig.initialTickers?.some(ticker => investmentSecurityKey(ticker) === investmentSecurityKey(order.ticker))) {
      const [trade] = await tx.select().from(paperTrades).where(and(eq(paperTrades.owner, owner), eq(paperTrades.accountId, accountId), eq(paperTrades.ticker, order.ticker))).limit(1);
      if (!trade) {
        const [review] = await tx.select().from(strategyRouteReviews).where(and(eq(strategyRouteReviews.owner, owner), eq(strategyRouteReviews.signalId, candidate.signalId)));
        const [session] = review?.councilSessionId && review.councilReportId ? await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, review.councilSessionId), isNull(councilSessions.deletedAt))).for('share') : [];
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
