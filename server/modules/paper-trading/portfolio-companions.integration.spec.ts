import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { paperAccounts } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { portfolioAccountCompanions } from '../../database/portfolio-workspace.schema';
import { DEFAULT_INVESTMENT_CONFIG } from './investment-policy.rules';
import { PortfolioWorkspaceService } from './portfolio-workspace.service';
import { investmentFixture } from './investment-test.fixture';

test('companion metadata is owner-scoped, retry-safe and independent of ledger and policy authority', async () => {
  await investmentFixture(async (db, sql, owner) => {
    await sql.unsafe(readFileSync('scripts/db/47_portfolio_companions.sql', 'utf8'));
    const [account] = await db.insert(paperAccounts).values({ owner, name: 'Fictional independent account' }).returning();
    const [other] = await db.insert(paperAccounts).values({ owner, name: 'Another account' }).returning();
    const [policy] = await db.insert(investmentPolicies).values({ owner, accountId: account.id, status: 'paused',
      baseConfig: DEFAULT_INVESTMENT_CONFIG, effectiveConfig: DEFAULT_INVESTMENT_CONFIG }).returning();
    const workspace = new PortfolioWorkspaceService(db, {} as never, {} as never);
    const request = { companionId: 'value', expectedRevision: 0, requestKey: randomUUID() };
    const saved = await workspace.setCompanion(owner, account.id, request);
    assert.deepEqual(await workspace.setCompanion(owner, account.id, request), saved);
    assert.equal(saved.companionRevision, 1);
    await assert.rejects(workspace.setCompanion(owner, account.id, { ...request, companionId: 'macro' }), /REQUEST_KEY_CONFLICT/);
    await assert.rejects(workspace.setCompanion(owner, account.id, { ...request, requestKey: randomUUID() }), /COMPANION_REVISION_CHANGED/);
    await assert.rejects(workspace.setCompanion(randomUUID(), account.id, request), /ACCOUNT_NOT_FOUND/);
    assert.deepEqual((await db.select().from(paperAccounts).where(eq(paperAccounts.id, account.id)))[0], account);
    assert.deepEqual((await db.select().from(investmentPolicies).where(eq(investmentPolicies.id, policy.id)))[0], policy);
    const accounts = await workspace.list(owner);
    assert.equal(accounts.find(item => item.id === account.id)?.companionId, 'value');
    assert.equal(accounts.find(item => item.id === other.id)?.companionId, null);
    const second = await workspace.setCompanion(owner, account.id, { companionId: 'macro', expectedRevision: 1, requestKey: randomUUID() });
    assert.equal(second.companionRevision, 2);
    await sql.unsafe(readFileSync('scripts/db/47_portfolio_companions.sql', 'utf8'));
    assert.equal((await db.select().from(portfolioAccountCompanions))[0].companionId, 'macro');
    await db.update(investmentPolicies).set({ status: 'archived' }).where(eq(investmentPolicies.id, policy.id));
    await assert.rejects(workspace.setCompanion(owner, account.id, { companionId: 'growth', expectedRevision: 2, requestKey: randomUUID() }), /ARCHIVED_ACCOUNT_READ_ONLY/);
    await db.update(paperAccounts).set({ isActive: false }).where(eq(paperAccounts.id, account.id));
    await assert.rejects(workspace.setCompanion(owner, account.id, { companionId: 'growth', expectedRevision: 2, requestKey: randomUUID() }), /ARCHIVED_ACCOUNT_READ_ONLY/);
    assert.deepEqual(await workspace.setCompanion(owner, account.id, request), saved, 'retry acknowledges the original receipt even after the account is archived');
  });
});
