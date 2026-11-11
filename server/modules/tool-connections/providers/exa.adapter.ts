import { ToolAdapterError, type ToolAdapterConnection, type ToolAdapterContext, type TrustedToolAdapter } from '../tool-adapter.contract';
import type { AgentToolDescriptor } from '../../../../shared/agent-tooling.interface';
import { nativeDescriptor, ProviderHttp, SEARCH_INPUT_SCHEMA, searchRequest, searchResult } from './search-provider.contract';

export class ExaAdapter implements TrustedToolAdapter {
  readonly provider = 'exa';
  constructor(private readonly http: ProviderHttp) {}
  async discover(connection: ToolAdapterConnection) {
    return [nativeDescriptor(connection.id, 'search', SEARCH_INPUT_SCHEMA, 'Search public web sources with Exa highlights. Publication date may be unknown.')];
  }
  async invoke(connection: ToolAdapterConnection, _tool: AgentToolDescriptor, args: Record<string, unknown>, context: ToolAdapterContext) {
    const request = searchRequest(args);
    // Exa has no equivalent guaranteed language filter: reject rather than silently ignore an asserted filter.
    if (request.language) throw new ToolAdapterError('SEARCH_LANGUAGE_FILTER_UNSUPPORTED');
    await context.beforeDispatch?.();
    const value = await this.http.json('https://api.exa.ai/search', connection.secret,
      { query: request.query, numResults: request.topK, type: 'auto', contents: { highlights: true },
        ...(request.from ? { startPublishedDate: `${request.from}T00:00:00.000Z` } : {}),
        ...(request.to ? { endPublishedDate: `${request.to}T23:59:59.999Z` } : {}),
        ...(request.domains ? { includeDomains: request.domains } : {}) }, context.signal, 'x-api-key');
    return searchResult(this.provider, value, request.topK);
  }
}
