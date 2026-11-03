import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, lte, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { builderProfiles, paperAccounts, paperPositions } from '../../database/schema';
import { strategyOutbox, strategyPlans, strategyProtections, strategyRuntime, strategySignals, strategyTasks } from '../../database/strategy.schema';
import type { BuilderProfile, Market } from '../../../shared/api.interface';
import type { DailyStrategyPlan, StrategyCandidate, StrategyMarketRuntime, StrategyRule, StrategyRuntime } from '../../../shared/strategy.interface';
import type { NotificationPayload } from '../notifications/notification.service';
import { strategyReason } from './strategy.messages';
import { councilReports, councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';

export type StrategyTaskRow = typeof strategyTasks.$inferSelect;
export type StrategyPlanRow = typeof strategyPlans.$inferSelect;
export interface StrategyResearchFence { sessionId: string; reportId: string; revision: number; cycleId: string }
export const mapStrategyPlan = (row: StrategyPlanRow): DailyStrategyPlan => ({
  id: row.id, profileId: row.profileId, profileVersion: row.profileVersion, version: row.version,
  market: row.market as Market, marketDate: row.marketDate, status: row.status as DailyStrategyPlan['status'],
  rules: row.rules, sessionIds: row.sessionIds, reportIds: row.reportIds, summary: row.summary,
  expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(),
});

@Injectable()
export class StrategyStore {
  constructor(@Inject(DRIZZLE_DATABASE) readonly db: PostgresJsDatabase) {}

  async tasks(owner: string, profile: BuilderProfile, market: Market, date: string): Promise<StrategyTaskRow[]> {
    return this.db.select().from(strategyTasks).where(and(eq(strategyTasks.owner, owner),
      eq(strategyTasks.profileId, profile.id), eq(strategyTasks.profileVersion, profile.version),
      eq(strategyTasks.market, market), eq(strategyTasks.marketDate, date))).orderBy(desc(strategyTasks.attempt));
  }
  async claimTask(owner: string, profile: BuilderProfile, market: Market, marketDate: string,
    attempt: number): Promise<StrategyTaskRow | null> {
    const [row] = await this.db.insert(strategyTasks).values({ owner, profileId: profile.id,
      profileVersion: profile.version, market, marketDate, attempt }).onConflictDoNothing().returning();
    return row ?? null;
  }
  async updateTask(id: string, state: string, reason: string | null = null, sessionIds?: string[]): Promise<void> {
    await this.db.update(strategyTasks).set({ state, reason, ...(sessionIds ? { sessionIds } : {}), updatedAt: new Date() })
      .where(eq(strategyTasks.id, id));
  }
  async claimExtraction(id: string): Promise<boolean> {
    const [row] = await this.db.update(strategyTasks).set({ state: 'extracting', updatedAt: new Date() })
      .where(and(eq(strategyTasks.id, id), eq(strategyTasks.state, 'discussing'))).returning({ id: strategyTasks.id });
    return Boolean(row);
  }
  async currentPlan(owner: string, profile: BuilderProfile, market: Market, date: string): Promise<StrategyPlanRow | null> {
    const [row] = await this.db.select().from(strategyPlans).where(and(eq(strategyPlans.owner, owner),
      eq(strategyPlans.profileId, profile.id), eq(strategyPlans.profileVersion, profile.version),
      eq(strategyPlans.market, market), eq(strategyPlans.marketDate, date),
      eq(strategyPlans.status, 'active'), gt(strategyPlans.expiresAt, new Date())))
      .orderBy(desc(strategyPlans.version)).limit(1);
    return row ?? null;
  }
  async publish(task: StrategyTaskRow, rules: StrategyRule[], reportIds: string[], summary: string,
    expiresAt: Date, researchFence: StrategyResearchFence[] = []): Promise<StrategyPlanRow> {
    return this.db.transaction(async (tx) => {
      if (researchFence.length) {
        const sessions = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, task.owner),
          inArray(councilSessions.id, researchFence.map(f => f.sessionId)))).orderBy(councilSessions.id).for('update');
        for (const fence of researchFence) {
          const session = sessions.find(s => s.id === fence.sessionId);
          if (!session || session.status !== 'completed' || session.revision !== fence.revision
            || session.checkpoint?.cycleId !== fence.cycleId || !task.sessionIds.includes(session.id) || !reportIds.includes(fence.reportId)) throw new Error('Research changed; plan discarded');
          const [report] = await tx.select().from(councilReports).where(and(eq(councilReports.owner, task.owner),
            eq(councilReports.id, fence.reportId), eq(councilReports.sessionId, fence.sessionId), eq(councilReports.revision, fence.revision)));
          const tasks = await tx.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, task.owner),
            eq(councilResearchTasks.sessionId, fence.sessionId), eq(councilResearchTasks.cycleId, fence.cycleId)));
          if (!report?.coverage?.complete || report.coverage.revision !== fence.revision || report.coverage.cycleId !== fence.cycleId
            || !tasks.length || tasks.length !== report.coverage.tasks.length || tasks.some(t => t.revision !== fence.revision
              || t.state !== 'accepted' || !t.acceptedAttemptId || !report.coverage!.tasks.some(c => c.id === t.id && c.acceptedAttemptId === t.acceptedAttemptId && c.state === 'accepted'))) {
            throw new Error('Research is not accepted; plan discarded');
          }
        }
      }
      const [profile] = await tx.select().from(builderProfiles).where(and(eq(builderProfiles.owner, task.owner),
        eq(builderProfiles.id, task.profileId))).for('update');
      if (profile?.status !== 'active' || profile.version !== task.profileVersion
        || !(profile.config as { automation?: { enabled?: boolean } }).automation?.enabled) throw new Error('Profile changed; plan discarded');
      await tx.update(strategyPlans).set({ status: 'superseded' }).where(and(eq(strategyPlans.owner, task.owner),
        eq(strategyPlans.profileId, task.profileId), eq(strategyPlans.market, task.market), eq(strategyPlans.status, 'active')));
      const [plan] = await tx.insert(strategyPlans).values({ owner: task.owner, profileId: task.profileId,
        profileVersion: task.profileVersion, taskId: task.id, version: task.attempt + 1,
        market: task.market, marketDate: task.marketDate, rules, sessionIds: task.sessionIds,
        reportIds, summary: summary.slice(0, 2000), expiresAt }).returning();
      const [account] = await tx.select().from(paperAccounts).where(eq(paperAccounts.owner, task.owner));
      if (!account?.botEnabled) throw new Error('Paper account stopped; plan discarded');
      const positions = await tx.select().from(paperPositions).where(eq(paperPositions.accountId, account.id));
      for (const rule of rules) if (positions.some((position) => position.ticker === rule.ticker && Number(position.shares) > 0)) {
        await tx.insert(strategyProtections).values({ owner: task.owner, accountId: account.id,
          ticker: rule.ticker, market: task.market, stopLossPrice: String(rule.stopLossPrice), planId: plan.id, ruleId: rule.id })
          .onConflictDoUpdate({ target: [strategyProtections.owner, strategyProtections.accountId, strategyProtections.ticker],
            set: { stopLossPrice: sql`greatest(${strategyProtections.stopLossPrice}, ${rule.stopLossPrice})`,
              planId: plan.id, ruleId: rule.id, version: sql`${strategyProtections.version} + 1`, updatedAt: new Date() } });
      }
      await tx.update(strategyTasks).set({ state: 'completed', updatedAt: new Date() }).where(eq(strategyTasks.id, task.id));
      if ((profile.config as { notifyOnProposal?: boolean }).notifyOnProposal) await tx.insert(strategyOutbox).values({ owner: task.owner, profileId: task.profileId,
        eventKey: `strategy-ready:${plan.id}`, payload: { event: 'strategy_ready',
          title: `${task.market} ${(profile.config as { language?: string }).language === 'en' ? 'daily PAPER strategy ready' : '每日模拟策略已就绪'}`,
          body: `${task.marketDate} · v${plan.version} · ${rules.length} ${(profile.config as { language?: string }).language === 'en' ? 'rules' : '条规则'}\n${summary.slice(0, 1000)}` } });
      return plan;
    });
  }
  async claimSignal(owner: string, profile: BuilderProfile, candidate: StrategyCandidate): Promise<boolean> {
    const [row] = await this.db.insert(strategySignals).values({ id: candidate.signalId, owner, profileId: profile.id,
      planId: candidate.planId, ruleId: candidate.ruleId, kind: candidate.protectiveStop
        ? `stop:${candidate.protectionId ?? 'plan'}:${candidate.protectionVersion ?? 1}:${candidate.quoteAt}`
        : `entry:${candidate.reviewAttempt ?? 1}`,
      state: candidate.protectiveStop ? 'approved' : 'reviewing', candidate, reason: candidate.reason })
      .onConflictDoNothing().returning({ id: strategySignals.id });
    return Boolean(row);
  }
  async nextReviewAttempt(owner: string, planId: string, ruleId: string, quoteAt: string): Promise<number | null> {
    const rows = await this.db.select().from(strategySignals).where(and(eq(strategySignals.owner, owner),
      eq(strategySignals.planId, planId), eq(strategySignals.ruleId, ruleId), sql`${strategySignals.kind} like 'entry:%'`))
      .orderBy(desc(strategySignals.createdAt));
    if (!rows.length) return 1;
    const previous = rows[0];
    if (previous.state !== 'wait' || rows.length >= 3 || Date.now() - previous.updatedAt.getTime() < 30 * 60000
      || Date.parse(quoteAt) <= Date.parse(previous.candidate.quoteAt)) return null;
    return rows.length + 1;
  }
  async protections(owner: string) {
    return this.db.select().from(strategyProtections).where(eq(strategyProtections.owner, owner));
  }
  async finishSignal(id: string, state: string, reason: string): Promise<void> {
    await this.db.update(strategySignals).set({ state, reason: reason.slice(0, 1000), updatedAt: new Date() })
      .where(and(eq(strategySignals.id, id), ne(strategySignals.state, 'filled')));
  }
  async runtime(owner: string, profile: BuilderProfile): Promise<StrategyRuntime> {
    const [rows, messages] = await Promise.all([
      this.db.select().from(strategyRuntime).where(and(eq(strategyRuntime.owner, owner),
        eq(strategyRuntime.profileId, profile.id), eq(strategyRuntime.profileVersion, profile.version))),
      this.db.select().from(strategyOutbox).where(and(eq(strategyOutbox.owner, owner), eq(strategyOutbox.profileId, profile.id))),
    ]);
    return { enabled: profile.config.automation?.enabled ?? false, profileId: profile.id, profileVersion: profile.version,
      markets: rows.map((row) => ({ ...row.data, reason: strategyReason(row.data.reason, profile.config.language),
        ...(profile.status === 'active' ? {} : { state: 'stopped' as const, reason: strategyReason('Agent paused', profile.config.language) }) })),
      notification: { pending: messages.filter((row) => row.state === 'pending' || row.state === 'delivering').length,
        failed: messages.filter((row) => row.state === 'failed').length,
        lastDeliveredAt: messages.map((row) => row.deliveredAt?.toISOString()).filter((date): date is string => Boolean(date)).sort().at(-1) ?? null } };
  }
  async setRuntime(owner: string, profile: BuilderProfile, data: StrategyMarketRuntime): Promise<void> {
    await this.db.insert(strategyRuntime).values({ owner, profileId: profile.id, profileVersion: profile.version,
      market: data.market, data }).onConflictDoUpdate({ target: [strategyRuntime.owner, strategyRuntime.profileId, strategyRuntime.market],
      set: { profileVersion: profile.version, data, updatedAt: new Date() } });
  }
  async enqueue(owner: string, profileId: string, eventKey: string, payload: NotificationPayload): Promise<void> {
    await this.db.insert(strategyOutbox).values({ owner, profileId, eventKey, payload }).onConflictDoNothing();
  }
  async claimNotifications() {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(strategyOutbox).where(and(ne(strategyOutbox.state, 'delivered'),
        lte(strategyOutbox.availableAt, new Date()), sql`${strategyOutbox.attempts} < 10`)).limit(20).for('update', { skipLocked: true });
      for (const row of rows) await tx.update(strategyOutbox).set({ state: 'delivering', attempts: row.attempts + 1,
        availableAt: new Date(Date.now() + 120000) }).where(eq(strategyOutbox.id, row.id));
      return rows;
    });
  }
  async notificationResult(id: string, deliveredChannelIds: string[], ok: boolean, attempts: number): Promise<void> {
    await this.db.update(strategyOutbox).set({ deliveredChannelIds, state: ok ? 'delivered' : 'failed',
      deliveredAt: ok ? new Date() : null, availableAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** attempts)) })
      .where(eq(strategyOutbox.id, id));
  }
}
