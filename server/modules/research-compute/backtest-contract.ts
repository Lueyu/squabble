import { z } from 'zod';

const day = z.iso.date();
const backtestSchema = z.object({
  templateId: z.enum(['fixed-shares-v1', 'moving-average-v1']), instrumentId: z.string().min(1).max(160),
  quantity: z.number().int().positive().max(100_000_000), initialCash: z.number().finite().positive(),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/u), from: day, to: day, signalDate: day,
  signalAvailableAt: z.iso.datetime({ offset: true }), exitSignalDate: day.optional(),
  exitAvailableAt: z.iso.datetime({ offset: true }).optional(),
  universeVersionId: z.uuid(), priceDatasetVersionId: z.uuid(), calendarVersionId: z.uuid(),
  marketRulesVersionId: z.uuid(), corporateActionsVersionId: z.uuid(), fxVersionId: z.uuid(),
  benchmark: z.object({ datasetVersionId: z.uuid(), returnColumn: z.string().min(1).max(100) }).strict(),
  cashFlowDatasetVersionId: z.uuid().nullable(),
  outOfSampleFrom: day, frequency: z.literal('daily'), annualizationFactor: z.number().int().min(1).max(366),
  riskFreeRate: z.number().finite().gt(-1), window: z.number().int().min(2).max(200).optional(),
}).strict().superRefine((input, context) => {
  if (input.from > input.to || input.signalDate < input.from || input.signalDate > input.to
    || input.outOfSampleFrom < input.from || input.outOfSampleFrom > input.to
    || Boolean(input.exitSignalDate) !== Boolean(input.exitAvailableAt)
    || input.templateId === 'moving-average-v1' && !input.window) {
    context.addIssue({ code: 'custom', message: 'BACKTEST_CHRONOLOGY_OR_TEMPLATE_INVALID' });
  }
});
export type BacktestParameters = z.infer<typeof backtestSchema>;
export function parseBacktestParameters(value: unknown): BacktestParameters { return backtestSchema.parse(value); }
export function backtestDatasetIds(parameters: BacktestParameters): string[] {
  return [...new Set([parameters.universeVersionId, parameters.priceDatasetVersionId, parameters.calendarVersionId,
    parameters.marketRulesVersionId, parameters.corporateActionsVersionId, parameters.fxVersionId, parameters.benchmark.datasetVersionId,
    ...(parameters.cashFlowDatasetVersionId ? [parameters.cashFlowDatasetVersionId] : [])])];
}
