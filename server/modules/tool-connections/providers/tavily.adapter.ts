import type { ToolAdapterConnection, ToolAdapterContext, TrustedToolAdapter } from '../tool-adapter.contract';
import type { AgentToolDescriptor } from '../../../../shared/agent-tooling.interface';
import { nativeDescriptor, ProviderHttp, SEARCH_INPUT_SCHEMA, searchRequest, searchResult } from './search-provider.contract';

/** Official REST endpoint is fixed; discovery is local schema inspection and costs no provider call. */
export class TavilyAdapter implements TrustedToolAdapter {
  readonly provider = 'tavily';
  constructor(private readonly http: ProviderHttp) {}
  async discover(connection: ToolAdapterConnection) {
    return [nativeDescriptor(connection.id, 'search', SEARCH_INPUT_SCHEMA, 'Search public web sources with Tavily. Dates are provider supplied and may be unknown.')];
  }
  async invoke(connection: ToolAdapterConnection, _tool: AgentToolDescriptor, args: Record<string, unknown>, context: ToolAdapterContext) {
    const request = searchRequest(args);
    await context.beforeDispatch?.();
    const value = await this.http.json('https://api.tavily.com/search', connection.secret,
      { query: request.query, max_results: request.topK, search_depth: 'basic', include_answer: false,
        include_raw_content: false, include_usage: true, ...(request.language ? { language: request.language } : {}),
        ...(request.from ? { start_date: request.from } : {}), ...(request.to ? { end_date: request.to } : {}),
        ...(request.domains ? { include_domains: request.domains } : {}) }, context.signal);
    return searchResult(this.provider, value, request.topK);
  }
}
