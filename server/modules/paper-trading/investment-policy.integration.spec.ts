import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { InvestmentPolicyService } from './investment-policy.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { investmentPolicies, investmentCycles } from '../../database/investment-policy.schema';
import { paperAccounts } from '../../database/schema';
import { investmentFixture, startPreUserStrategyInvestmentFixture } from './investment-test.fixture';
import { investmentExecutionFence } from './investment-policy.fence';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
test('cash start is atomic and idempotent; pause/resume invalidates old work and preserves ledger', async () => {
  await investmentFixture(async (db, _client, owner) => {
    const simulations = new SimulationExperimentsService(db, {} as never, { convert: async (amount: number) => amount } as never);
    const policies = new InvestmentPolicyService(db, simulations);
    const before = await policies.overview(owner);
    assert.equal(before.status, 'not_started');
    assert.equal((await db.select().from(paperAccounts)).length, 0, 'read never opens account');
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'preview-cash-one' });
    const request = { previewId: preview.id, requestKey: 'start-cash-once', markets: ['US'] };
    const [a, b] = await Promise.all([policies.start(owner, request), policies.start(owner, request)]);
    assert.equal(a.policy.id, b.policy.id);
    assert.equal((await db.select().from(paperAccounts)).length, 1);
    assert.equal((await db.select().from(investmentCycles)).length, 0);
    await assert.rejects(policies.start(owner, { ...request, markets: ['HK'] }), /REQUEST_KEY_CONFLICT/);
    const paused = await policies.pause(owner, { expectedRevision: 1, requestKey: 'pause-account-one' });
    assert.equal(paused.policy.status, 'paused');
    assert.equal((await db.select().from(paperAccounts))[0].botEnabled, false);
    await assert.rejects(policies.resume(owner, { expectedRevision: 2, requestKey: 'resume-account-one' }), /CONFIRMED_USER_STRATEGY_REQUIRED/);
    assert.equal((await db.select().from(investmentCycles)).filter(c => c.state === 'queued').length, 0);
    await assert.rejects(policies.pause(randomUUID(), { expectedRevision: 3, requestKey: 'pause-cross-owner' }), /not found|NOT_STARTED/);
    assert.equal((await db.select().from(investmentPolicies).where(eq(investmentPolicies.owner, owner)))[0].revision, 2);
  });
});

test('temporary cash floor expires once under the execution lock and old candidates stay invalid', async t => {
  await investmentFixture(async (db, _client, owner) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T15:00:00Z') });
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'expiry-preview' });
    const start = await startPreUserStrategyInvestmentFixture(policies, db, owner, { previewId: preview.id, requestKey: 'expiry-start' });
    const permanent = await policies.propose(owner, { text: 'Keep cash at 20%', requestKey: 'expiry-permanent', constraint: { kind: 'cash_floor', percent: 20, expiresAt: null } });
    await policies.confirm(owner, permanent.id, { expectedPolicyRevision: 1, requestKey: 'expiry-perm-confirm' });
    const temporary = await policies.propose(owner, { text: 'Keep cash at 40% temporarily', requestKey: 'expiry-temporary', constraint: { kind: 'cash_floor', percent: 40, expiresAt: '2026-11-06T15:01:00Z' } });
    await policies.confirm(owner, temporary.id, { expectedPolicyRevision: 2, requestKey: 'expiry-temp-confirm' });
    t.mock.timers.tick(61000);
    const evaluate = () => db.transaction(async tx => {
      await lockMemoryOwner(tx, owner); await tx.select().from(paperAccounts).where(eq(paperAccounts.id, start.accountId)).for('update');
      return investmentExecutionFence(tx, owner, start.accountId, { ticker: 'ABC', market: 'US', side: 'sell' }, 'agent', { parentPolicyId: start.policy.id, parentPolicyRevision: 3, protectiveStop: true } as never);
    });
    const [first, second] = await Promise.all([evaluate(), evaluate()]);
    assert.equal(first.block, 'INVESTMENT_AUTHORIZATION_CHANGED'); assert.equal(second.block, 'INVESTMENT_AUTHORIZATION_CHANGED');
    const [saved] = await db.select().from(investmentPolicies);
    assert.equal(saved.revision, 4); assert.equal(saved.effectiveConfig.limits.minCashPct, 20);
    assert.equal(saved.constraintRecords.filter(c => c.status === 'expired').length, 1);
    assert.ok((await db.select().from(investmentCycles)).every(c => c.policyRevision === 4 || c.state === 'cancelled'));
  });
});

test('confirmed no_sell blocks protective exits and unknown future model output cannot revive a paused revision', async () => {
  await investmentFixture(async (db, _client, owner) => {
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'nosell-preview' });
    const start = await startPreUserStrategyInvestmentFixture(policies, db, owner, { previewId: preview.id, requestKey: 'nosell-start' });
    const proposal = await policies.propose(owner, { text: 'Do not sell ABC', requestKey: 'nosell-propose', constraint: { kind: 'no_sell', ticker: 'abc', expiresAt: null } });
    await policies.confirm(owner, proposal.id, { expectedPolicyRevision: 1, requestKey: 'nosell-confirm' });
    const blocked = await db.transaction(async tx => {
      await lockMemoryOwner(tx, owner); await tx.select().from(paperAccounts).where(eq(paperAccounts.id, start.accountId)).for('update');
      return investmentExecutionFence(tx, owner, start.accountId, { ticker: 'ABC', market: 'US', side: 'sell' }, 'agent', { parentPolicyId: start.policy.id, parentPolicyRevision: 2, protectiveStop: true } as never);
    });
    assert.equal(blocked.block, 'INVESTMENT_NO_SELL_INCLUDES_PROTECTION');
    await policies.pause(owner, { expectedRevision: 2, requestKey: 'nosell-pause' });
    const [saved] = await db.select().from(investmentPolicies); assert.equal(saved.revision, 3); assert.equal(saved.status, 'paused');
  });
});

test('constraints require confirmation, forbid protective sales, expire and revoke idempotently', async () => {
  await investmentFixture(async (db, _client, owner) => {
    const policies = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, { convert: async (n: number) => n } as never));
    const preview = await policies.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'preview-constraint' });
    await policies.start(owner, { previewId: preview.id, requestKey: 'start-constraint' });
    const proposal = await policies.propose(owner, { text: 'Do not sell AAPL', requestKey: 'propose-no-sell', constraint: { kind: 'no_sell', ticker: 'AAPL', expiresAt: null } });
    assert.deepEqual((await policies.overview(owner)).policy!.effectiveConfig.noSell, []);
    assert.match(proposal.impact, /protective|止损/);
    const applied = await policies.confirm(owner, proposal.id, { expectedPolicyRevision: 1, requestKey: 'confirm-no-sell' });
    assert.deepEqual(applied.policy.effectiveConfig.noSell, ['AAPL']);
    const repeat = await policies.confirm(owner, proposal.id, { expectedPolicyRevision: 1, requestKey: 'confirm-no-sell' });
    assert.equal(repeat.policy.revision, 2);
    const revoked = await policies.revoke(owner, proposal.id, { expectedPolicyRevision: 2, requestKey: 'revoke-no-sell' });
    assert.deepEqual(revoked.policy.effectiveConfig.noSell, []);
    assert.equal((await policies.revoke(owner, proposal.id, { expectedPolicyRevision: 2, requestKey: 'revoke-no-sell' })).policy.revision, 3);
  });
});
