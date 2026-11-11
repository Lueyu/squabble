import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { toolConnections } from '../../database/tool-connections.schema';
import { toolActions } from '../../database/tool-actions.schema';
import { ToolActionsService, type ToolActionClaim } from './tool-actions.service';
import { nativeDescriptor } from '../tool-connections/providers/search-provider.contract';
import { toolHash } from '../tool-connections/tool-catalog.service';
import type { ToolActionPreviewInput } from './tool-actions.rules';

async function fixture() {
  const url = process.env.TOOL_CONNECTIONS_TEST_DATABASE_URL;
  assert.ok(url, 'TOOL_CONNECTIONS_TEST_DATABASE_URL must point at isolated PostgreSQL');
  const namespace = `tool_actions_${randomUUID().replaceAll('-', '')}`, admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: namespace } });
  await admin.unsafe(`CREATE SCHEMA ${namespace}`);
  await client.unsafe(readFileSync('scripts/db/56_tool_connections.sql', 'utf8'));
  await client.unsafe(readFileSync('scripts/db/17_research_memory.sql', 'utf8'));
  await client.unsafe(readFileSync('scripts/db/55_tool_actions.sql', 'utf8'));
  process.env.SETTINGS_ENCRYPTION_KEY = 'tool-actions-isolated-test-encryption-key';
  const db = drizzle(client), owner = randomUUID(), connectionId = randomUUID(), catalogVersionId = randomUUID(), runId = randomUUID(), stepId = randomUUID();
  const descriptor = nativeDescriptor(connectionId, 'send_note', { type: 'object', required: ['body', 'recipient'], additionalProperties: false,
    properties: { body: { type: 'string' }, recipient: { type: 'string' } } }, 'send a note');
  descriptor.effect = 'external_write'; descriptor.catalogVersionId = catalogVersionId;
  await db.insert(toolConnections).values({ id: connectionId, owner, provider: 'mcp', transport: 'streamable_http', revision: 3,
    status: 'configured', catalogVersionId, allowedToolIds: [descriptor.id] });
  const input: ToolActionPreviewInput = { runId, stepId, toolCallId: 'write_call', descriptor, connectionRevision: 3,
    args: { body: 'research note body', recipient: 'test@example.org' }, accountId: 'fixture-account', target: 'test@example.org',
    attachments: [], resourceVersion: null, costLimit: { maxCalls: 1, maxAmount: null, currency: null },
    scope: { owner, runId, sessionId: randomUUID(), revision: 1, leaseToken: 'lease1', allowedInstrumentIds: [],
      allowedAccountIds: [], allowedDataClasses: ['public'], sourceVersions: [], permissionRevision: 3 } };
  const claim: ToolActionClaim = { owner, runId, stepId, toolCallId: input.toolCallId, invocationId: randomUUID(),
    toolId: descriptor.id, argumentsHash: toolHash(input.args), catalogVersionId, connectionRevision: 3, scope: input.scope };
  return { db, owner, input, claim, close: async () => { await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); } };
}

test('write preview owns exact content, expires, rejects other owners, edits invalidate approval and cannot submit invalid arguments', async () => {
  const context = await fixture(), service = new ToolActionsService(context.db);
  try {
    const preview = await service.prepare(context.owner, context.input, true);
    assert.equal(preview.state, 'pending'); assert.ok(Date.parse(preview.expiresAt) - Date.now() <= 15 * 60_000);
    assert.ok(!(await context.db.select().from(toolActions))[0].previewEnc.includes('research note body'));
    await assert.rejects(service.detail(randomUUID(), preview.id), /TOOL_ACTION_NOT_FOUND/u);
    await assert.rejects(service.confirm(randomUUID(), preview.id, { revision: 1, payloadHash: preview.payloadHash }), /TOOL_ACTION_NOT_FOUND/u);
    await assert.rejects(context.db.transaction(tx => service.claimInTransaction(tx, context.claim)), /TOOL_ACTION_APPROVAL_REQUIRED/u);
    const approved = await service.confirm(context.owner, preview.id, { revision: 1, payloadHash: preview.payloadHash });
    assert.equal(approved.state, 'approved');
    await assert.rejects(service.edit(context.owner, preview.id, { revision: 1, payloadHash: preview.payloadHash,
      args: { recipient: 'other@example.org', body: 12 }, accountId: 'fixture-account', target: 'other@example.org' }), /INVALID_TOOL_ACTION_PREVIEW/u);
    const edited = await service.edit(context.owner, preview.id, { revision: 1, payloadHash: preview.payloadHash,
      args: { recipient: 'other@example.org', body: 'changed body' }, accountId: 'fixture-account', target: 'other@example.org' });
    assert.equal(edited.state, 'pending'); assert.equal(edited.revision, 2); assert.notEqual(edited.payloadHash, preview.payloadHash);
    await assert.rejects(service.confirm(context.owner, preview.id, { revision: 1, payloadHash: preview.payloadHash }), /TOOL_ACTION_PREVIEW_CHANGED/u);
    await context.db.update(toolActions).set({ expiresAt: new Date(0) }).where(eq(toolActions.id, preview.id));
    await assert.rejects(service.confirm(context.owner, preview.id, { revision: 2, payloadHash: edited.payloadHash }), /TOOL_ACTION_PREVIEW_EXPIRED/u);
  } finally { await context.close(); }
});

test('confirmed write has one atomic dispatch claim; unknown receipts prevent automatic redispatch and repeated confirm is stable', async () => {
  const context = await fixture(), service = new ToolActionsService(context.db);
  try {
    const preview = await service.prepare(context.owner, context.input, true);
    const confirmation = { revision: preview.revision, payloadHash: preview.payloadHash };
    await Promise.all([service.confirm(context.owner, preview.id, confirmation), service.confirm(context.owner, preview.id, confirmation)]);
    const outcomes = await Promise.allSettled([context.db.transaction(tx => service.claimInTransaction(tx, context.claim)),
      context.db.transaction(tx => service.claimInTransaction(tx, { ...context.claim, invocationId: randomUUID() }))]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const dispatched = await service.detail(context.owner, preview.id); assert.equal(dispatched.state, 'dispatched');
    const [row] = await context.db.select().from(toolActions);
    await service.settle(context.owner, row.invocationId!, { state: 'unknown', code: 'TOOL_PROVIDER_UNKNOWN' });
    const unknown = await service.confirm(context.owner, preview.id, confirmation);
    assert.equal(unknown.state, 'unknown'); assert.equal(unknown.receipt?.state, 'unknown');
    await assert.rejects(context.db.transaction(tx => service.claimInTransaction(tx, context.claim)), /TOOL_ACTION_APPROVAL_REQUIRED/u);
    await assert.rejects(service.edit(context.owner, preview.id, { ...confirmation, args: context.input.args,
      accountId: context.input.accountId, target: context.input.target }), /TOOL_ACTION_PREVIEW_CHANGED/u);
  } finally { await context.close(); }
});

test('non-interactive drafts cannot be approved; source revocation and connection change fence dispatch', async () => {
  const context = await fixture();
  let sourceValid = true;
  const service = new ToolActionsService(context.db, { validate: async () => { if (!sourceValid) throw new Error('SOURCE_REVOKED'); } });
  try {
    const draft = await service.prepare(context.owner, context.input, false);
    await assert.rejects(service.confirm(context.owner, draft.id, { revision: draft.revision, payloadHash: draft.payloadHash }), /TOOL_ACTION_INTERACTIVE_CONFIRMATION_REQUIRED/u);
    const input = { ...context.input, toolCallId: 'interactive_write' }, claim = { ...context.claim, toolCallId: input.toolCallId };
    const preview = await service.prepare(context.owner, input, true);
    await service.confirm(context.owner, preview.id, { revision: 1, payloadHash: preview.payloadHash });
    sourceValid = false;
    await assert.rejects(context.db.transaction(tx => service.claimInTransaction(tx, claim)), /SOURCE_REVOKED/u);
    assert.equal((await service.detail(context.owner, preview.id)).state, 'approved');
    sourceValid = true;
    await context.db.update(toolConnections).set({ revision: 4 });
    await assert.rejects(context.db.transaction(tx => service.claimInTransaction(tx, claim)), /TOOL_ACTION_CONNECTION_CHANGED/u);
  } finally { await context.close(); }
});

test('GET action projections redact revoked source derivatives and missing visibility validation fails closed', async () => {
  const context = await fixture(); let visible = true;
  const input = { ...context.input, scope: { ...context.input.scope, sourceVersions: [{ sourceId: randomUUID(), sourceVersionId: randomUUID(), contentHash: 'a'.repeat(64) }] } };
  const service = new ToolActionsService(context.db, { validate: async () => {}, assertVisible: async () => { if (!visible) throw new Error('SOURCE_REVOKED'); } });
  try {
    const preview = await service.prepare(context.owner, input, true);
    assert.equal((await service.detail(context.owner, preview.id)).args.body, 'research note body');
    visible = false;
    const detail = await service.detail(context.owner, preview.id), list = await service.list(context.owner);
    assert.equal(detail.state, 'redacted'); assert.equal(list[0].state, 'redacted');
    assert.ok(!JSON.stringify(detail).includes('research note body')); assert.ok(!JSON.stringify(list).includes('test@example.org'));
    const noReadPort = new ToolActionsService(context.db, { validate: async () => {} });
    assert.equal((await noReadPort.detail(context.owner, preview.id)).state, 'redacted');
  } finally { await context.close(); }
});
