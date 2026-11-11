import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { or, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { researchComputeJobs as jobs } from '../../database/research-compute.schema';
import { ComputeJobsService } from './compute-jobs.service';
import { E2bAdapter } from './e2b.adapter';
import { LocalContainerAdapter } from './local-container.adapter';

/** Bounded compensation destroys known resources; it can never create or execute a sandbox. */
@Injectable()
export class ComputeCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active = false;
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly jobs: ComputeJobsService, @Inject(E2bAdapter) private readonly sandbox: Pick<E2bAdapter, 'kill'>,
    @Optional() private readonly local?: LocalContainerAdapter) {}
  onModuleInit(): void {
    if (process.env.COMPUTE_CLEANUP_WORKER_ENABLED !== 'true') return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  async tick(): Promise<number> {
    if (this.active) return 0;
    this.active = true;
    try {
      const candidates = await this.db.select({ owner: jobs.owner }).from(jobs).where(or(
        sql`${jobs.retentionUntil} <= now() and ${jobs.inputEnc} <> ''`,
        sql`${jobs.sandboxId} is not null and ${jobs.terminationConfirmed}=false and (
          ${jobs.cancelRequested}=true or ${jobs.state}='provider_unknown' or ${jobs.errorCode}='E2B_CLEANUP_UNKNOWN'
          or ${jobs.createdAt} + (${jobs.maxRuntimeMs}+30000) * interval '1 millisecond' < now())`,
      )).limit(20);
      let terminated = 0;
      for (const owner of [...new Set(candidates.map(row => row.owner))]) {
        await this.jobs.purgeExpired(owner);
        const retained = await this.db.select({ id: jobs.id, sandboxId: jobs.sandboxId, provider: jobs.provider }).from(jobs)
          .where(sql`${jobs.owner}=${owner} and ${jobs.sandboxId} is not null and ${jobs.terminationConfirmed}=false and (
            ${jobs.cancelRequested}=true or ${jobs.state}='provider_unknown' or ${jobs.errorCode}='E2B_CLEANUP_UNKNOWN'
            or ${jobs.createdAt} + (${jobs.maxRuntimeMs}+30000) * interval '1 millisecond' < now())`).limit(20);
        for (const job of retained) {
          let confirmed = false;
          await this.jobs.cancel(owner, job.id);
          try {
            const provider = job.provider === 'e2b' ? this.sandbox : this.local;
            if (!provider) throw new Error('COMPUTE_PROVIDER_UNAVAILABLE');
            await provider.kill(job.sandboxId); confirmed = true;
          } catch { confirmed = false; }
          if (confirmed) { await this.jobs.confirmTermination(owner, job.id); terminated += 1; }
        }
      }
      return terminated;
    } finally { this.active = false; }
  }
}
