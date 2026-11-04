import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, notExists, or, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchArchiveJobs, researchMemories } from '../../database/research-memory.schema';
import type { ResearchArchiveImport, ResearchArchiveImportResult, ResearchArchiveJob, ResearchArchiveJobs, ResearchArchiveQuery } from '@shared/research-memory.interface';
import { archiveImportSchema, archiveQuerySchema, memoryIdSchema } from './research-memory.requests';
import { archivalEligibility } from './research-memory.archive-authority';
import { normalizedTopic } from './research-memory.rules';
import { ResearchMemoryService } from './research-memory.service';

type Job = typeof researchArchiveJobs.$inferSelect;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;
const TERMINAL_ERRORS = ['MEMORY_SOURCE_NOT_FOUND', 'MEMORY_SOURCE_NOT_COMPLETED', 'MEMORY_AUTO_ARCHIVE_DISABLED', 'MEMORY_DELETED'];

/** Called with the report publication transaction, using its exact inserted report identity. */
export async function enqueueResearchArchive(tx: Pick<PostgresJsDatabase, 'insert'>,
  report: typeof councilReports.$inferSelect, ticker: string, topic?: string, intent: Job['intent'] = 'automatic'): Promise<boolean> {
  const inserted = await tx.insert(researchArchiveJobs).values({ owner: report.owner, sessionId: report.sessionId, reportId: report.id,
    reportVersion: report.version, ticker, topic: normalizedTopic(topic), intent }).onConflictDoNothing().returning({ id: researchArchiveJobs.id });
  return inserted.length > 0;
}

@Injectable()
export class ResearchArchiveService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase, private readonly memory: ResearchMemoryService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 5_000);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  async onModuleDestroy(): Promise<void> { if (this.timer) clearInterval(this.timer); await this.active; }
  async tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.drain();
    try { await this.active; } finally { this.active = undefined; }
  }
  private async drain(): Promise<void> {
    await this.db.update(researchArchiveJobs).set({ state: 'failed', error: 'MEMORY_ARCHIVE_RETRIES_EXHAUSTED',
      leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(researchArchiveJobs.state, 'running'),
      lte(researchArchiveJobs.leaseUntil, new Date()), sql`${researchArchiveJobs.attempts} >= ${MAX_ATTEMPTS}`));
    for (let index = 0; index < 5; index++) {
      const job = await this.claim();
      if (!job) return;
      await this.runClaim(job.id, job.leaseToken!);
    }
  }
  async claim(): Promise<Job | null> {
    return this.db.transaction(async tx => {
      const [job] = await tx.select().from(researchArchiveJobs).where(and(lt(researchArchiveJobs.attempts, MAX_ATTEMPTS),
        or(and(eq(researchArchiveJobs.state, 'queued'), lte(researchArchiveJobs.nextAttemptAt, new Date())),
          and(eq(researchArchiveJobs.state, 'running'), lte(researchArchiveJobs.leaseUntil, new Date())))))
        .orderBy(asc(researchArchiveJobs.nextAttemptAt), asc(researchArchiveJobs.id)).limit(1).for('update', { skipLocked: true });
      if (!job) return null;
      const [claimed] = await tx.update(researchArchiveJobs).set({ state: 'running', attempts: job.attempts + 1,
        leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + LEASE_MS), updatedAt: new Date() })
        .where(eq(researchArchiveJobs.id, job.id)).returning();
      return claimed;
    });
  }
  async runClaim(id: string, token: string): Promise<void> {
    try {
      await this.db.transaction(async tx => {
        // Future owner-level revocation fences belong before these row locks. No network work occurs here.
        const [job] = await tx.select().from(researchArchiveJobs).where(and(eq(researchArchiveJobs.id, id),
          eq(researchArchiveJobs.state, 'running'), eq(researchArchiveJobs.leaseToken, token),
          gt(researchArchiveJobs.leaseUntil, new Date()))).for('update');
        if (!job) return;
        const [source] = await tx.select({ report: councilReports, session: councilSessions }).from(councilReports)
          .innerJoin(councilSessions, and(eq(councilSessions.id, councilReports.sessionId), eq(councilSessions.owner, job.owner)))
          .where(and(eq(councilReports.owner, job.owner), eq(councilReports.id, job.reportId),
            eq(councilReports.sessionId, job.sessionId), eq(councilReports.version, job.reportVersion)));
        if (!source) throw new Error('MEMORY_SOURCE_NOT_FOUND');
        const memoryId = await this.memory.archiveReportInTransaction(tx, job.owner, { sessionId: source.session.id,
          ticker: source.session.ticker, language: source.session.language, topic: job.topic,
          report: { ...source.report, createdAt: source.report.createdAt.toISOString() } }, job.intent);
        if (!memoryId) {
          const [tombstone] = await tx.select({ id: researchMemories.id }).from(researchMemories)
            .where(and(eq(researchMemories.owner, job.owner), eq(researchMemories.reportId, job.reportId),
              eq(researchMemories.reportVersion, job.reportVersion), sql`${researchMemories.deletedAt} IS NOT NULL`));
          throw new Error(tombstone ? 'MEMORY_DELETED' : 'MEMORY_AUTO_ARCHIVE_DISABLED');
        }
        const completed = await tx.update(researchArchiveJobs).set({ state: 'succeeded', error: null,
          leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(researchArchiveJobs.id, id),
          eq(researchArchiveJobs.leaseToken, token), sql`${researchArchiveJobs.leaseUntil} > clock_timestamp()`)).returning();
        if (!completed.length) throw new Error('MEMORY_ARCHIVE_LEASE_EXPIRED');
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code = [...TERMINAL_ERRORS, 'MEMORY_ARCHIVE_LEASE_EXPIRED'].find(code => message.includes(code)) ?? 'MEMORY_ARCHIVE_FAILED';
      await this.db.update(researchArchiveJobs).set({
        state: sql`CASE WHEN ${researchArchiveJobs.attempts} >= ${MAX_ATTEMPTS} OR ${TERMINAL_ERRORS.includes(code)} THEN 'failed' ELSE 'queued' END`,
        error: code, leaseToken: null, leaseUntil: null, updatedAt: new Date(),
        nextAttemptAt: sql`now() + least(300, 5 * power(2, ${researchArchiveJobs.attempts} - 1)) * interval '1 second'`,
      }).where(and(eq(researchArchiveJobs.id, id), eq(researchArchiveJobs.leaseToken, token), eq(researchArchiveJobs.state, 'running')));
    }
  }
  async list(owner: string, input: ResearchArchiveQuery = {}): Promise<ResearchArchiveJobs> {
    await this.memory.getPreferences(owner);
    const parsed = archiveQuerySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('MEMORY_INVALID_QUERY');
    const { cursor, state, limit } = parsed.data;
    const symbols = this.symbols(parsed.data);
    const scope = and(eq(researchArchiveJobs.owner, owner), symbols ? inArray(sql<string>`upper(trim(${researchArchiveJobs.ticker}))`, symbols) : undefined);
    const rows = await this.db.select().from(researchArchiveJobs).where(and(scope,
      state ? eq(researchArchiveJobs.state, state) : undefined, cursor ? gt(researchArchiveJobs.id, cursor) : undefined))
      .orderBy(asc(researchArchiveJobs.id)).limit(limit + 1);
    const counts = { queued: 0, running: 0, succeeded: 0, failed: 0 };
    const totals = await this.db.select({ state: researchArchiveJobs.state, count: sql<number>`count(*)::int` })
      .from(researchArchiveJobs).where(scope).groupBy(researchArchiveJobs.state);
    for (const row of totals) counts[row.state] = row.count;
    return { jobs: rows.slice(0, limit).map(publicJob), nextCursor: rows.length > limit ? rows[limit - 1].id : null, counts };
  }
  async retry(owner: string, id: string): Promise<ResearchArchiveJob> {
    await this.memory.getPreferences(owner);
    if (!memoryIdSchema.safeParse(id).success) throw new BadRequestException('MEMORY_INVALID_ID');
    return this.db.transaction(async tx => {
      const [job] = await tx.select().from(researchArchiveJobs)
        .where(and(eq(researchArchiveJobs.owner, owner), eq(researchArchiveJobs.id, id))).for('update');
      if (!job) throw new NotFoundException('MEMORY_ARCHIVE_NOT_FOUND');
      if (job.state === 'running' && job.leaseUntil && job.leaseUntil > new Date()) throw new ConflictException('MEMORY_ARCHIVE_RUNNING');
      if (job.state === 'succeeded') return publicJob(job);
      const [updated] = await tx.update(researchArchiveJobs).set({ intent: 'manual', state: 'queued', attempts: 0,
        error: null, leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(), updatedAt: new Date() })
        .where(and(eq(researchArchiveJobs.owner, owner), eq(researchArchiveJobs.id, id))).returning();
      return publicJob(updated);
    });
  }
  private symbols(input: Pick<ResearchArchiveImport, 'ticker' | 'market'>): string[] | undefined {
    if (!input.ticker) {
      if (input.market) throw new BadRequestException('MEMORY_INVALID_QUERY');
      return;
    }
    const target = this.memory.symbol({ ticker: input.ticker, market: input.market });
    const digits = target.ticker.split('.')[0];
    const candidates = target.market === 'HK' ? [target.ticker, digits, String(Number(digits)),
      digits.replace(/^0/u, ''), `${Number(digits)}.HK`, `${String(Number(digits)).padStart(4, '0')}.HK`]
      : [target.ticker, target.ticker.replace(/\.SH$/u, '.SS'), digits];
    return [...new Set(candidates.filter(ticker => {
      try { const symbol = this.memory.symbol({ ticker }); return symbol.ticker === target.ticker && symbol.market === target.market; }
      catch { return false; }
    }))];
  }
  async importReports(owner: string, input: ResearchArchiveImport = {}): Promise<ResearchArchiveImportResult> {
    await this.memory.getPreferences(owner);
    const parsed = archiveImportSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('MEMORY_INVALID_QUERY');
    const { cursor, limit } = parsed.data;
    const symbols = this.symbols(parsed.data);
    return this.db.transaction(async tx => {
      const rows = await tx.select({ report: councilReports, session: councilSessions }).from(councilReports)
        .innerJoin(councilSessions, and(eq(councilSessions.id, councilReports.sessionId), eq(councilSessions.owner, owner)))
        .where(and(eq(councilReports.owner, owner), ne(councilReports.engine, 'basic'),
          or(isNull(councilReports.publicationOutcome), eq(councilReports.publicationOutcome, 'succeeded')),
          symbols ? inArray(sql<string>`upper(trim(${councilSessions.ticker}))`, symbols) : undefined, cursor ? gt(councilReports.id, cursor) : undefined,
          notExists(tx.select({ id: researchArchiveJobs.id }).from(researchArchiveJobs).where(and(eq(researchArchiveJobs.owner, owner),
            eq(researchArchiveJobs.reportId, councilReports.id), eq(researchArchiveJobs.reportVersion, councilReports.version)))),
          notExists(tx.select({ id: researchMemories.id }).from(researchMemories).where(and(eq(researchMemories.owner, owner),
            eq(researchMemories.reportId, councilReports.id), eq(researchMemories.reportVersion, councilReports.version))))))
        .orderBy(asc(councilReports.id)).limit(limit + 1).for('update');
      let queued = 0;
      for (const { report, session } of rows.slice(0, limit)) {
        if (!await archivalEligibility(tx, owner, report, session)) continue;
        if (await enqueueResearchArchive(tx, report, session.ticker, session.checkpoint?.workflow?.goal, 'manual')) queued++;
      }
      return { queued, scanned: Math.min(rows.length, limit), hasMore: rows.length > limit,
        nextCursor: rows.length > limit ? rows[limit - 1].report.id : null };
    });
  }
}

function publicJob(row: Job): ResearchArchiveJob {
  return { id: row.id, reportId: row.reportId, sessionId: row.sessionId, reportVersion: row.reportVersion, ticker: row.ticker,
    intent: row.intent, state: row.state, attempts: row.attempts, error: row.error,
    nextAttemptAt: row.nextAttemptAt.toISOString(), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
