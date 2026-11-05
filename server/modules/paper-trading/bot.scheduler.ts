/**
 * @file server/modules/paper-trading/bot.scheduler.ts
 * @description Around-the-clock bot scheduler.
 *
 * Every PAPER_TRADING_SCAN_MINUTES (default 15) minutes the scheduler wakes,
 * checks whether at least one market is in its continuous session, and runs
 * one bot scan for every account with the bot enabled. Each scan derives
 * signals from that user's own analysis ratings, passes them through the
 * guardrails, fills what survives, records an event, and takes the daily
 * equity snapshot.
 *
 * Disable entirely with PAPER_TRADING_ENABLED=false. A scan failure for one
 * account never stops the others (or the timer).
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { paperAccounts, builderProfiles } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { anyMarketOpen } from '../../common/market-clock';
import { PaperTradingService } from './paper-trading.service';

/** Default minutes between scans. */
const DEFAULT_SCAN_MINUTES = 15;

@Injectable()
export class BotScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PaperBot');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly paper: PaperTradingService,
  ) {}

  /** Start the interval unless paper trading is disabled by env. */
  onModuleInit(): void {
    if (process.env.PAPER_TRADING_ENABLED === 'false') {
      this.logger.log('paper trading scheduler disabled (PAPER_TRADING_ENABLED=false)');
      return;
    }
    const minutes = Math.max(1, Number(process.env.PAPER_TRADING_SCAN_MINUTES ?? DEFAULT_SCAN_MINUTES));
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.warn(`scan tick failed: ${String(error)}`));
    }, minutes * 60 * 1000);
    // Unref so the timer never keeps the process alive on its own.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log(`paper trading scheduler started (every ${minutes} min)`);
  }

  /** Clear the interval on shutdown. */
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One scheduler tick: skip when all markets are closed, else scan bots. */
  private async tick(): Promise<void> {
    if (!anyMarketOpen()) return;
    const accounts = await this.db
      .select()
      .from(paperAccounts)
      .where(and(eq(paperAccounts.botEnabled, true), eq(paperAccounts.isActive, true)));
    for (const account of accounts) {
      try {
        const [policy] = await this.db.select({ id: investmentPolicies.id }).from(investmentPolicies).where(eq(investmentPolicies.accountId, account.id));
        if (policy) continue;
        const profiles = await this.db.select().from(builderProfiles).where(eq(builderProfiles.owner, account.owner));
        if (profiles.some((item) => item.status === 'active'
          && (item.config as { automation?: { enabled: boolean } }).automation?.enabled)) continue;
        await this.paper.runBotScan(account.owner, account.id);
      } catch (error) {
        this.logger.warn(`bot scan failed for account ${account.id}: ${String(error)}`);
      }
    }
  }
}
