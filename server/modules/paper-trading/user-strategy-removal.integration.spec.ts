import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { investmentFixture } from './investment-test.fixture';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { InvestmentPolicyService } from './investment-policy.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { investmentExecutionFence } from './investment-policy.fence';
import { builderProfiles, paperAccounts } from '../../database/schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { strategySignals } from '../../database/strategy.schema';
import { userInvestmentStrategyPreparations, userInvestmentStrategyRevisions } from '../../database/user-investment-strategies.schema';
import type { StrategyDraftInput } from '../../../shared/user-investment-strategy.interface';

const content = (): StrategyDraftInput => ({ title: 'Fictional plan', body: '', timezone: 'Asia/Shanghai', startsAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 86400000).toISOString(), entries: [{ id: 'watch', text: 'Watch FICT', sourceKeys: [] }] });

test('draft deletion is owner/revision fenced, retryable, retains audit and prevents automatic report resurrection', async () => {
  await investmentFixture(async (db, client, owner) => {
    await client.unsafe('ALTER TABLE user_investment_strategies DROP COLUMN deleted_at');
    await client.unsafe(readFileSync('scripts/db/44_strategy_draft_deletion.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/44_strategy_draft_deletion.sql', 'utf8'));
    const documents = new ResearchDocumentsService(db), strategies = new UserInvestmentStrategyService(db, documents, {} as never);
    const draft = await strategies.create(owner, content());
    await assert.rejects(strategies.deleteDraft(randomUUID(), draft.id, draft.revision), /not found/i);
    await assert.rejects(strategies.deleteDraft(owner, draft.id, draft.revision + 1), /changed/i);
    await strategies.deleteDraft(owner, draft.id, draft.revision);
    await strategies.deleteDraft(owner, draft.id, draft.revision);
    assert.equal((await strategies.workspace(owner)).drafts.length, 0);
    await assert.rejects(strategies.get(owner, draft.id), /not found/i);
    await assert.rejects(strategies.update(owner, draft.id, draft.revision, content()), /not found/i);
    assert.equal((await db.select().from(userInvestmentStrategyRevisions).where(eq(userInvestmentStrategyRevisions.strategyId, draft.id))).length, 1);
    const report = await documents.submit(owner, { idempotencyKey: 'removed-report-fixture', title: 'Fixture source', kind: 'deep', content: 'Watch FICT', sections: [{ id: 'view', title: 'View', content: 'Watch FICT' }], availableAt: new Date().toISOString() });
    const source = { kind: 'report' as const, versionId: report.id };
    const imported = await strategies.importSource(owner, source);
    await strategies.deleteDraft(owner, imported.id, imported.revision);
    await strategies.importSource(owner, source, true);
    assert.equal((await strategies.workspace(owner)).drafts.length, 0, 'background sync must respect an explicit deletion');
    const explicit = await strategies.importSource(owner, source);
    assert.notEqual(explicit.id, imported.id, 'a new explicit copy can restore the source as a fresh draft');
    const race = await strategies.create(owner, content());
    const results = await Promise.allSettled([strategies.deleteDraft(owner, race.id, race.revision), strategies.update(owner, race.id, race.revision, { ...race.content, title: 'A newer draft' })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'deletion and editing cannot both overwrite the same draft revision');
  });
});

test('removing current strategy atomically stops execution, retains confirmation and rejects stale or cross-owner requests', async () => {
  await investmentFixture(async (db, _client, owner) => {
    const strategies = new UserInvestmentStrategyService(db, new ResearchDocumentsService(db), {} as never);
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never), strategies);
    const seed = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'removal-preview' });
    await policies.start(owner, { previewId: seed.id, requestKey: 'removal-start' });
    const draft = await strategies.create(owner, content()), ready = await strategies.preview(owner, draft.id, draft.revision);
    const applied = await policies.applyStrategy(owner, { strategyId: ready.id, expectedRevision: ready.revision, previewHash: ready.preview!.contentHash, expectedCurrentId: null, requestKey: 'removal-apply' });
    const request = { strategyId: ready.id, expectedRevision: ready.revision, expectedPolicyRevision: applied.policy.revision, requestKey: 'removal-remove' };
    await assert.rejects(strategies.deleteDraft(owner, ready.id, ready.revision), /immutable|changed/i);
    await assert.rejects(policies.removeStrategy(randomUUID(), request), /NOT_STARTED|not found/i);
    await assert.rejects(policies.removeStrategy(owner, { ...request, expectedPolicyRevision: applied.policy.revision + 1 }), /REVISION_CHANGED/i);
    const [profile] = await db.select().from(builderProfiles).where(eq(builderProfiles.owner, owner));
    const signalId = randomUUID();
    await db.insert(strategySignals).values({ id: signalId, owner, profileId: profile.id, planId: randomUUID(), ruleId: 'watch', kind: 'buy', state: 'reviewing', reason: 'Offline fixture', candidate: { accountId: applied.policy.accountId } as never });
    const removed = await policies.removeStrategy(owner, request);
    assert.deepEqual(await policies.removeStrategy(owner, request), removed);
    assert.equal((await strategies.workspace(owner)).current, null);
    assert.equal((await strategies.history(owner)).items[0].id, ready.id);
    const view = await policies.overview(owner);
    assert.equal(view.policy!.status, 'paused'); assert.equal(view.currentStrategy, null);
    assert.equal(view.currentThinking, null, 'removed mandate text must not remain the account current intent');
    assert.equal((await db.select().from(paperAccounts).where(eq(paperAccounts.id, applied.policy.accountId)))[0].botEnabled, false);
    assert.ok((await db.select().from(strategyMandates).where(eq(strategyMandates.owner, owner))).every(row => row.status === 'paused'));
    assert.ok((await db.select().from(builderProfiles).where(eq(builderProfiles.owner, owner))).every(row => row.status === 'paused'));
    assert.equal((await db.select().from(strategySignals).where(eq(strategySignals.id, signalId)))[0].state, 'cancelled');
    const fenced = await db.transaction(tx => investmentExecutionFence(tx, owner, applied.policy.accountId, { ticker: 'FICT', market: 'US', side: 'buy' }, 'agent', { parentPolicyId: applied.policy.id, parentPolicyRevision: applied.policy.revision } as never));
    assert.ok(fenced.block, 'a pre-removal candidate cannot execute');
    await assert.rejects(policies.resume(owner, { expectedRevision: view.policy!.revision, requestKey: 'removal-resume' }), /CONFIRMED_USER_STRATEGY_REQUIRED/);
    const next = await strategies.create(owner, content()), nextReady = await strategies.preview(owner, next.id, next.revision);
    const nextApplied = await policies.applyStrategy(owner, { strategyId: next.id, expectedRevision: next.revision, previewHash: nextReady.preview!.contentHash, expectedCurrentId: null, requestKey: 'removal-next-apply' });
    const replacement = await strategies.create(owner, content()), replacementReady = await strategies.preview(owner, replacement.id, replacement.revision);
    const race = await Promise.allSettled([
      policies.removeStrategy(owner, { strategyId: next.id, expectedRevision: next.revision, expectedPolicyRevision: nextApplied.policy.revision, requestKey: 'removal-race-remove' }),
      policies.applyStrategy(owner, { strategyId: replacement.id, expectedRevision: replacement.revision, previewHash: replacementReady.preview!.contentHash, expectedCurrentId: next.id, requestKey: 'removal-race-replace' }),
    ]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1, 'replacement and removal serialize under the same owner fence');
    assert.equal((await strategies.workspace(owner)).current?.id ?? null, race[0].status === 'fulfilled' ? null : replacement.id);
  });
});

test('deleting a draft during preparation preserves its receipt and prevents late model output from restoring it', async () => {
  await investmentFixture(async (db, _client, owner) => {
    let release!: (value: unknown) => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const result = new Promise<unknown>(resolve => { release = resolve; });
    const strategies = new UserInvestmentStrategyService(db, new ResearchDocumentsService(db), { json: async () => { started(); return result; } } as never);
    const draft = await strategies.create(owner, content());
    const preparing = strategies.prepare(owner, draft.id, draft.revision, 'removed-pending-prepare');
    await entered;
    await strategies.deleteDraft(owner, draft.id, draft.revision);
    release({ entries: [] });
    await assert.rejects(preparing, /not found/i);
    assert.equal((await strategies.workspace(owner)).drafts.length, 0);
    const [receipt] = await db.select().from(userInvestmentStrategyPreparations).where(eq(userInvestmentStrategyPreparations.strategyId, draft.id));
    assert.equal(receipt.status, 'failed');
  });
});
