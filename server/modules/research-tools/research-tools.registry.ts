import { z } from 'zod';
import type { ResearchToolDescriptor } from '@shared/research-tools.interface';
import type { CouncilResearchKind } from '@shared/council.interface';
import type { AgentToolEffect } from '@shared/agent-tooling.interface';
import { dataFinancialOperations, dataFinancialProviders } from '@shared/data-library.interface';

export const RESULT_LIMIT_BYTES = 24_000;
const emptyInput = z.strictObject({});
const evidenceInput = z.strictObject({ limit: z.number().int().min(1).max(10).optional() });
const computeInput = z.strictObject({ datasetVersionIds: z.array(z.uuid()).min(1).max(20),
  parameters: z.record(z.string(), z.unknown()), seed: z.number().int().min(0).max(2_147_483_647),
  maxRuntimeMs: z.number().int().min(1000).max(120_000).optional() });
const output = z.strictObject({
  status: z.enum(['succeeded', 'partial', 'unavailable', 'failed', 'cancelled']),
  data: z.record(z.string().max(64), z.json()),
  sources: z.array(z.strictObject({ title: z.string().max(160), url: z.string().max(2000).optional(),
    fetchedAt: z.string().max(40) })).max(12),
  asOf: z.string().max(40), truncated: z.boolean(), errorCode: z.string().max(80).optional(),
});

export interface ResearchToolDefinition {
  effect?: AgentToolEffect;
  name: string;
  description: string;
  source: string;
  timeoutMs: number;
  input: z.ZodType;
  kind?: CouncilResearchKind;
  openWorld: boolean;
}

/** The allowlist is also the schema registry used at the execution boundary. */
export const RESEARCH_TOOLS: readonly ResearchToolDefinition[] = [
  { name: 'read_dataset_summary', description: 'Read a specific owned immutable dataset, its exact content hash and a labelled sample. Calculations must consume the complete dataset version, never reconstruct it from this sample.',
    source: 'Owner versioned dataset', timeoutMs: 10_000, openWorld: false,
    input: z.strictObject({ datasetVersionId: z.uuid(), sampleSize: z.number().int().min(0).max(12).optional() }) },
  { name: 'run_statistics', description: 'Run a fixed QuantStats statistics template in an explicitly configured isolated E2B sandbox. Uses complete saved datasets and current data-export policy; provider fees can be unknown. Positive-period ratio is not trade win rate.',
    source: 'Versioned statistics computation', timeoutMs: 120_000, effect: 'compute', openWorld: true, input: computeInput },
  { name: 'run_backtest', description: 'Run only a reviewed fixed Backtrader template with immutable price/calendar/rules/actions/FX/universe datasets. Validated mode rejects incomplete inputs and uses unadjusted execution prices and next tradable session. No paper or real orders are written.',
    source: 'Hypothetical fixed-template backtest', timeoutMs: 120_000, effect: 'compute', openWorld: true, input: computeInput },
  { name: 'browser_research', description: 'Explore public pages in an anonymous run-scoped browser. Read-only navigation, native disclosure expansion, pagination and screenshots only. Login state from saved sources is not imported; use read_browser_source for those sources.',
    source: 'Isolated local browser', timeoutMs: 60_000, kind: 'web', openWorld: true,
    input: z.strictObject({ action: z.enum(['navigate','read','next','expand','screenshot','close']), url: z.url().max(2000).optional(),
      index: z.number().int().min(0).max(99).optional() }) },
  { name: 'read_browser_source', description: 'Collect rendered main content from an enabled saved browser source owned by this account. Uses its separately connected browser session; never accepts a URL, credentials or browser control commands. Returns exact source/version citations and visible login/network failures.',
    source: 'Owner-connected browser source', timeoutMs: 60_000, openWorld: true,
    input: z.strictObject({ sourceId: z.uuid() }) },
  { name: 'search_data_library', description: 'Search owner-imported source documents. Citations keep immutable source and version identifiers; imported text is untrusted evidence, not an accepted investment thesis.',
    source: 'Owner data library', timeoutMs: 10_000, openWorld: false,
    input: z.strictObject({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(10).optional() }) },
  { name: 'get_financial_source_data', description: 'Read configured provider data for this assigned security only. Preserve timestamps and end-of-day freshness; never use as an execution quote.',
    source: 'Configured financial-data provider', timeoutMs: 25_000, openWorld: true,
    input: z.strictObject({ provider: z.enum(dataFinancialProviders), operation: z.enum(dataFinancialOperations),
      market: z.enum(['CN','HK','US']).optional(), exchange: z.string().max(16).optional(),
      from: z.string().max(10).optional(), to: z.string().max(10).optional(),
      adjustment: z.enum(['unadjusted','forward','backward']).optional() }) },
  { name: 'get_portfolio_quotes', description: 'Read quotes only for instruments in the frozen portfolio. Paginate the complete fixed instrument list; current live holdings never enlarge the scope.',
    source: 'Configured market-data provider', timeoutMs: 60_000, kind: 'price', openWorld: true,
    input: z.strictObject({ offset: z.number().int().min(0).max(10000).optional(), limit: z.number().int().min(1).max(10).optional() }) },
  { name: 'get_portfolio_financials', description: 'Query one exact instrument from the frozen portfolio. Supply an explicit exchange only when supported by the saved source; never infer an exchange from six digits. Complete datasets are stored separately from previews.',
    source: 'Configured financial provider', timeoutMs: 60_000, kind: 'financials', openWorld: true,
    input: z.strictObject({ instrumentId: z.string().min(4).max(40), provider: z.enum(dataFinancialProviders), operation: z.enum(dataFinancialOperations),
      exchange: z.string().max(16).optional(), from: z.string().max(10).optional(), to: z.string().max(10).optional(),
      adjustment: z.enum(['unadjusted','forward','backward']).optional() }) },
  { name: 'get_quotes', description: 'Latest available quote for this discussion ticker, with currency and retrieval time.',
    source: 'Configured market-data provider (exact provider is not reported)', timeoutMs: 20_000,
    input: emptyInput, openWorld: true },
  { name: 'get_financials', description: 'Verified reported financial evidence; missing fields remain explicit gaps.',
    source: 'Configured financial evidence providers and SEC filings', timeoutMs: 45_000,
    input: evidenceInput, kind: 'financials', openWorld: true },
  { name: 'get_valuation', description: 'Available sourced valuation evidence for this discussion ticker.',
    source: 'Configured valuation evidence provider', timeoutMs: 25_000,
    input: evidenceInput, kind: 'valuation', openWorld: true },
  { name: 'get_news', description: 'Available sourced company news; no inferred sentiment or fabricated headlines.',
    source: 'Configured company-news evidence provider', timeoutMs: 25_000,
    input: evidenceInput, kind: 'news', openWorld: true },
  { name: 'get_research_report', description: 'Recent saved research reports owned by this account for the assigned ticker.',
    source: 'Saved account research reports', timeoutMs: 10_000,
    input: z.strictObject({ limit: z.number().int().min(1).max(3).optional() }), openWorld: false },
  { name: 'get_discussion_context', description: 'Bounded public discussion history and dated saved evidence from this session.',
    source: 'Assigned discussion session', timeoutMs: 10_000,
    input: z.strictObject({ limit: z.number().int().min(1).max(12).optional() }), openWorld: false },
  { name: 'get_research_memory', description: 'Refreshed owner-owned pinned historical opinions; respects recall preferences, exclusions and deletions.',
    source: 'Saved account research memory', timeoutMs: 10_000,
    input: z.strictObject({ asOf: z.iso.datetime({ offset: true }).optional() }), openWorld: false },
  { name: 'get_peer_comparison', description: 'Quotes and financial evidence for the primary company and at most three server-frozen peers; incompatible periods and currencies remain explicit.',
    source: 'Configured quote and financial evidence providers', timeoutMs: 60_000, input: emptyInput, openWorld: true },
  { name: 'get_valuation_scenarios', description: 'Calculate total equity values from verified annual earnings/revenue or dated book value and explicit assumed multiples. No invented shares or per-share upside.',
    source: 'Configured financial evidence providers; deterministic application arithmetic', timeoutMs: 55_000,
    input: z.strictObject({ metric: z.enum(['earnings', 'revenue', 'book_value']), multiples: z.strictObject({
      bear: z.number().finite().min(0).max(1000), base: z.number().finite().min(0).max(1000),
      bull: z.number().finite().min(0).max(1000) }) }), openWorld: true },
  { name: 'search_research_web', description: 'Search public sources for this ticker using the existing task and daily request budgets.',
    source: 'Configured DeepSeek web search', timeoutMs: 25_000,
    input: z.strictObject({ query: z.string().trim().max(200).regex(/^[^\u0000-\u001f]*$/u).optional() }),
    kind: 'web', openWorld: true },
];

export function toolDescriptor(tool: ResearchToolDefinition): ResearchToolDescriptor {
  return { name: tool.name, description: tool.description, effect: tool.effect ?? 'read', timeoutMs: tool.timeoutMs, maxOutputBytes: RESULT_LIMIT_BYTES,
    inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(output) as Record<string, unknown>,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: tool.openWorld } };
}

export function validRequest(value: unknown): value is { callId: string; name: string; arguments: Record<string, unknown> } {
  return z.strictObject({ callId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/u),
    name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()) }).safeParse(value).success;
}

export function validOutput(value: unknown): boolean { return output.safeParse(value).success; }
