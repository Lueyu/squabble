import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { strategyMonitorState, strategyReviewJobs, strategyMandates, strategyRouteReviews, strategyReservations } from '../../database/strategy-mandates.schema';
import { strategySignals, strategyPlans } from '../../database/strategy.schema';
import { paperAccounts, paperOrders, paperTrades } from '../../database/schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { paperRiskDay, paperRiskTimezone } from './paper-risk-day';
import { settleStrategyReservation } from './strategy-reservation';

/** Local heartbeat and deterministic reviews never fabricate fills for an offline interval. */
@Injectable()
export class StrategyMonitorService {
  private readonly logger = new Logger(StrategyMonitorService.name);
  private readonly leaseMs = 5 * 60_000;
  constructor(@Inject(DRIZZLE_DATABASE) readonly db: PostgresJsDatabase,
    private readonly documents: ResearchDocumentsService, private readonly experiments: SimulationExperimentsService) {}
  async heartbeat(owner: string, accountId: string): Promise<void> {
    const now = new Date();
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [account] = await tx.select({ id: paperAccounts.id }).from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
      if (!account) throw new NotFoundException('Simulation account not found');
      const timezone = await paperRiskTimezone(tx, owner, accountId);
      const [state] = await tx.select().from(strategyMonitorState).where(and(eq(strategyMonitorState.owner, owner),
        eq(strategyMonitorState.accountId, accountId))).for('update');
      const interrupted = state && now.getTime() - state.lastHeartbeat.getTime() > 180000;
      const gaps = interrupted ? [...state.gaps, { from: state.lastHeartbeat.toISOString(), to: now.toISOString() }].slice(-30) : state?.gaps ?? [];
      await tx.insert(strategyMonitorState).values({ accountId, owner, lastHeartbeat: now, gaps }).onConflictDoUpdate({
        target: strategyMonitorState.accountId, set: { lastHeartbeat: now, gaps } });
      const candidates = await tx.select().from(strategySignals).where(and(eq(strategySignals.owner, owner),
        inArray(strategySignals.state, ['reviewing', 'approved', 'wait'])));
      for (const signal of candidates) if (signal.candidate.accountId === accountId) {
        const [mandate] = signal.candidate.mandateId ? await tx.select().from(strategyMandates).where(and(eq(strategyMandates.id, signal.candidate.mandateId), eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, accountId))) : [];
        const [reservation] = await tx.select().from(strategyReservations).where(and(eq(strategyReservations.owner, owner), eq(strategyReservations.signalId, signal.id), eq(strategyReservations.status, 'active')));
        const ttl = mandate?.config.routePolicy.candidateTtlSeconds ?? 1200;
        if (!Number.isFinite(Date.parse(signal.candidate.quoteAt)) || now.getTime() - Date.parse(signal.candidate.quoteAt) > ttl * 1000
          || reservation && reservation.expiresAt <= now) {
          await tx.update(strategySignals).set({ state: 'expired', reason: 'Candidate expired; current data must create a new candidate', updatedAt: now })
            .where(and(eq(strategySignals.id, signal.id), inArray(strategySignals.state, ['reviewing', 'approved', 'wait'])));
          await settleStrategyReservation(tx, owner, signal.id, 'released', 'Candidate expired');
          if (signal.orderId) await tx.update(paperOrders).set({ status: 'cancelled', reason: 'Candidate expired' })
            .where(and(eq(paperOrders.owner, owner), eq(paperOrders.accountId, accountId), eq(paperOrders.id, signal.orderId), eq(paperOrders.status, 'pending_approval')));
        }
      }
      // Queue every closed date before advancing the heartbeat. A failed report never loses its period boundary.
      if (state) {
        const today = paperRiskDay(now, timezone);
        const pending: Array<typeof strategyReviewJobs.$inferInsert> = [];
        for (let date = paperRiskDay(state.lastHeartbeat, timezone); date < today;) {
          pending.push({ owner, accountId, key: `${accountId}:daily:${date}:${date}`, from: date, to: date, state: 'queued', updatedAt: now });
          const next = new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
          if (date.slice(0, 7) !== next.slice(0, 7)) {
            const first = date.slice(0, 8) + '01';
            pending.push({ owner, accountId, key: `${accountId}:monthly:${first}:${date}`, from: first, to: date, state: 'queued', updatedAt: now });
          }
          date = next;
        }
        for (let offset = 0; offset < pending.length; offset += 100) await tx.insert(strategyReviewJobs).values(pending.slice(offset, offset + 100)).onConflictDoNothing();
      }
    });
    // Work is bounded per heartbeat; the remainder stays durably queued for subsequent heartbeats.
    const pending = await this.db.select().from(strategyReviewJobs).where(and(eq(strategyReviewJobs.owner, owner), eq(strategyReviewJobs.accountId, accountId),
      or(inArray(strategyReviewJobs.state, ['queued', 'failed']), and(eq(strategyReviewJobs.state, 'running'), lte(strategyReviewJobs.updatedAt, new Date(now.getTime() - this.leaseMs))))))
      .orderBy(asc(strategyReviewJobs.updatedAt), asc(strategyReviewJobs.createdAt)).limit(10);
    for (const job of pending) {
      const kind = job.key.split(':')[1];
      try { await this.archivePeriod(owner, accountId, job.from, job.to, kind === 'daily' || kind === 'monthly' ? kind : 'custom'); }
      catch { this.logger.warn(`Simulation review ${job.id} remains failed and will retry on a later heartbeat`); }
    }
  }
  async archivePeriod(owner: string, accountId: string, from: string, to: string, kind: 'daily' | 'monthly' | 'custom' = 'custom') {
    const validDate = (value: string) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
      && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!validDate(from) || !validDate(to) || from > to || !['daily', 'monthly', 'custom'].includes(kind)) throw new BadRequestException('Invalid review period');
    const key = accountId + ':' + kind + ':' + from + ':' + to;
    const claim = await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [account] = await tx.select({ id: paperAccounts.id }).from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
      if (!account) throw new NotFoundException('Simulation account not found');
      const now = new Date();
      await tx.insert(strategyReviewJobs).values({ owner, accountId, key, from, to, state: 'queued', updatedAt: now }).onConflictDoNothing();
      const [existing] = await tx.select().from(strategyReviewJobs).where(and(eq(strategyReviewJobs.owner, owner), eq(strategyReviewJobs.key, key))).for('update');
      if (!existing) throw new NotFoundException('Review job not found');
      if (existing.state === 'completed' && existing.reportVersionId) return { result: existing.reportVersionId };
      // Recover a pre-existing durable document before rebuilding mutable metrics or timestamps.
      const [saved] = await tx.select({ id: researchDocumentVersions.id }).from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.idempotencyKey, 'automatic-review:' + key)));
      if (saved) {
        await tx.update(strategyReviewJobs).set({ state: 'completed', reportVersionId: saved.id, updatedAt: now }).where(eq(strategyReviewJobs.id, existing.id));
        return { result: saved.id };
      }
      if (existing.state === 'running' && existing.updatedAt.getTime() > now.getTime() - this.leaseMs) return { result: null };
      const lease = new Date(Math.max(now.getTime(), existing.updatedAt.getTime() + 1));
      const [job] = await tx.update(strategyReviewJobs).set({ state: 'running', updatedAt: lease }).where(eq(strategyReviewJobs.id, existing.id)).returning();
      return { job };
    });
    if ('result' in claim) return claim.result;
    const { job } = claim;
    try {
      const review = await this.experiments.review(owner, accountId, from, to);
      const timezone = await paperRiskTimezone(this.db, owner, accountId);
      const [monitor] = await this.db.select().from(strategyMonitorState).where(and(eq(strategyMonitorState.owner, owner), eq(strategyMonitorState.accountId, accountId)));
      const monitorGaps = (monitor?.gaps ?? []).filter(gap => paperRiskDay(new Date(gap.from), timezone) <= to && paperRiskDay(new Date(gap.to), timezone) >= from);
      const gaps = [...review.gaps, ...(monitorGaps.length ? ['MONITOR_OFFLINE_INTERVAL'] : [])];
      const rows = await this.db.select({ signal: strategySignals, review: strategyRouteReviews }).from(strategySignals)
        .innerJoin(strategyRouteReviews, eq(strategySignals.id, strategyRouteReviews.signalId))
        .where(and(eq(strategySignals.owner, owner), eq(strategyRouteReviews.owner, owner), eq(strategyRouteReviews.accountId, accountId)));
      const signals = rows.filter(row => { const date = paperRiskDay(new Date(row.signal.candidate.quoteAt), timezone); return date >= from && date <= to; });
      const trades = await this.db.select().from(paperTrades).where(and(eq(paperTrades.owner, owner), eq(paperTrades.accountId, accountId)));
      const losing = trades.filter(trade => { const date = paperRiskDay(trade.createdAt, timezone);
        return date >= from && date <= to && trade.realizedPl !== null && Number(trade.realizedPl) < 0; });
      const executionLimited = signals.filter(row => ['blocked', 'expired', 'cancelled'].includes(row.signal.state));
      const insufficient = signals.filter(row => ['wait', 'reviewing'].includes(row.signal.state));
      const vetoes = signals.filter(row => row.signal.state === 'veto');
      const sections = [
        { id: 'performance', title: '收益与数据口径 / Performance & data coverage', content: JSON.stringify(review, null, 2) },
        { id: 'thesis-review', title: '判断待复核 / Thesis review', content: losing.length
          ? '亏损成交不直接证明原判断错误。以下成交需要回看当时假设、价格变化与反证 / Losing fills require thesis review; loss alone does not establish a wrong judgment.\n' + JSON.stringify(losing.map(t => ({ orderId: t.orderId, ticker: t.ticker, realizedPl: t.realizedPl })), null, 2)
          : '本期没有可直接归类的已实现亏损成交；不自动判定判断正确 / No realized losing fills identified; this does not validate the thesis.' },
        { id: 'execution-limited', title: '执行受限 / Execution constraints', content: JSON.stringify(executionLimited.map(row => ({ signalId: row.signal.id, reason: row.signal.reason })), null, 2) },
        { id: 'information-gaps', title: '资料不够 / Insufficient information', content: JSON.stringify({ gaps, monitorGaps,
          decisions: insufficient.map(row => ({ signalId: row.signal.id, reason: row.signal.reason })) }, null, 2) },
        { id: 'route-attribution', title: 'AI 与研讨影响 / AI & Council decisions', content: JSON.stringify({ direct: signals.filter(r => r.review.decision.route === 'direct').length,
          ai: signals.filter(r => r.review.decision.route === 'ai').length, council: signals.filter(r => r.review.decision.route === 'council').length,
          vetoes: vetoes.map(r => ({ signalId: r.signal.id, reason: r.signal.reason })),
          sourcePlans: [...new Set(signals.map(row => row.signal.planId))] }, null, 2) },
      ];
      return await this.db.transaction(async tx => {
        await lockMemoryOwner(tx, owner);
        const [current] = await tx.select().from(strategyReviewJobs).where(and(eq(strategyReviewJobs.owner, owner), eq(strategyReviewJobs.id, job.id))).for('update');
        if (current?.state === 'completed') return current.reportVersionId;
        if (!current || current.state !== 'running' || current.updatedAt.getTime() !== job.updatedAt.getTime()) return null;
        const version = await this.documents.submitInTransaction(tx, owner, { idempotencyKey: 'automatic-review:' + key,
          title: (kind === 'monthly' ? '月度' : kind === 'daily' ? '每日' : '期间') + '模拟复盘 / Simulation review ' + from + ' — ' + to,
          kind: 'council', content: sections.map(s => '## ' + s.title + '\n' + s.content).join('\n\n'), sections,
          dataAsOf: null, availableAt: new Date().toISOString(),
          snapshot: { experimentId: accountId, scene: 'trade_post_review', from, to, timezone, review, decisionIds: signals.map(s => s.signal.id), gaps, monitorGaps } });
        await tx.update(strategyReviewJobs).set({ state: 'completed', reportVersionId: version.id, updatedAt: new Date() }).where(eq(strategyReviewJobs.id, job.id));
        return version.id;
      });
    } catch (error) {
      await this.db.update(strategyReviewJobs).set({ state: 'failed', updatedAt: new Date() }).where(and(eq(strategyReviewJobs.id, job.id), eq(strategyReviewJobs.owner, owner), eq(strategyReviewJobs.state, 'running'), eq(strategyReviewJobs.updatedAt, job.updatedAt)));
      throw error;
    }
  }
  async state(owner: string, accountId: string) {
    const [state] = await this.db.select().from(strategyMonitorState).where(and(eq(strategyMonitorState.owner, owner), eq(strategyMonitorState.accountId, accountId)));
    const reviews = await this.db.select().from(strategyReviewJobs).where(and(eq(strategyReviewJobs.owner, owner),
      eq(strategyReviewJobs.accountId, accountId))).orderBy(desc(strategyReviewJobs.createdAt)).limit(12);
    const activePlans = await this.db.select({ id: strategyPlans.id }).from(strategyPlans).where(and(eq(strategyPlans.owner, owner),
      eq(strategyPlans.accountId, accountId), eq(strategyPlans.status, 'active'), sql`${strategyPlans.expiresAt} > now()`));
    return { lastHeartbeat: state?.lastHeartbeat.toISOString() ?? null, gaps: state?.gaps ?? [], activePlanCount: activePlans.length,
      reviews: reviews.map(row => ({ id: row.id, from: row.from, to: row.to, state: row.state, reportVersionId: row.reportVersionId })) };
  }
}
