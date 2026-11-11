import { ToolAdapterError, type ToolAdapterResult } from '../tool-adapter.contract';
import type { AgentToolDescriptor } from '../../../../shared/agent-tooling.interface';
import { toolHash } from '../tool-catalog.service';
import { ToolTransportPolicy } from '../tool-transport-policy';

export interface SearchRequest {
  query: string; topK: number; language?: string; from?: string; to?: string; domains?: string[];
}
export interface SearchSource {
  title: string; url: string; snippet: string; publishedAt: string | null; observedAt: string;
}
export const SEARCH_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['query', 'topK'],
  properties: { query: { type: 'string', minLength: 1, maxLength: 2000 }, topK: { type: 'integer', minimum: 1, maximum: 10 },
    language: { type: 'string', enum: ['zh', 'en'] }, from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, domains: { type: 'array', maxItems: 10,
      items: { type: 'string', pattern: '^[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$', maxLength: 253 } } },
};

export function nativeDescriptor(connectionId: string, name: string, inputSchema: Record<string, unknown>, description: string): AgentToolDescriptor {
  return { id: `${connectionId}:${name}`, connectionId, catalogVersionId: '', name, description, inputSchema,
    schemaHash: toolHash({ name, inputSchema, description }), effect: 'read', dataClasses: ['public'],
    timeoutMs: 30_000, maxOutputBytes: 1_000_000, supportsCancellation: false, supportsStatusLookup: false,
    remoteIdempotency: 'unsupported' };
}

export function searchRequest(value: Record<string, unknown>): SearchRequest {
  if (Object.keys(value).some(key => !Object.keys(SEARCH_INPUT_SCHEMA.properties).includes(key))
    || typeof value.query !== 'string' || !value.query.trim() || value.query.length > 2000
    || !Number.isInteger(value.topK) || Number(value.topK) < 1 || Number(value.topK) > 10) throw new ToolAdapterError('INVALID_TOOL_ARGUMENTS');
  if (value.language !== undefined && !['en', 'zh'].includes(String(value.language))) throw new ToolAdapterError('INVALID_TOOL_ARGUMENTS');
  for (const key of ['from', 'to']) if (value[key] !== undefined
    && (typeof value[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(String(value[key])))) throw new ToolAdapterError('INVALID_TOOL_ARGUMENTS');
  if (value.from && value.to && String(value.from) > String(value.to)) throw new ToolAdapterError('INVALID_TOOL_ARGUMENTS');
  if (value.domains !== undefined && (!Array.isArray(value.domains) || value.domains.length > 10
    || value.domains.some(domain => typeof domain !== 'string' || domain.length > 253 || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/u.test(domain)))) {
    throw new ToolAdapterError('INVALID_TOOL_ARGUMENTS');
  }
  return value as unknown as SearchRequest;
}

export class ProviderHttp {
  constructor(private readonly policy: ToolTransportPolicy) {}
  async json(url: string, secret: string | null, body: Record<string, unknown> | null,
    signal?: AbortSignal, apiKeyHeader = 'Authorization', method = 'POST'): Promise<Record<string, unknown>> {
    if (!secret) throw new ToolAdapterError('TOOL_AUTHORIZATION_REQUIRED');
    signal?.throwIfAborted();
    try {
      const response = await this.policy.fetch(url, { method, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30_000)]),
        headers: { [apiKeyHeader]: apiKeyHeader === 'Authorization' ? `Bearer ${secret}` : secret, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined }, url, 1_000_000);
      if (response.status === 401 || response.status === 403) throw new ToolAdapterError('TOOL_AUTHORIZATION_REQUIRED', true);
      if (!response.ok) throw new ToolAdapterError(response.status === 429 ? 'TOOL_PROVIDER_RATE_LIMITED' : 'TOOL_PROVIDER_ERROR', true);
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolAdapterError('TOOL_PROVIDER_INVALID_RESPONSE', true);
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ToolAdapterError) throw error;
      throw new ToolAdapterError('TOOL_PROVIDER_UNKNOWN', true);
    }
  }
}

export function searchResult(provider: string, value: Record<string, unknown>, topK: number): ToolAdapterResult {
  const observedAt = new Date().toISOString();
  const results = Array.isArray(value.results) ? value.results : [];
  const sources: SearchSource[] = [];
  for (const entry of results.slice(0, topK)) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    let url: URL;
    try { url = new URL(String(row.url)); } catch { continue; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
    const published = row.publishedDate ?? row.published_date;
    sources.push({ title: String(row.title ?? '').slice(0, 1000), url: url.href,
      snippet: String(row.content ?? (Array.isArray(row.highlights) ? row.highlights.join('\n') : '')).slice(0, 12_000),
      publishedAt: typeof published === 'string' && !Number.isNaN(Date.parse(published)) ? published : null, observedAt });
  }
  return { output: { provider, sources, coverage: { status: sources.length < topK ? 'partial' : 'unknown', returnedRows: sources.length,
    totalRows: null, missing: [] } }, receipt: { provider, state: 'completed' }, observedAt, dataAsOf: null,
    usage: [{ quantity: '1', unit: 'calls', amount: null, currency: null, known: true, priceVersionId: null }] };
}
