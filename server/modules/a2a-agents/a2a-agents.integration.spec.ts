import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ToolTransportPolicy } from '../tool-connections/tool-transport-policy';
import { A2aProtocolAdapter } from './a2a-protocol.adapter';
import { A2aAgentsService } from './a2a-agents.service';
import { AgentRosterService } from '../agent-roster/agent-roster.service';
import { CouncilService } from '../council/council.service';
import { TeamStore } from '../teams/team-store';
import { TeamsService } from '../teams/teams.service';
import { TeamVersionService } from '../teams/team-version.service';
import { TeamCommissionService } from '../teams/team-commission.service';
import { TeamCommissionWorker } from '../teams/team-commission.worker';
import { TeamRuntimeAdapter } from '../teams/team-runtime-adapter';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { paperAccounts } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { DEFAULT_INVESTMENT_CONFIG } from '../paper-trading/investment-policy.rules';
import type { TeamSemanticConfig } from '../../../shared/team-workspace.interface';
import { councilSessions } from '../../database/council.schema';
import { eq } from 'drizzle-orm';
import { assertTeamExecutionInTransaction } from '../../database/team-context';
import { commissionContext } from '../teams/team-commission.service';
import { teamCommissions } from '../../database/teams.schema';

const available = Boolean(process.env.A2A_TEST_DATABASE_URL);
async function fixture(fullSchema = false) {
  process.env.SETTINGS_ENCRYPTION_KEY = 'a2a-test-only-encryption-key';
  let origin = '', sends = 0, gets = 0, cancels = 0;
  let behavior = 'immediate';
  let beforeReply: (() => Promise<void>) | undefined;
  let rpcReply: ((method: string, result: unknown) => Promise<unknown>) | undefined;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/agent-card.json') {
      res.end(JSON.stringify({ name: 'Conforming fixture', version: '1', defaultOutputModes: ['application/json'], skills: [{ id: 'research', name: 'Research', description: 'fictional' }],
        supportedInterfaces: [{ protocolVersion: '1.0', protocolBinding: 'JSONRPC', url: origin + '/rpc' }] })); return;
    }
    assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    let output: unknown = { summary: 'fictional private result', evidenceIds: [] };
    if (behavior === 'team' && rpc.method === 'SendMessage') {
      const prompt = rpc.params.message.parts[0].text as string;
      const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      output = { conclusion: 'Fictional team finding', evidenceIds: input.evidence.slice(0, 1).map((item: { id: string }) => item.id), asOf: '2020-01-01T00:00:00.000Z', currency: 'USD', units: 'USD', assumptions: [], gaps: [], skillVersions: input.skills,
        response: { thesis: 'Fictional structured finding', evidencePoints: [], risks: ['Uncertain'], nextChecks: ['Review source'] } };
    }
    const message = { messageId: 'reply', role: 'ROLE_AGENT', contextId: 'ctx', parts: [{ text: JSON.stringify(output) }] };
    let result: unknown;
    if (rpc.method === 'SendMessage') {
      sends++; assert.equal(rpc.params.message.role, 'ROLE_USER'); assert.equal(rpc.params.configuration.returnImmediately, true);
      await beforeReply?.();
      if (behavior === 'network') { req.socket.destroy(); return; }
      if (behavior === 'immediate' || behavior === 'team') result = { message };
      else result = { task: { id: 'remote-' + behavior, contextId: 'ctx', status: { state: behavior === 'input' ? 'TASK_STATE_INPUT_REQUIRED' : behavior === 'auth' ? 'TASK_STATE_AUTH_REQUIRED' : 'TASK_STATE_WORKING' } } };
    } else if (rpc.method === 'GetTask') {
      gets++;
      result = { id: rpc.params.id, contextId: 'ctx', status: { state: ['pending', 'late', 'refuse'].includes(behavior) ? 'TASK_STATE_WORKING' : 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'a', parts: behavior === 'invalid' ? [{ url: origin + '/secret-artifact' }] : message.parts }] };
    } else {
      cancels++;
      if (behavior === 'refuse') { res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32002, message: 'cannot cancel' } })); return; }
      result = { id: rpc.params.id, status: { state: behavior === 'pending' ? 'TASK_STATE_WORKING' : 'TASK_STATE_CANCELED' } };
    }
    if (rpcReply) result = await rpcReply(rpc.method, result);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const ns = 'a2a_fixture_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.A2A_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.A2A_TEST_DATABASE_URL!, { max: 5, connection: { search_path: ns }, onnotice: () => undefined });
  await admin.unsafe('CREATE SCHEMA ' + ns);
  if (fullSchema) await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
  await client.unsafe(readFileSync('scripts/db/64_a2a_agents_runtime.sql', 'utf8'));
  const services = [{ id: 'card', endpoint: origin + '/.well-known/agent-card.json' }, { id: 'rpc', endpoint: origin + '/rpc' }];
  process.env.A2A_LOCAL_SERVICES_JSON = JSON.stringify(services);
  const db = drizzle(client), adapter = new A2aProtocolAdapter(new ToolTransportPolicy(services));
  const service = new A2aAgentsService(db, adapter), owner = randomUUID(), stranger = randomUUID();
  if (fullSchema) await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},${owner.slice(0,24)},'fixture')`;
  const connection = await service.create(owner, { requestKey: 'create', name: 'External friend', cardUrl: services[0].endpoint, credential: 'fixture-secret', trustLocalEndpoint: true });
  return { service, db, adapter, client, owner, stranger, connection, behavior: (value: string) => { behavior = value; }, beforeReply: (callback: () => Promise<void>) => { beforeReply = callback; }, rpcReply: (callback: (method: string, result: unknown) => Promise<unknown>) => { rpcReply = callback; }, counts: () => ({ sends, gets, cancels }),
    dispose: async () => { await client.end(); await admin.unsafe('DROP SCHEMA ' + ns + ' CASCADE'); await admin.end(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('real immediate/polled replies survive restart, keep encrypted originals, isolate owner and never resend', { skip: !available }, async () => {
  const f = await fixture();
  try {
    const input = { connectionId: f.connection.id, messageId: 'one', prompt: 'private fictional prompt' };
    const a = await f.service.execute(f.owner, input);
    assert.deepEqual(a.data, { summary: 'fictional private result', evidenceIds: [] });
    const restarted = new A2aAgentsService(f.db, f.adapter);
    assert.equal((await restarted.execute(f.owner, input)).taskId, a.taskId);
    assert.equal(f.counts().sends, 1);
    await assert.rejects(restarted.inspectTask(f.stranger, a.taskId));
    const raw = JSON.stringify(await f.client`SELECT * FROM a2a_agent_invocations`);
    assert.equal(raw.includes('private fictional prompt'), false); assert.equal(raw.includes('fictional private result'), false); assert.equal(raw.includes('fixture-secret'), false);
    f.behavior('poll');
    const b = await restarted.execute(f.owner, { ...input, messageId: 'two' });
    assert.equal(b.remoteTaskId, 'remote-poll'); assert.equal(f.counts().gets, 1);
    assert.equal((await restarted.inspectTask(f.owner, b.taskId!)).acceptance, 'pending');
    await restarted.acceptResult(f.owner, b.taskId!, { structuredOutput: true });
    assert.equal((await restarted.inspectTask(f.owner, b.taskId!)).acceptance, 'accepted');
  } finally { await f.dispose(); }
});

test('unknown dispatch, interrupted tasks, invalid artifacts, timeout, refused/pending cancellation and revoked publication remain explicit', { skip: !available }, async () => {
  const f = await fixture();
  try {
    let next = 0;
    const run = (timeoutMs = 5000) => f.service.execute(f.owner, { connectionId: f.connection.id, messageId: 'm' + next++, prompt: 'fictional', timeoutMs, pollIntervalMs: 5 });
    f.behavior('network'); await assert.rejects(run(), /A2A_DISPATCH_UNKNOWN/u);
    await assert.rejects(f.service.execute(f.owner, { connectionId: f.connection.id, messageId: 'm0', prompt: 'fictional', timeoutMs: 50 }), /A2A_DISPATCH_UNKNOWN/u);
    assert.equal(f.counts().sends, 1);
    for (const [behavior, code] of [['input', 'A2A_INPUT_REQUIRED'], ['auth', 'A2A_AUTH_REQUIRED'], ['invalid', 'A2A_INVALID_OUTPUT'], ['pending', 'A2A_TIMEOUT']]) {
      f.behavior(behavior); await assert.rejects(run(behavior === 'pending' ? 500 : 5000), new RegExp(code, 'u'));
    }
    const pending = (await f.service.listTasks(f.owner, {})).items.find(task => task.remoteTaskId === 'remote-pending')!;
    const receipt = await f.service.cancelTask(f.owner, pending.id);
    assert.equal(receipt.cancellation, 'requested'); assert.equal(receipt.state, 'working'); assert.equal(receipt.externalCostUnknown, true);
    f.behavior('refuse'); await assert.rejects(run(500), /A2A_TIMEOUT/u);
    const refused = (await f.service.listTasks(f.owner, {})).items.find(task => task.remoteTaskId === 'remote-refuse')!;
    assert.equal((await f.service.cancelTask(f.owner, refused.id)).cancellation, 'refused');
    f.behavior('immediate');
    const good = await run();
    await f.service.disable(f.owner, f.connection.id, { requestKey: 'disable', expectedRevision: f.connection.revision });
    await assert.rejects(f.service.reparse(f.owner, good.taskId!), /A2A_CONNECTION_DISABLED/u);
    assert.equal((await f.service.inspectTask(f.owner, good.taskId!)).acceptance, 'blocked');
    assert.equal((await f.service.cancelTask(f.owner, pending.id)).cancellation, 'confirmed');
  } finally { await f.dispose(); }
});

test('real external friend executes through roster, ordinary Council and frozen team commission with unknown fees', { skip: !available }, async t => {
  const f = await fixture(true);
  const before = { workspace: process.env.TEAM_WORKSPACE_ENABLED, research: process.env.TEAM_RESEARCH_ENABLED };
  process.env.TEAM_WORKSPACE_ENABLED = 'true'; process.env.TEAM_RESEARCH_ENABLED = 'true';
  try {
    const [clock] = await f.client<{ milliseconds: string }[]>`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS milliseconds`;
    t.mock.timers.enable({ apis: ['Date'], now: Math.ceil(Number(clock.milliseconds)) + 3600000 });
    const budget = new LlmBudgetService(f.db);
    await budget.saveSettings(f.owner, { ...await budget.getSettings(f.owner), maxCallsPerTask: 20, dailyCallLimit: 100, perTaskTokenLimit: 100000, dailyTokenLimit: 200000, monthlyTokenLimit: 500000 });
    const external = new A2aAgentsService(f.db, f.adapter, budget);
    const roster = new AgentRosterService(f.db);
    const friend = await roster.create(f.owner, { requestKey: 'external-friend', name: 'A2A fixture friend', allowedToolIds: [],
      executor: { executionMode: 'a2a', connectionId: f.connection.id } });
    const members = await roster.resolveMembers(f.owner, [{ agentId: friend.id, agentVersionId: friend.currentVersionId }]);
    assert.equal(members[0].a2aFingerprint?.cardHash, f.connection.cardHash);
    const documents = new ResearchDocumentsService(f.db);
    const llm = { validateConnectionIds: async (_owner: string, ids: string[]) => { assert.deepEqual(ids, []); },
      isConfigured: async () => { throw new Error('A2A must never enter model transport'); }, getInputLimit: async () => 32000 };
    const council = new CouncilService(f.db, llm as never, { collectEvidence: async () => [] } as never,
      { getPortfolioContext: async () => ({ totalValue: 0, cash: 0, holdings: [] }) } as never,
      { listRuns: async () => ({ items: [] }) } as never, undefined, budget, undefined, undefined, documents, undefined, external);
    const session = await council.createSession(f.owner, { ticker: 'FIXTURE', members, language: 'en' }, { independent: true });
    await council.runSession(f.owner, session.id);
    await Promise.all((council as unknown as { jobs: Map<string, Promise<void>> }).jobs.values());
    const ordinary = await council.getSession(f.owner, session.id);
    assert.equal(ordinary.status, 'completed', JSON.stringify({ error: ordinary.error, tasks: await external.listTasks(f.owner, {}), members: await f.client`SELECT status,failure FROM council_member_attempts WHERE owner=${f.owner}` })); assert.equal(f.counts().sends, 1);
    assert.equal((await external.detail(f.owner, f.connection.id)).capabilities.structuredOutputVerified, true);
    assert.ok(ordinary.messages.some(message => message.content.includes('fictional private result')));

    const store = new TeamStore(f.db), teams = new TeamsService(store), runtime = new TeamRuntimeAdapter(council), versions = new TeamVersionService(store, runtime);
    const commissions = new TeamCommissionService(store, runtime), worker = new TeamCommissionWorker(store, runtime, commissions);
    const created = await teams.create(f.owner, { requestKey: 'team', name: 'External team fixture' });
    const role = randomUUID();
    const config: TeamSemanticConfig = { schemaVersion: 1, departments: [], relations: [], roles: [{ id: role, departmentId: null, participation: 'enabled',
      agentId: friend.id, agentVersionId: friend.currentVersionId, responsibility: 'Check fictional evidence', expectedOutput: 'Structured finding',
      executor: { executionMode: 'a2a', connectionId: f.connection.id }, allowedToolIds: [], sourceGrantIds: [] }], defaults: { leadRoleId: role, parallelism: 1 } };
    const saved = await teams.save(f.owner, created.id, 'draft', { requestKey: 'draft', expectedSemanticRevision: 1, config });
    const pp = await versions.publishPreview(f.owner, created.id, { requestKey: 'publish-preview', expectedSemanticRevision: saved.semanticRevision });
    const published = await versions.publish(f.owner, created.id, { requestKey: 'publish', previewId: pp.previewId, previewHash: pp.previewHash });
    const [account] = await f.db.insert(paperAccounts).values({ owner: f.owner, name: 'Fictional paper account', isActive: true }).returning();
    await f.db.insert(investmentPolicies).values({ owner: f.owner, accountId: account.id, baseConfig: DEFAULT_INVESTMENT_CONFIG, effectiveConfig: DEFAULT_INVESTMENT_CONFIG });
    const bp = await versions.bindingPreview(f.owner, created.id, { requestKey: 'bind-preview', action: 'assign', accountId: account.id,
      teamVersionId: published.version.id, expectedBindingRevision: 0, expectedAccountBindingId: null, executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
    const bound = await versions.binding(f.owner, created.id, { requestKey: 'bind', previewId: bp.previewId, previewHash: bp.previewHash });
    const cp = await commissions.preview(f.owner, created.id, { requestKey: 'commission-preview', teamVersionId: published.version.id, bindingId: bound.binding!.id,
      expectedBindingRevision: bound.team.bindingRevision, leadRoleId: role, participantRoleIds: [role], supervisorRoleIds: [], objective: 'Fictional A2A team objective', expectedOutput: 'Structured finding',
      dataCutoffAt: null, deadlineAt: new Date(Date.now() + 3600000).toISOString(), parallelism: 1, inputRefs: [], conflictResolutions: [],
      work: [{ workKey: 'summary', roleId: role, taskKind: 'summary', objective: 'Summarize fictional evidence', expectedOutput: 'Report', dependencyWorkKeys: [], reviewerRoleId: role, reviewMode: 'self_check', inputRefs: [], requestedByRoleIds: [] }],
      budget: { budgetMode: 'calls_only', ceiling: { amount: null, currency: 'USD' }, callLimit: 3, paidRevisionLimit: 0 } });
    const commissioned = await commissions.create(f.owner, created.id, { requestKey: 'commission', previewId: cp.previewId, previewHash: cp.previewHash });
    f.behavior('team');
    await worker.runOnce(); await worker.runOnce();
    await Promise.all((council as unknown as { jobs: Map<string, Promise<void>> }).jobs.values());
    const [beforeProject] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, commissioned.commissionId));
    await f.db.transaction(tx => assertTeamExecutionInTransaction(tx, f.owner, commissionContext(beforeProject), { publication: true }));
    await worker.projectActive();
    const detail = await commissions.detail(f.owner, created.id, commissioned.commissionId);
    assert.equal(detail.state, 'completed', JSON.stringify({ state: detail.state, error: detail.lastError, tasks: detail.tasks })); assert.equal(f.counts().sends, 2);
    assert.equal(detail.members[0].rosterAgentId, friend.id); assert.ok(detail.members[0].a2aFingerprint);
    assert.equal(detail.cost.externalUsageUnknown, true);
    const [teamSession] = await f.db.select().from(councilSessions).where(eq(councilSessions.id, detail.sessionId!));
    assert.equal(teamSession.profileSnapshot.council!.members[0].executionMode, 'a2a');
    assert.equal(teamSession.profileSnapshot.council!.members[0].rosterAgentVersionId, friend.currentVersionId);
    const reservations = await f.client`SELECT status,model FROM llm_budget_usage WHERE owner=${f.owner}`;
    assert.equal(reservations.length, 2); assert.ok(reservations.every(row => row.status === 'reserved' && row.model === 'a2a:external-unknown'));
    const refreshed = await external.refreshCard(f.owner, f.connection.id, { requestKey: 'refresh', expectedRevision: f.connection.revision });
    assert.equal(refreshed.revision, 2);
    await assert.rejects(external.assertFingerprint(f.owner, members[0].a2aFingerprint!));
    worker.onModuleDestroy();
  } finally {
    if (before.workspace === undefined) delete process.env.TEAM_WORKSPACE_ENABLED; else process.env.TEAM_WORKSPACE_ENABLED = before.workspace;
    if (before.research === undefined) delete process.env.TEAM_RESEARCH_ENABLED; else process.env.TEAM_RESEARCH_ENABLED = before.research;
    await f.dispose();
  }
});

test('external telemetry records exact local identity and leaves private payload and unknown usage out', { skip: !available }, async () => {
  const f = await fixture();
  try {
    const records: Array<Record<string, unknown>> = [];
    const service = new A2aAgentsService(f.db, f.adapter, undefined, { recordSpan: (_owner: string, record: Record<string, unknown>) => { records.push(record); } } as never);
    const result = await service.execute(f.owner, { connectionId: f.connection.id, messageId: 'telemetry', prompt: 'PRIVATE_PROMPT_SENTINEL',
      activityContext: { sessionId: randomUUID(), revision: 1, cycleId: randomUUID(), memberId: 'fixture-member', rosterAgentId: randomUUID(), rosterAgentVersionId: randomUUID() } });
    assert.equal(records.length, 3); assert.ok(records.every(record => record.sourceId === result.taskId && record.model === null && record.totalTokens === null && record.estimatedCostUsd === null));
    const serialized = JSON.stringify(records);
    for (const secret of ['PRIVATE_PROMPT_SENTINEL', 'fixture-secret', 'fictional private result', f.connection.cardUrl]) assert.equal(serialized.includes(secret), false);
  } finally { await f.dispose(); }
});

test('explicit local trust and revocation during a real response prevent new dispatch and late acceptance', { skip: !available }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.create(f.owner, { requestKey: 'without-trust', name: 'Untrusted', cardUrl: f.connection.cardUrl }), /A2A_LOCAL_TRUST_REQUIRED/u);
    await assert.rejects(new A2aProtocolAdapter(new ToolTransportPolicy([])).discover(f.connection.cardUrl), /ENDPOINT_RESTRICTED/u);
    const counts = f.counts().sends;
    f.beforeReply(async () => { await f.service.disable(f.owner, f.connection.id, { requestKey: 'revoke-inflight', expectedRevision: f.connection.revision }); });
    let taskId: string | undefined;
    await assert.rejects(f.service.execute(f.owner, { connectionId: f.connection.id, messageId: 'late', prompt: 'fictional', onTask: async ref => { taskId = ref.taskId; } }), /A2A_CONNECTION_DISABLED/u);
    const task = await f.service.inspectTask(f.owner, taskId!);
    assert.equal(task.state, 'completed'); assert.equal(task.acceptance, 'blocked');
    await assert.rejects(f.service.execute(f.owner, { connectionId: f.connection.id, messageId: 'new-after-revoke', prompt: 'fictional' }));
    assert.equal(f.counts().sends, counts + 1);
    assert.equal((await f.service.cancelTask(f.owner, task.id)).cancellation, 'refused');
  } finally { await f.dispose(); }
});

test('concurrent GetTask and CancelTask responses retain the first terminal raw receipt atomically', { skip: !available }, async t => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  await t.test('completed artifacts survive a late working poll and contradictory cancellation', async () => {
    const f = await fixture();
    const releasePoll = deferred(), pollEntered = deferred(), releaseCancel = deferred(), cancelEntered = deferred();
    let staleRead: ReturnType<A2aAgentsService['read']> | undefined, cancel: ReturnType<A2aAgentsService['cancelTask']> | undefined;
    try {
      f.behavior('pending');
      await assert.rejects(f.service.execute(f.owner, { connectionId: f.connection.id, messageId: 'race', prompt: 'fictional', timeoutMs: 250, pollIntervalMs: 5 }), /A2A_TIMEOUT/u);
      const task = (await f.service.listTasks(f.owner, {})).items[0];
      let polls = 0;
      f.rpcReply(async (method, result) => {
        if (method === 'GetTask' && ++polls === 1) {
          pollEntered.resolve(); await releasePoll.promise;
          return { id: task.remoteTaskId, contextId: 'ctx', status: { state: 'TASK_STATE_WORKING' } };
        }
        if (method === 'CancelTask') { cancelEntered.resolve(); await releaseCancel.promise; }
        return result;
      });
      staleRead = f.service.read(f.owner, task.id); await pollEntered.promise;
      f.behavior('poll');
      cancel = f.service.cancelTask(f.owner, task.id); await cancelEntered.promise;
      assert.equal((await f.service.read(f.owner, task.id)).state, 'completed');
      await f.service.acceptResult(f.owner, task.id, { structuredOutput: true });
      const [saved] = await f.client`SELECT raw_response_enc,remote_task_id,context_id,output_bytes,acceptance FROM a2a_agent_invocations WHERE id=${task.id}`;
      releasePoll.resolve(); assert.equal((await staleRead).state, 'completed');
      releaseCancel.resolve(); assert.equal((await cancel).state, 'completed');
      const [retained] = await f.client`SELECT raw_response_enc,remote_task_id,context_id,output_bytes,acceptance FROM a2a_agent_invocations WHERE id=${task.id}`;
      assert.deepEqual(retained, saved, 'late responses must not replace the accepted raw artifact or its metadata');
      const result = await f.service.reparse(f.owner, task.id);
      assert.deepEqual(result.data, { summary: 'fictional private result', evidenceIds: [] });
      assert.equal((await f.service.inspectTask(f.owner, task.id)).cancellation, 'refused');
      assert.equal(f.counts().sends, 1);
    } finally {
      releasePoll.resolve(); releaseCancel.resolve(); await Promise.allSettled([staleRead, cancel].filter(Boolean)); await f.dispose();
    }
  });
  await t.test('confirmed cancellation survives an already-running completion poll', async () => {
    const f = await fixture();
    const releasePoll = deferred(), pollEntered = deferred();
    let staleRead: ReturnType<A2aAgentsService['read']> | undefined;
    try {
      f.behavior('pending');
      await assert.rejects(f.service.execute(f.owner, { connectionId: f.connection.id, messageId: 'cancel-race', prompt: 'fictional', timeoutMs: 250, pollIntervalMs: 5 }), /A2A_TIMEOUT/u);
      const task = (await f.service.listTasks(f.owner, {})).items[0];
      f.behavior('poll');
      f.rpcReply(async (method, result) => { if (method === 'GetTask') { pollEntered.resolve(); await releasePoll.promise; } return result; });
      staleRead = f.service.read(f.owner, task.id); await pollEntered.promise;
      assert.equal((await f.service.cancelTask(f.owner, task.id)).cancellation, 'confirmed');
      const [saved] = await f.client`SELECT raw_response_enc,remote_task_id,context_id,output_bytes,acceptance,cancellation FROM a2a_agent_invocations WHERE id=${task.id}`;
      releasePoll.resolve(); assert.equal((await staleRead).state, 'cancelled');
      const [retained] = await f.client`SELECT raw_response_enc,remote_task_id,context_id,output_bytes,acceptance,cancellation FROM a2a_agent_invocations WHERE id=${task.id}`;
      assert.deepEqual(retained, saved, 'late completion cannot replace confirmed cancellation evidence');
      await assert.rejects(f.service.reparse(f.owner, task.id), /A2A_CANCELLED/u);
      assert.equal(f.counts().sends, 1);
    } finally { releasePoll.resolve(); await Promise.allSettled([staleRead].filter(Boolean)); await f.dispose(); }
  });
});
