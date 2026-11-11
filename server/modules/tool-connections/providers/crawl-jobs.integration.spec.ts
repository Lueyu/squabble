import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { toolRemoteJobs } from '../../../database/tool-connections.schema';
import { ToolConnectionsService } from '../tool-connections.service';
import { ToolTransportPolicy } from '../tool-transport-policy';
import { ProviderHttp } from './search-provider.contract';
import { FirecrawlAdapter } from './firecrawl.adapter';

class CrawlPolicy extends ToolTransportPolicy {
  requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  statusFails = false;
  async fetch(input: string | URL, init: RequestInit = {}) {
    this.requests.push({ url: String(input), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
    if (init.method === 'GET' && this.statusFails) throw new Error('disconnected');
    const value = init.method === 'POST' ? { success: true, id: 'fake-crawl-job' }
      : init.method === 'DELETE' ? { success: true } : { status: 'scraping', completed: 1, creditsUsed: 1, data: [] };
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  }
}

test('Firecrawl saves remote identity/limits before returning; cancel acknowledgment without stop fact remains unknown', async () => {
  const url = process.env.TOOL_CONNECTIONS_TEST_DATABASE_URL;
  assert.ok(url, 'TOOL_CONNECTIONS_TEST_DATABASE_URL must name isolated PostgreSQL');
  const namespace = `crawl_jobs_${randomUUID().replaceAll('-', '')}`, admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 3, onnotice: () => {}, connection: { search_path: namespace } });
  process.env.SETTINGS_ENCRYPTION_KEY = 'crawl-test-isolated-encryption-key';
  await admin.unsafe(`CREATE SCHEMA ${namespace}`);
  await client.unsafe(readFileSync('scripts/db/56_tool_connections.sql', 'utf8'));
  const db = drizzle(client), policy = new CrawlPolicy([]), adapter = new FirecrawlAdapter(new ProviderHttp(policy));
  const service = new ToolConnectionsService(db, [adapter], policy), owner = randomUUID();
  try {
    const connection = await service.create(owner, { provider: 'firecrawl', credential: 'crawl-secret' });
    const discovered = await service.discover(owner, connection.id);
    assert.equal(policy.requests.length, 0);
    const crawl = discovered.catalog.descriptors.find(tool => tool.name === 'crawl')!;
    const enabled = await service.enable(owner, connection.id, { revision: discovered.connection.revision,
      catalogVersionId: discovered.catalog.id, schemaHash: discovered.catalog.schemaHash, toolIds: [crawl.id], dataClasses: ['public'] });
    const tool = (await service.freezeCatalog(owner)).descriptors[0], invocationId = randomUUID();
    const result = await service.invokeFrozen(owner, tool, enabled.revision,
      { url: 'https://www.iana.org/domains/reserved', maxPages: 2, maxDepth: 1, maxCredits: 2 }, { invocationId });
    assert.equal(result.receipt.state, 'running'); assert.equal(result.receipt.remoteJobId, 'fake-crawl-job');
    assert.equal(policy.requests[0].body?.allowExternalLinks, false); assert.equal(policy.requests[0].body?.allowSubdomains, false);
    assert.equal(policy.requests[0].body?.limit, 2); assert.equal(policy.requests[0].body?.maxDiscoveryDepth, 1);
    const [job] = await db.select().from(toolRemoteJobs);
    assert.equal(job.invocationId, invocationId); assert.deepEqual(job.limits, { maxPages: 2, maxDepth: 1, maxCredits: 2 });
    await assert.rejects(service.remoteJob(randomUUID(), job.id), /TOOL_JOB_NOT_FOUND/u);
    policy.statusFails = true;
    const cancelled = await service.remoteJob(owner, job.id, true);
    assert.equal(cancelled.receipt.state, 'unknown'); assert.equal((await db.select().from(toolRemoteJobs))[0].state, 'unknown');
    assert.deepEqual(policy.requests.map(request => request.method), ['POST', 'DELETE', 'GET']);
    assert.equal(cancelled.usage, null);
  } finally { await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); }
});
