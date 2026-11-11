import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComposioAdapter } from './composio.adapter';
import { ProviderHttp } from './search-provider.contract';
import { ToolTransportPolicy } from '../tool-transport-policy';

class ComposioFixturePolicy extends ToolTransportPolicy {
  owner = 'server-injected-owner'; active = true; dropped = false; schemaVersion = 1;
  requests: Array<{ url: string; method: string; body: Record<string, unknown> | null; key: string | null }> = [];
  async fetch(input: string | URL, init: RequestInit = {}) {
    const url = new URL(String(input));
    this.requests.push({ url: url.href, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null,
      key: new Headers(init.headers).get('x-api-key') });
    let value: unknown;
    if (url.pathname.includes('/connected_accounts/')) value = { id: 'ca_fixture', user_id: this.owner, toolkit: { slug: 'gmail' },
      status: this.active ? 'ACTIVE' : 'EXPIRED', state: { oauthToken: 'not-returned' } };
    else if (url.pathname.includes('/tools/execute/')) {
      if (this.dropped) throw new Error('provider executed, response was lost fixture-key');
      value = { successful: true, data: { messageId: 'message-fixture' }, log_id: 'log-fixture' };
    } else value = { slug: 'GMAIL_SEND_EMAIL', version: '20261105_00', description: `send email schema ${this.schemaVersion}`,
      input_parameters: { type: 'object', required: ['body', 'recipient_email'], additionalProperties: false,
        properties: { body: { type: 'string' }, recipient_email: { type: 'string' } } } };
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  }
}

test('Composio binds server owner/account and fixed write whitelist/version; no workbench/batch/shell proxy', async () => {
  const policy = new ComposioFixturePolicy([]), adapter = new ComposioAdapter(new ProviderHttp(policy));
  const connection = { id: 'fixture', provider: 'composio', endpoint: null, secret: 'fixture-key', externalUserId: 'server-injected-owner',
    config: { connectedAccountId: 'ca_fixture', toolVersions: { GMAIL_SEND_EMAIL: '20261105_00' } } };
  const [tool] = await adapter.discover(connection);
  assert.equal(tool.effect, 'external_write'); assert.equal(policy.requests.filter(request => request.method === 'POST').length, 0);
  const result = await adapter.invoke(connection, tool, { body: 'Full research note', recipient_email: 'test@example.org' }, { invocationId: '1' });
  const execution = policy.requests.find(request => request.url.includes('/tools/execute/'))!;
  assert.equal(execution.key, 'fixture-key'); assert.equal(execution.body?.connected_account_id, 'ca_fixture');
  assert.equal(execution.body?.user_id, 'server-injected-owner'); assert.equal(execution.body?.version, '20261105_00');
  assert.equal(result.receipt.state, 'completed'); assert.ok(!JSON.stringify(result).includes('not-returned'));
  await assert.rejects(adapter.discover({ ...connection, config: { ...connection.config, toolVersions: { COMPOSIO_REMOTE_BASH_TOOL: '20261105_00' } } }), /COMPOSIO_TOOL_RESTRICTED/u);
  policy.owner = 'other-owner';
  await assert.rejects(adapter.invoke(connection, tool, { body: 'x', recipient_email: 'test@example.org' }, { invocationId: '2' }), /COMPOSIO_ACCOUNT_OWNER_MISMATCH/u);
  assert.equal(policy.requests.filter(request => request.url.includes('/tools/execute/')).length, 1);
});

test('Composio rejects expired auth/schema changes and leaves sent lost writes unknown without retry', async () => {
  const policy = new ComposioFixturePolicy([]), adapter = new ComposioAdapter(new ProviderHttp(policy));
  const connection = { id: 'fixture', provider: 'composio', endpoint: null, secret: 'fixture-key', externalUserId: 'server-injected-owner',
    config: { connectedAccountId: 'ca_fixture', toolVersions: { GMAIL_SEND_EMAIL: '20261105_00' } } };
  const [tool] = await adapter.discover(connection);
  policy.schemaVersion++;
  await assert.rejects(adapter.invoke(connection, tool, { body: 'x', recipient_email: 'test@example.org' }, { invocationId: '1' }), /TOOL_RECONFIRMATION_REQUIRED/u);
  policy.schemaVersion--; policy.active = false;
  await assert.rejects(adapter.discover(connection), /TOOL_AUTHORIZATION_REQUIRED/u);
  policy.active = true; policy.dropped = true;
  await assert.rejects(adapter.invoke(connection, tool, { body: 'x', recipient_email: 'test@example.org' }, { invocationId: '2' }), /TOOL_PROVIDER_UNKNOWN/u);
  assert.equal(policy.requests.filter(request => request.url.includes('/tools/execute/')).length, 1);
});
