import type { AgentToolDescriptor, AgentToolEffect } from '../../../../shared/agent-tooling.interface';
import { ToolAdapterError, type ToolAdapterConnection, type ToolAdapterContext,
  type ToolAdapterResult, type TrustedToolAdapter } from '../tool-adapter.contract';
import { nativeDescriptor, ProviderHttp } from './search-provider.contract';
import { toolHash, validateToolSchema } from '../tool-catalog.service';

export const COMPOSIO_TOOL_POLICY: Readonly<Record<string, { toolkit: string; effect: AgentToolEffect }>> = Object.freeze({
  GOOGLEDRIVE_GET_FILE_METADATA: { toolkit: 'googledrive', effect: 'read' },
  GOOGLEDRIVE_GET_DOCUMENT: { toolkit: 'googledrive', effect: 'read' },
  NOTION_RETRIEVE_PAGE: { toolkit: 'notion', effect: 'read' },
  NOTION_CREATE_NOTION_PAGE: { toolkit: 'notion', effect: 'external_write' },
  GMAIL_SEND_EMAIL: { toolkit: 'gmail', effect: 'external_write' },
});
const BASE = 'https://backend.composio.dev/api/v3.1';

/** Direct REST supports a fixed per-tool policy, exact version and explicit connected account. */
export class ComposioAdapter implements TrustedToolAdapter {
  readonly provider = 'composio';
  constructor(private readonly http: ProviderHttp) {}

  private async account(connection: ToolAdapterConnection): Promise<{ id: string; toolkit: string }> {
    const id = connection.config?.connectedAccountId;
    if (!id || !/^[a-zA-Z0-9_-]{1,120}$/u.test(id) || !connection.externalUserId) throw new ToolAdapterError('COMPOSIO_ACCOUNT_REQUIRED');
    const account = await this.http.json(`${BASE}/connected_accounts/${id}`, connection.secret, null, undefined, 'x-api-key', 'GET');
    if (account.id !== id || account.user_id !== connection.externalUserId) throw new ToolAdapterError('COMPOSIO_ACCOUNT_OWNER_MISMATCH');
    if (account.status !== 'ACTIVE' || account.is_disabled === true) throw new ToolAdapterError('TOOL_AUTHORIZATION_REQUIRED');
    const toolkit = account.toolkit && typeof account.toolkit === 'object' && 'slug' in account.toolkit ? String(account.toolkit.slug) : '';
    return { id, toolkit };
  }

  private async descriptor(connection: ToolAdapterConnection, slug: string, version: string): Promise<AgentToolDescriptor> {
    if (!COMPOSIO_TOOL_POLICY[slug] || !/^\d{8}_\d+$/u.test(version)) throw new ToolAdapterError('COMPOSIO_TOOL_RESTRICTED');
    const remote = await this.http.json(`${BASE}/tools/${slug}?version=${encodeURIComponent(version)}`, connection.secret, null, undefined, 'x-api-key', 'GET');
    if (remote.slug !== slug || remote.version !== version || remote.is_deprecated === true) throw new ToolAdapterError('TOOL_RECONFIRMATION_REQUIRED');
    const schema = validateToolSchema(remote.input_parameters);
    const tool = nativeDescriptor(connection.id, slug, schema, String(remote.description ?? slug).slice(0, 4000));
    tool.effect = COMPOSIO_TOOL_POLICY[slug].effect;
    tool.schemaHash = toolHash({ slug, version, schema, description: tool.description, effect: tool.effect });
    tool.dataClasses = ['application'];
    return tool;
  }
  async discover(connection: ToolAdapterConnection): Promise<AgentToolDescriptor[]> {
    const account = await this.account(connection), descriptors: AgentToolDescriptor[] = [];
    const versions = connection.config?.toolVersions ?? {};
    if (!Object.keys(versions).length) throw new ToolAdapterError('COMPOSIO_PINNED_VERSION_REQUIRED');
    if (Object.keys(versions).length > 5) throw new ToolAdapterError('COMPOSIO_TOOL_RESTRICTED');
    for (const [slug, version] of Object.entries(versions)) {
      if (!COMPOSIO_TOOL_POLICY[slug] || COMPOSIO_TOOL_POLICY[slug].toolkit !== account.toolkit) throw new ToolAdapterError('COMPOSIO_TOOL_RESTRICTED');
      descriptors.push(await this.descriptor(connection, slug, version));
    }
    return descriptors;
  }
  async invoke(connection: ToolAdapterConnection, tool: AgentToolDescriptor, args: Record<string, unknown>, context: ToolAdapterContext): Promise<ToolAdapterResult> {
    const policy = COMPOSIO_TOOL_POLICY[tool.name], version = connection.config?.toolVersions?.[tool.name];
    if (!policy || !version || policy.effect !== tool.effect) throw new ToolAdapterError('COMPOSIO_TOOL_RESTRICTED');
    const account = await this.account(connection);
    if (account.toolkit !== policy.toolkit) throw new ToolAdapterError('COMPOSIO_TOOL_RESTRICTED');
    const current = await this.descriptor(connection, tool.name, version);
    if (current.schemaHash !== tool.schemaHash) throw new ToolAdapterError('TOOL_RECONFIRMATION_REQUIRED');
    // Connected-account/user authentication is always supplied at the envelope level by the backend.
    if (['connected_account_id', 'entity_id', 'custom_auth_params', 'custom_connection_data'].some(key => key in args)) throw new ToolAdapterError('INVALID_TOOL_ARGUMENTS');
    await context.beforeDispatch?.();
    const output = await this.http.json(`${BASE}/tools/execute/${tool.name}`, connection.secret,
      { connected_account_id: account.id, user_id: connection.externalUserId, version, arguments: args }, context.signal, 'x-api-key');
    if (output.successful !== true) throw new ToolAdapterError('COMPOSIO_EXECUTION_FAILED', true);
    const receipt = { provider: this.provider, state: 'completed' as const };
    await context.onReceipt?.(receipt);
    return { output: { data: output.data, logId: typeof output.log_id === 'string' ? output.log_id : null },
      receipt, usage: null, observedAt: new Date().toISOString(), dataAsOf: null };
  }
}
