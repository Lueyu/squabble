import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { councilSessions } from '../../database/council.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { teams } from '../../database/teams.schema';
import { makeTeamFixture } from './team-test.fixture';

test('nullable team metadata preserves existing sessions and tasks in left-joined projections', async () => {
  const f = await makeTeamFixture();
  try {
    const team = await f.service.create(f.owner, { requestKey: randomUUID(), name: 'Fictional join fixture' });
    const [session] = await f.db.insert(councilSessions).values({ owner: f.owner, profileVersion: 1,
      profileSnapshot: {} as never, ticker: 'PORTFOLIO' }).returning();
    const [task] = await f.db.insert(councilResearchTasks).values({ owner: f.owner, sessionId: session.id,
      cycleId: randomUUID(), revision: 1, key: 'summary', position: 0, memberId: 'fixture', dependencies: [], skills: [] }).returning();
    const [joined] = await f.db.select({ session: councilSessions }).from(teams)
      .leftJoin(councilSessions, eq(councilSessions.owner, teams.ownerId)).where(eq(teams.id, team.id));
    assert.equal(joined.session?.id, session.id, 'A legacy session exists even when its teamCommissionId is null');
    assert.equal(joined.session?.teamCommissionId, null);
    const [work] = await f.db.select({ task: councilResearchTasks }).from(councilSessions)
      .leftJoin(councilResearchTasks, eq(councilResearchTasks.sessionId, councilSessions.id)).where(eq(councilSessions.id, session.id));
    assert.equal(work.task?.id, task.id, 'A legacy task exists even when its workKey is null');
    assert.equal(work.task?.workKey, null);
    const [missing] = await f.db.select({ session: councilSessions }).from(teams)
      .leftJoin(councilSessions, eq(councilSessions.id, randomUUID())).where(eq(teams.id, team.id));
    assert.equal(missing.session, null, 'A genuinely absent left join remains null');
  } finally { await f.dispose(); }
});
