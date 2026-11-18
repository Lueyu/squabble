import { HttpException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { TeamRunConfiguration, TeamRunCycle, TeamRunFill, TeamRunResearch, TeamRunResearchResult, TeamRunWindow } from '../../../shared/team-run.interface';
import { assertReportVersionSources } from '../../database/report-source-fence';
import type { TeamDatabase } from '../../database/team-context';
import { tradingMarketSchedule } from '../paper-trading/trading-market.calendar';

export function nextRunWindow(configuration: TeamRunConfiguration, cycles: TeamRunCycle[],
  confirmationRevision: number, now: Date): TeamRunWindow {
  let schedule = tradingMarketSchedule(configuration.market, now);
  if (!schedule.calendarVerified) return { kind: 'unknown' };
  if (cycles.some(c => ['reserved', 'researching', 'processing', 'uncertain'].includes(c.state))) return { kind: 'after_cycle' };
  if (configuration.initialRun === 'immediate' && !cycles.some(c => c.agreementRevision >= confirmationRevision)) return { kind: 'first' };
  if (cycles.some(c => c.tradingDate === schedule.tradingDate) && schedule.closesAt) {
    schedule = tradingMarketSchedule(configuration.market, new Date(Date.parse(schedule.closesAt) + 1));
    if (!schedule.nextOpenAt) return { kind: 'unknown' };
    schedule = tradingMarketSchedule(configuration.market, new Date(schedule.nextOpenAt));
  } else if (!schedule.isTradingDay && schedule.nextOpenAt) {
    schedule = tradingMarketSchedule(configuration.market, new Date(schedule.nextOpenAt));
  }
  if (!schedule.calendarVerified || !schedule.closesAt) return { kind: 'unknown' };
  return { kind: 'after_close', timezone: schedule.timezone,
    at: new Date(Date.parse(schedule.closesAt) + configuration.cadence.delayMinutes * 60000).toISOString() };
}

// An execution can settle after an account handoff. Its commission's immutable binding
// and the actual ledger row identify the original team, independently of today's binding.
export async function recentTeamFills(db: TeamDatabase, owner: string, teamId: string): Promise<TeamRunFill[]> {
  const rows = await db.execute<TeamRunFill & Record<string, unknown>>(sql`SELECT DISTINCT
    t.id, t.order_id AS "orderId", t.account_id AS "accountId", a.name AS "accountName",
    t.ticker, t.market, t.side, t.quantity::text, t.price::text, o.currency, t.created_at AS "createdAt"
    FROM team_research_links l
    JOIN team_commissions c ON c.id = l.commission_id AND c.team_id = l.team_id AND c.owner_id = l.owner_id
    JOIN team_account_bindings b ON b.id = c.binding_id AND b.owner_id = c.owner_id
      AND b.team_id = c.team_id AND b.account_id = c.account_id AND b.binding_revision = c.binding_revision
    JOIN team_decisions d ON d.id::text = l.metadata_json->>'decisionId' AND d.owner_id = c.owner_id
      AND d.team_id = c.team_id AND d.commission_id = c.id AND d.account_id = c.account_id
      AND d.event = 'adopt' AND d.basis_json->>'commissionId' = c.id::text
      AND d.basis_json->>'sessionId' = c.session_id::text AND d.basis_json->>'cycleId' = c.cycle_id::text
      AND d.proposal_id::text = coalesce(l.metadata_json->>'proposalId', d.proposal_id::text)
      AND d.proposal_revision::text = coalesce(l.metadata_json->>'proposalRevision', d.proposal_revision::text)
      AND d.basis_json->>'teamVersionId' = c.team_version_id::text
      AND d.basis_json->>'bindingId' = b.id::text AND d.basis_json->>'bindingRevision' = b.binding_revision::text
      AND d.basis_json->>'workKey' = l.work_key AND d.basis_json->>'acceptedAttemptId' = l.attempt_id
    JOIN paper_trades t ON t.id::text = l.target_id AND t.owner = c.owner_id AND t.account_id = c.account_id
      AND t.order_id::text = l.metadata_json->>'sourceId'
    JOIN paper_orders o ON o.id = t.order_id AND o.owner = t.owner AND o.account_id = t.account_id
    JOIN paper_accounts a ON a.id = t.account_id AND a.owner = t.owner
    WHERE l.owner_id = ${owner} AND l.team_id = ${teamId} AND l.kind = 'trade' AND l.relation = 'executed'
      AND l.metadata_json->>'sourceKind' = 'order'
    ORDER BY "createdAt" DESC, t.id DESC LIMIT 2`);
  return rows.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }));
}

export async function recentTeamResearch(tx: TeamDatabase, owner: string, teamId: string): Promise<TeamRunResearchResult> {
  const candidates = await tx.execute<Omit<TeamRunResearch, 'applied'> & {
    policyRevision: number | null; appliedAt: string | null;
  }>(sql`SELECT v.id AS "versionId", v.version, c.id AS "commissionId", v.title,
      left(r.summary, 360) AS summary, v.created_at AS "publishedAt",
      CASE WHEN cycle.id IS NULL THEN 'manual' ELSE 'automatic' END AS source,
      CASE WHEN cycle.state = 'applied' AND cycle.report_version_id = v.id THEN cycle.policy_revision END AS "policyRevision",
      cycle.updated_at AS "appliedAt"
    FROM team_research_links l
    JOIN team_commissions c ON c.id = l.commission_id AND c.owner_id = l.owner_id AND c.team_id = l.team_id
    JOIN team_account_bindings b ON b.id = c.binding_id AND b.owner_id = c.owner_id AND b.team_id = c.team_id
      AND b.account_id = c.account_id AND b.binding_revision = c.binding_revision
    JOIN council_sessions s ON s.id = c.session_id AND s.owner = c.owner_id AND s.deleted_at IS NULL
      AND s.team_commission_id = c.id
    JOIN council_reports r ON r.owner = s.owner AND r.session_id = s.id AND r.publication_outcome = 'succeeded'
      AND r.coverage->>'cycleId' = c.cycle_id::text AND r.id::text = l.metadata_json->>'reportId'
    JOIN research_document_versions v ON v.owner = c.owner_id AND v.id = r.research_version_id
      AND v.id::text = l.target_id AND v.version::text = l.target_revision
      AND v.source->>'type' = 'council' AND v.source->>'id' = r.id::text
      AND v.deleted_at IS NULL AND v.revoked_at IS NULL
    LEFT JOIN team_run_cycles cycle ON cycle.commission_id = c.id AND cycle.team_id = c.team_id AND cycle.owner_id = c.owner_id
    WHERE l.owner_id = ${owner} AND l.team_id = ${teamId} AND l.kind = 'report_version' AND l.relation = 'produced'
    ORDER BY v.created_at DESC, v.id DESC LIMIT 8`);
  for (const candidate of candidates) {
    try {
      await assertReportVersionSources(tx, owner, [{ versionId: candidate.versionId }], new Date());
    } catch (error) {
      if (error instanceof HttpException && [400, 404, 409, 422].includes(error.getStatus())) continue;
      throw error;
    }
    const { policyRevision, appliedAt, publishedAt, ...report } = candidate;
    return { report: { ...report, publishedAt: new Date(publishedAt).toISOString(),
      applied: policyRevision !== null && appliedAt ? { revision: policyRevision, at: new Date(appliedAt).toISOString() } : null }, visibilityLimited: false };
  }
  return { report: null, visibilityLimited: candidates.length > 0 };
}
