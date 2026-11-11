import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { paperAccounts, paperOrders, paperPositions, paperSnapshots, paperTrades } from '../../database/schema';
import { simulationCash } from '../../database/simulation-experiments.schema';
import type { PortfolioAccountAssets, PortfolioExecutionProvenance } from '../../../shared/portfolio-workspace.interface';
import type { PaperOrder, PaperTrade } from '../../../shared/api.interface';
import { teamCommissions, teamDecisions, teamResearchLinks, teamVersions } from '../../database/teams.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';

/** Audit identifiers remain readable when a source is unavailable; source content uses its original guarded reader. */
async function executionProvenance(tx: Pick<PostgresJsDatabase, 'select'>, owner: string, accountId: string,
  orderIds: string[], tradeIds: string[]): Promise<PortfolioExecutionProvenance[]> {
  const targets = [orderIds.length ? and(eq(teamResearchLinks.kind, 'order'), inArray(teamResearchLinks.targetId, orderIds)) : undefined,
    tradeIds.length ? and(eq(teamResearchLinks.kind, 'trade'), inArray(teamResearchLinks.targetId, tradeIds)) : undefined].filter(Boolean);
  if (!targets.length) return [];
  const rows = await tx.select({ link: teamResearchLinks,
    commission: { id: teamCommissions.id, teamVersionId: teamCommissions.teamVersionId },
    version: { id: teamVersions.id, displaySnapshot: teamVersions.displaySnapshot, version: teamVersions.version },
    decision: { id: teamDecisions.id, proposalId: teamDecisions.proposalId, proposalRevision: teamDecisions.proposalRevision,
      event: teamDecisions.event, reason: teamDecisions.reason, createdAt: teamDecisions.createdAt, basis: teamDecisions.basis },
    report: { id: researchDocumentVersions.id, deletedAt: researchDocumentVersions.deletedAt, revokedAt: researchDocumentVersions.revokedAt,
      availableAt: researchDocumentVersions.availableAt, dataAsOf: researchDocumentVersions.dataAsOf } }).from(teamResearchLinks)
    .innerJoin(teamCommissions, and(eq(teamCommissions.id, teamResearchLinks.commissionId),
      eq(teamCommissions.ownerId, owner), eq(teamCommissions.teamId, teamResearchLinks.teamId), eq(teamCommissions.accountId, accountId)))
    .leftJoin(teamVersions, and(eq(teamVersions.ownerId, owner), eq(teamVersions.teamId, teamResearchLinks.teamId),
      eq(teamVersions.id, teamCommissions.teamVersionId)))
    .leftJoin(teamDecisions, and(eq(teamDecisions.ownerId, owner), eq(teamDecisions.accountId, accountId),
      eq(teamDecisions.teamId, teamResearchLinks.teamId), eq(teamDecisions.commissionId, teamResearchLinks.commissionId),
      sql`${teamDecisions.id}::text = ${teamResearchLinks.metadata}->>'decisionId'`))
    .leftJoin(researchDocumentVersions, and(eq(researchDocumentVersions.owner, owner),
      sql`${researchDocumentVersions.id}::text = ${teamDecisions.basis}->>'reportVersionId'`))
    .where(and(eq(teamResearchLinks.ownerId, owner), eq(teamResearchLinks.relation, 'executed'), or(...targets)))
    .orderBy(teamResearchLinks.createdAt, teamResearchLinks.id);
  return rows.map(({ link, commission, version, decision, report }) => {
    const exactDecision = decision?.basis.teamVersionId === commission.teamVersionId && decision.basis.commissionId === commission.id
      && decision.basis.workKey === link.workKey && decision.basis.acceptedAttemptId === link.attemptId ? decision : null;
    return { kind: link.kind as 'order' | 'trade', targetId: link.targetId, teamId: link.teamId,
      teamName: version?.displaySnapshot.name ?? null, teamVersionId: commission.teamVersionId,
      teamVersion: version?.version ?? null, commissionId: commission.id, workKey: link.workKey, attemptId: link.attemptId,
      decision: exactDecision ? { id: exactDecision.id, proposalId: exactDecision.proposalId,
        proposalRevision: exactDecision.proposalRevision, event: exactDecision.event as NonNullable<PortfolioExecutionProvenance['decision']>['event'],
        reason: exactDecision.reason, createdAt: exactDecision.createdAt.toISOString(), basis: exactDecision.basis } : null,
      reportAvailability: !exactDecision?.basis.reportVersionId ? 'not_recorded'
        : report && !report.deletedAt && !report.revokedAt && report.availableAt && report.availableAt <= new Date()
          && (!report.dataAsOf || report.dataAsOf <= new Date()) ? 'available' : 'unavailable' };
  });
}

/** Account-scoped projection; intentionally independent from execution, settlement and NAV writers. */
@Injectable()
export class PortfolioAssetsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async read(owner: string, accountId: string): Promise<PortfolioAccountAssets> {
    if (!z.string().uuid().safeParse(accountId).success) throw new BadRequestException('INVALID_ACCOUNT_ID');
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const [account] = await tx.select().from(paperAccounts)
        .where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
      if (!account) throw new NotFoundException('ACCOUNT_NOT_FOUND');
      const [positions, cash, orders, trades, snapshots] = await Promise.all([
        tx.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, accountId))),
        tx.select().from(simulationCash).where(and(eq(simulationCash.owner, owner), eq(simulationCash.accountId, accountId))),
        tx.select().from(paperOrders).where(and(eq(paperOrders.owner, owner), eq(paperOrders.accountId, accountId)))
          .orderBy(desc(paperOrders.createdAt), paperOrders.id),
        tx.select().from(paperTrades).where(and(eq(paperTrades.owner, owner), eq(paperTrades.accountId, accountId)))
          .orderBy(desc(paperTrades.createdAt), paperTrades.id),
        tx.select().from(paperSnapshots).where(and(eq(paperSnapshots.owner, owner), eq(paperSnapshots.accountId, accountId)))
          .orderBy(desc(paperSnapshots.valuedAt), desc(paperSnapshots.snapshotDate)).limit(1),
      ]);
      const gaps = positions.map(position => `QUOTE_UNAVAILABLE:${position.ticker}`);
      const nativeCash = account.ledgerMode === 'native_currency';
      if (nativeCash && !cash.length) gaps.push('CASH_NOT_RECORDED');
      for (const item of cash) if (!item.availabilityKnown) gaps.push(`CASH_AVAILABILITY_UNKNOWN:${item.currency}`);
      return {
        accountId,
        positions: positions.map(position => {
          const knownCost = Number(position.avgCost) > 0;
          if (!knownCost) gaps.push(`COST_NOT_RECORDED:${position.ticker}`);
          return {
            id: position.id, ticker: position.ticker, company: position.company,
            market: position.market, currency: position.currency, shares: position.shares,
            avgCost: knownCost ? position.avgCost : null,
            currentPrice: null, priceAsOf: null, marketValue: null, unrealizedPl: null,
          };
        }),
        cash: nativeCash ? cash.map(item => ({
          currency: item.currency, availabilityKnown: item.availabilityKnown,
          available: item.availabilityKnown ? item.available : null,
          frozen: item.availabilityKnown ? item.frozen : null,
          unsettled: item.availabilityKnown ? item.unsettled : null,
        })) : [{ currency: account.baseCurrency, available: account.cashBalance, frozen: null, unsettled: null, availabilityKnown: true }],
        orders: orders.map(order => ({ ...order, createdAt: order.createdAt.toISOString(), filledAt: order.filledAt?.toISOString() ?? null })) as PaperOrder[],
        trades: trades.map(trade => ({ ...trade, createdAt: trade.createdAt.toISOString() })) as PaperTrade[],
        executionProvenance: await executionProvenance(tx, owner, accountId, orders.map(order => order.id), trades.map(trade => trade.id)),
        equityUsd: snapshots[0]?.equity ?? null,
        valuedAt: snapshots[0]?.valuedAt?.toISOString() ?? null,
        gaps,
      };
    });
  }
}
