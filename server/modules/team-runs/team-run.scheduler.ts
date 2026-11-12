import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { teamRunAgreements, teamRunCycles } from '../../database/team-run.schema';
import { teamCommissions, teamVersions, teamResearchLinks } from '../../database/teams.schema';
import { lockTeamOwner } from '../../database/team-context';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { TradingMarketService } from '../paper-trading/trading-market.service';
import { TeamRunService, activeCycleStates, type AgreementRow, type RunCycleRow } from './team-run.service';
import { compileRunCommission, dueTeamRun } from './team-run.rules';
import { TeamCommissionService } from '../teams/team-commission.service';
import { TeamRunDelivery } from './team-run.delivery';
import { assertTeamRunAuthority, isArchiveOnlyTeamRun } from '../../database/team-run-authority';

/** Durable reservations precede commission creation. Replays reuse commission/receipt identities, never model dispatches. */
@Injectable()
export class TeamRunScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TeamRunScheduler.name);
  private readonly leaseOwner = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(private readonly runs: TeamRunService, private readonly markets: TradingMarketService,
    private readonly commissions: TeamCommissionService, private readonly delivery: TeamRunDelivery) {}
  onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, 5000); this.timer.unref(); void this.tick();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await this.runOnce(); } catch (error) { this.logger.error(error instanceof Error ? error.message : 'Team run scheduler failed'); }
    finally { this.busy = false; }
  }
  async reserve(row: AgreementRow, now: Date): Promise<void> {
    const schedule = await this.markets.getSchedule(row.configuration.market, now);
    const tradingDate = dueTeamRun(schedule, row.configuration.cadence.delayMinutes, now);
    if (!tradingDate) return;
    await this.runs.store.db.transaction(async tx => {
      await lockMemoryOwner(tx, row.ownerId); await lockTeamOwner(tx, row.ownerId);
      const current = await this.runs.row(tx, row.ownerId, row.teamId);
      if (!current || current.state !== 'running' || current.revision !== row.revision || await this.runs.authorityChanged(tx, current)) return;
      const existing = await tx.select().from(teamRunCycles).where(and(eq(teamRunCycles.agreementId, row.id),
        sql`(${teamRunCycles.tradingDate}=${tradingDate} OR ${teamRunCycles.state} IN ('reserved','researching','processing','uncertain'))`));
      if (existing.length) return;
      const { perRun, daily, monthly } = current.configuration.budget;
      // Entire authorized maxima stay reserved, including uncertain/closed unknown provider calls.
      // This intentionally favours an early budget stop over treating missing usage as zero.
      const [usage] = await tx.execute(sql`SELECT
        coalesce(sum(reserved_cost_usd) FILTER (WHERE trading_date=${tradingDate}),0)+${perRun.ceiling.amount}::numeric <= ${daily.costUsd}::numeric AS daily_cost,
        coalesce(sum(reserved_calls) FILTER (WHERE trading_date=${tradingDate}),0)+${perRun.callLimit} <= ${daily.calls} AS daily_calls,
        coalesce(sum(reserved_cost_usd),0)+${perRun.ceiling.amount}::numeric <= ${monthly.costUsd}::numeric AS monthly_cost,
        coalesce(sum(reserved_calls),0)+${perRun.callLimit} <= ${monthly.calls} AS monthly_calls
        FROM team_run_cycles WHERE owner_id=${row.ownerId} AND team_id=${row.teamId} AND left(trading_date,7)=${tradingDate.slice(0, 7)}`);
      if (!usage?.daily_cost || !usage.daily_calls || !usage.monthly_cost || !usage.monthly_calls) return;
      await tx.insert(teamRunCycles).values({ ownerId: row.ownerId, teamId: row.teamId, agreementId: row.id, agreementRevision: row.revision,
        tradingDate, state: 'reserved', reservedCostUsd: perRun.ceiling.amount, reservedCalls: perRun.callLimit, createdAt: new Date(), updatedAt: new Date() });
    });
  }
  async runOnce(now = new Date()): Promise<void> {
    const agreements = await this.runs.store.db.select().from(teamRunAgreements).limit(200);
    for (const row of agreements) {
      await this.runs.reconcileAuthority(row);
      await this.runs.cancelInactive(row.ownerId, row.teamId);
      if (row.state === 'running') await this.reserve(row, now);
    }
    const cycles = await this.runs.store.db.select().from(teamRunCycles).where(inArray(teamRunCycles.state, activeCycleStates)).limit(100);
    for (const cycle of cycles) await this.advance(cycle);
  }
  async advance(hint: RunCycleRow): Promise<void> {
    const claimed = await this.runs.store.db.transaction(async tx => {
      await lockTeamOwner(tx, hint.ownerId);
      const [row] = await tx.select().from(teamRunCycles).where(and(eq(teamRunCycles.id, hint.id),
        sql`(${teamRunCycles.leaseUntil} IS NULL OR ${teamRunCycles.leaseUntil}<now())`)).for('update');
      if (!row || !activeCycleStates.includes(row.state)) return null;
      const [leased] = await tx.update(teamRunCycles).set({ leaseOwner: this.leaseOwner, leaseUntil: new Date(Date.now() + 60000) }).where(eq(teamRunCycles.id, row.id)).returning();
      return leased;
    });
    if (!claimed) return;
    try {
      const [agreement] = await this.runs.store.db.select().from(teamRunAgreements).where(and(eq(teamRunAgreements.ownerId, claimed.ownerId), eq(teamRunAgreements.id, claimed.agreementId)));
      if (!agreement) return;
      if (claimed.commissionId) {
        const [commission] = await this.runs.store.db.select().from(teamCommissions).where(and(eq(teamCommissions.ownerId, claimed.ownerId), eq(teamCommissions.id, claimed.commissionId)));
        if (!commission) throw new Error('TEAM_REFERENCE_NOT_FOUND');
        if (commission.state === 'uncertain' || commission.state === 'cancelling') {
          await this.runs.store.db.update(teamRunCycles).set({ state: commission.state === 'uncertain' ? 'uncertain' : claimed.state, lastError: 'Awaiting existing provider cancellation or settlement', updatedAt: new Date() }).where(eq(teamRunCycles.id, claimed.id));
          return;
        }
        const archiveOnly = isArchiveOnlyTeamRun(agreement) && agreement.revision === claimed.agreementRevision + 1;
        if (commission.state === 'cancelled' || !archiveOnly && (agreement.state !== 'running' || agreement.revision !== claimed.agreementRevision)) {
          await this.runs.store.db.update(teamRunCycles).set({ state: 'cancelled', lastError: 'Standing authority stopped', updatedAt: new Date() }).where(eq(teamRunCycles.id, claimed.id));
          return;
        }
        if (['failed', 'blocked', 'partial'].includes(commission.state)) throw new Error('TEAM_DELIVERY_NOT_COMPLETE');
        if (commission.state === 'completed') {
          if (archiveOnly) {
            const [report] = await this.runs.store.db.select().from(teamResearchLinks).where(and(eq(teamResearchLinks.ownerId, claimed.ownerId),
              eq(teamResearchLinks.commissionId, commission.id), eq(teamResearchLinks.kind, 'report_version'), eq(teamResearchLinks.relation, 'produced')));
            await this.runs.store.db.update(teamRunCycles).set({ state: 'observed', reportVersionId: report?.targetId ?? null,
              lastError: 'Dispatched research retained in history; friend archive stopped automatic paper execution', updatedAt: new Date() }).where(eq(teamRunCycles.id, claimed.id));
            return;
          }
          if (claimed.state === 'uncertain') await this.runs.store.db.update(teamRunCycles).set({ state: 'researching', lastError: null }).where(eq(teamRunCycles.id, claimed.id));
          await this.delivery.process(agreement, { ...claimed, state: 'researching' }, commission);
        }
        else if (claimed.state === 'uncertain') await this.runs.store.db.update(teamRunCycles).set({ state: 'researching', lastError: null }).where(eq(teamRunCycles.id, claimed.id));
        return;
      }
      const authority = { agreementId: agreement.id, revision: claimed.agreementRevision, cycleId: claimed.id };
      await this.runs.store.db.transaction(async tx => { await lockTeamOwner(tx, claimed.ownerId); await assertTeamRunAuthority(tx, claimed.ownerId, authority); });
      const [version] = await this.runs.store.db.select().from(teamVersions).where(and(eq(teamVersions.ownerId, claimed.ownerId), eq(teamVersions.id, agreement.configuration.teamVersionId)));
      if (!version) throw new Error('TEAM_REFERENCE_NOT_FOUND');
      const preview = await this.commissions.preview(claimed.ownerId, claimed.teamId,
        compileRunCommission(version.config, agreement.configuration, 'run-preview:' + claimed.id, claimed.createdAt));
      await this.commissions.create(claimed.ownerId, claimed.teamId, { requestKey: 'run-create:' + claimed.id, previewId: preview.previewId, previewHash: preview.previewHash }, authority);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'TEAM_DEPENDENCY_UNAVAILABLE';
      const [saved] = await this.runs.store.db.select().from(teamRunCycles).where(eq(teamRunCycles.id, claimed.id));
      const [ongoing] = saved?.commissionId ? await this.runs.store.db.select().from(teamCommissions).where(eq(teamCommissions.id, saved.commissionId)) : [];
      if (ongoing && ['queued', 'running', 'awaiting_review', 'cancelling', 'uncertain'].includes(ongoing.state)) {
        await this.runs.store.db.update(teamRunCycles).set({ state: ongoing.state === 'uncertain' ? 'uncertain' : 'researching', lastError: message.slice(0, 1000), updatedAt: new Date() }).where(eq(teamRunCycles.id, claimed.id));
        return;
      }
      await this.runs.store.db.update(teamRunCycles).set({ state: 'blocked', lastError: message.slice(0, 1000), updatedAt: new Date() })
        .where(and(eq(teamRunCycles.id, claimed.id), sql`${teamRunCycles.state} NOT IN ('applied','observed','cancelled')`));
    } finally {
      await this.runs.store.db.update(teamRunCycles).set({ leaseOwner: null, leaseUntil: null }).where(and(eq(teamRunCycles.id, claimed.id), eq(teamRunCycles.leaseOwner, this.leaseOwner)));
    }
  }
}
