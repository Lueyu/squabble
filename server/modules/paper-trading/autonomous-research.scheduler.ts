import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AutonomousResearchService } from './autonomous-research.service';

@Injectable()
export class AutonomousResearchScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly jobs = new Map<string, Promise<void>>();
  private scanning = false;
  private readonly logger = new Logger(AutonomousResearchScheduler.name);
  constructor(private readonly research: AutonomousResearchService) {}
  onModuleInit() {
    if (process.env.PAPER_TRADING_ENABLED === 'false' || process.env.SQUABBLE_SIMPLE_EXPERIENCE !== 'true') return;
    this.timer = setInterval(() => { void this.tick().catch(() => this.logger.warn('Autonomous investment scheduler waiting')); }, 30000); this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async tick() {
    if (this.scanning || process.env.SQUABBLE_SIMPLE_EXPERIENCE !== 'true') return;
    this.scanning = true;
    try {
      await this.research.queueCurrentMarkets();
      for (const cycle of await this.research.queued()) {
        if (this.jobs.size >= 3) break;
        if (this.jobs.has(cycle.id)) continue;
        const job = this.research.runCycle(cycle.owner, cycle.id).finally(() => { this.jobs.delete(cycle.id); });
        this.jobs.set(cycle.id, job); void job.catch(() => this.logger.warn('Autonomous investment cycle waiting'));
      }
    } finally { this.scanning = false; }
  }
}
