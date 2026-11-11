import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { teamCommissions, teamDecisions, teamResearchLinks } from '../../database/teams.schema';
import { paperOrders, paperTrades } from '../../database/schema';
import { makeTeamFixture } from '../teams/team-test.fixture';
import { PortfolioAssetsService } from './portfolio-assets.service';

test('ledger projection returns exact historical team decisions after handover and never guesses missing or foreign provenance', async () => {
  const f = await makeTeamFixture();
  try {
    const original = await f.commission();
    const [commission] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, original.created.commissionId));
    const reportId = randomUUID();
    const basis = { teamVersionId: original.version.id, bindingId: original.binding.id,
      bindingRevision: original.binding.bindingRevision, commissionId: commission.id, sessionId: randomUUID(),
      cycleId: randomUUID(), workKey: commission.plan.work[0].workKey, acceptedAttemptId: randomUUID(),
      reportVersionId: reportId, thesisVersions: [{ thesisId: randomUUID(), versionId: randomUUID() }], sourceRefs: [] };
    const [decision] = await f.db.insert(teamDecisions).values({ ownerId: f.owner, teamId: original.team.id,
      accountId: original.account.id, commissionId: commission.id, proposalId: randomUUID(), proposalRevision: 2,
      event: 'adopt', actorType: 'user', actorId: f.owner, basis, reason: 'Original fixture investment judgment', requestKey: randomUUID() }).returning();
    const [order] = await f.db.insert(paperOrders).values({ owner: f.owner, accountId: original.account.id,
      ticker: 'FICT', side: 'buy', quantity: '1', status: 'filled' }).returning();
    const [legacy] = await f.db.insert(paperOrders).values({ owner: f.owner, accountId: original.account.id,
      ticker: 'FICT', side: 'buy', quantity: '1' }).returning();
    const [trade] = await f.db.insert(paperTrades).values({ owner: f.owner, accountId: original.account.id,
      orderId: order.id, ticker: 'FICT', side: 'buy', quantity: '1', price: '10', cashAfter: '990' }).returning();
    for (const [kind, targetId] of [['order', order.id], ['trade', trade.id]]) {
      await f.db.insert(teamResearchLinks).values({ ownerId: f.owner, teamId: original.team.id,
        commissionId: commission.id, kind, targetId, relation: 'executed', workKey: basis.workKey,
        attemptId: basis.acceptedAttemptId, metadata: { decisionId: decision.id, sourceKind: 'order', sourceId: order.id } });
    }
    const other = await f.commission();
    await f.db.insert(teamResearchLinks).values({ ownerId: f.owner, teamId: other.team.id,
      commissionId: other.created.commissionId, kind: 'order', targetId: legacy.id, relation: 'executed',
      metadata: { decisionId: decision.id } });
    await assert.rejects(f.db.insert(teamResearchLinks).values({ ownerId: f.stranger, teamId: original.team.id,
      commissionId: commission.id, kind: 'order', targetId: order.id, relation: 'used', metadata: { private: 'FOREIGN' } }),
    /Failed query/, 'The database also rejects cross-owner provenance');
    const replacement = await f.team('Replacement fixture');
    const preview = await f.versions.bindingPreview(f.owner, replacement.team.id, { requestKey: randomUUID(), action: 'assign',
      accountId: original.account.id, teamVersionId: replacement.version.id, expectedBindingRevision: 0,
      expectedAccountBindingId: original.binding.id, executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
    await f.versions.binding(f.owner, replacement.team.id, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
    const result = await new PortfolioAssetsService(f.db).read(f.owner, original.account.id);
    assert.equal(result.executionProvenance?.length, 2);
    for (const item of result.executionProvenance ?? []) {
      assert.equal(item.teamId, original.team.id);
      assert.equal(item.teamName, original.version.displaySnapshot.name);
      assert.equal(item.teamVersionId, original.version.id);
      assert.equal(item.teamVersion, 1);
      assert.equal(item.decision?.id, decision.id);
      assert.equal(item.decision?.reason, 'Original fixture investment judgment');
      assert.equal(item.decision?.basis.acceptedAttemptId, basis.acceptedAttemptId);
      assert.deepEqual(item.decision?.basis.thesisVersions, basis.thesisVersions);
      assert.equal(item.reportAvailability, 'unavailable', 'A missing report is shown honestly without replacing the pinned version');
    }
    assert.equal(result.executionProvenance?.some(item => item.targetId === legacy.id), false, 'Same ticker/time and another account commission cannot fabricate a relationship');
    assert.equal(JSON.stringify(result).includes('FOREIGN'), false);
    await assert.rejects(new PortfolioAssetsService(f.db).read(f.stranger, original.account.id), /ACCOUNT_NOT_FOUND/);
    assert.equal((await new PortfolioAssetsService(f.db).read(f.owner, other.account.id)).executionProvenance?.length, 0);
  } finally { await f.dispose(); }
});
