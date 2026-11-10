import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { paperAccounts } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { userInvestmentStrategies } from '../../database/user-investment-strategies.schema';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { DEFAULT_INVESTMENT_CONFIG } from './investment-policy.rules';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { StrategyInterviewService } from './strategy-interview.service';

test('interviews persist exact answers, isolate owner/account, deduplicate actions and invalidate stale strategy previews without activation', async () => {
  assert.ok(process.env.STRATEGY_TEST_DATABASE_URL, 'A disposable STRATEGY_TEST_DATABASE_URL is required');
  const namespace = 'strategy_interview_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 8, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/46_strategy_interviews.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/46_strategy_interviews.sql', 'utf8'));
    const db = drizzle(client);
    const owner = randomUUID(); const stranger = randomUUID();
    for (const id of [owner, stranger]) await client`INSERT INTO users(id,username,password_hash) VALUES(${id},${'fixture-' + id.slice(0, 20)},'unused')`;
    const [first, second, foreign] = await db.insert(paperAccounts).values([
      { owner, name: 'First', isActive: true, botEnabled: false },
      { owner, name: 'Second', isActive: true, botEnabled: false },
      { owner: stranger, name: 'Foreign', isActive: true, botEnabled: false },
    ]).returning();
    await db.insert(investmentPolicies).values([first, second, foreign].map(account => ({ owner: account.owner, accountId: account.id,
      baseConfig: DEFAULT_INVESTMENT_CONFIG, effectiveConfig: DEFAULT_INVESTMENT_CONFIG })));
    let calls = 0;
    const strategies = new UserInvestmentStrategyService(db, new ResearchDocumentsService(db), { json: async () => { calls++; throw new Error('No provider calls allowed'); } } as never);
    const service = new StrategyInterviewService(db, strategies);
    const input = { accountId: first.id, message: '我想试试低频价值策略', requestKey: randomUUID() };
    const created = await service.create(owner, input);
    assert.equal(created.confirmed.length, 0);
    await assert.rejects(service.review(owner, created.id), /INTERVIEW_REVIEW_REQUIRED/);
    assert.deepEqual(await service.create(owner, input), created);
    await assert.rejects(service.create(owner, { ...input, accountId: second.id }), /REQUEST_KEY_REUSED/);
    await assert.rejects(service.create(owner, { ...input, accountId: foreign.id, requestKey: randomUUID() }), /ACCOUNT_NOT_FOUND/);
    await assert.rejects(service.get(stranger, created.id), /INTERVIEW_NOT_FOUND/);
    assert.deepEqual(await service.list(owner, second.id), []);
    assert.equal((await service.get(owner, created.id)).messages[0].text, input.message);
    let current = await service.accept(owner, created.id, { expectedRevision: created.revision, suggestionId: created.suggestions[0].id, requestKey: randomUUID() });
    const answer = { expectedRevision: current.revision, field: 'security', message: 'buy AAPL', requestKey: randomUUID() };
    const [left, right] = await Promise.all([service.answer(owner, current.id, answer), service.answer(owner, current.id, answer)]);
    assert.deepEqual(left, right);
    await assert.rejects(service.answer(owner, current.id, { ...answer, requestKey: randomUUID(), message: 'buy MSFT' }), /INTERVIEW_REVISION_CHANGED/);
    current = await service.accept(owner, left.id, { expectedRevision: left.revision, suggestionId: left.suggestions[0].id, requestKey: randomUUID() });
    const observation = await service.preview(owner, current.id, { expectedRevision: current.revision, observationOnly: true, requestKey: randomUUID() });
    assert.equal(observation.strategy.preview?.directives.length, 0);
    assert.equal(observation.strategy.status, 'draft');
    const restoredObservation = await service.review(owner, current.id);
    assert.deepEqual(restoredObservation, observation);
    assert.equal((await service.get(owner, current.id)).revision, observation.interview.revision, 'reading examples cannot regenerate a strategy');
    const changed = await service.answer(owner, current.id, { expectedRevision: observation.interview.revision, field: 'security', message: 'buy MSFT', requestKey: randomUUID() });
    assert.equal(changed.review, null);
    const stale = await strategies.get(owner, observation.strategy.id);
    assert.equal(stale.preview, null);
    assert.equal(stale.revision, observation.strategy.revision + 1);
    await assert.rejects(service.review(owner, current.id), /INTERVIEW_REVIEW_REQUIRED/);
    await assert.rejects(service.preview(owner, current.id, { expectedRevision: changed.revision, requestKey: randomUUID() }), /INTERVIEW_INCOMPLETE/);
    current = await service.accept(owner, changed.id, { expectedRevision: changed.revision, suggestionId: changed.suggestions[0].id, requestKey: randomUUID() });
    for (const [field, message] of [['condition', '价格低于20'], ['amount', '1股'], ['frequency', '每交易日最多一次'], ['period', '未来30天']] as const) {
      current = await service.answer(owner, current.id, { expectedRevision: current.revision, field, message, requestKey: randomUUID() });
      assert.equal(current.suggestions.length, 1, message);
      current = await service.accept(owner, current.id, { expectedRevision: current.revision, suggestionId: current.suggestions[0].id, requestKey: randomUUID() });
    }
    const previewInput = { expectedRevision: current.revision, requestKey: randomUUID() };
    const ready = await service.preview(owner, current.id, previewInput);
    assert.equal(ready.strategy.preview?.canConfirm, true);
    assert.equal(ready.strategy.preview?.directives[0].trigger.kind, 'price_lt');
    assert.equal(ready.strategy.preview?.directives[0].executionFrequency?.kind, 'per_trading_day');
    assert.deepEqual(await service.preview(owner, current.id, previewInput), ready);
    assert.ok(ready.strategy.content.body.includes(changed.messages[0].id), 'materialized strategy keeps exact interview source identities');
    assert.equal(ready.examples.find(item => item.id === 'threshold')?.outcome, 'no_action');
    const amountEdit = await service.answer(owner, current.id, { expectedRevision: ready.interview.revision,
      field: 'amount', message: '2股', requestKey: randomUUID() });
    assert.ok(amountEdit.confirmed.some(answer => answer.field === 'frequency'), 'editing quantity preserves independent frequency and period answers');
    assert.equal((await strategies.get(owner, ready.strategy.id)).preview, null);
    await assert.rejects(db.transaction(tx => strategies.accountSnapshot(tx, owner, ready.strategy.id, ready.strategy.revision)), /STRATEGY_REVISION_CHANGED/);
    assert.equal((await db.select().from(paperAccounts).where(eq(paperAccounts.id, first.id)))[0].botEnabled, false);
    assert.equal((await db.select().from(investmentPolicies).where(eq(investmentPolicies.accountId, first.id)))[0].revision, 1);
    assert.equal((await db.select().from(userInvestmentStrategies).where(eq(userInvestmentStrategies.owner, owner))).every(item => item.status === 'draft'), true);
    const acceptedAmount = await service.accept(owner, current.id, { expectedRevision: amountEdit.revision,
      suggestionId: amountEdit.suggestions[0].id, requestKey: randomUUID() });
    const confirmedReview = await service.preview(owner, current.id, { expectedRevision: acceptedAmount.revision, requestKey: randomUUID() });
    const confirmed = await db.transaction(tx => strategies.accountSnapshot(tx, owner, confirmedReview.strategy.id, confirmedReview.strategy.revision, true));
    const editedVersion = await service.answer(owner, current.id, { expectedRevision: confirmedReview.interview.revision,
      field: 'frequency', message: '只执行一次', requestKey: randomUUID() });
    assert.equal(editedVersion.baseStrategyId, confirmed.id, 'editing a confirmed interview creates a child version, never loses its lineage');
    const acceptedFrequency = await service.accept(owner, current.id, { expectedRevision: editedVersion.revision,
      suggestionId: editedVersion.suggestions[0].id, requestKey: randomUUID() });
    const nextVersion = await service.preview(owner, current.id, { expectedRevision: acceptedFrequency.revision, requestKey: randomUUID() });
    assert.equal(nextVersion.strategy.parentId, confirmed.id);
    assert.deepEqual(await strategies.get(owner, confirmed.id), confirmed);
    assert.equal((await db.select().from(paperAccounts).where(eq(paperAccounts.id, first.id)))[0].botEnabled, false);

    let independent = await service.create(owner, { accountId: second.id, message: 'Independent edits', requestKey: randomUUID() });
    independent = await service.accept(owner, independent.id, { expectedRevision: independent.revision,
      suggestionId: independent.suggestions[0].id, requestKey: randomUUID() });
    for (const [field, message] of [['security', 'buy AAPL'], ['condition', 'price < 100'], ['amount', '1 shares'],
      ['frequency', 'once'], ['period', 'next 30 days']] as const) {
      independent = await service.answer(owner, independent.id, { expectedRevision: independent.revision, field, message, requestKey: randomUUID() });
      independent = await service.accept(owner, independent.id, { expectedRevision: independent.revision,
        suggestionId: independent.suggestions[0].id, requestKey: randomUUID() });
    }
    independent = await service.answer(owner, independent.id, { expectedRevision: independent.revision,
      field: 'security', message: 'buy MSFT', requestKey: randomUUID() });
    independent = await service.accept(owner, independent.id, { expectedRevision: independent.revision,
      suggestionId: independent.suggestions[0].id, requestKey: randomUUID() });
    independent = await service.answer(owner, independent.id, { expectedRevision: independent.revision,
      field: 'frequency', message: 'once per trading day', requestKey: randomUUID() });
    const savedProposal = independent.suggestions[0];
    const oldRevision = independent.revision;
    independent = await service.answer(owner, independent.id, { expectedRevision: independent.revision,
      field: 'frequency', message: 'once', requestKey: randomUUID() });
    assert.equal(independent.currentQuestion?.field, 'condition');
    assert.equal(independent.messages.at(-2)?.supersedesMessageId, savedProposal.sourceMessageId);
    await assert.rejects(service.accept(owner, independent.id, { expectedRevision: independent.revision,
      suggestionId: savedProposal.id, requestKey: randomUUID() }), /INTERVIEW_SUGGESTION_CHANGED/);
    await assert.rejects(service.answer(owner, independent.id, { expectedRevision: oldRevision,
      field: 'frequency', message: 'once', requestKey: randomUUID() }), /INTERVIEW_REVISION_CHANGED/);
    await assert.rejects(service.answer(stranger, independent.id, { expectedRevision: independent.revision,
      field: 'frequency', message: 'once', requestKey: randomUUID() }), /INTERVIEW_NOT_FOUND/);
    independent = await service.accept(owner, independent.id, { expectedRevision: independent.revision,
      suggestionId: independent.suggestions[0].id, requestKey: randomUUID() });
    assert.equal(independent.currentQuestion?.field, 'condition');
    await assert.rejects(service.answer(owner, independent.id, { expectedRevision: independent.revision,
      field: 'amount', message: '2 shares', requestKey: randomUUID() }), /INTERVIEW_QUESTION_CHANGED/);
    assert.equal(calls, 0);
  } finally {
    await client.end();
    await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE');
    await admin.end();
  }
});
