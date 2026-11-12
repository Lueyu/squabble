import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { modelConnections } from '../../database/model-connections.schema';
import { dataLibrarySources, dataLibraryVersions } from '../../database/data-library.schema';
import type { AgentExecutor } from '../../../shared/agent-roster.interface';
import type { ResearchSourceRef } from '../../../shared/team-workspace.interface';

const available = Boolean(process.env.AGENT_ROSTER_TEST_DATABASE_URL ?? process.env.TEAM_TEST_DATABASE_URL);
const errorIs = (code: string) => (error: unknown) => Boolean(error && typeof error === 'object' && 'getResponse' in error && (error.getResponse as () => { code: string })().code === code);
async function fixture() {
  assert.ok(existsSync('server/modules/agent-roster/agent-roster.service.ts'), 'persistent agent roster service must exist');
  const { AgentRosterService } = await import('./agent-roster.service');
  const url = process.env.AGENT_ROSTER_TEST_DATABASE_URL ?? process.env.TEAM_TEST_DATABASE_URL;
  const ns = 'roster_fixture_' + randomUUID().replaceAll('-', '');
  const admin = postgres(url!, { max: 1, onnotice: () => undefined });
  const client = postgres(url!, { max: 5, onnotice: () => undefined, connection: { search_path: ns } });
  await admin.unsafe('CREATE SCHEMA ' + ns);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/62_agent_roster.sql', 'utf8'));
    const db = drizzle(client), owner = randomUUID(), stranger = randomUUID();
    await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},${'roster-' + owner.slice(0, 12)},'unused'),(${stranger},${'roster-' + stranger.slice(0, 12)},'unused')`;
    const [connection] = await db.insert(modelConnections).values({ owner, name: 'Fixture connection', baseUrl: 'https://fixture.invalid', fastModel: 'fictional-fast', slowModel: 'fictional-slow', apiKeyEnc: 'never-used-secret' }).returning();
    const service = new AgentRosterService(db);
    const executor: AgentExecutor = { executionMode: 'model', connectionId: connection.id, model: 'slow' };
    async function source(): Promise<ResearchSourceRef> {
      const [s] = await db.insert(dataLibrarySources).values({ owner, kind: 'upload', title: 'Fictional report', format: 'text', enabled: true }).returning();
      const [v] = await db.insert(dataLibraryVersions).values({ owner, sourceId: s.id, version: 1, contentHash: randomUUID(), rawContent: 'Fictional only', extractedText: 'Fictional only', sections: [], byteLength: 14, extractionState: 'ready' }).returning();
      return { kind: 'document_version', id: v.id, revision: '1', availability: 'available' };
    }
    async function team(name: string, agents: Array<{ id: string; currentVersionId: string }>) {
      const [row] = await client`INSERT INTO teams(owner_id,name,display_json,layout_json) VALUES(${owner},${name},'{}','{}') RETURNING id`;
      const config = { schemaVersion: 1, departments: [], roles: agents.map(a => ({ id: randomUUID(), departmentId: null, participation: 'enabled', responsibility: 'Fixture', expectedOutput: 'Fixture', executor: null, agentId: a.id, agentVersionId: a.currentVersionId, allowedToolIds: [], sourceGrantIds: [] })), relations: [], defaults: { leadRoleId: null, parallelism: 1 } };
      const [version] = await client`INSERT INTO team_versions(team_id,owner_id,version,semantic_revision,semantic_hash,config_json,display_snapshot,created_by) VALUES(${row.id},${owner},1,1,'fixture',${JSON.stringify(config)}::jsonb,'{}',${owner}) RETURNING id`;
      await client`UPDATE teams SET current_version_id=${version.id} WHERE id=${row.id}`;
      return row;
    }
    return { client, db, owner, stranger, service, executor, source, team, dispose: async () => { await client.end(); await admin.unsafe('DROP SCHEMA ' + ns + ' CASCADE'); await admin.end(); } };
  } catch (error) {
    await client.end(); await admin.unsafe('DROP SCHEMA ' + ns + ' CASCADE'); await admin.end(); throw error;
  }
}

test('create replay survives service restart, owner isolation and immutable historical capability versions', { skip: !available }, async () => {
  const f = await fixture();
  try {
    const input = { requestKey: 'create-one', templateId: 'financials', description: '核对周期高点', executor: f.executor };
    const a = await f.service.create(f.owner, input);
    assert.deepEqual(await f.service.create(f.owner, input), a);
    const { AgentRosterService } = await import('./agent-roster.service');
    const restarted = new AgentRosterService(f.db);
    assert.deepEqual(await restarted.detail(f.owner, a.id), a);
    assert.equal((await restarted.list(f.stranger, {})).items.length, 0);
    await assert.rejects(restarted.detail(f.stranger, a.id), errorIs('AGENT_NOT_FOUND'));
    await assert.rejects(restarted.create(f.owner, { ...input, name: 'Changed' }), errorIs('AGENT_REQUEST_KEY_CONFLICT'));
    const changed = await restarted.update(f.owner, a.id, { requestKey: 'update-one', expectedRevision: a.revision, instructions: '新的财务核对职责' });
    assert.equal(changed.revision, a.revision + 1);
    assert.notEqual(changed.currentVersionId, a.currentVersionId);
    assert.equal((await restarted.version(f.owner, a.id, a.currentVersionId)).config.instructions, a.currentVersion.config.instructions);
    await assert.rejects(restarted.update(f.owner, a.id, { requestKey: 'stale', expectedRevision: a.revision, name: 'Stale' }), errorIs('AGENT_REVISION_CONFLICT'));
    await assert.rejects(f.client`UPDATE agent_roster_versions SET config_json='{}'::jsonb WHERE id=${a.currentVersionId}`);
    const stored = JSON.stringify(await f.client`SELECT config_json FROM agent_roster_versions`);
    assert.equal(stored.includes('never-used-secret'), false);
    assert.equal(stored.includes('fixture.invalid'), false);
  } finally { await f.dispose(); }
});

test('recommended templates are atomic and idempotent; duplicate people are rejected while same connections are reusable', { skip: !available }, async () => {
  const f = await fixture();
  try {
    const request = { requestKey: 'five', executor: f.executor };
    const result = await f.service.recommended(f.owner, request);
    assert.equal(result.items.length, 5);
    assert.equal(new Set(result.items.map(a => a.id)).size, 5);
    assert.deepEqual(await f.service.recommended(f.owner, request), result);
    const selections = result.items.slice(0, 2).map(a => ({ agentId: a.id, agentVersionId: a.currentVersionId }));
    assert.equal((await f.service.resolveMembers(f.owner, selections)).length, 2);
    await assert.rejects(f.service.resolveMembers(f.owner, [selections[0], selections[0]]), errorIs('AGENT_INVALID_INPUT'));
    const a = result.items[0];
    const archived = await f.service.archive(f.owner, a.id, { requestKey: 'archive', expectedRevision: a.revision });
    assert.equal(archived.status, 'archived');
    await assert.rejects(f.service.resolveMembers(f.owner, [selections[0]]), errorIs('AGENT_ARCHIVED'));
    assert.equal((await f.service.version(f.owner, a.id, a.currentVersionId)).id, a.currentVersionId);
  } finally { await f.dispose(); }
});

test('exact source ceilings and live deletion fences apply before selection and private memory reads', { skip: !available }, async () => {
  const f = await fixture();
  try {
    const source = await f.source();
    const a = await f.service.create(f.owner, { requestKey: 'source-agent', executor: f.executor, allowedSources: [source], allowedToolIds: ['read_source'] });
    const selected = [{ agentId: a.id, agentVersionId: a.currentVersionId }];
    const members = await f.service.resolveMembers(f.owner, selected, { sourceRefs: [source], allowedToolIds: ['read_source'] });
    assert.equal(members[0].rosterAgentId, a.id);
    await assert.rejects(f.service.resolveMembers(f.owner, selected, { allowedToolIds: ['write_external'] }), errorIs('AGENT_SCOPE_DENIED'));
    const memory = await f.service.writeMemory(f.owner, a.id, { requestKey: 'remember', expectedRevision: a.revision, scope: { kind: 'personal' }, content: 'Derived from the fictional report', origin: 'source_summary', sourceRefs: [source] });
    assert.equal((await f.service.readMemory(f.owner, a.id, { kind: 'personal' })).items[0].id, memory.id);
    await f.client`UPDATE data_library_sources SET enabled=false WHERE id=(SELECT source_id FROM data_library_versions WHERE id=${source.id})`;
    await assert.rejects(f.service.resolveMembers(f.owner, selected, { sourceRefs: [source] }), errorIs('AGENT_SOURCE_UNAVAILABLE'));
    assert.deepEqual((await f.service.readMemory(f.owner, a.id, { kind: 'personal' })).items, []);
  } finally { await f.dispose(); }
});

test('team and conversation memories require explicit scopes and sharing retains original provenance', { skip: !available }, async () => {
  const f = await fixture();
  try {
    const a = await f.service.create(f.owner, { requestKey: 'a', executor: f.executor });
    const b = await f.service.create(f.owner, { requestKey: 'b', executor: f.executor });
    const teamA = await f.team('A', [a]);
    const teamB = await f.team('B', [a, b]);
    const memory = await f.service.writeMemory(f.owner, a.id, { requestKey: 'team-memory', expectedRevision: a.revision, scope: { kind: 'team', teamId: teamA.id }, content: 'Team A only', origin: 'user_note', sourceRefs: [] });
    assert.equal((await f.service.readMemory(f.owner, a.id, { kind: 'personal' })).items.length, 0);
    assert.equal((await f.service.readMemory(f.owner, a.id, { kind: 'team', teamId: teamB.id })).items.length, 0);
    await f.service.shareMemory(f.owner, a.id, memory.id, { requestKey: 'share', expectedRevision: a.revision, targetAgentId: b.id, targetScope: { kind: 'team', teamId: teamB.id } });
    const shared = (await f.service.readMemory(f.owner, b.id, { kind: 'team', teamId: teamB.id })).items[0];
    assert.equal(shared.content, 'Team A only');
    assert.deepEqual(shared.sharedFrom, { memoryId: memory.id, agentId: a.id, scope: { kind: 'team', teamId: teamA.id } });
    await assert.rejects(f.service.readMemory(f.owner, b.id, { kind: 'team', teamId: teamA.id }), errorIs('AGENT_SCOPE_DENIED'));
    await assert.rejects(f.service.readMemory(f.stranger, a.id, { kind: 'personal' }), errorIs('AGENT_NOT_FOUND'));
    await assert.rejects(f.service.readMemory(f.owner, a.id, { kind: 'conversation', conversationId: randomUUID() }), errorIs('AGENT_SCOPE_DENIED'));
    await f.client`UPDATE teams SET status='archived' WHERE id=${teamA.id}`;
    assert.equal((await f.service.readMemory(f.owner, b.id, { kind: 'team', teamId: teamB.id })).items.length, 0, 'archiving the source scope invalidates later shared retrieval');
  } finally { await f.dispose(); }
});

test('sharing a derived memory never grants its sources to the receiving team', { skip: !available }, async () => {
  const f = await fixture();
  try {
    const ref = await f.source();
    const a = await f.service.create(f.owner, { requestKey: 'a', executor: f.executor, allowedSources: [ref] });
    const b = await f.service.create(f.owner, { requestKey: 'b', executor: f.executor, allowedSources: [ref] });
    const team = await f.team('Receiver', [b]);
    const memory = await f.service.writeMemory(f.owner, a.id, { requestKey: 'remember', expectedRevision: 1, scope: { kind: 'personal' }, content: 'Fictional source summary', origin: 'source_summary', sourceRefs: [ref] });
    const share = { requestKey: 'share', expectedRevision: 1, targetAgentId: b.id, targetScope: { kind: 'team', teamId: team.id } };
    await assert.rejects(f.service.shareMemory(f.owner, a.id, memory.id, share), errorIs('AGENT_SCOPE_DENIED'));
    await f.client`INSERT INTO team_source_grants(owner_id,team_id,source_kind,source_id,source_revision,state,granted_by) VALUES(${f.owner},${team.id},${ref.kind},${ref.id},${ref.revision},'active',${f.owner})`;
    await f.service.shareMemory(f.owner, a.id, memory.id, share);
    assert.equal((await f.service.readMemory(f.owner, b.id, { kind: 'team', teamId: team.id })).items.length, 1);
    await f.client`UPDATE team_source_grants SET state='revoked' WHERE team_id=${team.id}`;
    assert.equal((await f.service.readMemory(f.owner, b.id, { kind: 'team', teamId: team.id })).items.length, 0);
  } finally { await f.dispose(); }
});

test('neutral transaction fence rejects narrowed current scopes and archived snapshots; memory scopes require real participation', { skip: !available }, async () => {
  const f = await fixture();
  try {
    assert.ok(existsSync('server/database/agent-roster-context.ts'), 'final authority must have a neutral database fence');
    const { assertAgentRosterExecutionFence } = await import('../../database/agent-roster-context');
    const ref = await f.source();
    const a = await f.service.create(f.owner, { requestKey: 'a', executor: f.executor, allowedSources: [ref] });
    const b = await f.service.create(f.owner, { requestKey: 'b', executor: f.executor });
    const members = [{ rosterAgentId: a.id, rosterAgentVersionId: a.currentVersionId }];
    await f.db.transaction(tx => assertAgentRosterExecutionFence(tx, f.owner, members, { sourceRefs: [ref] }));
    const narrowed = await f.service.update(f.owner, a.id, { requestKey: 'narrow', expectedRevision: 1, allowedSources: [] });
    await assert.rejects(f.db.transaction(tx => assertAgentRosterExecutionFence(tx, f.owner, members, { sourceRefs: [ref] })), errorIs('AGENT_SCOPE_DENIED'));
    const team = await f.team('Only B', [b]);
    await assert.rejects(f.service.writeMemory(f.owner, a.id, { requestKey: 'outsider', expectedRevision: narrowed.revision, scope: { kind: 'team', teamId: team.id }, content: 'No implicit team membership', origin: 'user_note', sourceRefs: [] }), errorIs('AGENT_SCOPE_DENIED'));
    const [session] = await f.client`INSERT INTO council_sessions(owner,profile_version,profile_snapshot,ticker) VALUES(${f.owner},1,${JSON.stringify({ council: { members: [{ rosterAgentId: b.id, rosterAgentVersionId: b.currentVersionId }] } })}::jsonb,'FIXTURE') RETURNING id`;
    await assert.rejects(f.service.writeMemory(f.owner, a.id, { requestKey: 'outsider-chat', expectedRevision: narrowed.revision, scope: { kind: 'conversation', conversationId: session.id }, content: 'Not a participant', origin: 'user_note', sourceRefs: [] }), errorIs('AGENT_SCOPE_DENIED'));
    await f.service.archive(f.owner, a.id, { requestKey: 'archive', expectedRevision: narrowed.revision });
    await assert.rejects(f.db.transaction(tx => assertAgentRosterExecutionFence(tx, f.owner, members)), errorIs('AGENT_ARCHIVED'));
    await f.db.transaction(tx => assertAgentRosterExecutionFence(tx, f.owner, [{}]));
  } finally { await f.dispose(); }
});

test('runtime recall pins version, sources, cutoff and one scope while archived owner history remains readable', { skip: !available }, async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.service.readMemoryForExecution, 'function', 'runtime recall must not reuse the owner history endpoint');
    const ref = await f.source();
    const a = await f.service.create(f.owner, { requestKey: 'a', executor: f.executor, allowedSources: [ref] });
    const selection = { agentId: a.id, agentVersionId: a.currentVersionId };
    const personal = await f.service.writeMemory(f.owner, a.id, { requestKey: 'note', expectedRevision: 1, scope: { kind: 'personal' }, content: 'Explicit user preference', origin: 'user_note', sourceRefs: [] });
    await f.service.writeMemory(f.owner, a.id, { requestKey: 'derived', expectedRevision: 1, scope: { kind: 'personal' }, content: 'A source-derived fact', origin: 'source_summary', sourceRefs: [ref] });
    const options = { sourceRefs: [], dataCutoffAt: new Date(Date.now() + 60000).toISOString() };
    const onlyNote = await f.db.transaction(tx => f.service.readMemoryForExecution(tx, f.owner, selection, { kind: 'personal' }, options));
    assert.deepEqual(onlyNote.items.map(m => m.id), [personal.id]);
    assert.equal((await f.db.transaction(tx => f.service.readMemoryForExecution(tx, f.owner, selection, { kind: 'personal' }, { ...options, sourceRefs: [ref] }))).items.length, 2);
    assert.equal((await f.db.transaction(tx => f.service.readMemoryForExecution(tx, f.owner, selection, { kind: 'personal' }, { ...options, dataCutoffAt: new Date(Date.now() - 60000).toISOString() }))).items.length, 0);
    const [session] = await f.client`INSERT INTO council_sessions(owner,profile_version,profile_snapshot,ticker) VALUES(${f.owner},1,${JSON.stringify({ council: { members: [{ rosterAgentId: a.id, rosterAgentVersionId: a.currentVersionId }] } })}::jsonb,'FIXTURE') RETURNING id`;
    assert.equal((await f.db.transaction(tx => f.service.readMemoryForExecution(tx, f.owner, selection, { kind: 'conversation', conversationId: session.id }, options))).items.length, 0, 'conversation recall must not inherit personal memory');
    await f.service.archive(f.owner, a.id, { requestKey: 'archive', expectedRevision: 1 });
    assert.equal((await f.service.readMemory(f.owner, a.id, { kind: 'personal' })).items.length, 2, 'owner history remains readable after archive');
    await assert.rejects(f.db.transaction(tx => f.service.readMemoryForExecution(tx, f.owner, selection, { kind: 'personal' }, options)), errorIs('AGENT_ARCHIVED'));
  } finally { await f.dispose(); }
});
