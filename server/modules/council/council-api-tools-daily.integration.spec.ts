import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { councilSessions, councilReports } from '../../database/council.schema';
import { councilMemberAttempts, councilIndependentSubmissions } from '../../database/simple-council.schema';
import { toolConnections } from '../../database/tool-connections.schema';
import { CouncilService } from './council.service';
import { CouncilToolRuntimeService } from './council-tool-runtime.service';
import { newCheckpoint, parseContribution } from './council.dialogue';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';
import { RuntimeJournalService } from '../research-runtime/runtime-journal.service';
import { RuntimeDispatchService } from '../research-runtime/runtime-dispatch.service';
import { RuntimeInvocationsService } from '../research-runtime/runtime-invocations.service';
import { ModelStepService } from '../research-core/model-step.service';
import { AiSdkModelAdapter } from '../research-core/ai-sdk-model.adapter';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { ToolBudgetService } from '../tool-connections/tool-budget.service';
import { ToolActionsService } from '../tool-actions/tool-actions.service';
import { ToolActionSourceValidation } from '../tool-actions/tool-action-source-validation';
import { nativeDescriptor } from '../tool-connections/providers/search-provider.contract';
import type { CouncilEvidence } from './council.rules';

interface Wire { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> }

async function fixture(run: (state: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'Temporary database required');
  const namespace = `council_daily_tools_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 10, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin.unsafe(`create schema ${namespace}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    for (const name of ['53_agent_tool_runtime.sql', '54_research_artifacts.sql', '55_tool_actions.sql', '56_tool_connections.sql', '59_capability_activation.sql']) await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    await run(await setup(client));
  } finally { await client.end(); await admin.unsafe(`drop schema ${namespace} cascade`); await admin.end(); }
}

async function setup(client: ReturnType<typeof postgres>) {
  process.env.SETTINGS_ENCRYPTION_KEY = 'daily-tool-fixture-encryption-key-2026';
  const db = drizzle(client), owner = randomUUID();
  await client`insert into users(id,username,password_hash) values(${owner},${owner.slice(0, 20)},'fixture')`;
  const members = ['one', 'two'].map((id, index) => ({ id, name: id, role: index ? 'manager' as const : 'researcher' as const,
    model: 'fast' as const, instructions: '' }));
  const config = normalizeBuilderConfig({ name: 'Daily fixture', template: 'guard', tickers: ['PORTFOLIO'], minimumRating: 'Buy',
    customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false,
    council: { enabled: true, members } });
  const common: CouncilEvidence[] = [{ id: 'owner', title: 'Owner facts', role: 'fundamental', sourceName: 'Frozen owner context',
    sourceUrl: null, relevanceScore: 1, fetchedAt: '2026-11-11T00:00:00Z', content: JSON.stringify({
      holdings: Array.from({ length: 13 }, (_, index) => ({ ticker: `TEST${index}`, market: 'US', shares: index === 12 ? null : '1', accountId: 'account' })),
      cash: [{ currency: 'HKD', amount: null }], confirmedInvestorLimits: { maxPositionPct: 17 } }) }];
  const checkpoint = newCheckpoint(members, { independent: true });
  checkpoint.simple!.commonEvidence = common;
  checkpoint.simple!.researchOnly = true;
  checkpoint.simple!.overallDaily = { date: '2026-11-11', timezone: 'Asia/Shanghai', readAt: '2026-11-11T00:00:00Z', factsHash: 'fixture' };
  const [session] = await db.insert(councilSessions).values({ owner, ticker: 'PORTFOLIO', scene: 'portfolio_daily', language: 'en',
    profileVersion: 1, profileSnapshot: config, status: 'running', checkpoint, evidenceSnapshot: common }).returning();
  const budget = new LlmBudgetService(db);
  await budget.saveSettings(owner, { ...await budget.getSettings(owner), enabled: false });
  const connectionId = randomUUID(), catalogVersionId = randomUUID();
  const descriptor = nativeDescriptor(connectionId, 'send_note', { type: 'object', properties: {
    recipient: { type: 'string' }, body: { type: 'string' } }, required: ['recipient', 'body'], additionalProperties: false }, 'Write note');
  descriptor.effect = 'external_write'; descriptor.catalogVersionId = catalogVersionId; descriptor.dataClasses = ['public', 'portfolio'];
  await db.insert(toolConnections).values({ id: connectionId, owner, provider: 'mcp', transport: 'streamable_http', status: 'configured',
    catalogVersionId, allowedToolIds: [descriptor.id], allowedDataClasses: ['public', 'portfolio'] });
  const wires: Wire[] = [], quotes: string[] = [], writes: Record<string, unknown>[] = [];
  const transport = { unknownOne: false };
  const model = new ModelStepService({ getLlmConfig: async () => ({ source: 'user', apiKey: 'fake-key', baseUrl: 'https://fixture.example/v1',
    fastModel: 'fake', slowModel: 'fake' }) }, new AiSdkModelAdapter(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)) as Wire; wires.push(wire);
    const frozen = JSON.parse(wire.messages[0].content.split('\n').slice(1).join('\n'));
    const member = frozen.context.member.name as string;
    if (transport.unknownOne && member === 'one') throw new Error('fixture HTTP transport lost after dispatch');
    const prior = wire.messages.filter(message => message.role === 'tool');
    let message: Record<string, unknown>;
    if (!prior.length) {
      const name = member === 'one' ? '_send_note' : '_get_portfolio_quotes';
      const tool = wire.tools.find(item => item.function.name.endsWith(name)); assert.ok(tool);
      message = { role: 'assistant', content: null, tool_calls: [{ id: member === 'one' ? 'write-original' : 'portfolio-read', type: 'function',
        function: { name: tool.function.name, arguments: JSON.stringify(member === 'one'
          ? { recipient: 'old@example.org', body: 'original body' } : { offset: 10, limit: 3 }) } }] };
    } else {
      const result = JSON.parse(prior.at(-1)!.content);
      message = { role: 'assistant', content: JSON.stringify({ content: 'Fixture saved view', evidenceIds: result.data?.evidenceId ? [result.data.evidenceId] : [] }) };
    }
    return Response.json({ id: `fixture-${wires.length}`, model: 'fake', created: 1,
      choices: [{ index: 0, finish_reason: prior.length ? 'stop' : 'tool_calls', message }] });
  }));
  const tools = new ResearchToolsService(db, { getQuote: async (ticker: string) => { quotes.push(ticker); return {
    symbol: ticker, price: 10, currency: 'USD', market: 'US', change: 0, changePercent: 0, timestamp: '2026-11-11T00:00:00Z' }; } } as never,
  {} as never, {} as never);
  const journal = new RuntimeJournalService(db, 'daily-tool-fixture-encryption-key-2026');
  const actions = new ToolActionsService(db, new ToolActionSourceValidation());
  const runtime = new CouncilToolRuntimeService(db, model, { enabled: async () => true } as never, journal,
    new RuntimeDispatchService(budget, db), new RuntimeInvocationsService(db, 'daily-tool-fixture-encryption-key-2026'), tools,
    { freezeCatalog: async () => ({ descriptors: [descriptor], connectionRevisions: { [connectionId]: 1 } }),
      invokeFrozen: async (_owner: string, _tool: unknown, _revision: number, args: Record<string, unknown>, options: { beforeDispatch(): Promise<void> }) => {
        await options.beforeDispatch(); writes.push(args); return { output: { sent: true }, receipt: { state: 'completed' },
          observedAt: new Date().toISOString(), dataAsOf: null }; } } as never, new ToolBudgetService(db), budget, actions);
  return { db, client, owner, members, session, common, budget, runtime, actions, tools, journal, wires, quotes, writes, transport };
}

test('parallel daily openings retain the completed portfolio tool result while the other member waits for approval, without publishing a wait report', async () => fixture(async state => {
  const council = new CouncilService(state.db, { isConfigured: async () => true,
    chatFastJSON: async () => { throw new Error('legacy route must not run'); } } as never,
  {} as never, {} as never, {} as never, undefined, state.budget, undefined, state.tools, undefined, state.runtime);
  await (council as unknown as { execute(owner: string, id: string): Promise<void> }).execute(state.owner, state.session.id);
  const [session] = await state.db.select().from(councilSessions).where(eq(councilSessions.id, state.session.id));
  const submissions = await state.db.select().from(councilIndependentSubmissions);
  assert.equal(session.status, 'paused'); assert.equal(session.checkpoint?.runtimePending?.[0].state, 'waiting_approval');
  assert.equal(submissions.length, 1); assert.equal(submissions[0].memberId, 'two');
  assert.ok(submissions[0].evidence.some(item => item.title.includes('get_portfolio_quotes')));
  assert.deepEqual(state.quotes, ['TEST10', 'TEST11', 'TEST12']);
  assert.equal(state.writes.length, 0); assert.equal(state.wires.length, 3);
  assert.equal((await state.db.select().from(councilReports)).length, 0);
  assert.equal((await state.actions.list(state.owner))[0].state, 'pending');
  await assert.rejects(council.recoverMember(state.owner, session.id, { memberId: 'one', action: 'retry_member',
    expectedRevision: session.revision, requestKey: randomUUID() }), /RUNTIME_RECOVERY_TARGET_REQUIRED/);
  const originalPending = session.checkpoint!.runtimePending![0];
  await council.pauseSession(state.owner, session.id);
  const [stopped] = await state.db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
  assert.equal(stopped.checkpoint?.runtimePending?.length, 0);
  assert.equal((await state.actions.list(state.owner))[0].state, 'rejected');
  assert.equal((await state.journal.read(state.owner, originalPending.runId)).state, 'cancelled');
  assert.equal((await state.db.select().from(councilMemberAttempts)).find(item => item.memberId === 'one')?.status, 'cancelled');
  assert.equal(state.wires.length, 3); assert.equal(state.writes.length, 0);
}));

test('unknown daily model receipts only refresh or explicitly close; close retains reservation and fences late output without resending', async () => fixture(async state => {
  state.transport.unknownOne = true;
  const council = new CouncilService(state.db, { isConfigured: async () => true } as never,
    {} as never, {} as never, {} as never, undefined, state.budget, undefined, state.tools, undefined, state.runtime);
  await (council as unknown as { execute(owner: string, id: string): Promise<void> }).execute(state.owner, state.session.id);
  const [session] = await state.db.select().from(councilSessions).where(eq(councilSessions.id, state.session.id));
  const pending = session.checkpoint!.runtimePending![0];
  assert.equal(session.status, 'paused'); assert.equal(pending.state, 'provider_unknown');
  assert.equal((await state.db.select().from(councilIndependentSubmissions)).length, 1, 'the other member completes before pause');
  const original = await state.journal.read(state.owner, pending.runId), step = original.steps[0];
  const before = await state.client`select status,reserved_tokens,charged_tokens from llm_budget_usage where id=${step.budgetId!}`;
  const target = { runId: pending.runId, stepId: pending.stepId, expectedCursor: pending.expectedCursor };
  await state.runtime.recover(state.owner, session.id, { action: 'check_existing', requestKey: randomUUID(),
    expectedRevision: session.revision, runtimeTarget: target });
  assert.equal(state.wires.length, 3); assert.equal(state.writes.length, 0);
  const request = { action: 'close_unknown' as const, requestKey: randomUUID(), expectedRevision: session.revision, runtimeTarget: target };
  assert.equal(await state.runtime.recover(state.owner, session.id, request), false);
  assert.equal(await state.runtime.recover(state.owner, session.id, request), false);
  const after = await state.client`select status,reserved_tokens,charged_tokens from llm_budget_usage where id=${step.budgetId!}`;
  assert.deepEqual(after, before); assert.ok(Number(after[0].reserved_tokens) > 0);
  await state.journal.receive(state.owner, pending.runId, step.id, { text: 'late untrusted answer', toolCalls: [], finishReason: 'stop', usage: null });
  assert.equal((await state.journal.read(state.owner, pending.runId)).state, 'settled_unknown');
  const [closed] = await state.db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
  assert.equal(closed.checkpoint?.runtimePending?.length, 0);
  await assert.rejects(council.recoverMember(state.owner, session.id, { memberId: 'one', action: 'retry_member',
    expectedRevision: closed.revision, requestKey: randomUUID() }), /ORIGINAL_TASK_NOT_TERMINATED/);
  assert.equal((await state.db.select().from(councilReports)).length, 0);
  assert.equal(state.wires.length, 3);
}));

test('edited approval resumes the exact receipt once, preserves original assistant call and uses the approved effective payload', async () => fixture(async state => {
  const member = state.members[0];
  const [attempt] = await state.db.insert(councilMemberAttempts).values({ owner: state.owner, sessionId: state.session.id,
    cycleId: state.session.checkpoint!.cycleId, revision: state.session.revision, memberId: member.id, turn: 0, attempt: 1,
    resourceKey: 'api:default', inputHash: 'frozen', inputSnapshot: {} }).returning();
  const row = { ...state.session, memberAttempt: attempt };
  assert.equal(await state.runtime.eligible(state.owner, row, member), true);
  const execute = () => state.runtime.execute({ owner: state.owner, row, member, prompt: [{ role: 'system', content: 'Return contribution JSON' }],
    evidence: state.common, context: { member: { name: 'one' } }, shouldContinue: async () => true, activity: async () => {},
    validate: async (text, sources) => { parseContribution(JSON.parse(text), new Set(sources.map(item => item.id)), { memberId: member.id, phase: 'opening' }, null); } });
  await assert.rejects(execute(), /RESEARCH_RUNTIME_WAITING_APPROVAL/);
  assert.equal(state.writes.length, 0); assert.equal(state.wires.length, 1);
  const preview = (await state.actions.list(state.owner))[0];
  const edited = await state.actions.edit(state.owner, preview.id, { revision: preview.revision, payloadHash: preview.payloadHash,
    args: { body: 'approved edited body', recipient: 'new@example.org' }, accountId: preview.accountId, target: 'new@example.org' });
  assert.equal(state.wires.length, 1, 'editing has no paid model self-loop');
  await state.actions.confirm(state.owner, edited.id, { revision: edited.revision, payloadHash: edited.payloadHash });
  const pending = await state.runtime.pending(state.owner, preview.runId);
  await state.db.update(councilSessions).set({ status: 'paused', checkpoint: { ...state.session.checkpoint!, runtimePending: [pending] } }).where(eq(councilSessions.id, row.id));
  const request = { action: 'resume_approval' as const, requestKey: randomUUID(), expectedRevision: row.revision,
    runtimeTarget: { runId: pending.runId, stepId: pending.stepId, expectedCursor: pending.expectedCursor } };
  await assert.rejects(state.runtime.recover(state.owner, row.id, { ...request, runtimeTarget: { ...request.runtimeTarget, expectedCursor: pending.expectedCursor - 1 } }), /TARGET_CHANGED/);
  assert.equal(await state.runtime.recover(state.owner, row.id, request), true);
  assert.equal(await state.runtime.recover(state.owner, row.id, request), false);
  const result = await execute();
  assert.equal(result.usageUnknown, true, 'missing provider usage remains unknown');
  assert.equal(state.wires.length, 2); assert.deepEqual(state.writes, [{ body: 'approved edited body', recipient: 'new@example.org' }]);
  const second = JSON.stringify(state.wires[1]);
  assert.match(second, /original body/); assert.match(second, /write-original/);
  assert.match(second, /effectivePayloadHash/); assert.match(second, new RegExp(edited.payloadHash));
  assert.match(second, /approved edited body/);
  await execute(); assert.equal(state.writes.length, 1); assert.equal(state.wires.length, 2);
  assert.equal((await state.actions.detail(state.owner, edited.id)).state, 'completed');
}));
