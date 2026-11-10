import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { paperAccounts } from '../../database/schema';
import { StrategyService } from './strategy.service';
import { StrategyNotificationsService } from './strategy-notifications.service';
import { PaperTradingService } from './paper-trading.service';

/** Wakes pre-open as well as in session. Deterministic checks decide whether any paid work is due. */
@Injectable()
export class StrategyScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StrategyScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly jobs = new Set<Promise<void>>();
  private readonly valuations = new Map<string, number>();
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly strategy: StrategyService, private readonly notifications: StrategyNotificationsService,
    @Optional() private readonly paper?: PaperTradingService) {}
  onModuleInit(): void {
    if (process.env.PAPER_TRADING_ENABLED === 'false') return;
    this.timer = setInterval(() => { void this.tick().catch(() => this.logger.warn('Strategy scheduler check failed')); }, 30000);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.db.select({ owner: paperAccounts.owner, accountId: paperAccounts.id, botEnabled: paperAccounts.botEnabled })
        .from(paperAccounts).where(eq(paperAccounts.isActive, true));
      for (const row of rows) {
        // Valuation continues for paused accounts and never dispatches research or orders.
        const key = `${row.owner}:${row.accountId}`;
        if (this.paper && Date.now() - (this.valuations.get(key) ?? 0) >= 15 * 60_000) {
          this.valuations.set(key, Date.now());
          const valuation = this.paper.ensureDailySnapshot(row.owner, row.accountId)
            .catch(() => { this.logger.warn('Account valuation waiting for verified market data'); });
          this.jobs.add(valuation);
          void valuation.finally(() => this.jobs.delete(valuation));
        }
        if (!row.botEnabled) continue;
        const job = this.strategy.tick(row.owner, row.accountId).then(() => undefined)
          .catch(() => { this.logger.warn('Automatic strategy waiting after failed check'); });
        this.jobs.add(job);
        void job.finally(() => this.jobs.delete(job));
      }
      await this.notifications.tick();
    } finally { this.running = false; }
  }
}
