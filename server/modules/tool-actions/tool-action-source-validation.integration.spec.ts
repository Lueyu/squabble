import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { ToolActionSourceValidation } from './tool-action-source-validation';
import { ToolActionsService } from './tool-actions.service';
import { dataLibrarySources, dataLibraryVersions } from '../../database/data-library.schema';
import { researchSourcePolicies } from '../../database/research-artifacts.schema';
import { toolConnections } from '../../database/tool-connections.schema';
import { councilSessions } from '../../database/council.schema';
import { RuntimeJournalService } from '../research-runtime/runtime-journal.service';
import { canonicalHash } from '../research-runtime/runtime-contract';
import { nativeDescriptor } from '../tool-connections/providers/search-provider.contract';
import type { ToolActionPreviewInput } from './tool-actions.rules';

test('write authorization reevaluates current source use/classification; readonly preview redacts deletion even without attachments', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'Temporary database required');
  const ns = `action_policy_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 5, onnotice: () => {}, connection: { search_path: ns } });
  try {
    await admin.unsafe(`create schema ${ns}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    for (const name of ['53_agent_tool_runtime.sql', '54_research_artifacts.sql', '55_tool_actions.sql', '56_tool_connections.sql']) await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    process.env.SETTINGS_ENCRYPTION_KEY = 'policy-test-encryption-key-2026';
    const db = drizzle(client), owner = randomUUID(), cycleId = randomUUID();
    await client`insert into users(id,username,password_hash) values(${owner},${owner.slice(0, 20)},'fixture')`;
    const [session] = await db.insert(councilSessions).values({ owner, ticker: 'AAPL', profileVersion: 1,
      profileSnapshot: {} as never, status: 'paused', checkpoint: { cycleId, nextTurn: 0, turns: [], toolKindsUsed: [], pendingResearch: [] } }).returning();
    const payload = { holdings: [], cash: [], sourcePayloads: [] };
    const journal = new RuntimeJournalService(db, 'policy-test-encryption-key-2026');
    const run = await journal.create({ identity: { owner, sessionId: session.id, cycleId, revision: session.revision,
      memberId: 'one', turn: 0, executionAttempt: 1 }, driver: 'controlled', frozenInput: { version: 1,
      datasetVersionIds: [], datasets: [], payload, payloadHash: canonicalHash(payload) },
      policy: { loopOwner: 'runtime', maxModelRequestsPerStep: 1, sdkRetries: 0, sdkToolExecution: false,
        sdkToolApproval: false, providerExecutedWrites: false, fallback: null } });
    await client`update agent_runtime_runs set state='waiting_approval' where id=${run.id}`;
    const [source] = await db.insert(dataLibrarySources).values({ owner, title: 'Fixture', kind: 'document', format: 'text' }).returning();
    const [version] = await db.insert(dataLibraryVersions).values({ owner, sourceId: source.id, version: 1,
      contentHash: 'a'.repeat(64), rawContent: 'fixture', extractedText: 'fixture', sections: [], byteLength: 7, extractionState: 'succeeded' }).returning();
    await db.insert(researchSourcePolicies).values({ owner, sourceVersionId: version.id, dataClasses: ['public'], permittedUses: ['research', 'external_write'] });
    const connectionId = randomUUID(), catalogVersionId = randomUUID();
    const descriptor = nativeDescriptor(connectionId, 'send_note', { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] }, 'Write note');
    descriptor.effect = 'external_write'; descriptor.catalogVersionId = catalogVersionId;
    await db.insert(toolConnections).values({ id: connectionId, owner, provider: 'mcp', transport: 'streamable_http', status: 'configured',
      catalogVersionId, allowedToolIds: [descriptor.id], allowedDataClasses: ['public'] });
    const preview: ToolActionPreviewInput = { runId: run.id, stepId: randomUUID(), toolCallId: 'write', descriptor, connectionRevision: 1,
      args: { body: 'protected fixture text' }, accountId: connectionId, target: 'fixture', attachments: [], resourceVersion: null,
      costLimit: { maxCalls: 1, maxAmount: null, currency: null }, scope: { owner, runId: run.id, sessionId: session.id,
        revision: session.revision, leaseToken: '', permissionRevision: 1, allowedInstrumentIds: [], allowedAccountIds: [],
        allowedDataClasses: ['public'], sourceVersions: [{ sourceId: source.id, sourceVersionId: version.id, contentHash: version.contentHash }] } };
    const validation = new ToolActionSourceValidation(), actions = new ToolActionsService(db, validation);
    const saved = await actions.prepare(owner, preview, true);
    await db.update(researchSourcePolicies).set({ dataClasses: ['private_material'] }).where(eq(researchSourcePolicies.sourceVersionId, version.id));
    await assert.rejects(actions.confirm(owner, saved.id, { revision: saved.revision, payloadHash: saved.payloadHash }), /EGRESS|EXPORT/);
    await db.update(researchSourcePolicies).set({ dataClasses: ['public'], permittedUses: ['research'] }).where(eq(researchSourcePolicies.sourceVersionId, version.id));
    await assert.rejects(actions.confirm(owner, saved.id, { revision: saved.revision, payloadHash: saved.payloadHash }), /EXPORT/);
    await db.update(dataLibrarySources).set({ deletedAt: new Date() }).where(eq(dataLibrarySources.id, source.id));
    assert.equal((await actions.detail(owner, saved.id)).state, 'redacted');
    assert.doesNotMatch(JSON.stringify(await actions.list(owner)), /protected fixture text/);
  } finally { await client.end(); await admin.unsafe(`drop schema ${ns} cascade`); await admin.end(); }
});
