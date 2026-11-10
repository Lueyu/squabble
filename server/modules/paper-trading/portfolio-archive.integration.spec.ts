import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { builderProfiles, paperAccounts, paperOrders, paperPositions, paperSnapshots, paperTrades } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { strategyMandates, strategyReservations } from '../../database/strategy-mandates.schema';
import { simulationCash, simulationSeeds } from '../../database/simulation-experiments.schema';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { PortfolioWorkspaceService } from './portfolio-workspace.service';
import { InvestmentPolicyService } from './investment-policy.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { investmentFixture, startPreUserStrategyInvestmentFixture } from './investment-test.fixture';
import { investmentExecutionFence } from './investment-policy.fence';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';

test('archive is account-scoped and retry-safe, preserving financial and report history including legacy books', async () => {
  await investmentFixture(async (db, _sql, owner) => {
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const workspace = new PortfolioWorkspaceService(db, policies, {} as never);
    const preview = await policies.preview(owner, { origin: 'cash', cash: { currency: 'USD', amount: 10000 }, requestKey: randomUUID() });
    const created = await policies.createAccount(owner, { name: 'Archive fixture', previewId: preview.id, requestKey: randomUUID() });
    const [other] = await db.insert(paperAccounts).values({ owner, name: 'Other running fixture', botEnabled: true }).returning();
    await db.insert(paperPositions).values({ owner, accountId: created.accountId, ticker: 'AAPL', shares: '2', avgCost: '100' });
    const [filled] = await db.insert(paperOrders).values({ owner, accountId: created.accountId, ticker: 'AAPL', side: 'buy', quantity: '2', status: 'filled' }).returning();
    await db.insert(paperTrades).values({ owner, accountId: created.accountId, orderId: filled.id, ticker: 'AAPL', side: 'buy', quantity: '2', price: '100', cashAfter: '9800' });
    const [pending] = await db.insert(paperOrders).values({ owner, accountId: created.accountId, ticker: 'AAPL', side: 'buy', quantity: '1', status: 'pending_approval' }).returning();
    const [reservation] = await db.insert(strategyReservations).values({ owner, accountId: created.accountId, signalId: randomUUID(), ticker: 'AAPL', side: 'buy', currency: 'USD', cash: '100', shares: '0', expiresAt: new Date(Date.now() + 60000) }).returning();
    const [profile] = await db.insert(builderProfiles).values({ owner, accountId: created.accountId, config: {}, status: 'active' }).returning();
    const [mandate] = await db.insert(strategyMandates).values({ owner, accountId: created.accountId, profileId: profile.id, profileVersion: 1, config: {} as never, status: 'published' }).returning();
    const documents = new ResearchDocumentsService(db);
    await documents.submit(owner, { idempotencyKey: randomUUID(), title: 'Saved archive evidence', kind: 'portfolio', content: 'Immutable fictional report', sections: [{ id: 'summary', title: 'Summary', content: 'Immutable fictional report' }] });
    const ledger = async () => ({ positions: await db.select().from(paperPositions), trades: await db.select().from(paperTrades), seeds: await db.select().from(simulationSeeds), cash: await db.select().from(simulationCash), valuations: await db.select().from(paperSnapshots), reports: await db.select().from(researchDocumentVersions) });
    const before = await ledger();
    const request = { expectedPolicyRevision: 1, requestKey: randomUUID() };
    await assert.rejects(workspace.archive(randomUUID(), created.accountId, request), /ACCOUNT_NOT_FOUND/);
    await assert.rejects(workspace.archive(owner, created.accountId, { ...request, expectedPolicyRevision: null }), /POLICY_REVISION_CHANGED/);
    await assert.rejects(workspace.archive(owner, created.accountId, { ...request, owner: 'foreign' }),
      (error: { getResponse(): { code: string }; getStatus(): number }) => error.getStatus() === 400 && error.getResponse().code === 'INVALID_WORKSPACE_REQUEST');
    await assert.rejects(workspace.archive(owner, created.accountId, { ...request, expectedPolicyRevision: 2 }), /POLICY_REVISION_CHANGED/);
    const archived = await workspace.archive(owner, created.accountId, request);
    assert.deepEqual(await workspace.archive(owner, created.accountId, request), archived);
    await assert.rejects(workspace.archive(owner, created.accountId, { ...request, expectedPolicyRevision: 2 }), /REQUEST_KEY_CONFLICT/);
    assert.equal(archived.status, 'archived');
    assert.equal(archived.policyRevision, 2);
    assert.equal((await db.select().from(paperOrders).where(eq(paperOrders.id, pending.id)))[0].status, 'cancelled');
    assert.equal((await db.select().from(strategyReservations).where(eq(strategyReservations.signalId, reservation.signalId)))[0].status, 'released');
    assert.equal((await db.select().from(builderProfiles).where(eq(builderProfiles.id, profile.id)))[0].status, 'paused');
    assert.equal((await db.select().from(strategyMandates).where(eq(strategyMandates.id, mandate.id)))[0].status, 'paused');
    assert.deepEqual((await db.select().from(paperOrders).where(eq(paperOrders.id, filled.id)))[0], filled);
    assert.deepEqual(await ledger(), before);
    assert.equal((await db.select().from(paperAccounts)).length, 2, 'archiving never creates another account');
    assert.deepEqual((await db.select().from(paperAccounts).where(eq(paperAccounts.id, other.id)))[0], other);
    const legacy = await workspace.archive(owner, other.id, { expectedPolicyRevision: null, requestKey: randomUUID() });
    assert.equal(legacy.policyRevision, null);
    assert.equal((await db.select().from(investmentPolicies)).length, 1, 'legacy archiving does not adopt or invent a policy');
    assert.equal((await workspace.list(owner)).every(account => account.status === 'archived'), true);
  });
});

test('a final execution waiting behind an uncommitted archive observes the archived fence', async () => {
  await investmentFixture(async (db, _sql, owner) => {
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: randomUUID() });
    const started = await startPreUserStrategyInvestmentFixture(policies, db, owner, { previewId: preview.id, requestKey: randomUUID() });
    let unlock!: () => void, acquired!: () => void, transaction = 0;
    const barrier = new Promise<void>(resolve => { unlock = resolve; });
    const lockHeld = new Promise<void>(resolve => { acquired = resolve; });
    const archiveDb = Object.create(db) as typeof db;
    archiveDb.transaction = async callback => db.transaction(async tx => {
      const result = await callback(tx);
      // The workspace's first transaction only commits independent constraint expiry.
      if (++transaction === 2) { acquired(); await barrier; }
      return result;
    });
    const workspace = new PortfolioWorkspaceService(archiveDb, policies, {} as never);
    const archive = workspace.archive(owner, started.accountId, { expectedPolicyRevision: 1, requestKey: randomUUID() });
    try {
      await Promise.race([lockHeld, archive.then(() => { throw new Error('Archive did not hold the expected final transaction'); })]);
      const pendingExecution = db.transaction(async tx => {
        await lockMemoryOwner(tx, owner);
        await tx.select().from(paperAccounts).where(eq(paperAccounts.id, started.accountId)).for('update');
        return investmentExecutionFence(tx, owner, started.accountId, { ticker: 'AAPL', market: 'US', side: 'sell' }, 'agent', {
          parentPolicyId: started.policy.id, parentPolicyRevision: 1, protectiveStop: true,
        } as never);
      });
      unlock(); await archive;
      assert.equal((await pendingExecution).block, 'INVESTMENT_ARCHIVED_ACCOUNT');
    } finally { unlock(); await archive; }
  });
});

test('archive and the existing final execution fence serialize execution-first and archive-first outcomes', async () => {
  await investmentFixture(async (db, _sql, owner) => {
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const workspace = new PortfolioWorkspaceService(db, policies, {} as never);
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: randomUUID() });
    const started = await startPreUserStrategyInvestmentFixture(policies, db, owner, { previewId: preview.id, requestKey: randomUUID() });
    let unlock!: () => void, acquired!: () => void;
    const barrier = new Promise<void>(resolve => { unlock = resolve; });
    const lockHeld = new Promise<void>(resolve => { acquired = resolve; });
    const candidate = { parentPolicyId: started.policy.id, parentPolicyRevision: 1, protectiveStop: true } as never;
    const first = db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      await tx.select().from(paperAccounts).where(eq(paperAccounts.id, started.accountId)).for('update');
      const result = await investmentExecutionFence(tx, owner, started.accountId, { ticker: 'AAPL', market: 'US', side: 'sell' }, 'agent', candidate);
      assert.equal(result.block, null); acquired(); await barrier;
    });
    await lockHeld;
    try {
      const archive = workspace.archive(owner, started.accountId, { expectedPolicyRevision: 1, requestKey: randomUUID() });
      unlock(); await first; await archive;
    } finally { unlock(); await first; }
    const after = await db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      await tx.select().from(paperAccounts).where(eq(paperAccounts.id, started.accountId)).for('update');
      return investmentExecutionFence(tx, owner, started.accountId, { ticker: 'AAPL', market: 'US', side: 'sell' }, 'agent', candidate);
    });
    assert.equal(after.block, 'INVESTMENT_ARCHIVED_ACCOUNT');
  });
});
