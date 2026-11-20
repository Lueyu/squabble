import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { paperAccounts } from '../../database/schema';
import { teamAccountBindings, teams, teamVersions } from '../../database/teams.schema';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { makeTeamFixture } from '../teams/team-test.fixture';
import { InvestmentPolicyService } from './investment-policy.service';
import { PortfolioWorkspaceService } from './portfolio-workspace.service';
import { SimulationExperimentsService } from './simulation-experiments.service';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';

test('the account list labels only paused accounts whose latest owned binding and team are archived', {
  skip: !process.env.TEAM_TEST_DATABASE_URL,
}, async () => {
  const f = await makeTeamFixture();
  try {
    const strategies = new UserInvestmentStrategyService(f.db, new ResearchDocumentsService(f.db), {} as never);
    const simulations = new SimulationExperimentsService(f.db, {} as never, {} as never);
    const workspace = new PortfolioWorkspaceService(f.db, new InvestmentPolicyService(f.db, simulations, strategies), strategies);
    const independent = await f.account('Independent');
    const account = await f.account('Former team account');
    const first = await f.team('First team');
    const former = await f.team('Former team');
    const successor = await f.team('Successor');
    for (const archived of [first, former]) {
      await f.db.update(teams).set({ status: 'archived' }).where(eq(teams.id, archived.team.id));
    }

    const effectiveFrom = new Date('2026-11-10T08:00:00Z');
    const effectiveTo = new Date('2026-11-11T08:00:00Z');
    const binding = { ownerId: f.owner, accountId: account.id, bindingRevision: 1, state: 'archived',
      executionChoice: 'pause_all', effectiveFrom, effectiveTo, createdAt: effectiveFrom };
    const formerBindingId = '00000000-0000-4000-8000-000000000002';
    await f.db.insert(teamAccountBindings).values([
      { ...binding, id: formerBindingId, teamId: former.team.id, teamVersionId: former.version.id },
      { ...binding, id: '00000000-0000-4000-8000-000000000001', teamId: first.team.id, teamVersionId: first.version.id },
    ]);
    const [foreign] = await f.db.insert(teams).values({ ownerId: f.stranger, status: 'archived', name: 'Foreign team',
      display: former.team.display, layout: former.team.layout }).returning();
    const [foreignVersion] = await f.db.insert(teamVersions).values({ ...former.version, id: undefined, teamId: foreign.id,
      ownerId: f.stranger, createdBy: f.stranger, createdAt: effectiveFrom }).returning();
    await f.db.insert(teamAccountBindings).values({ ...binding, ownerId: f.stranger, teamId: foreign.id, teamVersionId: foreignVersion.id,
      effectiveFrom: effectiveTo });

    const formerTeam = { id: former.team.id, name: former.team.name };
    const expectAccount = async (status: 'paused' | 'running' | 'archived', expectedTeam?: typeof formerTeam) => {
      const list = await workspace.list(f.owner);
      assert.equal(list.length, 2);
      const selected = list.find(row => row.id === account.id);
      assert.ok(selected);
      assert.equal(selected.status, status);
      if (expectedTeam) assert.deepEqual(selected.formerTeam, expectedTeam);
      else assert.equal(Object.hasOwn(selected, 'formerTeam'), false);
      assert.equal(Object.hasOwn(list.find(row => row.id === independent.id)!, 'formerTeam'), false);
    };
    await expectAccount('paused', formerTeam);
    assert.equal(Object.hasOwn(await workspace.detail(f.owner, account.id), 'formerTeam'), false);
    await f.db.update(investmentPolicies).set({ status: 'running' }).where(eq(investmentPolicies.accountId, account.id));
    await expectAccount('running');
    await f.db.update(investmentPolicies).set({ status: 'archived' }).where(eq(investmentPolicies.accountId, account.id));
    await expectAccount('archived');
    await f.db.update(investmentPolicies).set({ status: 'paused' }).where(eq(investmentPolicies.accountId, account.id));
    await f.db.update(paperAccounts).set({ isActive: false }).where(eq(paperAccounts.id, account.id));
    await expectAccount('archived');
    await f.db.update(paperAccounts).set({ isActive: true }).where(eq(paperAccounts.id, account.id));

    const [newer] = await f.db.insert(teamAccountBindings).values({ ...binding, teamId: successor.team.id,
      teamVersionId: successor.version.id, effectiveFrom: effectiveTo }).returning();
    await expectAccount('paused');
    await f.db.update(teamAccountBindings).set({ state: 'active', effectiveFrom, effectiveTo: null }).where(eq(teamAccountBindings.id, newer.id));
    await expectAccount('paused');
    await f.db.update(teamAccountBindings).set({ state: 'released', effectiveFrom: effectiveTo, effectiveTo }).where(eq(teamAccountBindings.id, newer.id));
    await f.db.update(teams).set({ status: 'archived' }).where(eq(teams.id, successor.team.id));
    await expectAccount('paused');
  } finally {
    await f.dispose();
  }
});
