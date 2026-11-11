import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { CouncilToolRuntimeService, freezeCouncilInput } from './council-tool-runtime.service';
import type { CouncilEvidence } from './council.rules';
import { RuntimeJournalService } from '../research-runtime/runtime-journal.service';
import { RuntimeDispatchService } from '../research-runtime/runtime-dispatch.service';
import { RuntimeInvocationsService } from '../research-runtime/runtime-invocations.service';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { ToolBudgetService } from '../tool-connections/tool-budget.service';
import { ToolActionsService } from '../tool-actions/tool-actions.service';
import { ModelStepService } from '../research-core/model-step.service';
import { AiSdkModelAdapter } from '../research-core/ai-sdk-model.adapter';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { councilSessions } from '../../database/council.schema';
import { councilMemberAttempts } from '../../database/simple-council.schema';
import { newCheckpoint, parseContribution } from './council.dialogue';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';
import { and, eq } from 'drizzle-orm';
import { dataLibrarySources, dataLibraryVersions } from '../../database/data-library.schema';
import { researchDatasetVersions } from '../../database/research-artifacts.schema';
import { DataDatasetService } from '../data-library/data-dataset.service';

const ownerEvidence = (): CouncilEvidence => ({ id: 'owner', title: 'Frozen facts', role: 'fundamental',
  sourceName: 'Frozen owner context', sourceUrl: null, fetchedAt: '2026-11-11T00:00:00Z', relevanceScore: 1,
  content: JSON.stringify({ holdings: Array.from({ length: 13 }, (_, index) => ({ ticker: `TEST${index}`,
    market: 'US', shares: index === 12 ? null : String(index), accountId: 'account' })),
  cash: [{ currency: 'HKD', amount: null }], confirmedInvestorLimits: { maxPositionPct: 17 } }) });

test('controlled frozen input preserves all holdings, unknown quantities/cash and constraints', () => {
  const frozen = freezeCouncilInput([ownerEvidence()], { evidence: [ownerEvidence()] });
  assert.equal(frozen.payload.holdings.length, 13);
  assert.equal(frozen.payload.holdings[12].quantity, null);
  assert.equal(frozen.payload.cash[0].amount, null);
  assert.match(JSON.stringify(frozen.payload.context), /maxPositionPct/);
});

test('production SDK/tool/journal roundtrip binds own evidence before parse, rejects another sealed member and replays saved response locally', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'Temporary database required');
  const namespace = `council_tools_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 8, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin.unsafe(`create schema ${namespace}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    for (const file of ['53_agent_tool_runtime.sql', '54_research_artifacts.sql', '55_tool_actions.sql', '56_tool_connections.sql', '59_capability_activation.sql']) {
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    }
    const db = drizzle(client), owner = randomUUID();
    await client`insert into users(id,username,password_hash) values(${owner},${owner.slice(0, 20)},'fixture')`;
    const members = ['one', 'two'].map((id, index) => ({ id, name: id, role: index ? 'manager' as const : 'researcher' as const, model: 'fast' as const, instructions: '' }));
    const config = normalizeBuilderConfig({ name: 'Fixture', template: 'guard', tickers: ['AAPL'], minimumRating: 'Buy',
      customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false,
      council: { enabled: true, webResearch: false, members } });
    const common = [ownerEvidence()], checkpoint = newCheckpoint(members, { independent: true });
    checkpoint.simple!.commonEvidence = common;
    const [session] = await db.insert(councilSessions).values({ owner, ticker: 'AAPL', language: 'en', profileVersion: 1,
      profileSnapshot: config, status: 'running', checkpoint, evidenceSnapshot: common }).returning();
    const budget = new LlmBudgetService(db);
    await budget.saveSettings(owner, { ...await budget.getSettings(owner), enabled: false });
    let sends = 0, quoteReads = 0, citeForeign = false, firstEvidence = '';
    const wires: string[] = [];
    const model = new ModelStepService({ getLlmConfig: async () => ({ source: 'user', apiKey: 'fake-key',
      baseUrl: 'https://fixture.example/v1', fastModel: 'fake', slowModel: 'fake' }) },
    new AiSdkModelAdapter(async (_url, init) => {
      sends += 1; const body = JSON.parse(String(init?.body)); wires.push(JSON.stringify(body));
      const toolMessages = body.messages.filter((message: { role: string }) => message.role === 'tool');
      let message: Record<string, unknown>;
      if (!toolMessages.length) {
        const tool = body.tools.find((item: { function: { name: string } }) => item.function.name.endsWith('_get_quotes'));
        assert.ok(tool, 'the original queued attempt must expose real tools once assigned');
        message = { role: 'assistant', content: null, tool_calls: [{ id: 'quote-read', type: 'function',
          function: { name: tool.function.name, arguments: '{}' } }] };
      } else {
        const result = JSON.parse(toolMessages.at(-1).content), evidenceId = result.data.evidenceId;
        assert.ok(evidenceId); if (!firstEvidence) firstEvidence = evidenceId;
        message = { role: 'assistant', content: JSON.stringify({ content: 'Verified fixture view', evidenceIds: [citeForeign ? firstEvidence : evidenceId] }) };
      }
      return Response.json({ id: `receipt-${sends}`, model: 'fake', created: 1,
        choices: [{ index: 0, finish_reason: toolMessages.length ? 'stop' : 'tool_calls', message }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
    }));
    const tools = new ResearchToolsService(db, { getQuote: async () => {
      quoteReads += 1; return { symbol: 'AAPL', price: 10, currency: 'USD', market: 'US', change: 0,
        changePercent: 0, timestamp: '2026-11-11T00:00:00Z' }; } } as never, {} as never, {} as never);
    const journal = new RuntimeJournalService(db, 'fixture-encryption-key-2026');
    const service = new CouncilToolRuntimeService(db, model, { enabled: async () => true } as never, journal,
      new RuntimeDispatchService(budget, db), new RuntimeInvocationsService(db, 'fixture-encryption-key-2026'), tools,
      { freezeCatalog: async () => ({ descriptors: [], connectionRevisions: {} }) } as never,
      new ToolBudgetService(db), budget, new ToolActionsService(db));
    const run = async (index: number) => {
      const member = members[index];
      const [attempt] = await db.insert(councilMemberAttempts).values({ owner, sessionId: session.id,
        cycleId: checkpoint.cycleId, revision: session.revision, memberId: member.id, turn: index, attempt: 1,
        resourceKey: 'api:default', inputHash: 'frozen', inputSnapshot: {} }).returning();
      const row = { ...session, checkpoint: { ...checkpoint, nextTurn: index }, memberAttempt: attempt };
      assert.equal(await service.eligible(owner, row, member), true);
      const execute = () => service.execute({ owner, row, member, prompt: [{ role: 'system', content: 'Return contribution JSON' }],
        context: { evidence: common }, evidence: common, shouldContinue: async () => true,
        activity: async () => {}, validate: async (text, sources) => {
          parseContribution(JSON.parse(text), new Set(sources.map(item => item.id)), { memberId: member.id, phase: 'opening' }, null);
        } });
      return { execute, attempt };
    };
    const first = await run(0), result = await first.execute();
    assert.equal(sends, 2); assert.equal(quoteReads, 1); assert.equal(result.tokens, 20); assert.equal(result.usageUnknown, false);
    assert.ok(result.sources.some(item => item.id === firstEvidence));
    assert.ok(wires.every(wire => wire.includes('US:TEST12') && wire.includes('maxPositionPct') && wire.includes('HKD')));
    const [attempt] = await db.select().from(councilMemberAttempts).where(eq(councilMemberAttempts.id, first.attempt.id));
    assert.equal(attempt.dispatchStarted, true); assert.equal(attempt.taskId, result.runId);
    await first.execute(); assert.equal(sends, 2, 'accepted receipt is reparsed without another model request');
    citeForeign = true;
    const second = await run(1);
    await assert.rejects(second.execute(), /RESEARCH_RUNTIME_FAILED/);
    assert.equal(sends, 4); assert.equal(quoteReads, 2);
    await assert.rejects(second.execute(), /RESEARCH_RUNTIME_FAILED/);
    assert.equal(sends, 4, 'failed final parsing never invokes paid repair');
    const [saved] = await db.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, session.id)));
    assert.equal(saved.checkpoint?.simple?.privateEvidence?.two?.length, 1);
  } finally { await client.end(); await admin.unsafe(`drop schema ${namespace} cascade`); await admin.end(); }
});

test('execution choice is durable for the exact member turn attempt when capability is revoked', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'Temporary database required');
  const namespace = `council_route_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 3, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin.unsafe(`create schema ${namespace}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/53_agent_tool_runtime.sql', 'utf8'));
    let enabled = true, driver: 'controlled' | 'deep_agents' = 'controlled';
    const service = new CouncilToolRuntimeService(drizzle(client), { resolve: async () => ({
      model: 'fake', connectionId: '', connectionConfigHash: 'a'.repeat(64) }) } as never,
    { enabled: async () => enabled, driver: async () => driver } as never, new RuntimeJournalService(drizzle(client), 'test-encryption-key-2026'),
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const row = { id: randomUUID(), revision: 1, checkpoint: { toolRuntimeVersion: 1, cycleId: randomUUID(), nextTurn: 0 } };
    const member = { id: 'one', model: 'fast', instructions: '', name: 'One', role: 'researcher' };
    assert.equal(await service.eligible('owner', row as never, member as never), true);
    enabled = false;
    assert.equal(await service.eligible('owner', row as never, member as never), true, 'revocation must stop the existing route, never choose legacy');
    assert.equal(await service.eligible('owner', { ...row, checkpoint: { ...row.checkpoint, nextTurn: 1 } } as never, member as never), false);
    enabled = true;
    assert.equal(await service.eligible('owner', { ...row, checkpoint: { ...row.checkpoint, nextTurn: 1 } } as never, member as never), false, 'legacy choice is frozen too');
    assert.equal(await service.eligible('owner', { ...row, checkpoint: { ...row.checkpoint, toolRuntimeVersion: undefined } } as never, member as never), false);
    driver = 'deep_agents';
    const deepRow = { ...row, checkpoint: { ...row.checkpoint, nextTurn: 2 } };
    assert.equal(await service.eligible('owner', deepRow as never, member as never), true);
    driver = 'controlled';
    assert.equal(await service.eligible('owner', deepRow as never, member as never), true);
    const routes = await client`select route from agent_runtime_execution_routes where identity->>'turn'='2'`;
    assert.equal(routes[0].route, 'deep_agents', 'changing the preference cannot reroute a saved turn');
  } finally { await client.end(); await admin.unsafe(`drop schema ${namespace} cascade`); await admin.end(); }
});

test('runtime pins exact immutable dataset ids/hashes/storage references, ignores a newer source version and rejects corrupted original rows', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'Temporary database required');
  const namespace = `council_dataset_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 8, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin.unsafe(`create schema ${namespace}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    for (const name of ['53_agent_tool_runtime.sql', '54_research_artifacts.sql']) await client.unsafe(readFileSync(`scripts/db/${name}`, 'utf8'));
    const db = drizzle(client), owner = randomUUID();
    await client`insert into users(id,username,password_hash) values(${owner},${owner.slice(0, 20)},'fixture')`;
    const [source] = await db.insert(dataLibrarySources).values({ owner, title: 'Dataset fixture', kind: 'document', format: 'csv' }).returning();
    const version = async (index: number) => (await db.insert(dataLibraryVersions).values({ owner, sourceId: source.id,
      version: index, contentHash: String(index).repeat(64), rawContent: 'raw fixture rows', extractedText: 'fixture',
      sections: [], byteLength: 16, extractionState: 'succeeded' }).returning())[0];
    const v1 = await version(1), datasets = new DataDatasetService(db);
    const metadata = { sourceVersion: { sourceId: source.id, sourceVersionId: v1.id, contentHash: v1.contentHash }, dependencies: [],
      schema: { columns: ['value'] }, schemaVersion: '1', provider: 'fixture', operation: 'fixture', parameterVersion: '1',
      timing: { observedAt: '2026-11-11T00:00:00Z', fetchedAt: '2026-11-11T00:00:00Z', dataAsOf: null, marketDate: null,
        reportPeriod: null, announcedAt: null, availableAt: null, availableAtBasis: null, datePrecision: 'unknown' as const },
      coverage: { status: 'complete' as const, rowCount: 1, expectedRowCount: 1, from: null, to: null, missing: [], delayed: null },
      adjustment: 'unknown' as const, corporateActionsVersionId: null, dataClasses: ['private_material' as const],
      license: { termsRef: null, permittedUses: ['research'], retentionUntil: null } };
    const dataset = await datasets.create(owner, { metadata, rows: [{ value: 'FULL_ROW_SENTINEL_MUST_NOT_BE_INLINED' }] });
    const member = { id: 'one', name: 'One', role: 'manager' as const, instructions: '', model: 'fast' as const };
    const evidence: CouncilEvidence[] = [{ ...ownerEvidence(), id: 'dataset-evidence', sourceName: 'Dataset source', content: 'Saved dataset metadata',
      libraryReferences: [{ sourceId: source.id, versionId: v1.id }] }];
    const checkpoint = newCheckpoint([member], { independent: true }); checkpoint.simple!.commonEvidence = evidence;
    const config = { name: 'Dataset fixture', template: 'guard', tickers: ['AAPL'], council: { enabled: true, members: [member] } };
    const [session] = await db.insert(councilSessions).values({ owner, ticker: 'AAPL', language: 'en', profileVersion: 1,
      profileSnapshot: config as never, status: 'running', checkpoint, evidenceSnapshot: evidence }).returning();
    const budget = new LlmBudgetService(db); await budget.saveSettings(owner, { ...await budget.getSettings(owner), enabled: false });
    const journal = new RuntimeJournalService(db, 'dataset-fixture-key-2026');
    let sends = 0, finalChecks = 0, wire = '';
    const service = new CouncilToolRuntimeService(db, { resolve: async () => ({ model: 'fake', connectionId: '', connectionConfigHash: 'a'.repeat(64) }),
      generate: async (request: unknown) => { sends += 1; wire = JSON.stringify(request); return { text: '{}', toolCalls: [], finishReason: 'stop', usage: null }; } } as never,
    { enabled: async () => true } as never, journal, new RuntimeDispatchService(budget, db), new RuntimeInvocationsService(db, 'dataset-fixture-key-2026'),
    { bundle: async () => ({ descriptors: [] }), isCurrent: async () => true } as never,
    { freezeCatalog: async () => ({ descriptors: [], connectionRevisions: {} }) } as never,
    new ToolBudgetService(db), budget, new ToolActionsService(db));
    assert.equal(await service.eligible(owner, session, member), true);
    const execute = () => service.execute({ owner, row: session, member, prompt: [], context: {}, evidence,
      shouldContinue: async () => true, activity: async () => {}, validate: async () => { finalChecks += 1; } });
    const result = await execute(), saved = await journal.read(owner, result.runId);
    const frozen = saved.frozenInput as { datasetVersionIds: string[]; datasets: Array<{ contentHash: string }>; payload: unknown };
    assert.deepEqual(frozen.datasetVersionIds, [dataset.id]); assert.equal(frozen.datasets[0].contentHash, dataset.contentHash);
    assert.match(wire, new RegExp(dataset.storageRef)); assert.doesNotMatch(wire, /FULL_ROW_SENTINEL/);
    const v2 = await version(2);
    await datasets.create(owner, { metadata: { ...metadata, sourceVersion: { sourceId: source.id, sourceVersionId: v2.id, contentHash: v2.contentHash } }, rows: [{ value: 'newer' }] });
    await execute(); assert.equal(sends, 1); assert.equal(finalChecks, 2, 'saved response uses pinned v1 after v2 appears');
    await db.update(researchDatasetVersions).set({ rows: [{ value: 'tampered original' }] }).where(eq(researchDatasetVersions.id, dataset.id));
    await assert.rejects(execute()); assert.equal(sends, 1); assert.equal(finalChecks, 2, 'corrupted rows cannot be accepted or fetched again');
  } finally { await client.end(); await admin.unsafe(`drop schema ${namespace} cascade`); await admin.end(); }
});
