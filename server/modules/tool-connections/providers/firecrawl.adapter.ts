import type { AgentToolDescriptor } from '../../../../shared/agent-tooling.interface';
import { ToolAdapterError, type ToolAdapterConnection, type ToolAdapterContext,
  type ToolAdapterResult, type ToolRemoteReceipt, type TrustedToolAdapter } from '../tool-adapter.contract';
import { nativeDescriptor, ProviderHttp } from './search-provider.contract';
import { ToolTransportPolicy } from '../tool-transport-policy';

const SCRAPE_SCHEMA = { type: 'object', additionalProperties: false, required: ['url'],
  properties: { url: { type: 'string', maxLength: 500, format: 'uri' } } };
const CRAWL_SCHEMA = { type: 'object', additionalProperties: false, required: ['url', 'maxPages', 'maxDepth', 'maxCredits'],
  properties: { url: { type: 'string', maxLength: 500, format: 'uri' }, maxPages: { type: 'integer', minimum: 1, maximum: 20 },
    maxDepth: { type: 'integer', minimum: 0, maximum: 3 }, maxCredits: { type: 'integer', minimum: 1, maximum: 20 } } };

export class FirecrawlAdapter implements TrustedToolAdapter {
  readonly provider = 'firecrawl';
  constructor(private readonly http: ProviderHttp) {}
  async discover(connection: ToolAdapterConnection) {
    const crawl = nativeDescriptor(connection.id, 'crawl', CRAWL_SCHEMA, 'Start a bounded public same-domain crawl; returns a remote job for explicit status lookup.');
    crawl.supportsStatusLookup = true;
    crawl.supportsCancellation = true;
    return [nativeDescriptor(connection.id, 'scrape', SCRAPE_SCHEMA, 'Read public URL markdown through Firecrawl.'), crawl];
  }
  async invoke(connection: ToolAdapterConnection, tool: AgentToolDescriptor, args: Record<string, unknown>, context: ToolAdapterContext): Promise<ToolAdapterResult> {
    if (typeof args.url !== 'string') throw new ToolAdapterError('INVALID_TOOL_ARGUMENTS');
    // This is a provider-side fetch: do not allow registered internal endpoints as crawl targets.
    const target = await new ToolTransportPolicy([]).normalizeEndpoint(args.url);
    const crawl = tool.name === 'crawl';
    if (!['crawl', 'scrape'].includes(tool.name) || Object.keys(args).some(key => !Object.keys(crawl ? CRAWL_SCHEMA.properties : SCRAPE_SCHEMA.properties).includes(key))) {
      throw new ToolAdapterError('INVALID_TOOL_ARGUMENTS');
    }
    if (crawl && (!Number.isInteger(args.maxPages) || Number(args.maxPages) < 1 || Number(args.maxPages) > 20
      || !Number.isInteger(args.maxDepth) || Number(args.maxDepth) < 0 || Number(args.maxDepth) > 3
      || !Number.isInteger(args.maxCredits) || Number(args.maxCredits) < Number(args.maxPages) || Number(args.maxCredits) > 20)) {
      throw new ToolAdapterError('INVALID_TOOL_ARGUMENTS');
    }
    await context.beforeDispatch?.();
    const output = await this.http.json(`https://api.firecrawl.dev/v2/${crawl ? 'crawl' : 'scrape'}`, connection.secret,
      crawl ? { url: target, limit: args.maxPages, maxDiscoveryDepth: args.maxDepth, allowExternalLinks: false,
        allowSubdomains: false, scrapeOptions: { formats: ['markdown'], onlyMainContent: true, proxy: 'basic' } }
        : { url: target, formats: ['markdown'], onlyMainContent: true, proxy: 'basic' }, context.signal);
    const receipt: ToolRemoteReceipt = { provider: this.provider, state: crawl ? 'running' : 'completed' };
    if (crawl) {
      if (typeof output.id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/u.test(output.id)) throw new ToolAdapterError('TOOL_PROVIDER_UNKNOWN', true);
      receipt.remoteJobId = output.id;
    }
    await context.onReceipt?.(receipt);
    return { output, receipt, observedAt: new Date().toISOString(), dataAsOf: null, usage: null };
  }
  async status(connection: ToolAdapterConnection, remoteJobId: string, signal?: AbortSignal): Promise<ToolAdapterResult> {
    if (!/^[a-zA-Z0-9_-]{1,120}$/u.test(remoteJobId)) throw new ToolAdapterError('REMOTE_JOB_INVALID');
    const output = await this.http.json(`https://api.firecrawl.dev/v2/crawl/${remoteJobId}`, connection.secret, null, signal, 'Authorization', 'GET');
    const state = output.status === 'completed' ? 'completed' : output.status === 'cancelled' ? 'cancelled'
      : ['scraping', 'queued'].includes(String(output.status)) ? 'running' : 'unknown';
    const credits = typeof output.creditsUsed === 'number' && Number.isFinite(output.creditsUsed) ? String(output.creditsUsed) : null;
    return { output, receipt: { provider: this.provider, state, remoteJobId }, observedAt: new Date().toISOString(), dataAsOf: null,
      usage: [{ quantity: credits, unit: 'credits', amount: null, currency: null, known: credits !== null, priceVersionId: null }] };
  }
  async cancel(connection: ToolAdapterConnection, remoteJobId: string, signal?: AbortSignal): Promise<ToolAdapterResult> {
    if (!/^[a-zA-Z0-9_-]{1,120}$/u.test(remoteJobId)) throw new ToolAdapterError('REMOTE_JOB_INVALID');
    // An acknowledged cancel is not proof that the remote work stopped. Always query provider fact afterwards.
    try { await this.http.json(`https://api.firecrawl.dev/v2/crawl/${remoteJobId}`, connection.secret, null, signal, 'Authorization', 'DELETE'); }
    catch { return { output: null, receipt: { provider: this.provider, state: 'unknown', remoteJobId },
      observedAt: new Date().toISOString(), dataAsOf: null, usage: null }; }
    try { return await this.status(connection, remoteJobId, signal); }
    catch { return { output: null, receipt: { provider: this.provider, state: 'unknown', remoteJobId },
      observedAt: new Date().toISOString(), dataAsOf: null, usage: null }; }
  }
}
