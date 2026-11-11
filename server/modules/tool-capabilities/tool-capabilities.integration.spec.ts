import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ToolCapabilitiesService } from './tool-capabilities.service';
import { ToolCapabilityGrantsService } from './tool-capability-grants.service';
import { ToolConnectionsService } from '../tool-connections/tool-connections.service';
import { ToolTransportPolicy } from '../tool-connections/tool-transport-policy';
import { nativeDescriptor } from '../tool-connections/providers/search-provider.contract';
import { AKTOOLS_GET_DATA_SCHEMA } from './tool-capabilities.manifest';
import { FinancialDatasetService } from '../data-library/providers/financial-dataset.service';
import type { TrustedToolAdapter } from '../tool-connections/tool-adapter.contract';

test('preparation is metadata only, activation is owner bound and revoked grants remain disabled after preparation', async () => {
  const url = process.env.TOOL_CONNECTIONS_TEST_DATABASE_URL;
  assert.ok(url, 'TOOL_CONNECTIONS_TEST_DATABASE_URL must name isolated PostgreSQL');
  process.env.SETTINGS_ENCRYPTION_KEY = 'capability-integration-test-key';
  const previousEndpoint = process.env.FINANCIAL_AKTOOLS_MCP_URL;
  process.env.FINANCIAL_AKTOOLS_MCP_URL = 'http://127.0.0.1:58081/mcp';
  const ns = `capability_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: ns } });
  await admin.unsafe(`CREATE SCHEMA ${ns}`);
  await client.unsafe(readFileSync('scripts/db/56_tool_connections.sql', 'utf8'));
  await client.unsafe(readFileSync('scripts/db/59_capability_activation.sql', 'utf8'));
  const db = drizzle(client), owner = randomUUID(), other = randomUUID();
  let calls = 0, discoveries = 0, preparations = 0;
  const adapter: TrustedToolAdapter = { provider: 'mcp', discover: async connection => {
    discoveries++;
    return [nativeDescriptor(connection.id, 'get_data', AKTOOLS_GET_DATA_SCHEMA, 'Read bounded financial data')];
  }, invoke: async () => { calls++; throw new Error('BUSINESS_TOOL_MUST_NOT_RUN'); } };
  const connections = new ToolConnectionsService(db, [adapter], new ToolTransportPolicy([{ id: 'aktools', endpoint: 'http://127.0.0.1:58081/mcp' }]));
  const grants = new ToolCapabilityGrantsService(db);
  const readiness = { probe: async () => { preparations++; return {
    documents: { ready: true, facts: { engineVersion: '1.38.2' } }, market_data: { ready: true, facts: { engineVersion: '0.1.5' } },
    browser: { ready: true, facts: { chromium: true } }, compute: { ready: true, facts: { protocolVersion: 1, imageId: 'sha256:fixture' } },
  }; }, aktoolsEndpoint: () => 'http://127.0.0.1:58081/mcp', aktoolsCredential: () => undefined };
  const capabilities = new ToolCapabilitiesService(db, connections, grants, readiness);
  try {
    const initial = await capabilities.list(owner);
    assert.equal(initial.length, 4); assert.equal(preparations, 0); assert.equal(discoveries, 0);
    assert.ok(initial.every(item => !item.ready && item.grant === 'disabled'));
    const prepared = await capabilities.refresh(owner);
    assert.ok(prepared.every(item => item.installation === 'ready' && item.grant === 'disabled'));
    assert.equal((await connections.list(owner)).length, 1);
    const grantsBody = prepared.map(item => ({ packId: item.packId, revision: item.revision, manifestHash: item.manifestHash,
      catalogVersionId: item.catalogVersionId, schemaHash: item.schemaHash,
      dataClasses: item.packId === 'market_data' || item.packId === 'browser' ? ['public'] : ['public', 'private_material', 'portfolio'] }));
    await assert.rejects(capabilities.activate(other, { grants: grantsBody, publicNetwork: true }), /TOOL_CAPABILITY_NOT_PREPARED/u);
    await assert.rejects(capabilities.activate(owner, { grants: grantsBody, publicNetwork: false }), /TOOL_CAPABILITY_PUBLIC_NETWORK_REQUIRED/u);
    await assert.rejects(capabilities.activate(owner, { grants: grantsBody.map(item => item.packId === 'market_data'
      ? { ...item, schemaHash: '0'.repeat(64) } : item), publicNetwork: true }), /TOOL_CATALOG_RECONFIRMATION_REQUIRED/u);
    assert.ok((await capabilities.list(owner)).every(item => item.grant === 'disabled' && item.revision === 1), 'failed catalog approval rolls back the whole grant batch');
    const active = await capabilities.activate(owner, { grants: grantsBody, publicNetwork: true });
    assert.ok(active.every(item => item.ready && item.grant === 'enabled'));
    const repeated = await capabilities.activate(owner, { publicNetwork: true, grants: active.map(item => ({
      packId: item.packId, revision: item.revision, manifestHash: item.manifestHash, dataClasses: item.dataClasses,
      catalogVersionId: item.catalogVersionId, schemaHash: item.schemaHash,
    })) });
    assert.deepEqual(repeated.map(item => item.revision), active.map(item => item.revision), 'identical permission confirmation must not revoke running consumers');
    await assert.rejects(capabilities.activate(owner, { grants: grantsBody, publicNetwork: true }), /TOOL_CAPABILITY_REVISION_CHANGED/u);
    assert.equal((await connections.freezeCatalog(owner)).descriptors.length, 0, 'managed get_data never reaches the full-context generic catalog');
    await connections.create(owner, { provider: 'mcp', endpoint: 'http://127.0.0.1:58081/mcp' });
    assert.equal(await new FinancialDatasetService(db, connections, grants).available(owner), true, 'custom duplicate endpoints do not break the managed binding');
    await assert.rejects(grants.require(other, 'documents'), /TOOL_CAPABILITY_DISABLED/u);
    const saved = await grants.require(owner, 'documents', ['private_material']);
    const docs = active.find(item => item.packId === 'documents')!;
    await capabilities.revoke(owner, 'documents', { revision: docs.revision });
    await assert.rejects(grants.requireCurrent(owner, 'documents', saved.revision), /TOOL_CAPABILITY_DISABLED/u);
    const again = await capabilities.refresh(owner);
    assert.equal(again.find(item => item.packId === 'documents')?.grant, 'disabled');
    assert.equal((await connections.list(owner)).filter(item => item.managedPresetId === 'aktools').length, 1, 'managed identity is stable across refresh');
    assert.equal(calls, 0);
  } finally {
    if (previousEndpoint === undefined) delete process.env.FINANCIAL_AKTOOLS_MCP_URL; else process.env.FINANCIAL_AKTOOLS_MCP_URL = previousEndpoint;
    await client.end(); await admin.unsafe(`DROP SCHEMA ${ns} CASCADE`); await admin.end();
  }
});
