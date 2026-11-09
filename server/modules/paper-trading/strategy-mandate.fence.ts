import { BadRequestException } from '@nestjs/common';
import { and, eq, gte, inArray, or } from 'drizzle-orm';
import type { MemoryFenceTransaction } from '../research-memory/research-memory.fence';
import { strategyMandates, strategyRouteReviews, strategyReservations } from '../../database/strategy-mandates.schema';
import { strategySignals } from '../../database/strategy.schema';
import { paperOrders, paperPositions, paperTrades, paperAccounts } from '../../database/schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { routeStrategyCandidate } from './strategy-route.rules';
import type { StrategyCandidate, StrategyRule } from '../../../shared/strategy.interface';
import type { StrategyMandateInput } from '../../../shared/strategy-mandate.interface';
import type { TradingMarketSnapshot } from '../../../shared/trading-market.interface';
import { investorTargetQuantity } from './user-strategy-runtime';
import { executionEconomics } from './simulation-experiments.rules';
import { measuredLiquidityRisk } from './strategy-liquidity.rules';
import { councilReports } from '../../database/council.schema';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import type { PostgresJsDatabase } from '../../common/platform';
import { paperRiskDay } from './paper-risk-day';
import type { AutonomousMandateRule } from '../../../shared/investment-policy.interface';
import { investorAllocationBlock } from './strategy-allocation';
import type { PortfolioRiskSnapshot } from './strategy-portfolio-risk';

/** Recomputed under the paper account lock, including other still-live candidates. */
export async function mandateExposure(tx: MemoryFenceTransaction, owner: string, accountId: string,
  candidate: StrategyCandidate, config: StrategyMandateInput, equityUsd: number, unitUsd: number, now = new Date()) {
  const [position] = await tx.select().from(paperPositions).where(and(eq(paperPositions.owner, owner),
    eq(paperPositions.accountId, accountId), eq(paperPositions.ticker, candidate.ticker)));
  const recent = await tx.select().from(paperOrders).where(and(eq(paperOrders.owner, owner),
    eq(paperOrders.accountId, accountId), or(gte(paperOrders.filledAt, new Date(now.getTime() - 48 * 3600000)),
      gte(paperOrders.createdAt, new Date(now.getTime() - 48 * 3600000)), eq(paperOrders.status, 'pending_approval'))));
  const signals = await tx.select().from(strategySignals).where(and(eq(strategySignals.owner, owner),
    inArray(strategySignals.state, ['reviewing', 'approved']), gte(strategySignals.createdAt,
      new Date(now.getTime() - config.routePolicy.candidateTtlSeconds * 1000))));
  const pending = signals.filter(s => s.id !== candidate.signalId && s.candidate.accountId === accountId && s.candidate.side === 'buy');
  const currentPending = pending.filter(s => s.candidate.ticker === candidate.ticker)
    .reduce((sum, s) => sum + s.candidate.quantity * unitUsd, 0);
  const pendingTotalBuyUsd = pending.reduce((sum, s) => sum + (s.candidate.notionalUsd
    ?? (s.candidate.ticker === candidate.ticker ? s.candidate.quantity * unitUsd
      : s.candidate.market === 'US' ? s.candidate.quantity * s.candidate.price : Infinity)), 0);
  const orderValue = (order: typeof recent[number]) => Number((order.riskCheck as { notionalUsd?: number } | null)?.notionalUsd ?? 0);
  const filled = recent.filter(o => o.status === 'filled' || o.status === 'pending_approval');
  const rolling = filled.filter(o => o.side === 'buy' && (o.filledAt ?? o.createdAt).getTime() >= now.getTime() - config.routePolicy.rollingWindowMinutes * 60000)
    .reduce((sum, o) => sum + orderValue(o), 0);
  const businessDate = (date: Date) => paperRiskDay(date, config.timezone);
  const daily = filled.filter(o => o.status === 'pending_approval' || businessDate(o.filledAt ?? o.createdAt) === businessDate(now));
  const dailyBuys = daily.filter(o => o.side === 'buy').reduce((sum, o) => sum + orderValue(o), 0);
  const dailyTurnover = daily.reduce((sum, o) => sum + orderValue(o), 0);
  return { currentExposureUsd: Number(position?.shares ?? 0) * unitUsd, pendingBuyUsd: currentPending, pendingTotalBuyUsd,
    rollingBuyUsd: rolling, dailyBuys, dailyTurnover, equityUsd, candidateNotionalUsd: candidate.quantity * unitUsd };
}

/** Caller holds the shared owner fence and paper-account lock. It cannot be replaced by an AI approval. */
export async function assertMandateExecution(tx: MemoryFenceTransaction, owner: string, accountId: string,
  candidate: StrategyCandidate, rule: StrategyRule, equityUsd: number, unitUsd: number, now = new Date(), snapshot?: TradingMarketSnapshot,
  portfolioRisk?: { hardBlock: string | null; councilReason: string | null }, portfolio?: PortfolioRiskSnapshot): Promise<void> {
  if (candidate.accountId && candidate.accountId !== accountId) throw new BadRequestException('Strategy account changed');
  if (candidate.protectiveStop || !candidate.mandateId) return;
  const [reservation] = await tx.select().from(strategyReservations).where(and(eq(strategyReservations.owner, owner),
    eq(strategyReservations.signalId, candidate.signalId), eq(strategyReservations.accountId, accountId))).for('share');
  if (!reservation || reservation.status !== 'active' || reservation.expiresAt <= now) {
    throw new BadRequestException('Candidate reservation expired or was released');
  }
  const [mandate] = await tx.select().from(strategyMandates).where(and(eq(strategyMandates.owner, owner),
    eq(strategyMandates.id, candidate.mandateId))).for('share');
  if (!mandate || mandate.accountId !== accountId || mandate.version !== candidate.mandateVersion || mandate.status !== 'published'
    || now.getTime() < Date.parse(mandate.config.startsAt) || now.getTime() >= Date.parse(mandate.config.endsAt)
    || now.getTime() - Date.parse(candidate.quoteAt) > mandate.config.routePolicy.candidateTtlSeconds * 1000) {
    throw new BadRequestException('Mandate is expired, paused, superseded or belongs to another account');
  }
  const config = mandate.config;
  if (portfolioRisk?.hardBlock) throw new BadRequestException(portfolioRisk.hardBlock);
  if (rule.userStrategyId && rule.allocationPct !== undefined && candidate.side === 'buy') {
    if (!portfolio) throw new BadRequestException('PORTFOLIO_ALLOCATION_VALUATION_REQUIRED');
    const budgetBlock = await investorAllocationBlock(tx, owner, accountId, candidate, config, portfolio, now);
    if (budgetBlock) throw new BadRequestException(budgetBlock);
  }
  if (candidate.side === 'buy') await new ResearchDocumentsService(tx as PostgresJsDatabase)
    .assertExecutionSourcesInTransaction(tx, owner, config.references.filter(ref => rule.evidenceIds.includes(ref.versionId)), now);
  const authorized = config.rules.find(r => r.id === rule.id);
  if (!authorized || authorized.ticker !== candidate.ticker || authorized.side !== candidate.side
    || rule.maxPositionPct > authorized.maxPositionPct || rule.minPrice < authorized.minPrice || rule.maxPrice > authorized.maxPrice
    || rule.dailySuspended || rule.stopLossPrice < authorized.stopLossPrice || Date.parse(rule.expiresAt) > Date.parse(authorized.expiresAt)
    || JSON.stringify(rule.trigger) !== JSON.stringify(authorized.trigger)) throw new BadRequestException('Rule exceeds the published mandate');
  const versions = await tx.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner),
    inArray(researchDocumentVersions.id, rule.evidenceIds))).for('share');
  if (candidate.side === 'buy' && (versions.length !== new Set(rule.evidenceIds).size
    || versions.some(v => v.revokedAt || (v.availableAt ?? v.createdAt).getTime() > now.getTime()))) {
    throw new BadRequestException('Referenced research was revoked, missing or unavailable at the decision time');
  }
  if (authorized.userDirective?.positionPct !== undefined) {
    const [position] = await tx.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, accountId), eq(paperPositions.ticker, candidate.ticker)));
    const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
    if (!snapshot?.price || !account) throw new BadRequestException('Target exposure requires verified current valuation');
    const execution = executionEconomics(snapshot.price, 1, candidate.side, account.executionModel?.feeBps ?? 0, account.executionModel?.slippageBps ?? 0);
    const maximum = investorTargetQuantity({ ticker: candidate.ticker, market: candidate.market, side: candidate.side, heldShares: Number(position?.shares ?? 0), equityUsd, price: snapshot.price, fx: unitUsd / execution.price, positionPct: authorized.userDirective.positionPct, feeBps: account.executionModel?.feeBps, slippageBps: account.executionModel?.slippageBps, lotSize: snapshot.lotSize });
    if (candidate.quantity > maximum) throw new BadRequestException('Order exceeds the confirmed total target exposure');
  }
  const exposure = await mandateExposure(tx, owner, accountId, candidate, config, equityUsd, unitUsd, now);
  if (candidate.side === 'buy' && (exposure.dailyBuys + exposure.pendingTotalBuyUsd + exposure.candidateNotionalUsd) / equityUsd * 100 > config.limits.maxDailyIncreasePct + 1e-8) {
    throw new BadRequestException('Mandate daily increase limit exceeded');
  }
  if (!Number.isFinite(equityUsd) || equityUsd <= 0
    || (exposure.dailyTurnover + exposure.pendingTotalBuyUsd + exposure.candidateNotionalUsd) / equityUsd * 100 > config.limits.maxDailyTurnoverPct + 1e-8) {
    throw new BadRequestException('Mandate daily turnover limit exceeded');
  }
  const councilIds = versions.flatMap(version => version.source?.type === 'council' ? [version.source.id] : []);
  const [priorTrade] = candidate.parentPolicyId && candidate.side === 'buy' ? await tx.select({ id: paperTrades.id }).from(paperTrades).where(and(eq(paperTrades.owner, owner), eq(paperTrades.accountId, accountId), eq(paperTrades.ticker, candidate.ticker))).limit(1) : [];
  const requiresFirstBuyCouncil = Boolean((authorized as AutonomousMandateRule).requiresIndependentReview && !priorTrade);
  const reports = councilIds.length ? await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), inArray(councilReports.id, councilIds))).for('share') : [];
  const required = routeStrategyCandidate({ ...exposure, hardBlock: null, side: candidate.side, protectiveStop: false,
    deterministic: authorized.reviewMode !== 'ai', semanticCondition: authorized.semanticCondition ?? '',
    conflict: requiresFirstBuyCouncil || Boolean(portfolioRisk?.councilReason) || reports.some(report => report.dissent.length > 0),
    liquidityRisk: measuredLiquidityRisk(snapshot, candidate.quantity + (exposure.pendingBuyUsd + exposure.rollingBuyUsd) / unitUsd),
    hardPositionCapPct: Math.min(config.limits.maxPositionPct, rule.maxPositionPct), policy: config.routePolicy });
  const [review] = await tx.select().from(strategyRouteReviews).where(and(eq(strategyRouteReviews.owner, owner),
    eq(strategyRouteReviews.signalId, candidate.signalId)));
  const rank = { blocked: 99, direct: 0, ai: 1, council: 2 };
  if (!review || review.accountId !== accountId || required.route === 'blocked'
    || rank[review.decision.route] < rank[required.route]
    || required.route === 'council' && !review.councilReportId) {
    throw new BadRequestException('Exposure or review route changed; create a new reviewed candidate');
  }
}
