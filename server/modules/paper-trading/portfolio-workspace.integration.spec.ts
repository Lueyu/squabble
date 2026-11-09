import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../../common/platform/database.provider';
import { builderProfiles, paperAccounts } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { portfolioCombinationPreviews, portfolioStrategyAssignments } from '../../database/portfolio-workspace.schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { InvestmentPolicyService } from './investment-policy.service';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { PortfolioWorkspaceService } from './portfolio-workspace.service';
import { DEFAULT_INVESTMENT_CONFIG } from './investment-policy.rules';
import { previewStrategy } from './user-investment-strategy.rules';
import type { ConfirmedInvestmentStrategy, StrategyDraftInput } from '../../../shared/user-investment-strategy.interface';

function content(ticker: string, side: 'buy' | 'sell' = 'buy'): StrategyDraftInput {
  const text = `${ticker} at 100 ${side} 10 shares`;
  return { title: `${ticker} ${side} fictional`, body: text, timezone: 'Asia/Shanghai',
    limits: { maxPositionPct: 10, maxOrderPct: 5, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20, minCashPct: 10, maxGrossExposurePct: 90 },
    startsAt: new Date(Date.now() - 3600_000).toISOString(), endsAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    entries: [{ id: 'entry', text, ticker, sourceKeys: [], directive: { ticker, side, trigger: { kind: 'price_lte', price: 100 },
      quantity: 10, reviewedText: text, numericEvidence: [{ field: 'trigger.price', value: 100, quote: '100' }, { field: 'quantity', value: 10, quote: '10' }] } }] };
}

test('portfolio workspace upgrades, isolates two accounts, revalidates previews and survives complete restarts', {
  skip: !process.env.STRATEGY_TEST_DATABASE_URL,
}, async () => {
  const namespace = `portfolio_workspace_${randomUUID().replaceAll('-', '')}`;
  const url = process.env.STRATEGY_TEST_DATABASE_URL!;
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  const client = postgres(url, { max: 8, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe(`CREATE SCHEMA ${namespace}`);
  const restart = async () => {
    const scoped = new URL(url);
    scoped.searchParams.set('search_path', namespace);
    scoped.searchParams.set('client_min_messages', 'error');
    const started = await createDatabase(scoped.toString());
    await (started as typeof started & { $client: postgres.Sql }).$client.end();
  };
  try {
    // Deliberately stop before45: validate a populated old schema, not only fresh SQL.
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8').split('-- 45_portfolio_workspace.sql')[0]);
    const db = drizzle(client);
    const owner = randomUUID(); const stranger = randomUUID(); const oldOwner = randomUUID();
    for (const id of [owner, stranger, oldOwner]) await client`INSERT INTO users(id,username,password_hash) VALUES(${id},${'fixture-' + id.slice(0, 20)},'unused')`;
    const oldContent = content('AAPL'); const stamp = new Date().toISOString();
    const snapshot: ConfirmedInvestmentStrategy = { id: randomUUID(), revision: 1, parentId: null, status: 'confirmed',
      content: oldContent, sources: [], preview: previewStrategy(oldContent, [], 1), createdAt: stamp, updatedAt: stamp, confirmedAt: stamp };
    const [oldAccount] = await db.insert(paperAccounts).values({ owner: oldOwner, name: 'Old active', isActive: true }).returning();
    const [archivedAccount] = await db.insert(paperAccounts).values({ owner: oldOwner, name: 'Old archive', isActive: false }).returning();
    const legacyConfig = { ...DEFAULT_INVESTMENT_CONFIG, userStrategy: snapshot };
    await db.insert(investmentPolicies).values([
      { owner: oldOwner, accountId: oldAccount.id, status: 'running', baseConfig: legacyConfig, effectiveConfig: legacyConfig },
      { owner: oldOwner, accountId: archivedAccount.id, status: 'archived', baseConfig: legacyConfig, effectiveConfig: legacyConfig },
    ]);
    await restart();
    const migrated = await db.select().from(portfolioStrategyAssignments).where(eq(portfolioStrategyAssignments.owner, oldOwner));
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].accountId, oldAccount.id);
    assert.equal((await db.select().from(paperAccounts).where(eq(paperAccounts.id, archivedAccount.id)))[0].isActive, false);

    const docs = new ResearchDocumentsService(db);
    const strategies = new UserInvestmentStrategyService(db, docs, { json: async () => { throw new Error('Research must not run'); } } as never);
    const simulations = new SimulationExperimentsService(db, {} as never, {} as never);
    const policies = new InvestmentPolicyService(db, simulations, strategies);
    const workspace = new PortfolioWorkspaceService(db, policies, strategies);
    const create = async (name: string) => {
      const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: randomUUID() });
      return workspace.create(owner, { name, previewId: preview.previewId, requestKey: randomUUID() });
    };
    const first = await create('Account A'); const second = await create('Account B');
    assert.notEqual(first.accountId, second.accountId);
    assert.equal((await workspace.list(owner)).length, 2);
    assert.deepEqual(await workspace.list(stranger), []);
    await assert.rejects(workspace.detail(stranger, first.accountId), /ACCOUNT_NOT_FOUND/);
    assert.equal((await db.select().from(paperAccounts).where(eq(paperAccounts.owner, owner))).filter(a => a.isActive).length, 2);
    await assert.rejects(workspace.switchStatus(stranger, first.accountId, { expectedPolicyRevision: 1, requestKey: randomUUID() }, false), /ACCOUNT_NOT_FOUND/);
    await assert.rejects(policies.pause(owner, { expectedRevision: 1, requestKey: randomUUID() }), /ACCOUNT_SELECTION_REQUIRED/);
    await assert.rejects(policies.quickApply(owner, { versionId: randomUUID(), requestKey: randomUUID() }), /ACCOUNT_SELECTION_REQUIRED/);

    const createStrategy = async (ticker: string, side: 'buy' | 'sell' = 'buy') => {
      const draft = await strategies.create(owner, content(ticker, side));
      const ready = await strategies.preview(owner, draft.id, draft.revision);
      assert.equal(ready.preview?.canConfirm, true, JSON.stringify(ready.preview?.issues));
      return ready;
    };
    const apple = await createStrategy('AAPL'); const microsoft = await createStrategy('MSFT');
    const appleSell = await createStrategy('AAPL', 'sell');
    const allocations = [{ strategyId: apple.id, strategyRevision: apple.revision, allocationPct: 50, enabled: true },
      { strategyId: microsoft.id, strategyRevision: microsoft.revision, allocationPct: 50, enabled: true }];
    const common = { allocations, expectedPolicyRevision: 1, requestKey: 'same-key-two-accounts' };
    await workspace.saveDraft(owner, first.accountId, common);
    await workspace.saveDraft(owner, second.accountId, common);
    assert.equal((await workspace.combination(owner, first.accountId)).draft?.allocations.length, 2);
    assert.equal((await strategies.get(owner, apple.id)).status, 'draft', 'saving a combination never confirms or activates');
    assert.equal((await workspace.list(owner)).every(a => a.status === 'paused'), true);
    const changing = await createStrategy('GOOG');
    const changingAllocations = [{ strategyId: changing.id, strategyRevision: changing.revision, allocationPct: 100, enabled: true }];
    const changingPreview = await workspace.preview(owner, first.accountId, { allocations: changingAllocations, expectedPolicyRevision: 1, requestKey: randomUUID() });
    await strategies.update(owner, changing.id, changing.revision, { ...changing.content, title: 'Changed after combination preview' });
    await assert.rejects(workspace.apply(owner, first.accountId, { allocations: changingAllocations, expectedPolicyRevision: 1,
      previewHash: changingPreview.previewHash, requestKey: randomUUID() }), /STRATEGY_REVISION_CHANGED/);
    const expired = await workspace.preview(owner, first.accountId, { ...common, requestKey: randomUUID() });
    await db.update(portfolioCombinationPreviews).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(portfolioCombinationPreviews.previewHash, expired.previewHash));
    await assert.rejects(workspace.apply(owner, first.accountId, { ...common, requestKey: randomUUID(), previewHash: expired.previewHash }), /COMBINATION_PREVIEW_EXPIRED/);
    const bad = await workspace.preview(owner, first.accountId, { ...common, requestKey: randomUUID(),
      allocations: [allocations[0], { strategyId: appleSell.id, strategyRevision: appleSell.revision, allocationPct: 50, enabled: true }] });
    assert.equal(bad.canApply, false); assert.equal(bad.issues[0].code, 'STRATEGY_DIRECTION_CONFLICT');
    await assert.rejects(workspace.apply(owner, first.accountId, { expectedPolicyRevision: 1, requestKey: randomUUID(), previewHash: bad.previewHash,
      allocations: bad.allocations.map(({ snapshot: _snapshot, ...a }) => a) }), /COMBINATION_CONFLICT/);
    const apply = async (accountId: string, revision: number) => {
      const preview = await workspace.preview(owner, accountId, { allocations, expectedPolicyRevision: revision, requestKey: randomUUID() });
      const request = { allocations, expectedPolicyRevision: revision, previewHash: preview.previewHash, requestKey: randomUUID() };
      const result = await workspace.apply(owner, accountId, request);
      assert.deepEqual(await workspace.apply(owner, accountId, request), result, 'apply receipt is idempotent after revision changes');
      return result;
    };
    const appliedA = await apply(first.accountId, 1); await apply(second.accountId, 1);
    assert.equal((await strategies.get(owner, apple.id)).status, 'confirmed');
    assert.equal((await strategies.workspace(owner)).current, null, 'account assignment never changes owner-level execution selection');
    assert.equal((await db.select().from(builderProfiles).where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.status, 'active')))).length, 2);
    assert.equal((await db.select().from(strategyMandates).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.status, 'published')))).length, 2);
    await assert.rejects(strategies.remove(owner, apple.id), /CONFIRMED_STRATEGY_HISTORY_IMMUTABLE/);

    await restart(); await restart();
    assert.deepEqual((await workspace.list(owner)).map(a => a.status), ['running', 'running'], 'historical migration42 must not pause combinations on restart');
    assert.equal((await db.select().from(builderProfiles).where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.status, 'active')))).length, 2);
    const stale = await workspace.preview(owner, first.accountId, { allocations, expectedPolicyRevision: appliedA.policy.revision, requestKey: randomUUID() });
    await workspace.switchStatus(owner, first.accountId, { expectedPolicyRevision: 2, requestKey: randomUUID() }, false);
    assert.equal((await workspace.list(owner)).find(a => a.id === second.accountId)?.status, 'running');
    await assert.rejects(workspace.apply(owner, first.accountId, { allocations, expectedPolicyRevision: 2, previewHash: stale.previewHash, requestKey: randomUUID() }), /POLICY_REVISION_CHANGED/);
    await workspace.switchStatus(owner, first.accountId, { expectedPolicyRevision: 3, requestKey: randomUUID() }, true);

    const report = await docs.submit(owner, { idempotencyKey: randomUUID(), title: 'Fictional source', kind: 'deep', ticker: 'AAPL',
      content: 'Observe AAPL', sections: [{ id: 'summary', title: 'Summary', content: 'Observe AAPL' }], availableAt: new Date().toISOString() });
    const sourced = await strategies.importSource(owner, { kind: 'report', versionId: report.id });
    const ready = await strategies.preview(owner, sourced.id, sourced.revision);
    const sourceAllocations = [{ strategyId: ready.id, strategyRevision: ready.revision, allocationPct: 100, enabled: true }];
    const sourcePreview = await workspace.preview(owner, first.accountId, { allocations: sourceAllocations, expectedPolicyRevision: 4, requestKey: randomUUID() });
    await docs.revoke(owner, report.id, 'Fictional revocation');
    await assert.rejects(workspace.apply(owner, first.accountId, { allocations: sourceAllocations, expectedPolicyRevision: 4,
      requestKey: randomUUID(), previewHash: sourcePreview.previewHash }), /revoked|available|valid/i);
    assert.equal((await workspace.combination(owner, first.accountId)).allocations.length, 2, 'failed final source validation leaves authority intact');
    const isolatedPreview = await policies.preview(stranger, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: randomUUID() });
    await workspace.create(stranger, { name: 'Single-account compatibility', previewId: isolatedPreview.previewId, requestKey: randomUUID() });
    const broaderContent = content('AAPL');
    broaderContent.limits = { ...broaderContent.limits!, maxPositionPct: 20, maxOrderPct: 10 };
    const broaderDraft = await strategies.create(stranger, broaderContent);
    const broader = await strategies.preview(stranger, broaderDraft.id, broaderDraft.revision);
    const compatibility = await policies.applyStrategy(stranger, { strategyId: broader.id, expectedRevision: broader.revision,
      expectedCurrentId: null, previewHash: broader.preview!.contentHash, requestKey: randomUUID() });
    assert.equal(compatibility.policy.baseConfig.limits.maxPositionPct, 10, 'legacy apply must retain workspace account authority');
    assert.equal(compatibility.policy.effectiveConfig.limits.maxOrderPct, 5);
  } finally {
    await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end();
  }
});
