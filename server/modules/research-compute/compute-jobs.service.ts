import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { researchComputeJobs as jobs } from '../../database/research-compute.schema';
import { decryptSecret, encryptSecret } from '../settings/settings-security';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';

type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
type Job = typeof jobs.$inferSelect;
@Injectable()
export class ComputeJobsService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() @Inject('RUNTIME_ENCRYPTION_KEY') private readonly configuredKey?: string) {}
  private key(): string {
    const value = this.configuredKey ?? process.env.SETTINGS_ENCRYPTION_KEY ?? process.env.JWT_SECRET;
    if (!value || value.length < 16) throw new Error('COMPUTE_ENCRYPTION_KEY_REQUIRED');
    return value;
  }
  private async locked(tx: Tx, owner: string, id: string): Promise<Job> {
    await lockMemoryOwner(tx, owner);
    const [job] = await tx.select().from(jobs).where(and(eq(jobs.owner, owner), eq(jobs.id, id))).for('update');
    if (!job) throw new NotFoundException('COMPUTE_JOB_NOT_FOUND');
    return job;
  }
  async create(owner: string, input: { runId: string; requestKey: string; requestHash: string; kind: string;
    maxRuntimeMs: number; payload: unknown; sourceVersionIds?: string[]; datasetVersionIds?: string[];
    retentionUntil?: string | null; provider?: 'local-container' | 'e2b'; providerIdentity?: Record<string, unknown> }): Promise<Job> {
    const text = JSON.stringify(input.payload);
    if (!text || Buffer.byteLength(text) > 48 * 1024 * 1024) throw new Error('COMPUTE_INPUT_LIMIT');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [prior] = await tx.select().from(jobs).where(and(eq(jobs.owner, owner), eq(jobs.requestKey, input.requestKey)));
      if (prior) {
        if (prior.requestHash !== input.requestHash || prior.runId !== input.runId) throw new ConflictException('COMPUTE_REQUEST_CONFLICT');
        return prior;
      }
      const quota = await tx.execute(sql`select count(*) filter(where created_at>now()-interval '1 day')::int daily,
        count(*) filter(where state in ('queued','creating','running','cancel_requested') or state='provider_unknown' and termination_confirmed=false or termination_confirmed=false
          and sandbox_id is not null)::int active from research_compute_jobs where owner=${owner}`);
      if (Number(quota[0].daily) >= 10 || Number(quota[0].active) >= 1) throw new Error('COMPUTE_RESOURCE_LIMIT');
      const [job] = await tx.insert(jobs).values({ id: randomUUID(), owner, runId: input.runId,
        requestKey: input.requestKey, requestHash: input.requestHash, kind: input.kind,
        maxRuntimeMs: input.maxRuntimeMs, inputEnc: encryptSecret(text, this.key()),
        provider: input.provider ?? 'e2b', providerIdentity: input.providerIdentity ?? {},
        sourceVersionIds: input.sourceVersionIds ?? [], datasetVersionIds: input.datasetVersionIds ?? [],
        retentionUntil: input.retentionUntil ? new Date(input.retentionUntil) : null }).returning();
      return job;
    });
  }
  async read(owner: string, id: string): Promise<Job> {
    const [job] = await this.db.select().from(jobs).where(and(eq(jobs.owner, owner), eq(jobs.id, id)));
    if (!job) throw new NotFoundException('COMPUTE_JOB_NOT_FOUND');
    return job;
  }
  async input(owner: string, id: string): Promise<unknown> {
    const job = await this.read(owner, id);
    if (!job.inputEnc) throw new Error('COMPUTE_INPUT_REVOKED');
    return JSON.parse(decryptSecret(job.inputEnc, this.key()));
  }
  async status(owner: string, id: string) {
    const job = await this.read(owner, id);
    return { id: job.id, runId: job.runId, kind: job.kind, state: job.state, provider: job.provider,
      providerIdentity: job.providerIdentity, cancelRequested: job.cancelRequested,
      terminationConfirmed: job.terminationConfirmed, errorCode: job.errorCode, result: job.result,
      usage: { billableQuantity: null, cost: null, known: false }, createdAt: job.createdAt.toISOString() };
  }
  async receipt(owner: string, id: string) { return { ...await this.status(owner, id), result: null }; }
  async claim(owner: string, id: string): Promise<boolean> {
    return this.db.transaction(async tx => {
      const job = await this.locked(tx, owner, id);
      if (job.state !== 'queued' || job.cancelRequested) return false;
      await tx.update(jobs).set({ state: 'creating', updatedAt: new Date() }).where(eq(jobs.id, id)); return true;
    });
  }
  async created(owner: string, id: string, sandboxId: string): Promise<void> {
    await this.db.transaction(async tx => {
      const job = await this.locked(tx, owner, id);
      if (job.sandboxId && job.sandboxId !== sandboxId) throw new ConflictException('COMPUTE_SANDBOX_CONFLICT');
      if (!['creating', 'cancel_requested'].includes(job.state)) throw new ConflictException('COMPUTE_JOB_STATE');
      await tx.update(jobs).set({ sandboxId, state: job.cancelRequested ? 'cancel_requested' : 'running', updatedAt: new Date() }).where(eq(jobs.id, id));
    });
  }
  async complete(owner: string, id: string, result: Record<string, unknown>, authorize?: (tx: Tx) => Promise<void>): Promise<boolean> {
    return this.db.transaction(async tx => {
      const job = await this.locked(tx, owner, id);
      if (!['running', 'cancel_requested'].includes(job.state)) throw new ConflictException('COMPUTE_JOB_STATE');
      if (!job.inputEnc || job.cancelRequested || job.errorCode === 'COMPUTE_INPUT_REVOKED') {
        await tx.update(jobs).set({ result: null, terminationConfirmed: true, state: 'cancelled', updatedAt: new Date() }).where(eq(jobs.id, id));
        return false;
      }
      await authorize?.(tx);
      await tx.update(jobs).set({ result, terminationConfirmed: true, state: 'succeeded',
        updatedAt: new Date() }).where(eq(jobs.id, id));
      return true;
    });
  }
  async fail(owner: string, id: string, code: string, terminated: boolean,
    logs: { stdout?: string; stderr?: string; sandboxId?: string } = {}): Promise<void> {
    await this.db.transaction(async tx => {
      const job = await this.locked(tx, owner, id);
      if (job.state === 'succeeded') return;
      const unknown = code.includes('UNKNOWN');
      const revoked = !job.inputEnc || job.errorCode === 'COMPUTE_INPUT_REVOKED';
      const confirmed = job.terminationConfirmed || terminated;
      const cancelled = job.state === 'cancelled' || job.cancelRequested && confirmed;
      await tx.update(jobs).set({ state: cancelled ? 'cancelled' : unknown ? 'provider_unknown' : 'failed',
        sandboxId: job.sandboxId ?? logs.sandboxId,
        errorCode: revoked ? 'COMPUTE_INPUT_REVOKED' : job.state === 'cancelled' ? job.errorCode : code,
        terminationConfirmed: confirmed,
        result: revoked || cancelled || job.cancelRequested ? null : { stdout: logs.stdout ?? '', stderr: logs.stderr ?? '' },
        updatedAt: new Date() }).where(eq(jobs.id, id));
    });
  }
  async cancel(owner: string, id: string): Promise<void> {
    await this.db.transaction(async tx => {
      const job = await this.locked(tx, owner, id);
      if (['succeeded', 'cancelled'].includes(job.state)) return;
      await tx.update(jobs).set({ cancelRequested: true, state: job.state === 'queued' ? 'cancelled' : 'cancel_requested',
        terminationConfirmed: job.state === 'queued' ? true : job.terminationConfirmed, updatedAt: new Date() }).where(eq(jobs.id, id));
    });
  }
  async confirmTermination(owner: string, id: string): Promise<void> {
    await this.db.transaction(async tx => {
      const job = await this.locked(tx, owner, id);
      await tx.update(jobs).set({ terminationConfirmed: true,
        state: job.cancelRequested ? 'cancelled' : job.state, updatedAt: new Date() }).where(eq(jobs.id, id));
    });
  }
  async revokeSource(owner: string, sourceVersionId: string): Promise<string[]> {
    const records = await this.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.owner, owner),
      sql`${jobs.sourceVersionIds} @> ${JSON.stringify([sourceVersionId])}::jsonb`));
    for (const record of records) await this.revokeInput(owner, record.id);
    return records.map(record => record.id);
  }
  async purgeExpired(owner: string): Promise<string[]> {
    const records = await this.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.owner, owner),
      sql`${jobs.retentionUntil} is not null and ${jobs.retentionUntil} <= now() and ${jobs.inputEnc} <> ''`));
    for (const record of records) await this.revokeInput(owner, record.id);
    return records.map(record => record.id);
  }
  private async revokeInput(owner: string, id: string): Promise<void> {
    await this.db.transaction(async tx => {
      const job = await this.locked(tx, owner, id);
      const active = ['creating', 'running', 'cancel_requested'].includes(job.state);
      await tx.update(jobs).set({ inputEnc: '', result: null,
        cancelRequested: true, state: active ? 'cancel_requested' : 'failed', errorCode: 'COMPUTE_INPUT_REVOKED',
        updatedAt: new Date() }).where(eq(jobs.id, id));
    });
  }
}
