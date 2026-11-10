import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { paperAccounts, paperOrders, paperSnapshots, paperTrades } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { portfolioAccountCompanions } from '../../database/portfolio-workspace.schema';
import { paperRiskTimezone } from '../paper-trading/paper-risk-day';
import { capturePortfolioDailyFacts } from '../research-documents/portfolio-daily-facts';
import { CurrentResearchService } from './current-research.service';
import { dailyAccountFacts, dailyDate } from './daily-workspace.rules';
import type { DailyWorkspaceView } from '../../../shared/daily-workspace.interface';

/** Reading this workspace never refreshes prices, schedules research, or writes a valuation. */
@Injectable()
export class DailyWorkspaceService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly research: CurrentResearchService) {}

  async read(owner: string, input?: string): Promise<DailyWorkspaceView> {
    if (!owner?.trim()) throw new UnauthorizedException();
    const date = dailyDate(input), readAt = new Date().toISOString();
    const previousDate = new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const facts = await this.db.transaction(async tx => {
      const [accounts, trades, orders, snapshots, personal, companions] = await Promise.all([
        tx.select({ account: paperAccounts, policy: investmentPolicies }).from(paperAccounts)
          .leftJoin(investmentPolicies, and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, paperAccounts.id)))
          .where(and(eq(paperAccounts.owner, owner), sql`${paperAccounts.createdAt} < (${date}::date + interval '1 day') AT TIME ZONE 'Asia/Shanghai'`)).orderBy(asc(paperAccounts.createdAt), paperAccounts.id),
        tx.select({ trade: paperTrades, currency: paperOrders.currency }).from(paperTrades)
          .leftJoin(paperOrders, and(eq(paperOrders.owner, owner), eq(paperOrders.id, paperTrades.orderId), eq(paperOrders.accountId, paperTrades.accountId)))
          .where(and(eq(paperTrades.owner, owner), sql`(${paperTrades.createdAt} AT TIME ZONE 'Asia/Shanghai')::date = ${date}::date`)).orderBy(asc(paperTrades.createdAt), paperTrades.id),
        tx.select().from(paperOrders).where(and(eq(paperOrders.owner, owner), sql`(${paperOrders.createdAt} AT TIME ZONE 'Asia/Shanghai')::date = ${date}::date`)).orderBy(asc(paperOrders.createdAt), paperOrders.id),
        tx.select().from(paperSnapshots).where(and(eq(paperSnapshots.owner, owner), inArray(paperSnapshots.snapshotDate, [previousDate, date]))),
        capturePortfolioDailyFacts(tx, owner, new Date(`${date}T12:00:00Z`), 'zh-CN'),
        tx.select().from(portfolioAccountCompanions).where(eq(portfolioAccountCompanions.owner, owner)),
      ]);
      const accountFacts = await Promise.all(accounts.map(async ({ account, policy }) => {
        const valuationTimezone = await paperRiskTimezone(tx, owner, account.id);
        const result = dailyAccountFacts({
        id: account.id, name: account.name, status: !account.isActive ? 'archived' : policy?.status ?? 'not_started',
      }, date, snapshots.filter(row => row.accountId === account.id),
      trades.filter(row => row.trade.accountId === account.id).map(row => ({ ...row.trade, currency: row.currency })),
      orders.filter(row => row.accountId === account.id));
        if (valuationTimezone !== 'Asia/Shanghai') {
          result.dailyPnlUsd = null;
          result.gaps.push('VALUATION_DAY_DIFFERS');
        }
        return { ...result, valuationTimezone, companionId: companions.find(item => item.accountId === account.id)?.companionId ?? null };
      }));
      return { personal: { ...personal, capturedAt: readAt }, accounts: accountFacts };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    return { date, timezone: 'Asia/Shanghai', readAt, ...facts, reports: await this.research.getDailyReports(owner, date) };
  }
}
