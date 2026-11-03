import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { builderProfiles, paperAccounts } from '../../database/schema';
import type { BuilderConfig } from '../../../shared/api.interface';
import { StrategyService } from './strategy.service';
import { StrategyNotificationsService } from './strategy-notifications.service';

/** Wakes pre-open as well as in session. Deterministic checks decide whether any paid work is due. */
@Injectable()
export class StrategyScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StrategyScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly strategy: StrategyService, private readonly notifications: StrategyNotificationsService) {}
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
      const rows = await this.db.select({ owner: builderProfiles.owner, config: builderProfiles.config }).from(builderProfiles)
        .innerJoin(paperAccounts, eq(builderProfiles.owner, paperAccounts.owner))
        .where(and(eq(builderProfiles.status, 'active'), eq(paperAccounts.botEnabled, true)));
      for (const row of rows) if ((row.config as BuilderConfig).automation?.enabled) {
        try { await this.strategy.tick(row.owner); }
        catch { this.logger.warn('Automatic strategy waiting after failed check'); }
      }
      await this.notifications.tick();
    } finally { this.running = false; }
  }
}
