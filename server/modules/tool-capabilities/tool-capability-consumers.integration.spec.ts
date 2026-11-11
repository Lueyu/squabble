import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DocumentJobsService } from '../data-library/document-jobs.service';
import { DatabaseBrowserResearchAuthority } from '../data-library/browser/browser-research.module';
import { ResearchArtifactsService } from '../research-artifacts/research-artifacts.service';
import { PrivateArtifactStorage } from '../research-artifacts/research-artifacts.storage';
import { ToolCapabilityGrantsService } from './tool-capability-grants.service';
import { capabilityManifest } from './tool-capabilities.manifest';
import type { DocumentExtractor } from '../data-library/documents/document-client.interface';
import { toolCapabilityReadiness, toolCapabilityGrants } from '../../database/tool-capabilities.schema';
import { ResearchToolsService } from '../research-tools/research-tools.service';

test('bundled document receipts and browser run authority cannot survive revoke and re-enable', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'Disposable PostgreSQL required');
  const ns = `capability_consumers_${randomUUID().replaceAll('-', '')}`, owner = randomUUID();
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
  const root = await mkdtemp(join(tmpdir(), 'capability-documents-'));
  const previous = process.env.TOOL_CAPABILITIES_BUNDLE_ENABLED;
  process.env.TOOL_CAPABILITIES_BUNDLE_ENABLED = 'true';
  try {
    await admin.unsafe(`CREATE SCHEMA ${ns}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    const db = drizzle(client), grants = new ToolCapabilityGrantsService(db);
    for (const pack of ['documents', 'browser'] as const) {
      await db.insert(toolCapabilityReadiness).values({ packId: pack, manifestHash: 'a'.repeat(64), ready: true, facts: { configurationHash: capabilityManifest(pack).configurationHash } });
      await db.insert(toolCapabilityGrants).values({ owner, packId: pack, manifestHash: 'a'.repeat(64), enabled: true, revision: 2, dataClasses: ['public', 'private_material'], publicNetwork: true });
    }
    const [source] = await client`INSERT INTO data_library_sources(owner,title,kind,format,mime_type,file_name,file_data,version_count) VALUES(${owner},'Fictional PDF','file','pdf','application/pdf','fixture.pdf',${Buffer.from('%PDF-1.7').toString('base64')},1) RETURNING id`;
    const [version] = await client`INSERT INTO data_library_versions(owner,source_id,version,content_hash,raw_content,extracted_text,sections,byte_length,extraction_state) VALUES(${owner},${source.id},1,${'c'.repeat(64)},'','','[]',8,'needs-text') RETURNING id`;
    await client`UPDATE data_library_sources SET latest_version_id=${version.id} WHERE id=${source.id}`;
    let submissions = 0;
    const extractor: DocumentExtractor = { id: 'fixture', version: '1', submit: async () => { submissions++; return { taskId: 'one-receipt' }; },
      status: async () => 'completed', result: async () => {
        await client`UPDATE tool_capability_grants SET enabled=false,revision=3 WHERE owner=${owner} AND pack_id='documents'`;
        await client`UPDATE tool_capability_grants SET enabled=true,revision=4 WHERE owner=${owner} AND pack_id='documents'`;
        return { markdown: 'Fictional revenue 120', lossless: { texts: [] } };
      } };
    const artifacts = new ResearchArtifactsService(db, new PrivateArtifactStorage(root));
    const documents = new DocumentJobsService(db, artifacts, [extractor], grants);
    const task = await documents.start(owner, source.id, 'fixture', 'fixture-v1');
    await assert.rejects(documents.poll(owner, task.jobId), /TOOL_CAPABILITY_REVISION_CHANGED/u);
    assert.equal(submissions, 1);
    assert.equal(Number((await client`SELECT count(*) n FROM data_library_versions WHERE source_id=${source.id}`)[0].n), 1);
    assert.equal(Number((await client`SELECT count(*) n FROM research_artifacts WHERE status='active'`)[0].n), 0);
    await client`UPDATE tool_capability_grants SET data_classes='["public"]',revision=5 WHERE owner=${owner} AND pack_id='documents'`;
    const sessionId = randomUUID();
    await client`INSERT INTO council_sessions(id,owner,profile_version,profile_snapshot,ticker,language,status,revision,checkpoint)
      VALUES(${sessionId},${owner},1,'{}','PORTFOLIO','en','running',1,'{"nextTurn":0,"turns":[{"memberId":"researcher","phase":"opening"}]}')`;
    let searches = 0;
    const library = { search: async () => { searches++; return { items: [], asOf: new Date().toISOString(), truncated: false }; }, validateReferences: async () => true };
    const tools = new ResearchToolsService(db, {} as never, {} as never, {} as never, library as never,
      undefined, undefined, undefined, undefined, undefined, grants);
    const denied = await tools.call(owner, { sessionId, revision: 1, memberId: 'researcher', memberName: 'Researcher', turn: 0,
      ticker: 'PORTFOLIO', language: 'en', webResearch: false, expiresAt: Date.now() + 30_000 },
    { callId: 'private-search', name: 'search_data_library', arguments: { query: 'private revenue' } });
    assert.equal(denied.errorCode, 'TOOL_CAPABILITY_DATA_NOT_AUTHORIZED');
    assert.equal(searches, 0, 'public-only capability cannot dispatch an owner-library search');

    const runId = randomUUID(), token = randomUUID();
    await client`INSERT INTO agent_runtime_runs(id,owner,identity_hash,identity,driver,frozen_input_hash,frozen_input_enc,policy,state,lease_token,lease_until) VALUES(${runId},${owner},${randomUUID()},'{}','controlled','fixed-hash','ciphertext','{}','running',${token},now()+interval '1 minute')`;
    const binding = { owner, runId, leaseToken: token, runRevision: 'fixed-hash' };
    const authority = new DatabaseBrowserResearchAuthority(db, grants);
    await authority.assert(binding, []);
    await client`UPDATE agent_runtime_runs SET policy=policy || '{"dataClasses":["public","portfolio"],"publicBrowserStartUrls":["https://public.example.org/filing?version=1"]}'::jsonb WHERE id=${runId}`;
    await authority.beforeNavigate(binding, 'https://public.example.org/filing?version=1', []);
    await assert.rejects(authority.beforeNavigate(binding, 'https://public.example.org/filing?version=1&holding=private', []), /BROWSER_PUBLIC_SOURCE_REQUIRED/u);
    await assert.rejects(authority.beforeNavigate({ ...binding, publicBrowserStartUrls: ['https://attacker.example.org/'] } as never,
      'https://attacker.example.org/', []), /BROWSER_PUBLIC_SOURCE_REQUIRED/u);
    await client`UPDATE agent_runtime_runs SET policy=policy || '{"dataClasses":["public"],"publicBrowserStartUrls":[]}'::jsonb WHERE id=${runId}`;
    await authority.beforeNavigate(binding, 'https://another.example.org/public', []);
    await assert.rejects(authority.beforeNavigate({ ...binding, dataClasses: ['private_material'] }, 'https://another.example.org/public', []), /BROWSER_PUBLIC_SOURCE_REQUIRED/u);
    await client`UPDATE tool_capability_grants SET enabled=false,revision=3 WHERE owner=${owner} AND pack_id='browser'`;
    await client`UPDATE tool_capability_grants SET enabled=true,revision=4 WHERE owner=${owner} AND pack_id='browser'`;
    await assert.rejects(new DatabaseBrowserResearchAuthority(db, grants).assert(binding, []), /TOOL_CAPABILITY_REVISION_CHANGED/u);
    const [run] = await client`SELECT policy FROM agent_runtime_runs WHERE id=${runId}`;
    assert.equal(run.policy.capabilityGrants.browser, 2, 'frozen revision persists across authority instances');
  } finally {
    if (previous === undefined) delete process.env.TOOL_CAPABILITIES_BUNDLE_ENABLED; else process.env.TOOL_CAPABILITIES_BUNDLE_ENABLED = previous;
    await client.end(); await admin.unsafe(`DROP SCHEMA ${ns} CASCADE`); await admin.end(); await rm(root, { recursive: true, force: true });
  }
});
