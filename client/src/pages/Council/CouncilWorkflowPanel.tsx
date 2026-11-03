import { useTranslation } from 'react-i18next';
import type { CouncilSession } from '@shared/council.interface';
import type { useCouncilActions } from '@/hooks/use-council';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';
import { workflowCopy } from './workflow-copy';
import CouncilMemoryInventory from './CouncilMemoryInventory';

export default function CouncilWorkflowPanel({ session, actions }: { session: CouncilSession; actions: ReturnType<typeof useCouncilActions> }) {
  const { i18n } = useTranslation();
  const copy = workflowCopy[i18n.language.startsWith('zh') ? 'zh-CN' : 'en'];
  const workflow = session.workflow;
  if (!workflow) return null;
  const tasks = workflow.tasks;
  const accepted = tasks.filter(t => t.state === 'accepted').length;
  return <details className="shrink-0 border-b border-border bg-muted/20 text-xs">
    <summary className="cursor-pointer px-4 py-3"><span className="ml-1 font-medium">{copy.overview} · {copy.goals[workflow.goal]}</span>
      <span className="ml-3 text-muted-foreground">{accepted}/{tasks.length} {copy.accepted}</span></summary>
    <div className="max-h-[min(16rem,28dvh)] space-y-3 overflow-y-auto border-t border-border px-4 py-3">
      {!!workflow.peers.length && <p>{copy.peers}: {workflow.peers.join(' · ')}</p>}
      {tasks.map(task => <article key={task.id} className="space-y-2 rounded-md border border-border bg-card p-3">
        <div className="flex flex-wrap justify-between gap-2"><strong>{copy.kinds[task.key]} · {session.members?.find(m => m.id === task.memberId)?.name}</strong>
          <span className={['failed', 'uncertain'].includes(task.state) ? 'text-destructive' : 'text-muted-foreground'}>{copy.states[task.state]}</span></div>
        {!!task.dependencies.length && <p className="text-muted-foreground">{copy.dependencies}: {task.dependencies.map(k => copy.kinds[k]).join(' · ')}</p>}
        {task.reason && <p className="whitespace-pre-wrap break-words leading-5">{task.reason}</p>}
        {!!task.skills.length && <p className="text-muted-foreground">{copy.skills}: {task.skills.map(s => `${s.id} v${s.version}`).join(' · ')}</p>}
        {!!task.attempts.length && <details><summary className="cursor-pointer text-muted-foreground">{task.attempts.length} {copy.history} · {copy.reworks}: {task.reworks}/1</summary>
          <ol className="mt-2 space-y-2">{task.attempts.map((attempt, index) => <li key={attempt.id} className="border-l-2 border-border pl-2 leading-5">
            {index + 1}. {attempt.kind === 'review' ? copy.reviewer : copy.kinds[task.key]} · {copy.states[attempt.state === 'succeeded' ? 'submitted' : attempt.state]}
            <time className="ml-2 text-muted-foreground">{new Date(attempt.startedAt).toLocaleTimeString(i18n.language)}</time>
            {attempt.review && <p>{attempt.review.accepted ? copy.states.accepted : copy.states.needs_revision}: {attempt.review.feedback}</p>}
            {attempt.error && <p className="break-words text-destructive">{attempt.error}</p>}
            <CouncilMemoryInventory inventory={attempt.memory} />
          </li>)}</ol></details>}
        {session.status !== 'running' && ['failed', 'blocked', 'cancelled', 'uncertain'].includes(task.state) && <div className="space-y-1">
          <Button size="sm" variant="outline" disabled={actions.retry.isPending} onClick={() => actions.retry.mutate({ id: session.id, taskId: task.id },
            { onError: error => toast.error(errorMessage(error, copy.states.failed)) })}>{copy.retry}</Button>
          <p className="text-muted-foreground leading-5">{copy.retryHint}</p></div>}
      </article>)}
    </div>
  </details>;
}
