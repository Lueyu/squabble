import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { toolConnections, toolOAuthStates } from '../../database/tool-connections.schema';
import { ToolConnectionsService } from './tool-connections.service';
import { ToolOAuthService } from './tool-oauth.service';
import { ToolTransportPolicy } from './tool-transport-policy';
import { nativeDescriptor } from './providers/search-provider.contract';
import type { TrustedToolAdapter, ToolAdapterConnection, ToolAdapterContext } from './tool-adapter.contract';

async function database() {
  const url = process.env.TOOL_CONNECTIONS_TEST_DATABASE_URL;
  assert.ok(url, 'TOOL_CONNECTIONS_TEST_DATABASE_URL must name an isolated test PostgreSQL');
  const namespace = `tool_connections_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: namespace } });
  await admin.unsafe(`CREATE SCHEMA ${namespace}`);
  await client.unsafe(readFileSync('scripts/db/56_tool_connections.sql', 'utf8'));
  return { db: drizzle(client), close: async () => { await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); } };
}

class FixtureAdapter implements TrustedToolAdapter {
  readonly provider = 'mcp';
  calls = 0;
  async discover(connection: ToolAdapterConnection) {
    const descriptor = nativeDescriptor(connection.id, 'lookup', { type: 'object', additionalProperties: false,
      properties: { query: { type: 'string' } }, required: ['query'] }, 'fixture lookup');
    descriptor.effect = 'external_write';
    return [descriptor];
  }
  async invoke(connection: ToolAdapterConnection, _tool, args, context: ToolAdapterContext) {
    await context.beforeDispatch?.(); this.calls++;
    return { output: { args, echoed: connection.secret }, receipt: { provider: 'mcp', state: 'completed' as const },
      usage: null, observedAt: new Date().toISOString(), dataAsOf: null };
  }
}

test('connections persist encrypted credentials, isolate owners, require exact catalogs, freeze permissions and revoke dispatch', async () => {
  process.env.SETTINGS_ENCRYPTION_KEY = 'tool-connections-isolated-test-key';
  const fixture = await database(), adapter = new FixtureAdapter();
  const policy = new ToolTransportPolicy([{ id: 'fixture', endpoint: 'http://127.0.0.1:54321/mcp' }]);
  const service = new ToolConnectionsService(fixture.db, [adapter], policy), owner = randomUUID(), other = randomUUID();
  try {
    const created = await service.create(owner, { provider: 'mcp', endpoint: 'http://127.0.0.1:54321/mcp', credential: 'integration-secret' });
    assert.ok(!JSON.stringify(created).includes('integration-secret'));
    const [stored] = await fixture.db.select().from(toolConnections).where(eq(toolConnections.id, created.id));
    assert.ok(stored.secretEnc?.startsWith('v1:')); assert.ok(!stored.secretEnc?.includes('integration-secret'));
    assert.deepEqual(await service.list(other), []);
    await assert.rejects(service.detail(other, created.id), /TOOL_CONNECTION_NOT_FOUND/u);
    await assert.rejects(service.discover(other, created.id), /TOOL_CONNECTION_NOT_FOUND/u);
    assert.equal((await service.freezeCatalog(owner)).descriptors.length, 0);
    const discovered = await service.discover(owner, created.id);
    assert.equal(adapter.calls, 0); assert.equal(discovered.catalog.descriptors.length, 1);
    const body = { revision: discovered.connection.revision, catalogVersionId: discovered.catalog.id,
      schemaHash: discovered.catalog.schemaHash, toolIds: discovered.catalog.descriptors.map(tool => tool.id), dataClasses: ['public'] };
    await assert.rejects(service.enable(owner, created.id, { ...body, schemaHash: '0'.repeat(64) }), /TOOL_CATALOG_RECONFIRMATION_REQUIRED/u);
    await assert.rejects(service.enable(other, created.id, body), /TOOL_CONNECTION_NOT_FOUND/u);
    const enabled = await service.enable(owner, created.id, body);
    const restarted = new ToolConnectionsService(fixture.db, [adapter], policy), snapshot = await restarted.freezeCatalog(owner);
    assert.equal(snapshot.descriptors.length, 1); assert.equal(snapshot.connectionRevisions[created.id], enabled.revision);
    const tool = snapshot.descriptors[0]; assert.equal(tool.effect, 'external_write');
    await assert.rejects(service.invokeFrozen(owner, tool, enabled.revision, { query: 'x', injected: true }, { invocationId: randomUUID() }), /INVALID_TOOL_ARGUMENTS/u);
    await assert.rejects(service.invokeFrozen(other, tool, enabled.revision, { query: 'x' }, { invocationId: randomUUID() }), /TOOL_CONNECTION_NOT_FOUND/u);
    assert.equal(adapter.calls, 0);
    const result = await service.invokeFrozen(owner, tool, enabled.revision, { query: 'cash flow' }, { invocationId: randomUUID() });
    assert.ok(!JSON.stringify(result).includes('integration-secret')); assert.equal(adapter.calls, 1);
    await service.disconnect(owner, created.id);
    await assert.rejects(service.invokeFrozen(owner, tool, enabled.revision, { query: 'x' }, { invocationId: randomUUID() }), /TOOL_CONNECTION_REVISION_CHANGED/u);
    assert.equal(adapter.calls, 1); assert.equal((await restarted.freezeCatalog(owner)).descriptors.length, 0);
    assert.equal((await service.detail(owner, created.id)).hasCredential, false);
    assert.equal((await fixture.db.select().from(toolConnections).where(eq(toolConnections.id, created.id)))[0].secretEnc, null);
  } finally { await fixture.close(); }
});

test('OAuth requires owner bound one-use state, real PKCE exchange, fixed callback and fresh connection revision', async () => {
  process.env.SETTINGS_ENCRYPTION_KEY = 'tool-connections-oauth-isolated-key';
  process.env.TOOL_OAUTH_CALLBACK_URL = 'https://squabble.example.org/settings/tools';
  let exchanges = 0, verifier = '', receivedRedirect = '';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    verifier = body.get('code_verifier') ?? ''; receivedRedirect = body.get('redirect_uri') ?? ''; exchanges++;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ access_token: 'oauth-fixture-token', token_type: 'Bearer' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, fixture = await database(), owner = randomUUID(), other = randomUUID();
  const policy = new ToolTransportPolicy(['mcp', 'authorize', 'token'].map(path => ({ id: path, endpoint: `${base}/${path}` })));
  const service = new ToolConnectionsService(fixture.db, [new FixtureAdapter()], policy), oauth = new ToolOAuthService(fixture.db, policy);
  try {
    const connection = await service.create(owner, { provider: 'mcp', endpoint: `${base}/mcp`, oauth: {
      clientId: 'fixture-client', authorizationUrl: `${base}/authorize`, tokenUrl: `${base}/token`, scopes: ['read'] } });
    const begun = await oauth.begin(owner, connection.id), authorize = new URL(begun.authorizationUrl), state = authorize.searchParams.get('state')!;
    assert.equal(exchanges, 0); assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    await assert.rejects(oauth.complete(other, { state, code: 'code' }), /TOOL_OAUTH_STATE_INVALID/u);
    const authorized = await oauth.complete(owner, { state, code: 'code' });
    assert.equal(authorized.authorized, true); assert.equal(exchanges, 1);
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
    assert.equal(receivedRedirect, process.env.TOOL_OAUTH_CALLBACK_URL);
    await assert.rejects(oauth.complete(owner, { state, code: 'code' }), /TOOL_OAUTH_STATE_INVALID/u); assert.equal(exchanges, 1);
    assert.ok(!JSON.stringify(await service.detail(owner, connection.id)).includes('oauth-fixture-token'));
    const expired = new URL((await oauth.begin(owner, connection.id)).authorizationUrl).searchParams.get('state')!;
    await fixture.db.update(toolOAuthStates).set({ expiresAt: new Date(0) });
    await assert.rejects(oauth.complete(owner, { state: expired, code: 'code' }), /TOOL_OAUTH_STATE_INVALID/u);
    const stale = new URL((await oauth.begin(owner, connection.id)).authorizationUrl).searchParams.get('state')!;
    await service.disconnect(owner, connection.id);
    await assert.rejects(oauth.complete(owner, { state: stale, code: 'code' }), /TOOL_CONNECTION_REVISION_CHANGED/u); assert.equal(exchanges, 1);
  } finally { await fixture.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
