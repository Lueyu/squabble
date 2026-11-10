import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { builderProfiles, paperAccounts } from '../../database/schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { investmentFixture } from './investment-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { PortfolioWorkspaceService } from './portfolio-workspace.service';

test('unmanaged legacy accounts expose actual automation and pause only the explicitly selected account', async () => {
  await investmentFixture(async (db, _client, owner) => {
    const [a, b] = await db.insert(paperAccounts).values([
      { owner, name: 'Legacy A', botEnabled: true }, { owner, name: 'Legacy B', botEnabled: true },
    ]).returning();
    const [profileA, profileB] = await db.insert(builderProfiles).values([
      { owner, accountId: a.id, config: {}, status: 'active' }, { owner, accountId: b.id, config: {}, status: 'active' },
    ]).returning();
    const policies = new InvestmentPolicyService(db, {} as never);
    const workspace = new PortfolioWorkspaceService(db, policies, {} as never);
    assert.ok((await workspace.list(owner)).every(item => item.status === 'running' && item.policyRevision === null));
    const request = { requestKey: randomUUID() };
    const paused = await policies.pauseLegacy(owner, a.id, request);
    assert.deepEqual(await policies.pauseLegacy(owner, a.id, request), paused);
    assert.equal((await workspace.list(owner)).find(item => item.id === a.id)?.status, 'paused');
    assert.equal((await workspace.list(owner)).find(item => item.id === b.id)?.status, 'running');
    const profiles = await db.select().from(builderProfiles).where(eq(builderProfiles.owner, owner));
    assert.equal(profiles.find(p => p.id === profileA.id)?.status, 'paused');
    assert.equal(profiles.find(p => p.id === profileB.id)?.status, 'active');
    await assert.rejects(policies.pauseLegacy(randomUUID(), b.id, { requestKey: randomUUID() }), /not found/i);
  });
});

test('migration45 binds profiles only to an unambiguous active owned account with the current profile version', async () => {
  await investmentFixture(async (db, client, owner) => {
    const stranger = randomUUID();
    const [a, archived, staleAccount, foreignAccount, ambiguousA, ambiguousB] = await db.insert(paperAccounts).values([
      { owner, name: 'Current A' }, { owner, name: 'Historical', isActive: false },
      { owner, name: 'Stale version' }, { owner: stranger, name: 'Foreign' },
      { owner, name: 'Ambiguous A' }, { owner, name: 'Ambiguous B' },
    ]).returning();
    const [matching, stale, foreign, ambiguous] = await db.insert(builderProfiles).values([
      { owner, config: {}, version: 2 }, { owner, config: {}, version: 3 },
      { owner, config: {}, version: 1 }, { owner, config: {}, version: 1 },
    ]).returning();
    await db.insert(strategyMandates).values([
      { owner, accountId: archived.id, profileId: matching.id, profileVersion: 2, status: 'published', config: {} as never },
      { owner, accountId: a.id, profileId: matching.id, profileVersion: 2, status: 'published', config: {} as never },
      { owner, accountId: staleAccount.id, profileId: stale.id, profileVersion: 2, status: 'published', config: {} as never },
      { owner: stranger, accountId: foreignAccount.id, profileId: foreign.id, profileVersion: 1, status: 'published', config: {} as never },
      { owner, accountId: ambiguousA.id, profileId: ambiguous.id, profileVersion: 1, status: 'published', config: {} as never },
      { owner, accountId: ambiguousB.id, profileId: ambiguous.id, profileVersion: 1, status: 'published', config: {} as never },
    ]);
    await client.unsafe(readFileSync('scripts/db/45_portfolio_workspace.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/45_portfolio_workspace.sql', 'utf8'));
    const rows = await db.select().from(builderProfiles).where(eq(builderProfiles.owner, owner));
    assert.equal(rows.find(p => p.id === matching.id)?.accountId, a.id);
    assert.equal(rows.find(p => p.id === stale.id)?.accountId, null);
    assert.equal(rows.find(p => p.id === foreign.id)?.accountId, null);
    assert.equal(rows.find(p => p.id === ambiguous.id)?.accountId, null);
  });
});
