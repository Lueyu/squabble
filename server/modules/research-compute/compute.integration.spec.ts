import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { dataLibrarySources, dataLibraryVersions } from '../../database/data-library.schema';
import { researchSourcePolicies } from '../../database/research-artifacts.schema';
import { DataDatasetService } from '../data-library/data-dataset.service';
import { ResearchArtifactsService } from '../research-artifacts/research-artifacts.service';
import { PrivateArtifactStorage } from '../research-artifacts/research-artifacts.storage';
import { ComputeJobsService } from './compute-jobs.service';
import { E2bAdapter } from './e2b.adapter';
import type { ComputeSandboxFactory } from './e2b.adapter';
import { ResearchComputeService } from './research-compute.service';
import { ComputeCleanupService } from './compute-cleanup.service';
import { RuntimeJournalService } from '../research-runtime/runtime-journal.service';
import { canonicalHash } from '../../common/agent-contract';

async function fixture(run: (f: {
  owner: string; request: Record<string, unknown>; client: ReturnType<typeof postgres>; sourceId: string;
  createService: (factory: ComputeSandboxFactory) => ResearchComputeService;
  jobs: ComputeJobsService; db: ReturnType<typeof drizzle>;
}) => Promise<void>) {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'A disposable test database is required');
  const ns = `compute_${randomUUID().replaceAll('-', '')}`, owner = randomUUID();
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
  const directory = await mkdtemp(join(tmpdir(), 'squabble-compute-fixture-'));
  try {
    await admin.unsafe(`create schema ${ns}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    for (const name of ['50_data_library.sql', '51_browser_sources.sql', '54_research_artifacts.sql', '57_research_compute.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    }
    const db = drizzle(client), datasets = new DataDatasetService(db);
    const [source] = await db.insert(dataLibrarySources).values({ owner, title: 'Fictional returns', kind: 'page', format: 'text' }).returning();
    const [version] = await db.insert(dataLibraryVersions).values({ owner, sourceId: source.id, version: 1,
      contentHash: 'a'.repeat(64), rawContent: 'fixture', extractedText: 'fixture', sections: [], byteLength: 7, extractionState: 'ready' }).returning();
    await db.insert(researchSourcePolicies).values({ sourceVersionId: version.id, owner,
      dataClasses: ['portfolio'], permittedUses: ['research', 'egress:e2b'] });
    const rows = Array.from({ length: 1505 }, (_, index) => ({ return: index % 2 ? '-0.01' : '0.01' }));
    const dataset = await datasets.create(owner, { rows, metadata: {
      sourceVersion: { sourceId: source.id, sourceVersionId: version.id, contentHash: version.contentHash }, dependencies: [],
      schema: { fields: ['return'] }, schemaVersion: '1', provider: 'fictional', operation: 'returns', parameterVersion: '1',
      timing: { observedAt: '2020-01-01T00:00:00Z', fetchedAt: '2020-01-01T00:00:00Z', dataAsOf: null,
        marketDate: null, reportPeriod: null, announcedAt: null, availableAt: null, availableAtBasis: null, datePrecision: 'unknown' },
      coverage: { status: 'complete', rowCount: rows.length, expectedRowCount: rows.length, from: null, to: null, missing: [], delayed: null },
      adjustment: 'unknown', corporateActionsVersionId: null, dataClasses: ['portfolio'],
      license: { termsRef: 'fictional', permittedUses: ['research', 'egress:e2b'], retentionUntil: null },
    } });
    const request = { requestKey: randomUUID(), runId: randomUUID(), kind: 'statistics', datasetVersionIds: [dataset.id],
      expectedContentHashes: { [dataset.id]: dataset.contentHash }, seed: 7, maxRuntimeMs: 1000,
      parameters: { returnColumn: 'return', benchmarkColumn: null, frequency: 'daily', annualizationFactor: 252, riskFreeRate: 0 } };
    const jobs = new ComputeJobsService(db, 'compute-fixture-encryption-key');
    const createService = (factory: ComputeSandboxFactory) => new ResearchComputeService(db,
      jobs, new E2bAdapter({ apiKey: 'fake-only', templateId: 'fake-template', templateVersion: '1' }, factory),
      new ResearchArtifactsService(db, new PrivateArtifactStorage(directory)));
    await run({ owner, request, client, sourceId: source.id, createService, jobs, db });
  } finally {
    await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}
const fixtureMetrics = { templateId: 'returns-v1', templateVersion: '1', frequency: 'daily', annualizationFactor: 252,
  annualRiskFreeRate: 0, observations: 1505, missingPeriods: 0, coverage: 'complete', totalReturn: 0.12,
  positivePeriodRatio: 0.5, sharpe: null, maxDrawdown: -0.1 };
const data = Buffer.from(JSON.stringify(fixtureMetrics));
const outputs = { files: [{ name: 'result.json', mime: 'application/json', sizeBytes: data.length,
  sha256: createHash('sha256').update(data).digest('hex') }] };
const read = async (path: string) => new ReadableStream<Uint8Array>({ start(controller) {
  controller.enqueue(path.endsWith('outputs.json') ? Buffer.from(JSON.stringify(outputs)) : data); controller.close();
} });

test('complete private dataset survives durable cloud job, artifacts, replay and source revocation', async () => fixture(async f => {
  let creates = 0, fullRows = 0, kills = 0;
  const service = f.createService(async () => {
    creates += 1;
    return { id: 'fake-sandbox', write: async (path, value) => {
      if (path.endsWith('dataset-0.json')) fullRows = (JSON.parse(String(value)) as unknown[]).length;
      if (path.endsWith('manifest.json')) assert.doesNotMatch(String(value), /fake-only|encryption-key/);
    }, read, execute: async () => ({ stdout: 'fixture', stderr: '', error: null }), kill: async () => { kills += 1; return true; } };
  });
  const first = await service.run(f.owner, f.request);
  assert.equal(first.state, 'succeeded'); assert.equal(fullRows, 1505); assert.equal(kills, 1);
  assert.equal((first.result.metrics as Record<string, unknown>).totalReturn, 0.12);
  assert.equal((first.result.coverage as Record<string, unknown>).observations, 1505);
  const replay = await service.run(f.owner, f.request);
  assert.equal(replay.id, first.id); assert.equal(creates, 1);
  const artifacts = await f.client`select metadata from research_artifacts`;
  assert.equal(artifacts.length, 3);
  assert.ok(artifacts.every(row => row.metadata.effectiveDataClasses.includes('portfolio')));
  await assert.rejects(service.status(randomUUID(), first.id), /NOT_FOUND/);
  await f.client`update data_library_sources set enabled=false where id=${f.sourceId}`;
  await assert.rejects(service.status(f.owner, first.id), /SOURCE/);
}));

test('unknown sandbox creation cannot replay or consume another creation reservation', async () => fixture(async f => {
  let creates = 0;
  const service = f.createService(async () => { creates += 1; throw new Error('provider lost create response'); });
  const first = await service.run(f.owner, f.request);
  assert.equal(first.state, 'provider_unknown'); assert.equal(first.terminationConfirmed, false);
  assert.equal((await service.run(f.owner, f.request)).id, first.id); assert.equal(creates, 1);
  await assert.rejects(service.run(f.owner, { ...f.request, requestKey: randomUUID() }), /RESOURCE_LIMIT/);
  assert.equal(creates, 1);
}));

test('private data without owner egress permission is rejected before creating a sandbox', async () => fixture(async f => {
  let creates = 0;
  const service = f.createService(async () => { creates += 1; throw new Error('must not create'); });
  await f.client`update research_source_policies set permitted_uses='["research"]'::jsonb where owner=${f.owner}`;
  await assert.rejects(service.run(f.owner, f.request), /EGRESS_NOT_ALLOWED/);
  assert.equal(creates, 0);
}));

test('source tombstone and physical version deletion destroy private job inputs while retaining receipts', async () => {
  for (const mode of ['tombstone', 'version_delete']) await fixture(async f => {
    const service = f.createService(async () => ({ id: 'retained-sandbox', write: async () => {}, read,
      execute: async () => ({ stdout: '', stderr: '', error: null }), kill: async () => true }));
    const job = await service.run(f.owner, f.request);
    assert.equal(job.state, 'succeeded');
    if (mode === 'tombstone') await f.client`update data_library_sources set deleted_at=now() where id=${f.sourceId}`;
    else await f.client`delete from data_library_versions where source_id=${f.sourceId}`;
    const rows = await f.client`select input_enc,result,sandbox_id,cancel_requested from research_compute_jobs where id=${job.id}`;
    assert.equal(rows[0].input_enc, ''); assert.equal(rows[0].result, null);
    assert.equal(rows[0].sandbox_id, 'retained-sandbox'); assert.equal(rows[0].cancel_requested, true);
    await assert.rejects(f.jobs.input(f.owner, job.id), /INPUT_REVOKED/);
  });
});

test('periodic compensation purges expired data and preserves unconfirmed cleanup without creating resources', async () => fixture(async f => {
  let creates = 0, killAttempts = 0;
  const service = f.createService(async () => { creates += 1; return { id: 'cleanup-sandbox', write: async () => {}, read,
    execute: async () => ({ stdout: '', stderr: '', error: null }), kill: async () => { throw new Error('provider termination unknown'); } }; });
  const job = await service.run(f.owner, f.request);
  assert.equal(job.state, 'provider_unknown');
  await f.client`update research_compute_jobs set retention_until=now()-interval '1 second' where id=${job.id}`;
  const cleanup = new ComputeCleanupService(f.db, f.jobs, { kill: async () => { killAttempts += 1; throw new Error('unknown'); } });
  assert.equal(await cleanup.tick(), 0);
  assert.equal((await f.jobs.read(f.owner, job.id)).inputEnc, '');
  assert.equal((await f.jobs.read(f.owner, job.id)).terminationConfirmed, false);
  assert.equal(creates, 1); assert.equal(killAttempts, 1);
  const confirmed = new ComputeCleanupService(f.db, f.jobs, { kill: async () => true });
  assert.equal(await confirmed.tick(), 1);
  assert.equal((await f.jobs.read(f.owner, job.id)).terminationConfirmed, true);
  assert.equal(creates, 1);
}));

test('late execution logs and complete callbacks cannot restore tombstoned private inputs', async () => fixture(async f => {
  let executing: () => void, release: () => void;
  const started = new Promise<void>(resolve => { executing = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const service = f.createService(async () => ({ id: 'late-sandbox', write: async () => {}, read,
    execute: async () => { executing(); await resume; return { stdout: 'deleted-private-plaintext', stderr: '', error: null }; },
    kill: async () => true }));
  const running = service.run(f.owner, f.request);
  await started;
  const [job] = await f.client`select id from research_compute_jobs where owner=${f.owner}`;
  await f.client`update data_library_sources set deleted_at=now() where id=${f.sourceId}`;
  await f.jobs.complete(f.owner, job.id, { stdout: 'late-private-complete', artifacts: ['private-artifact'] });
  release();
  const returned = await running;
  const [saved] = await f.client`select input_enc,result from research_compute_jobs where id=${job.id}`;
  assert.equal(saved.input_enc, ''); assert.equal(saved.result, null);
  assert.doesNotMatch(JSON.stringify(returned), /private-plaintext|private-complete|private-artifact/);
}));

test('cancel and cleanup return only metadata after source disablement', async () => fixture(async f => {
  const service = f.createService(async () => ({ id: 'metadata-sandbox', write: async () => {}, read,
    execute: async () => ({ stdout: 'private-compute-output', stderr: '', error: null }), kill: async () => true }));
  const job = await service.run(f.owner, f.request);
  await f.client`update data_library_sources set enabled=false where id=${f.sourceId}`;
  assert.doesNotMatch(JSON.stringify(await service.cancel(f.owner, job.id)), /private-compute-output|manifestArtifactId/);
  assert.doesNotMatch(JSON.stringify(await service.cleanup(f.owner, job.id)), /private-compute-output|manifestArtifactId/);
}));

test('ordinary cleanup-unknown resources are compensated even without an explicit cancel request', async () => fixture(async f => {
  const service = f.createService(async () => ({ id: 'ordinary-unknown', write: async () => {}, read,
    execute: async () => ({ stdout: '', stderr: '', error: null }), kill: async () => { throw new Error('transport unknown'); } }));
  const job = await service.run(f.owner, f.request);
  assert.equal((await f.jobs.read(f.owner, job.id)).cancelRequested, false);
  const cleanup = new ComputeCleanupService(f.db, f.jobs, { kill: async () => false });
  assert.equal(await cleanup.tick(), 1);
  assert.equal((await f.jobs.read(f.owner, job.id)).terminationConfirmed, true);
}));

test('parent runtime stop and AbortSignal prevent late compute publication', async () => {
  for (const mode of ['parent', 'abort']) await fixture(async f => {
    const journal = new RuntimeJournalService(f.db, 'compute-fixture-encryption-key');
    const payload = { holdings: [], cash: [], sourcePayloads: [] };
    const parent = await journal.create({ identity: { owner: f.owner, sessionId: randomUUID(), cycleId: randomUUID(),
      revision: 1, memberId: 'member', turn: 0, executionAttempt: 1 }, driver: 'controlled',
    frozenInput: { version: 1, datasetVersionIds: [], datasets: [], payload, payloadHash: canonicalHash(payload) },
    policy: { loopOwner: 'runtime', maxModelRequestsPerStep: 1, sdkRetries: 0, sdkToolExecution: false,
      sdkToolApproval: false, providerExecutedWrites: false, fallback: null } });
    const lease = (await journal.claim(f.owner, parent.id))!;
    const controller = new AbortController();
    const datasetId = (f.request.datasetVersionIds as string[])[0];
    const metadata = await new DataDatasetService(f.db).read(f.owner, datasetId);
    const scope = { owner: f.owner, runId: parent.id, sessionId: String(parent.identity.sessionId), revision: 1,
      leaseToken: lease.token, allowedInstrumentIds: [], allowedAccountIds: [], allowedDataClasses: ['portfolio' as const],
      sourceVersions: [metadata.sourceVersion], permissionRevision: 1 };
    const service = f.createService(async () => ({ id: 'stopped-parent', write: async () => {}, read,
      execute: async () => {
        if (mode === 'parent') await journal.cancel(f.owner, parent.id); else controller.abort();
        return { stdout: 'late-private-parent-output', stderr: '', error: null };
      }, kill: async () => true }));
    const job = await service.run(f.owner, { ...f.request, runId: parent.id }, scope, controller.signal);
    assert.equal(job.state, 'cancelled'); assert.equal(job.result, null);
    assert.equal(Number((await f.client`select count(*) n from research_artifacts`)[0].n), 0);
  });
});

test('financial daily-history close is rejected as a return and selects the fixed price-conversion template', async () => fixture(async f => {
  const datasets = new DataDatasetService(f.db), original = await datasets.read(f.owner, (f.request.datasetVersionIds as string[])[0]);
  const rows = [{ trade_date: '20200102', close: '100', _provenance: { currency: null, unit: null } },
    { trade_date: '20200103', close: '110', _provenance: { currency: null, unit: null } }];
  const prices = await datasets.create(f.owner, { rows, metadata: {
    sourceVersion: original.sourceVersion, dependencies: original.dependencies, schema: { fields: ['trade_date', 'close', '_provenance'] },
    schemaVersion: 'financial-row-v1', provider: 'fictional-tushare', operation: 'daily', parameterVersion: 'tushare-http-v1',
    timing: original.timing, coverage: { ...original.coverage, rowCount: 2, expectedRowCount: 2 },
    adjustment: 'unadjusted', corporateActionsVersionId: null, dataClasses: original.dataClasses, license: original.license,
  } });
  let creates = 0;
  const service = f.createService(async () => { creates += 1; return { id: 'financial-prices', write: async (path, value) => {
    if (path.endsWith('manifest.json')) assert.equal(JSON.parse(String(value)).templateId, 'prices-to-returns-v1');
  }, read: async path => {
    const priceData = Buffer.from(JSON.stringify({ ...fixtureMetrics, templateId: 'prices-to-returns-v1' }));
    const priceOutputs = { files: [{ name: 'result.json', mime: 'application/json', sizeBytes: priceData.length,
      sha256: createHash('sha256').update(priceData).digest('hex') }] };
    return new ReadableStream({ start(controller) { controller.enqueue(path.endsWith('outputs.json')
      ? Buffer.from(JSON.stringify(priceOutputs)) : priceData); controller.close(); } });
  }, execute: async () => ({ stdout: '', stderr: '', error: null }), kill: async () => true }; });
  const request = { ...f.request, datasetVersionIds: [prices.id], expectedContentHashes: { [prices.id]: prices.contentHash } };
  await assert.rejects(service.run(f.owner, { ...request, parameters: { returnColumn: 'close', benchmarkColumn: null,
    frequency: 'daily', annualizationFactor: 252, riskFreeRate: 0 } }), /REQUIRE_PRICE_TO_RETURN/);
  assert.equal(creates, 0);
  const result = await service.run(f.owner, { ...request, parameters: { inputKind: 'prices', dateColumn: 'trade_date',
    priceColumn: 'close', returnBasis: 'unadjusted-price-only', calendarDatasetVersionId: null,
    frequency: 'daily', annualizationFactor: 252, riskFreeRate: 0 } });
  assert.equal(result.state, 'succeeded'); assert.equal(creates, 1);
}));

test('a created sandbox receipt is retained even if its first database write fails', async () => fixture(async f => {
  let creates = 0;
  f.jobs.created = async () => { throw new Error('fixture database write lost'); };
  const service = f.createService(async () => { creates += 1; return { id: 'created-before-db-failure', write: async () => {}, read,
    execute: async () => ({ stdout: '', stderr: '', error: null }), kill: async () => { throw new Error('kill unknown'); } }; });
  const result = await service.run(f.owner, f.request);
  assert.equal(result.state, 'provider_unknown');
  assert.equal((await f.jobs.read(f.owner, result.id)).sandboxId, 'created-before-db-failure');
  const cleanup = new ComputeCleanupService(f.db, f.jobs, { kill: async id => { assert.equal(id, 'created-before-db-failure'); return true; } });
  assert.equal(await cleanup.tick(), 1); assert.equal(creates, 1);
}));

test('late failure cannot undo confirmed cleanup or cancelled terminal state', async () => fixture(async f => {
  const service = f.createService(async () => ({ id: 'monotonic-sandbox', write: async () => {}, read,
    execute: async () => ({ stdout: '', stderr: '', error: null }), kill: async () => { throw new Error('initial kill unknown'); } }));
  const job = await service.run(f.owner, f.request);
  await f.jobs.cancel(f.owner, job.id);
  await f.jobs.confirmTermination(f.owner, job.id);
  await f.jobs.fail(f.owner, job.id, 'E2B_CLEANUP_UNKNOWN', false, { stdout: 'late-private-log' });
  const after = await f.jobs.read(f.owner, job.id);
  assert.equal(after.terminationConfirmed, true); assert.equal(after.state, 'cancelled');
  assert.equal(after.cancelRequested, true); assert.equal(after.result, null);
}));
