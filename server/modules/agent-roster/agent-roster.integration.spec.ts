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

test('chosen animals persist and avatar edits leave capabilities, authorization and old conversation identity intact', { skip: !available }, async () => {
  const f = await fixture();
  try {
    const input = { requestKey: 'animal-create', avatar: 'news', executor: f.executor, allowedToolIds: ['get_financials'] };
    const agent = await f.service.create(f.owner, input);
    assert.equal(agent.avatar, 'news');
    assert.deepEqual(await f.service.create(f.owner, input), agent);
    assert.equal((await f.service.detail(f.owner, agent.id)).avatar, 'news');
    const selection = { agentId: agent.id, agentVersionId: agent.currentVersionId, role: 'manager' as const };
    const [frozen] = await f.service.resolveMembers(f.owner, [selection], { allowedToolIds: ['get_financials'] });
    const snapshot = { council: { enabled: true, members: [frozen] } };
    const [session] = await f.client`INSERT INTO council_sessions(owner,profile_version,profile_snapshot,ticker) VALUES(${f.owner},1,${JSON.stringify(snapshot)}::jsonb,'FIXTURE') RETURNING id`;
    const request = { requestKey: 'animal-edit', expectedRevision: agent.revision, avatar: 'growth' };
    const updated = await f.service.update(f.owner, agent.id, request);
    assert.equal(updated.avatar, 'growth');
    assert.equal(updated.currentVersionId, agent.currentVersionId);
    assert.deepEqual(updated.currentVersion.config, agent.currentVersion.config);
    assert.deepEqual(await f.service.update(f.owner, agent.id, request), updated);
    const [next] = await f.service.resolveMembers(f.owner, [{ ...selection, role: 'challenger' }], { allowedToolIds: ['get_financials'] });
    assert.equal(next.avatar, 'growth');
    const [history] = await f.client`SELECT profile_snapshot FROM council_sessions WHERE id=${session.id}`;
    assert.equal(history.profile_snapshot.council.members[0].avatar, 'news');
    await assert.rejects(f.service.resolveMembers(f.owner, [selection], { allowedToolIds: ['write_external'] }), errorIs('AGENT_SCOPE_DENIED'));
    await assert.rejects(f.service.update(f.owner, agent.id, { requestKey: 'invalid-animal', expectedRevision: updated.revision, avatar: 'https://image.invalid/a.png' }), errorIs('AGENT_INVALID_INPUT'));
    const changedWork = await f.service.update(f.owner, agent.id, {
      requestKey: 'edit-work', expectedRevision: updated.revision,
      instructions: 'Focus on cash flow and flag uncertain facts.',
      preferences: { userPreferences: 'Answer briefly.' },
    });
    assert.notEqual(changedWork.currentVersionId, agent.currentVersionId);
    const [working] = await f.service.resolveMembers(f.owner, [{ ...selection, agentVersionId: changedWork.currentVersionId }]);
    assert.match(working.instructions, /Focus on cash flow/u);
    assert.match(working.instructions, /Answer briefly/u);
    assert.equal((await f.service.version(f.owner, agent.id, agent.currentVersionId)).config.instructions, agent.currentVersion.config.instructions);
  } finally { await f.dispose(); }
});

test('editing identity does not renew unavailable sources or create a new permission version', { skip: !available }, async () => {
  const f = await fixture();
  try {
    const source = await f.source();
    const agent = await f.service.create(f.owner, { requestKey: 'scoped-identity', executor: f.executor, allowedSources: [source] });
    await f.client`UPDATE data_library_sources SET enabled=false WHERE id=(SELECT source_id FROM data_library_versions WHERE id=${source.id})`;
    const updated = await f.service.update(f.owner, agent.id, { requestKey: 'identity-only', expectedRevision: agent.revision, avatar: 'news' });
    assert.equal(updated.currentVersionId, agent.currentVersionId);
    assert.deepEqual(updated.currentVersion.config.allowedSources, [source]);
    await assert.rejects(f.service.resolveMembers(f.owner, [{ agentId: agent.id, agentVersionId: agent.currentVersionId }], { sourceRefs: [source] }), errorIs('AGENT_SOURCE_UNAVAILABLE'));
  } finally { await f.dispose(); }
});

test('ordinary conversation creation freezes the selected animal and saved preferences across later edits and receipt replay', { skip: !available }, async () => {
  const f = await fixture();
  try {
    const { CouncilService } = await import('../council/council.service');
    const { SimpleCouncilService } = await import('../council/simple-council.service');
    let modelCalls = 0;
    const prompts: string[] = [];
    const fakeResponse = async (prompt: unknown) => {
      modelCalls++;
      prompts.push(JSON.stringify(prompt));
      return { data: { content: 'Fictional response with uncertainty retained.', evidenceIds: [], researchStance: 'balanced' }, tokens: 1 };
    };
    const llm = {
      validateConnectionIds: async () => {},
      isConfigured: async () => true,
      getExecutionInfo: async () => ({ provider: 'fictional', modelFast: 'fake', modelSlow: 'fake' }),
      chatFastJSON: fakeResponse,
      chatSlowJSON: fakeResponse,
    };
    const council = new CouncilService(f.db, llm as never,
      { collectEvidence: async () => [] } as never,
      { getPortfolioContext: async () => ({ totalValue: 0, cash: 0, holdings: [] }) } as never,
      { listRuns: async () => ({ items: [] }) } as never);
    const simple = new SimpleCouncilService(f.db, council, llm as never, undefined, undefined, undefined, undefined, f.service);
    const agent = await f.service.create(f.owner, {
      requestKey: 'conversation-person', avatar: 'news', executor: f.executor,
      instructions: 'Verify cash flow.', preferences: { language: 'en', userPreferences: 'Show missing data first.' },
    });
    const request = {
      requestKey: 'ordinary-conversation', message: 'How can an investor evaluate uncertainty?',
      agents: [{ agentId: agent.id, agentVersionId: agent.currentVersionId }],
    };
    const created = await simple.create(f.owner, request);
    assert.ok('id' in created, 'an ordinary discussion must create a durable conversation');
    if (!('id' in created)) throw new Error('Unexpected clarification');
    assert.equal(created.members?.[0].avatar, 'news');
    assert.match(created.members?.[0].instructions ?? '', /Show missing data first/u);
    const jobs = (council as unknown as { jobs: Map<string, Promise<void>> }).jobs;
    await jobs.get(`${f.owner}:${created.id}`);
    assert.equal((await simple.get(f.owner, created.id)).status, 'completed');
    assert.ok(modelCalls > 0, 'the actual conversation runner must reach the in-process fake model');
    assert.match(prompts[0], /Show missing data first/u);
    const callsAfterFirst = modelCalls;
    const changed = await f.service.update(f.owner, agent.id, {
      requestKey: 'change-after-conversation', expectedRevision: agent.revision,
      avatar: 'growth', instructions: 'Review concentration.', preferences: { userPreferences: 'Be concise.' },
    });
    const replayed = await simple.create(f.owner, request);
    assert.ok('id' in replayed);
    if (!('id' in replayed)) throw new Error('Unexpected clarification');
    assert.equal(replayed.id, created.id);
    assert.equal(replayed.members?.[0].avatar, 'news');
    assert.match(replayed.members?.[0].instructions ?? '', /Verify cash flow/u);
    assert.match(replayed.members?.[0].instructions ?? '', /Show missing data first/u);
    assert.equal(modelCalls, callsAfterFirst, 'receipt replay cannot dispatch another model request');
    const next = await simple.create(f.owner, {
      ...request, requestKey: 'next-ordinary-conversation',
      agents: [{ agentId: agent.id, agentVersionId: changed.currentVersionId, role: 'manager' }],
    });
    assert.ok('id' in next);
    if (!('id' in next)) throw new Error('Unexpected clarification');
    await jobs.get(`${f.owner}:${next.id}`);
    assert.equal((await simple.get(f.owner, next.id)).status, 'completed');
    assert.equal(next.members?.[0].avatar, 'growth');
    assert.equal(next.members?.[0].role, 'manager');
    assert.match(next.members?.[0].instructions ?? '', /Be concise/u);
    const [stored] = await f.client`SELECT profile_snapshot FROM council_sessions WHERE id=${created.id}`;
    assert.equal(stored.profile_snapshot.council.members[0].avatar, 'news');
    assert.equal(stored.profile_snapshot.council.members[0].rosterAgentVersionId, agent.currentVersionId);
    assert.equal((await f.client`SELECT count(*)::int AS count FROM council_sessions`)[0].count, 2);
    assert.ok(modelCalls > callsAfterFirst);
    assert.match(prompts.at(-1)!, /Be concise/u);
  } finally { await f.dispose(); }
});

test('migration66 backfills legacy identities deterministically, preserves history and replays without changing edited animals', { skip: !available }, async () => {
  const f = await fixture();
  try {
    const result = await f.service.recommended(f.owner, { requestKey: 'english-five', executor: f.executor, language: 'en' });
    assert.equal(result.items[0].name, 'Financials friend');
    assert.match(result.items[0].currentVersion.config.instructions, /cash flow/u);
    assert.equal(result.items[0].currentVersion.config.preferences.language, 'en');
    assert.deepEqual(await f.service.recommended(f.owner, { requestKey: 'english-five', executor: f.executor, language: 'en' }), result);
    const versions = await f.client`SELECT id,config_json FROM agent_roster_versions ORDER BY id`;
    const receipts = await f.client`SELECT result_json FROM agent_roster_requests ORDER BY id`;
    await f.client.unsafe('ALTER TABLE agent_roster_profiles DROP COLUMN avatar');
    const migration = readFileSync('scripts/db/66_agent_animal_identity.sql', 'utf8');
    await f.client.unsafe(migration);
    for (const agent of result.items) assert.equal((await f.service.detail(f.owner, agent.id)).avatar, agent.avatar);
    assert.deepEqual(await f.client`SELECT id,config_json FROM agent_roster_versions ORDER BY id`, versions);
    assert.deepEqual(await f.client`SELECT result_json FROM agent_roster_requests ORDER BY id`, receipts);
    const first = result.items[0];
    await f.service.update(f.owner, first.id, { requestKey: 'post-upgrade-animal', expectedRevision: first.revision, avatar: 'growth' });
    await f.client.unsafe(migration);
    assert.equal((await f.service.detail(f.owner, first.id)).avatar, 'growth');
    await assert.rejects(f.client`UPDATE agent_roster_profiles SET avatar='invalid' WHERE id=${first.id}`);
    await assert.rejects(f.client`UPDATE agent_roster_profiles SET avatar=NULL WHERE id=${first.id}`);
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
