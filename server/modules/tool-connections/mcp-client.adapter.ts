import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AgentToolDescriptor } from '../../../shared/agent-tooling.interface';
import { toolHash, validateToolSchema } from './tool-catalog.service';
import { ToolAdapterError, type ToolAdapterConnection, type ToolAdapterContext,
  type ToolAdapterResult, type TrustedToolAdapter } from './tool-adapter.contract';
import { ToolTransportPolicy } from './tool-transport-policy';

/** One official client, one transport, no request retry or sampling/elicitation capability. */
export class McpClientAdapter implements TrustedToolAdapter {
  readonly provider = 'mcp';
  private readonly changedCatalogs = new WeakSet<Client>();
  constructor(private readonly policy: ToolTransportPolicy) {}

  private async client(connection: ToolAdapterConnection): Promise<Client> {
    if (!connection.endpoint) throw new ToolAdapterError('MCP_ENDPOINT_REQUIRED');
    const endpoint = await this.policy.normalizeEndpoint(connection.endpoint);
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { redirect: 'error', headers: connection.secret ? { Authorization: `Bearer ${connection.secret}` } : {} },
      fetch: (input, init) => this.policy.fetch(String(input), init, endpoint),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    const client = new Client({ name: 'squabble-controlled-client', version: '1.0.0' }, { capabilities: {} });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { this.changedCatalogs.add(client); });
    try { await client.connect(transport, { timeout: 15_000 }); return client; }
    catch (error) {
      await client.close();
      if (error && typeof error === 'object' && 'code' in error && error.code === 401) throw new ToolAdapterError('TOOL_AUTHORIZATION_REQUIRED');
      throw new ToolAdapterError('MCP_DISCOVERY_UNAVAILABLE');
    }
  }

  private async list(client: Client, connectionId: string): Promise<AgentToolDescriptor[]> {
    this.changedCatalogs.delete(client);
    const tools: AgentToolDescriptor[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 15_000 });
      for (const remote of result.tools) {
        if (!/^[a-zA-Z0-9_.-]{1,100}$/u.test(remote.name) || seen.has(remote.name) || tools.length >= 100) {
          throw new ToolAdapterError('MCP_CATALOG_RESTRICTED');
        }
        seen.add(remote.name);
        const schema = validateToolSchema(remote.inputSchema);
        const outputSchema = remote.outputSchema ? validateToolSchema(remote.outputSchema) : null;
        const description = remote.description || remote.name;
        if (description.length > 4000) throw new ToolAdapterError('MCP_CATALOG_RESTRICTED');
        tools.push({ id: `${connectionId}:${remote.name}`, connectionId, catalogVersionId: '',
          schemaHash: toolHash({ name: remote.name, description, inputSchema: schema, outputSchema }), name: remote.name,
          description, inputSchema: schema, effect: 'external_write', dataClasses: ['public'],
          timeoutMs: 30_000, maxOutputBytes: 1_000_000, supportsCancellation: false, supportsStatusLookup: false,
          remoteIdempotency: 'unknown' });
      }
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) throw new ToolAdapterError('MCP_CATALOG_RESTRICTED');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return tools;
  }

  async discover(connection: ToolAdapterConnection): Promise<AgentToolDescriptor[]> {
    const client = await this.client(connection);
    try { return await this.list(client, connection.id); }
    catch (error) {
      if (error instanceof ToolAdapterError || (error instanceof Error && error.message === 'SCHEMA_RESTRICTED')) throw error;
      throw new ToolAdapterError('MCP_DISCOVERY_UNAVAILABLE');
    } finally { await client.close(); }
  }

  async invoke(connection: ToolAdapterConnection, tool: AgentToolDescriptor,
    args: Record<string, unknown>, context: ToolAdapterContext): Promise<ToolAdapterResult> {
    const client = await this.client(connection);
    let dispatched = false;
    try {
      const current = (await this.list(client, connection.id)).find(item => item.id === tool.id);
      if (!current || current.schemaHash !== tool.schemaHash || this.changedCatalogs.has(client)) throw new ToolAdapterError('TOOL_RECONFIRMATION_REQUIRED');
      await context.beforeDispatch?.();
      context.signal?.throwIfAborted();
      dispatched = true;
      const result = await client.callTool({ name: tool.name, arguments: args }, undefined,
        { signal: context.signal, timeout: tool.timeoutMs, maxTotalTimeout: tool.timeoutMs });
      if (Buffer.byteLength(JSON.stringify(result)) > tool.maxOutputBytes) throw new ToolAdapterError('TOOL_OUTPUT_LIMIT', true);
      const receipt = { provider: 'mcp', state: 'completed' as const };
      await context.onReceipt?.(receipt);
      return { output: result, receipt, observedAt: new Date().toISOString(), dataAsOf: null, usage: null };
    } catch (error) {
      if (error instanceof ToolAdapterError) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === 401) throw new ToolAdapterError('TOOL_AUTHORIZATION_REQUIRED', dispatched);
      throw new ToolAdapterError(dispatched ? 'TOOL_PROVIDER_UNKNOWN' : 'MCP_DISCOVERY_UNAVAILABLE', dispatched);
    } finally { await client.close(); }
  }
}
