import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { paperAccounts, paperSnapshots } from '../../database/schema';
import { portfolioValuePoints } from '../../database/portfolio-value-points.schema';
import { simulationSeeds } from '../../database/simulation-experiments.schema';
import { simulationValuationBaselines } from '../../database/user-strategy-runtime.schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import type { PortfolioComparisonPeriod, PortfolioComparisonSeries, PortfolioComparisonView } from '../../../shared/portfolio-comparison.interface';
import { comparisonObservations, comparisonPeriodStart, type SavedComparisonObservation } from './portfolio-comparison.rules';
import { paperRiskDay } from './paper-risk-day';
import { isSimulationReviewModelNote } from '../../../shared/simulation-experiment.interface';
import { PortfolioCurrentMarksService } from '../portfolio-history/portfolio-current-marks.service';

const periods: PortfolioComparisonPeriod[] = ['1D', '1W', '1M', '3M', 'YTD', 'ALL'];
const finite = (value: string | null): number | null => value !== null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

@Injectable()
export class PortfolioComparisonService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() private readonly currentMarks?: PortfolioCurrentMarksService) {}

  /** Saved NAV stays read-only; separate present marks may enqueue shared market-cache refreshes. */
  async read(owner: string, periodInput = '1M', accountIds?: string, at = new Date()): Promise<PortfolioComparisonView> {
    if (!periods.includes(periodInput as PortfolioComparisonPeriod)) throw new BadRequestException('COMPARISON_PERIOD_INVALID');
    const period = periodInput as PortfolioComparisonPeriod;
    const from = comparisonPeriodStart(period, at);
    const requested = accountIds ? [...new Set(accountIds.split(',').filter(Boolean))] : null;
    if (requested && (requested.length > 30 || requested.some(id => id !== 'real' && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(id)))) {
      throw new BadRequestException('COMPARISON_ACCOUNTS_INVALID');
    }
    const granularity = period === '1D' ? 'observations' : 'daily';
    const marks = await this.currentMarks?.read(owner, requested ?? undefined, at);
    return this.db.transaction(async tx => {
      const accounts = await tx.select().from(paperAccounts).where(eq(paperAccounts.owner, owner)).orderBy(asc(paperAccounts.createdAt), asc(paperAccounts.id));
      if (requested?.some(id => id !== 'real' && !accounts.some(account => account.id === id))) throw new NotFoundException('COMPARISON_ACCOUNT_NOT_FOUND');
      const selected = accounts.filter(account => requested ? requested.includes(account.id) : account.isActive);
      const ids = selected.map(account => account.id);
      const realFilter = and(eq(portfolioValuePoints.owner, owner), gte(portfolioValuePoints.capturedAt, from), lte(portfolioValuePoints.capturedAt, at));
      const [real, latestReal, snapshots, seeds, policies, baselines] = await Promise.all([
        requested && !requested.includes('real') ? []
          : tx.select().from(portfolioValuePoints).where(realFilter).orderBy(asc(portfolioValuePoints.capturedAt)),
        tx.select().from(portfolioValuePoints).where(and(eq(portfolioValuePoints.owner, owner), lte(portfolioValuePoints.capturedAt, at))).orderBy(desc(portfolioValuePoints.capturedAt)).limit(1),
        ids.length ? tx.select().from(paperSnapshots).where(and(eq(paperSnapshots.owner, owner), inArray(paperSnapshots.accountId, ids), or(isNull(paperSnapshots.valuedAt), lte(paperSnapshots.valuedAt, at)))).orderBy(asc(paperSnapshots.snapshotDate)) : [],
        ids.length ? tx.select().from(simulationSeeds).where(and(eq(simulationSeeds.owner, owner), inArray(simulationSeeds.accountId, ids))) : [],
        ids.length ? tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), inArray(investmentPolicies.accountId, ids))) : [],
        ids.length ? tx.select().from(simulationValuationBaselines).where(and(eq(simulationValuationBaselines.owner, owner), inArray(simulationValuationBaselines.accountId, ids))) : [],
      ]);
      const series: PortfolioComparisonSeries[] = [];
      if (!requested || requested.includes('real')) {
        const observations: SavedComparisonObservation[] = real.map(point => ({
          timestamp: point.capturedAt.toISOString(), date: point.dateKey,
          equityUsd: point.complete ? finite(point.totalValueUsd) : null,
          continuity: point.estimated ? null : createHash('sha256').update(JSON.stringify([
            [...point.externalFlows].sort((a, b) => a.id.localeCompare(b.id)),
            [...point.cashCheckpoints].sort((a, b) => a.currency.localeCompare(b.currency)),
            [...point.positionCheckpoints].sort((a, b) => a.id.localeCompare(b.id)),
          ])).digest('hex'),
          gaps: [...(!point.complete ? ['INCOMPLETE_VALUATION'] : []), ...(point.estimated ? ['ESTIMATED_VALUATION'] : [])],
        }));
        const points = comparisonObservations(observations, granularity);
        const latest = latestReal[0];
        series.push(this.summary({ accountId: 'real', name: 'Real portfolio', kind: 'real', colorIndex: -1, status: 'real', createdAt: null,
          valuationAsOf: latest?.capturedAt.toISOString() ?? null, equityUsd: latest?.complete ? finite(latest.totalValueUsd) : null,
          strategyCount: 0, points, gaps: latest && !latest.complete ? ['INCOMPLETE_VALUATION'] : [] }));
      }
      for (const account of selected) {
        const seed = baselines.find(row => row.accountId === account.id)?.seed ?? seeds.find(row => row.accountId === account.id)?.seed;
        const policy = policies.find(row => row.accountId === account.id);
        const trustedOpening = seed && finite(seed.initialEquityUsd) !== null
          && seed.cash.every(cash => cash.availabilityKnown)
          && seed.gaps.every(isSimulationReviewModelNote);
        const seedAt = seed?.valuationStartedAt ?? seed?.capturedAt;
        const rows = snapshots.filter(row => row.accountId === account.id);
        const observations: SavedComparisonObservation[] = rows.map(row => ({
          timestamp: row.valuedAt?.toISOString() ?? `${row.snapshotDate}T00:00:00.000Z`, date: row.snapshotDate,
          equityUsd: row.valuedAt ? finite(row.equity) : null,
          continuity: trustedOpening && seedAt && row.valuedAt && row.valuedAt.getTime() >= Date.parse(seedAt)
            ? `simulation:${account.id}` : null,
          gaps: row.valuedAt ? [] : ['VALUATION_TIMESTAMP_UNKNOWN'],
        }));
        if (seedAt && trustedOpening && !observations.some(point => point.timestamp === seedAt)) {
          observations.push({ timestamp: seedAt, date: paperRiskDay(new Date(seedAt), policy?.baseConfig.timezone ?? 'Asia/Shanghai'), equityUsd: finite(seed.initialEquityUsd), continuity: `simulation:${account.id}`, gaps: [] });
        }
        const valid = observations.filter(point => Date.parse(point.timestamp) <= at.getTime()).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        const latest = valid.at(-1);
        const points = comparisonObservations(valid.filter(point => Date.parse(point.timestamp) >= from.getTime()), granularity);
        series.push(this.summary({ accountId: account.id, name: account.name, kind: 'simulation', colorIndex: accounts.findIndex(item => item.id === account.id),
          status: !account.isActive ? 'archived' : policy?.status ?? (account.botEnabled ? 'running' : 'paused'), createdAt: account.createdAt.toISOString(),
          valuationAsOf: latest?.equityUsd !== null ? latest?.timestamp ?? null : null, equityUsd: latest?.equityUsd ?? null,
          strategyCount: policy?.baseConfig.portfolio?.filter(item => item.enabled).length ?? (policy?.baseConfig.userStrategy ? 1 : 0),
          points, gaps: latest?.gaps ?? ['NO_OBSERVATIONS'] }));
      }
      return { currency: 'USD', period, from: from.toISOString(), to: at.toISOString(), granularity, methodology: 'saved_valuations_no_external_flows',
        series: series.map(item => ({ ...item, ...(marks?.[item.accountId] ? { currentMark: marks[item.accountId] } : {}) })) };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  private summary(input: Omit<PortfolioComparisonSeries, 'returnPct' | 'returnFrom'>): PortfolioComparisonSeries {
    const last = input.points.at(-1);
    const gaps = [...new Set([...input.gaps, ...input.points.flatMap(point => point.gaps)])];
    if (input.points.filter(point => point.equityUsd !== null).length < 2) gaps.push('INSUFFICIENT_OBSERVATIONS');
    return { ...input, returnPct: last?.returnPct ?? null,
      returnFrom: input.points.find(point => point.returnPct !== null)?.timestamp ?? null, gaps };
  }
}
