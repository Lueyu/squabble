import { z } from 'zod';
import type { ResearchToolDescriptor } from '@shared/research-tools.interface';
import type { CouncilResearchKind } from '@shared/council.interface';

export const RESULT_LIMIT_BYTES = 24_000;
const emptyInput = z.strictObject({});
const evidenceInput = z.strictObject({ limit: z.number().int().min(1).max(10).optional() });
const output = z.strictObject({
  status: z.enum(['succeeded', 'partial', 'unavailable', 'failed', 'cancelled']),
  data: z.record(z.string().max(64), z.json()),
  sources: z.array(z.strictObject({ title: z.string().max(160), url: z.string().max(2000).optional(),
    fetchedAt: z.string().max(40) })).max(12),
  asOf: z.string().max(40), truncated: z.boolean(), errorCode: z.string().max(80).optional(),
});

export interface ResearchToolDefinition {
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
  { name: 'search_research_web', description: 'Search public sources for this ticker using the existing task and daily request budgets.',
    source: 'Configured DeepSeek web search', timeoutMs: 25_000,
    input: z.strictObject({ query: z.string().trim().max(200).regex(/^[^\u0000-\u001f]*$/u).optional() }),
    kind: 'web', openWorld: true },
];

export function toolDescriptor(tool: ResearchToolDefinition): ResearchToolDescriptor {
  return { name: tool.name, description: tool.description,
    inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(output) as Record<string, unknown>,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: tool.openWorld } };
}

export function validRequest(value: unknown): value is { callId: string; name: string; arguments: Record<string, unknown> } {
  return z.strictObject({ callId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/u),
    name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()) }).safeParse(value).success;
}

export function validOutput(value: unknown): boolean { return output.safeParse(value).success; }
