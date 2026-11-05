import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { investmentFixture } from './investment-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { investmentExecutionFence } from './investment-policy.fence';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { paperAccounts } from '../../database/schema';

test('pause-first and execution-first owner/account fences serialize both legal outcomes', async () => {
  await investmentFixture(async (db, _client, owner) => {
    const service = new InvestmentPolicyService(db, new SimulationExperimentsService(db, {} as never, {} as never));
    const preview = await service.preview(owner, { origin: 'cash', cash: { amount: 10000, currency: 'USD' }, requestKey: 'race-preview-one' });
    const start = await service.start(owner, { previewId: preview.id, requestKey: 'race-start-one' });
    let unlock!: () => void; let locked!: () => void;
    const barrier = new Promise<void>(r => { unlock = r; }); const acquired = new Promise<void>(r => { locked = r; });
    const first = db.transaction(async tx => {
      await lockMemoryOwner(tx, owner); await tx.select().from(paperAccounts).where(eq(paperAccounts.id, start.accountId)).for('update');
      const result = await investmentExecutionFence(tx, owner, start.accountId, { ticker: 'AAPL', market: 'US', side: 'sell' }, 'agent', {
        parentPolicyId: start.policy.id, parentPolicyRevision: 1, protectiveStop: true,
      } as never);
      assert.equal(result.block, null); locked(); await barrier;
    });
    await acquired;
    const paused = service.pause(owner, { expectedRevision: 1, requestKey: 'race-pause-one' });
    unlock(); await first; await paused;
    const after = await db.transaction(async tx => {
      await lockMemoryOwner(tx, owner); await tx.select().from(paperAccounts).where(eq(paperAccounts.id, start.accountId)).for('update');
      return investmentExecutionFence(tx, owner, start.accountId, { ticker: 'AAPL', market: 'US', side: 'sell' }, 'agent', { parentPolicyId: start.policy.id, parentPolicyRevision: 1, protectiveStop: true } as never);
    });
    assert.equal(after.block, 'INVESTMENT_PAUSED');
  });
});
