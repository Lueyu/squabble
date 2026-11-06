import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CircleAlert } from 'lucide-react';
import type { ResearchConversationView } from '@shared/simple-conversation.interface';
import type { RecoveryAction, ResearchMemberState } from '@shared/research-execution.interface';
import { Button } from '@/components/ui/button';

function failureLabel(state: ResearchMemberState, zh: boolean): string {
  if (state.resultAcceptance === 'rejected' || state.failure?.stage === 'parse') return zh ? '研究已返回，内容整理未完成。已有观点继续保留。' : 'Research returned; formatting is incomplete. Accepted views remain available.';
  const code = state.failure?.code || '';
  if (/model|config/iu.test(code)) return zh ? '模型配置需要修正。' : 'The model configuration needs attention.';
  if (/login|auth/iu.test(code)) return zh ? '登录状态需要更新。' : 'The connection needs an updated sign-in.';
  if (/busy|lock/iu.test(code)) return zh ? '正在等待另一项任务结束。' : 'Waiting for another task to release this connection.';
  if (state.status === 'unknown') return zh ? '正在确认原任务状态，尚未重新发送。' : 'The original task needs a status check before another attempt.';
  if (state.status === 'cancelled') return zh ? '这次研究已停止。' : 'This research attempt stopped.';
  return zh ? '这位股友未能完成本次研究，已完成的观点继续保留。' : 'This member could not finish. Accepted views remain available.';
}

export default function CouncilRecoveryCard({ session, onRecover, onOriginal, pending }: {
  session: ResearchConversationView; onRecover: (memberId: string, action: RecoveryAction) => void;
  onOriginal?: (memberId: string) => void; pending: boolean;
}) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  if (session.initializing) return null;
  const issues = session.memberStates?.filter(item => ['failed', 'unknown', 'cancelled'].includes(item.status) || item.resultAcceptance === 'rejected') || [];
  const missingConnection = session.mode === 'unavailable' && !session.actualExecutors?.length && !issues.length && !session.researchEvents?.length;
  if (!issues.length && !session.error && !session.unavailableMembers?.length && !missingConnection) return null;
  const labels: Record<RecoveryAction, string> = { reparse_existing: zh ? '重新整理已有结果' : 'Reformat saved result', retry_member: zh ? '只重试这位' : 'Retry this member',
    check_existing: zh ? '查询原任务状态' : 'Check original task', fix_configuration: zh ? '修复模型配置' : 'Fix model configuration' };
  return <section aria-label={zh ? '研究恢复' : 'Research recovery'} className="research-recovery rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4 text-sm">
    <div className="flex items-center gap-2"><CircleAlert className="size-4 shrink-0 text-amber-600" /><h2 className="font-semibold">{zh ? '有些研究需要处理' : 'Some research needs attention'}</h2></div>
    {issues.length ? <ul className="mt-3 space-y-4">{issues.map(item => <li key={item.memberId} className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
      <p><strong>{session.members?.find(member => member.id === item.memberId)?.name || item.memberId}</strong><span className="ml-2 text-muted-foreground">{failureLabel(item, zh)}</span></p>
      <div className="flex flex-wrap gap-2">{item.recoveries.map(action => <Button key={action} type="button" size="sm" variant="outline" className="h-auto whitespace-normal text-left" disabled={pending} onClick={() => onRecover(item.memberId, action)} aria-label={`${labels[action]} · ${session.members?.find(member => member.id === item.memberId)?.name || item.memberId}`}>{labels[action]}</Button>)}
        {item.resultAcceptance === 'rejected' && onOriginal && <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => onOriginal(item.memberId)}>{zh ? '查看原始研究文本' : 'View original research text'}</Button>}</div>
      {item.failure && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{zh ? '查看诊断' : 'Diagnostics'}</summary><dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt>{zh ? '阶段' : 'Stage'}</dt><dd>{item.failure.stage}</dd><dt>{zh ? '原因' : 'Code'}</dt><dd>{item.failure.code}</dd>
        {item.failure.fieldPath && <><dt>{zh ? '字段' : 'Field'}</dt><dd>{item.failure.fieldPath}</dd></>}
        {item.failure.expectedType && <><dt>{zh ? '需要格式' : 'Expected'}</dt><dd>{item.failure.expectedType}</dd></>}
        {item.failure.actualType && <><dt>{zh ? '收到格式' : 'Received'}</dt><dd>{item.failure.actualType}</dd></>}
      </dl></details>}
    </li>)}</ul> : <div className="mt-2 space-y-2 text-muted-foreground">
      <p>{missingConnection ? (zh ? '尚未连接 AI 股友。连接后可以继续这场讨论。' : 'No AI member is connected. Connect one to continue this discussion.') : (session.error || (zh ? '部分股友暂未参与。已完成的观点继续保留。' : 'Some members could not participate. Accepted views remain available.'))}</p>
      {session.unavailableMembers?.map(item => <p key={item.memberId}>{session.members?.find(member => member.id === item.memberId)?.name || item.memberId}: {item.reason}</p>)}
      {missingConnection && <Link className="inline-block text-primary underline" to="/settings/agents">{zh ? '连接 AI' : 'Connect AI'}</Link>}
    </div>}
  </section>;
}
