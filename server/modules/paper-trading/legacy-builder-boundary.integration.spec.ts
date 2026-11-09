import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { investmentFixture } from './investment-test.fixture';
import { AgentBuilderService } from './agent-builder.service';
import { builderProfiles, paperAccounts } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';

test('legacy profile pause rejects managed or ambiguous accounts before changing runtime state', async () => {
  await investmentFixture(async (db, _client, owner) => {
    const [a, b] = await db.insert(paperAccounts).values([
      { owner, name: 'A', botEnabled: true }, { owner, name: 'B', botEnabled: true },
    ]).returning();
    const [profile] = await db.insert(builderProfiles).values({ owner, accountId: a.id, status: 'active', config: {} as never }).returning();
    const builder = new AgentBuilderService(db, {} as never);
    await assert.rejects(builder.pauseProfile(owner, profile.id), /ACCOUNT_SELECTION_REQUIRED/);
    let [unchanged] = await db.select().from(builderProfiles).where(eq(builderProfiles.id, profile.id));
    assert.equal(unchanged.status, 'active');
    assert.equal(unchanged.version, profile.version);
    await db.update(paperAccounts).set({ isActive: false, botEnabled: false }).where(eq(paperAccounts.id, b.id));
    await db.insert(investmentPolicies).values({ owner, accountId: a.id, status: 'running', baseConfig: {} as never, effectiveConfig: {} as never });
    await assert.rejects(builder.pauseProfile(owner, profile.id), /INVESTMENT_MANAGED_ACCOUNT_USE_AI_INVESTMENT/);
    [unchanged] = await db.select().from(builderProfiles).where(eq(builderProfiles.id, profile.id));
    assert.equal(unchanged.status, 'active');
    assert.equal(unchanged.version, profile.version);
    const [account] = await db.select().from(paperAccounts).where(eq(paperAccounts.id, a.id));
    assert.equal(account.botEnabled, true);
  });
});
