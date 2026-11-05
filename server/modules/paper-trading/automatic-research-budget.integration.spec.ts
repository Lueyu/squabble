import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { investmentFixture } from './investment-test.fixture';
import { AutomaticResearchBudgetService } from './automatic-research-budget.service';
import { automaticResearchTasks } from '../../database/investment-policy.schema';

test('concurrent reports, discovery and followups share six durable tasks and twelve calls', async () => {
  await investmentFixture(async (db, _client, owner) => {
    const budget = new AutomaticResearchBudgetService(db);
    const claims = await Promise.all(Array.from({ length: 9 }, (_, i) => budget.claimAutomaticResearch(owner, null, 'shared-task-' + i, i % 2 ? 'followup' : 'portfolio')));
    assert.equal(claims.filter(c => c.claimed).length, 6);
    const accepted = claims.find(c => c.claimed)!;
    const results = await Promise.allSettled(Array.from({ length: 14 }, () => budget.reserveCall(owner, accepted.taskId!)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 12);
    const prior = await budget.claimAutomaticResearch(owner, null, 'shared-task-0', 'portfolio');
    assert.equal(prior.claimed, false);
    assert.equal((await db.select().from(automaticResearchTasks)).length, 6);
  });
});
