import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import type { CouncilReport } from '../../../shared/council.interface';
import type { ThesisContent } from '../../../shared/research-memory.interface';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { thesisFingerprint } from './research-memory.theses';

/** Resolve workflow authority from owner-scoped persisted work, never from an archive request. */
export async function acceptedWorkflowProvenance(db: PostgresJsDatabase, owner: string, sessionId: string,
  report: Pick<CouncilReport, 'revision' | 'coverage' | 'thesisCandidates'>): Promise<NonNullable<ThesisContent['provenance']>['workflow']> {
  const coverage = report.coverage;
  if (!coverage || coverage.revision !== report.revision || !report.thesisCandidates?.length) return;
  const tasks = await db.select().from(councilResearchTasks).where(and(eq(councilResearchTasks.owner, owner),
    eq(councilResearchTasks.sessionId, sessionId), eq(councilResearchTasks.cycleId, coverage.cycleId)));
  if (!tasks.length || tasks.length !== coverage.tasks.length || tasks.some(task => task.state !== 'accepted'
    || task.revision !== report.revision || !task.delivery
    || !coverage.tasks.some(ref => ref.id === task.id && ref.key === task.key && ref.state === 'accepted'
      && ref.acceptedAttemptId === task.acceptedAttemptId)
    || !task.attempts.some(attempt => attempt.id === task.acceptedAttemptId && attempt.kind === 'work'
      && attempt.state === 'succeeded' && attempt.delivery))) return;
  const summary = tasks.find(task => task.key === 'summary');
  const candidates = summary?.delivery?.thesisCandidates;
  const accepted = summary?.attempts.find(attempt => attempt.id === summary.acceptedAttemptId)?.delivery?.thesisCandidates;
  if (!summary?.acceptedAttemptId || !candidates || !accepted || candidates.length !== report.thesisCandidates.length
    || accepted.length !== candidates.length || candidates.some((candidate, index) => thesisFingerprint(candidate)
      !== thesisFingerprint(report.thesisCandidates![index]) || thesisFingerprint(candidate) !== thesisFingerprint(accepted[index]))) return;
  return { cycleId: summary.cycleId, taskId: summary.id, attemptId: summary.acceptedAttemptId };
}
