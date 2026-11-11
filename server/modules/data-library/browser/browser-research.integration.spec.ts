import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DatabaseBrowserResearchAuthority } from './browser-research.module';
import { ResearchArtifactsService } from '../../research-artifacts/research-artifacts.service';
import { PrivateArtifactStorage } from '../../research-artifacts/research-artifacts.storage';

async function fixture(run: (state: { authority: DatabaseBrowserResearchAuthority; artifacts: ResearchArtifactsService;
  client: ReturnType<typeof postgres>; binding: { owner: string; runId: string; leaseToken: string; runRevision: string };
  dependency: { sourceId: string; sourceVersionId: string; contentHash: string } }) => Promise<void>) {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'A disposable RESEARCH_TEST_DATABASE_URL is required');
  const namespace = `browser_research_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 3, onnotice: () => {}, connection: { search_path: namespace } });
  const root = await mkdtemp(join(tmpdir(), 'browser-artifact-test-'));
  try {
    await admin.unsafe(`create schema ${namespace}`);
    for (const file of ['01_schema.sql', '50_data_library.sql', '51_browser_sources.sql', '53_agent_tool_runtime.sql', '54_research_artifacts.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    }
    const db = drizzle(client), owner = randomUUID(), runId = randomUUID(), leaseToken = randomUUID(), runRevision = 'a'.repeat(64);
    const sourceId = randomUUID(), sourceVersionId = randomUUID(), contentHash = 'b'.repeat(64);
    await client`insert into agent_runtime_runs(id,owner,identity_hash,identity,driver,frozen_input_hash,frozen_input_enc,policy,state,lease_token,lease_until)
      values(${runId},${owner},${'c'.repeat(64)},'{}','controlled',${runRevision},'fixture-encrypted','{}','running',${leaseToken},now()+interval '1 minute')`;
    await client`insert into data_library_sources(id,owner,kind,title,format) values(${sourceId},${owner},'document','Fictional source','text')`;
    await client`insert into data_library_versions(id,owner,source_id,version,content_hash,raw_content,extracted_text,sections,byte_length,extraction_state)
      values(${sourceVersionId},${owner},${sourceId},1,${contentHash},'fictional','fictional','[]',9,'succeeded')`;
    await client`insert into research_source_policies(source_version_id,owner,data_classes,permitted_uses)
      values(${sourceVersionId},${owner},'["private_material"]','["research"]')`;
    await run({ authority: new DatabaseBrowserResearchAuthority(db), artifacts: new ResearchArtifactsService(db, new PrivateArtifactStorage(root)),
      client, binding: { owner, runId, leaseToken, runRevision }, dependency: { sourceId, sourceVersionId, contentHash } });
  } finally {
    await client.end(); await admin.unsafe(`drop schema ${namespace} cascade`); await admin.end();
    const rel = relative(tmpdir(), root); assert.ok(rel.startsWith('browser-artifact-test-') && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(root, { recursive: true, force: true });
  }
}

test('database authority requires live owner/run/lease/revision and exact enabled undeleted source', async () => fixture(async state => {
  await state.authority.assert(state.binding, [state.dependency]);
  for (const change of [{ owner: randomUUID() }, { runId: randomUUID() }, { leaseToken: 'stale' }, { runRevision: 'stale' }]) {
    await assert.rejects(state.authority.assert({ ...state.binding, ...change }, [state.dependency]), /BROWSER_RUN_UNAVAILABLE/u);
  }
  await assert.rejects(state.authority.assert(state.binding, [{ ...state.dependency, contentHash: 'd'.repeat(64) }]), /SOURCE_UNAVAILABLE/u);
  await state.client`update data_library_sources set enabled=false where id=${state.dependency.sourceId}`;
  await assert.rejects(state.authority.assert(state.binding, [state.dependency]), /SOURCE_UNAVAILABLE/u);
  await state.client`update data_library_sources set enabled=true,deleted_at=now() where id=${state.dependency.sourceId}`;
  await assert.rejects(state.authority.assert(state.binding, [state.dependency]), /SOURCE_UNAVAILABLE/u);
  await state.client`update data_library_sources set deleted_at=null where id=${state.dependency.sourceId}`;
  await state.client`update agent_runtime_runs set cancel_requested=true where id=${state.binding.runId}`;
  await assert.rejects(state.authority.assert(state.binding, [state.dependency]), /BROWSER_RUN_UNAVAILABLE/u);
  await state.client`update agent_runtime_runs set cancel_requested=false,lease_until=now()-interval '1 second' where id=${state.binding.runId}`;
  await assert.rejects(state.authority.assert(state.binding, [state.dependency]), /BROWSER_RUN_UNAVAILABLE/u);
}));

test('browser artifact boundary inherits source policy, refuses another owner and revokes download after deletion', async () => fixture(async state => {
  const data = Buffer.from('fictional image bytes');
  const created = await state.artifacts.create(state.binding.owner, { runId: state.binding.runId, type: 'file', mime: 'image/png', data,
    dependencies: [state.dependency], datasetVersionIds: [], dataClasses: ['public'], permittedUses: ['research'], retentionUntil: null });
  assert.deepEqual(created.effectiveDataClasses, ['private_material', 'public']);
  assert.deepEqual((await state.artifacts.download(state.binding.owner, created.id)).data, data);
  await assert.rejects(state.artifacts.download(randomUUID(), created.id), /ARTIFACT_NOT_FOUND/u);
  await state.client`update data_library_sources set deleted_at=now() where id=${state.dependency.sourceId}`;
  await assert.rejects(state.artifacts.download(state.binding.owner, created.id), /SOURCE_UNAVAILABLE/u);
}));
