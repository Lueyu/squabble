import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { StrategyModelService } from './strategy-model.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { BudgetExceededException, DEFAULT_LLM_BUDGET } from '../llm-budget/llm-budget.rules';
import { LocalAgentError } from '../local-agents/local-agents.types';
import { userInvestmentStrategyPreparations } from '../../database/user-investment-strategies.schema';
import { compileInvestorRules } from './user-strategy-runtime';
import { strategyContentHash } from './user-investment-strategy.rules';

test('preparation state rejects invalid revision cursors before any database access', async () => {
  const service = new UserInvestmentStrategyService({} as never, {} as never, {} as never);
  for (const revision of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(async () => service.preparation('fixture-owner', randomUUID(), revision), /revision/iu);
  }
});

test('a claim appearing during status lookup is still reported as pending', async () => {
  const id = randomUUID();
  const snapshots = [[{ id }], [], [{ status: 'pending', requestKey: 'newly-claimed' }]];
  const db = { select: () => {
    const rows = snapshots.shift();
    const query = { from: () => query, where: () => query, orderBy: () => query, limit: async () => rows,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve) };
    return query;
  } };
  const service = new UserInvestmentStrategyService(db as never, {} as never, {} as never);
  assert.deepEqual(await service.preparation('fixture-owner', id, 1), { status: 'pending', requestKey: 'newly-claimed' });
});

test('an explicit observation keeps the monitoring idea through confirmation without models or executable rules', { skip: !process.env.STRATEGY_TEST_DATABASE_URL }, async () => {
  const namespace = 'strategy_observation_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 4, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/39_user_investment_strategies.sql', 'utf8'));
    const db = drizzle(client), owner = randomUUID(), now = new Date(), text = '持续监控FICT，寻找加仓机会';
    let modelCalls = 0;
    const service = new UserInvestmentStrategyService(db, new ResearchDocumentsService(db), { json: async () => { modelCalls++; throw new Error('An explicit observation must not call a model'); } } as never);
    const draft = await service.create(owner, { title: 'Fictional monitoring idea', body: '', timezone: 'Asia/Shanghai', startsAt: now.toISOString(),
      endsAt: new Date(+now + 86400000).toISOString(), entries: [{ id: 'manual_observation', text, sourceKeys: [] }] });
    const reviewed = await service.preview(owner, draft.id, draft.revision);
    assert.equal(reviewed.content.entries[0].text, text);
    assert.equal(reviewed.preview!.canConfirm, true);
    assert.equal(reviewed.preview!.entries[0].state, 'observation');
    assert.deepEqual(reviewed.preview!.directives, []);
    assert.deepEqual(reviewed.preview!.mandateRules, []);
    const confirmed = await db.transaction(tx => service.confirmInTransaction(tx, owner, reviewed.id, reviewed.revision, reviewed.preview!.contentHash, null,
      async (_tx, snapshot) => { assert.deepEqual(compileInvestorRules(snapshot, {} as never), []); }));
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.content.entries[0].text, text);
    assert.deepEqual(compileInvestorRules(confirmed, {} as never), []);
    assert.deepEqual((await service.workspace(owner)).current, confirmed);
    assert.deepEqual(await service.preparation(owner, confirmed.id, confirmed.revision), { status: 'none' });
    await assert.rejects(service.prepare(owner, confirmed.id, confirmed.revision, 'confirmed-cannot-prepare'), /immutable/iu);
    assert.equal((await service.get(owner, confirmed.id)).status, 'confirmed');
    assert.equal(modelCalls, 0);
  } finally { await client.end(); await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE'); await admin.end(); }
});

test('preparation recovery retains safe budget failures and fences explicit retries by owned revision', { skip: !process.env.STRATEGY_TEST_DATABASE_URL }, async () => {
  const namespace = 'strategy_preparation_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 8, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/39_user_investment_strategies.sql', 'utf8'));
    const db = drizzle(client), owner = randomUUID(), stranger = randomUUID();
    await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},'preparation-owner','fixture'),(${stranger},'preparation-stranger','fixture')`;
    const budgets = new LlmBudgetService(db);
    await budgets.saveSettings(owner, { ...DEFAULT_LLM_BUDGET, maxInputTokens: 100 });
    let executed = 0;
    const model = new StrategyModelService({} as never, { execute: async (_owner: string, options: { onDispatch(): Promise<void> }) => {
      await options.onDispatch(); executed++; return { text: '{"entries":[]}', usageTokens: null };
    } } as never, budgets, { resolve: async () => ({ route: { mode: 'local', agentId: 'native-codex' }, label: 'Fixture' }) } as never);
    const service = new UserInvestmentStrategyService(db, new ResearchDocumentsService(db), model);
    const now = new Date(), text = '持续监控FICT，寻找加仓机会';
    const draft = await service.create(owner, { title: 'Fictional observation', body: text, timezone: 'Asia/Shanghai', startsAt: now.toISOString(),
      endsAt: new Date(+now + 86400000).toISOString(), entries: [{ id: 'observation', text, sourceKeys: [] }] });
    assert.deepEqual(await service.preparation(owner, draft.id, draft.revision), { status: 'none' });
    await assert.rejects(service.prepare(owner, draft.id, draft.revision, 'budget-blocked-key'), BudgetExceededException);
    assert.equal(executed, 0, 'input budget rejection never executes a model');
    const failed = await service.preparation(owner, draft.id, draft.revision);
    assert.equal(failed.status, 'failed');
    if (failed.status !== 'failed') throw new Error('Expected a persisted failure');
    assert.equal(failed.requestKey, 'budget-blocked-key');
    assert.equal(failed.error.code, 'LLM_BUDGET_EXCEEDED_INPUT_TOKENS');
    assert.match(failed.error.message.en, /input budget/u);
    assert.match(failed.error.message['zh-CN'], /输入额度/u);
    await assert.rejects(service.preparation(stranger, draft.id, draft.revision), /not found/iu);
    await assert.rejects(service.preparation(owner, draft.id, 0), /revision/iu);
    await assert.rejects(service.prepare(owner, draft.id, draft.revision, 'budget-blocked-key'), /already dispatched/iu);
    assert.equal(executed, 0, 'reading or replaying a failure never starts a model');
    await budgets.saveSettings(owner, { ...DEFAULT_LLM_BUDGET });
    const prepared = await service.prepare(owner, draft.id, draft.revision, 'explicit-new-attempt');
    assert.equal(executed, 1);
    assert.equal(prepared.preview!.directives.length, 0);
    assert.equal(prepared.content.entries[0].text, text);
    const succeeded = await service.preparation(owner, draft.id, draft.revision);
    assert.equal(succeeded.status, 'succeeded');
    if (succeeded.status === 'succeeded') assert.deepEqual(succeeded.result, prepared);
    assert.equal((await service.prepare(owner, draft.id, draft.revision, 'explicit-new-attempt')).revision, prepared.revision);
    assert.equal(executed, 1);
    assert.equal(prepared.preview!.contentHash, strategyContentHash(prepared.content, prepared.sources), 'a prepared preview must bind to its persisted JSONB content');
    let activations = 0;
    await db.transaction(tx => service.confirmInTransaction(tx, owner, prepared.id, prepared.revision, prepared.preview!.contentHash, null,
      async () => { activations++; }));
    const historical = await service.preparation(owner, draft.id, draft.revision);
    assert.equal(historical.status, 'succeeded', 'receipts retain the outcome of their original revision');
    await service.prepare(owner, draft.id, draft.revision, 'explicit-new-attempt');
    await assert.rejects(service.prepare(owner, draft.id, prepared.revision, 'confirmed-new-attempt'), /immutable/iu);
    assert.equal((await service.get(owner, draft.id)).status, 'confirmed', 'receipt replay cannot restore an old draft snapshot');
    assert.equal(activations, 1, 'reading or replaying a receipt cannot reactivate a strategy');
    assert.equal(executed, 1);

    const legacy = await service.create(owner, draft.content);
    const inputHash = createHash('sha256').update(JSON.stringify({ id: legacy.id, expectedRevision: legacy.revision })).digest('hex');
    await db.insert(userInvestmentStrategyPreparations).values({ owner, strategyId: legacy.id, requestKey: 'legacy-failed-key', inputHash, status: 'failed' });
    const legacyFailure = await service.preparation(owner, legacy.id, legacy.revision);
    assert.equal(legacyFailure.status, 'failed');
    if (legacyFailure.status === 'failed') assert.equal(legacyFailure.error.code, 'STRATEGY_PREPARATION_FAILED');
    assert.deepEqual(await service.preparation(owner, legacy.id, legacy.revision + 1), { status: 'none' });

    const pendingDraft = await service.create(owner, draft.content);
    let entered!: () => void, release!: () => void, calls = 0;
    const begun = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const pendingService = new UserInvestmentStrategyService(db, new ResearchDocumentsService(db), { json: async () => { calls++; entered(); await blocked; return { entries: [] }; } } as never);
    const first = pendingService.prepare(owner, pendingDraft.id, pendingDraft.revision, 'pending-first-key');
    await begun;
    try {
      const pending = await pendingService.preparation(owner, pendingDraft.id, pendingDraft.revision);
      assert.equal(pending.status, 'pending');
      await assert.rejects(pendingService.prepare(owner, pendingDraft.id, pendingDraft.revision, 'pending-other-key'), /pending|in progress/iu);
      assert.equal(calls, 1, 'a different request key cannot overlap the same revision');
    } finally { release(); }
    await first;

    const privateDraft = await service.create(owner, draft.content);
    const privateService = new UserInvestmentStrategyService(db, new ResearchDocumentsService(db), { json: async () => { throw new Error('PRIVATE_MODEL_PROMPT sk-private-provider-payload'); } } as never);
    await assert.rejects(privateService.prepare(owner, privateDraft.id, 1, 'private-failure-key'));
    const privateFailure = await privateService.preparation(owner, privateDraft.id, 1);
    assert.equal(privateFailure.status, 'failed');
    assert.doesNotMatch(JSON.stringify(privateFailure), /PRIVATE_MODEL_PROMPT|sk-private-provider-payload/u);
    const [receipt] = await db.select().from(userInvestmentStrategyPreparations).where(eq(userInvestmentStrategyPreparations.requestKey, 'private-failure-key'));
    assert.doesNotMatch(JSON.stringify(receipt.result), /PRIVATE_MODEL_PROMPT|sk-private-provider-payload/u);

    for (const [failure, code] of [
      [new LocalAgentError('LOCAL_BUSY'), 'LOCAL_BUSY'],
      [new Error('No available strategy research member'), 'STRATEGY_REVIEWER_UNAVAILABLE'],
      [new Error('Local strategy result needs formatting'), 'STRATEGY_PREPARATION_FORMAT'],
      [new BudgetExceededException('daily_calls'), 'LLM_BUDGET_EXCEEDED_DAILY_CALLS'],
    ] as const) {
      const candidate = await service.create(owner, draft.content), key = randomUUID();
      const failingService = new UserInvestmentStrategyService(db, new ResearchDocumentsService(db), { json: async () => { throw failure; } } as never);
      await assert.rejects(failingService.prepare(owner, candidate.id, 1, key));
      const status = await failingService.preparation(owner, candidate.id, 1);
      assert.equal(status.status, 'failed');
      if (status.status === 'failed') {
        assert.equal(status.error.code, code);
        assert.ok(status.error.message.en && status.error.message['zh-CN']);
      }
    }
    const invalidDraft = await service.create(owner, draft.content);
    const invalidService = new UserInvestmentStrategyService(db, new ResearchDocumentsService(db), { json: async () => ({ entries: [{ id: 'observation', directive: null }] }) } as never);
    await assert.rejects(invalidService.prepare(owner, invalidDraft.id, 1, 'invalid-format-key'));
    const invalid = await invalidService.preparation(owner, invalidDraft.id, 1);
    assert.equal(invalid.status, 'failed');
    if (invalid.status === 'failed') assert.equal(invalid.error.code, 'STRATEGY_PREPARATION_FORMAT');
  } finally { await client.end(); await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE'); await admin.end(); }
});
