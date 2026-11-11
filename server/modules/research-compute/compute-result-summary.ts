import { z } from 'zod';

export interface ComputeResultSummary {
  kind: 'statistics' | 'backtest' | 'exploratory'; templateId: string;
  frequency: string | null;
  positivePeriodRatioBasis: string;
  metrics: Record<string, number | null>;
  coverage: { status: 'complete' | 'partial' | 'unknown'; observations: number; missingPeriods: number; missing: string[] };
  rowCounts: { navPoints: number; trades: number };
  latestNav: { date: string; value: number } | null;
  priceEvidence: { currency: string | null; unit: string | null; returnBasis: string | null;
    calendarVerified: boolean | null; limitations: string[]; endpointPriceChange?: number | null } | null;
  limitations: string[];
}
const metricNames = ['annualizationFactor', 'annualRiskFreeRate', 'totalReturn', 'annualizedReturn',
  'annualizedVolatility', 'sharpe', 'sortino', 'maxDrawdown', 'positivePeriodRatio', 'benchmarkTotalReturn'] as const;
const statisticsSchema = z.object({ templateId: z.string().min(1).max(100), templateVersion: z.literal('1'),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'annual', 'custom']),
  annualizationFactor: z.number().int().positive(), annualRiskFreeRate: z.number().finite(),
  observations: z.number().int().min(0), missingPeriods: z.number().int().min(0),
  coverage: z.enum(['complete', 'partial']),
}).catchall(z.unknown());
const priceSchema = z.object({ currency: z.string().max(10).nullable(), unit: z.string().max(100).nullable(),
  returnBasis: z.string().max(100), calendarVerified: z.boolean(), limitations: z.array(z.string().max(160)).max(32),
  endpointPriceChange: z.number().finite().nullable().optional() });

/** Only bounded facts from the saved, owner/source-validated JSON artifact enter the next model prompt. */
export function summarizeComputeResult(kind: ComputeResultSummary['kind'], templateId: string, value: unknown): ComputeResultSummary {
  const summary: ComputeResultSummary = { kind, templateId, metrics: {},
    frequency: null, positivePeriodRatioBasis: 'positive observed return periods / observed return periods; not trade win rate',
    coverage: { status: 'unknown', observations: 0, missingPeriods: 0, missing: [] },
    rowCounts: { navPoints: 0, trades: 0 }, latestNav: null, priceEvidence: null, limitations: [] };
  if (kind === 'exploratory') return { ...summary, limitations: ['EXPLORATORY_OUTPUT_NOT_VALIDATED'] };
  let raw: unknown = value;
  if (kind === 'backtest') {
    const result = z.object({ classification: z.literal('hypothetical-validated-template-backtest'),
      templateId: z.string().max(100), templateVersion: z.literal('1'),
      engine: z.object({ name: z.literal('Backtrader'), version: z.literal('1.9.78.123'), preload: z.literal(false),
        runonce: z.literal(false), cheatOnClose: z.literal(false), cheatOnOpen: z.literal(false) }),
      nav: z.array(z.unknown()).max(100000), trades: z.array(z.unknown()).max(100000),
      finalCash: z.number().finite(), finalQuantity: z.number().finite(), statistics: z.unknown(),
      coverage: z.object({ status: z.enum(['complete', 'partial']), missing: z.array(z.string().max(160)).max(32) }),
    }).parse(value);
    if (result.templateId !== templateId) throw new Error('COMPUTE_TEMPLATE_RESULT_MISMATCH');
    summary.rowCounts = { navPoints: result.nav.length, trades: result.trades.length };
    summary.latestNav = result.nav.length ? z.object({ date: z.iso.date(), value: z.number().finite() }).parse(result.nav.at(-1)) : null;
    summary.metrics.finalCash = result.finalCash; summary.metrics.finalQuantity = result.finalQuantity;
    summary.limitations = result.coverage.missing;
    raw = result.statistics;
  }
  const stats = statisticsSchema.parse(raw);
  summary.frequency = stats.frequency;
  if (kind === 'statistics' && stats.templateId !== templateId) throw new Error('COMPUTE_TEMPLATE_RESULT_MISMATCH');
  for (const key of metricNames) {
    const field = stats[key];
    if (field !== undefined && field !== null && (typeof field !== 'number' || !Number.isFinite(field))) throw new Error('COMPUTE_METRIC_INVALID');
    summary.metrics[key] = typeof field === 'number' ? field : null;
  }
  summary.coverage = { status: summary.limitations.length ? 'partial' : stats.coverage, observations: stats.observations,
    missingPeriods: stats.missingPeriods, missing: [...summary.limitations] };
  if (stats.priceEvidence !== undefined) {
    const evidence = priceSchema.parse(stats.priceEvidence);
    summary.priceEvidence = { currency: evidence.currency ?? null, unit: evidence.unit ?? null,
      returnBasis: evidence.returnBasis, calendarVerified: evidence.calendarVerified,
      limitations: evidence.limitations, endpointPriceChange: evidence.endpointPriceChange ?? null };
    summary.limitations.push(...summary.priceEvidence.limitations);
    summary.metrics.endpointPriceChange = summary.priceEvidence.endpointPriceChange ?? null;
  }
  summary.limitations = [...new Set(summary.limitations)];
  summary.coverage.missing = [...summary.limitations];
  if (summary.limitations.length || summary.coverage.missingPeriods > 0) summary.coverage.status = 'partial';
  if (Buffer.byteLength(JSON.stringify(summary)) > 16000) throw new Error('COMPUTE_SUMMARY_LIMIT');
  return summary;
}
