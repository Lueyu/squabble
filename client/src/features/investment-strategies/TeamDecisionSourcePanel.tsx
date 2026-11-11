import { Link } from 'react-router-dom';
import type { TeamDecisionRef } from '@shared/team-workspace.interface';
import { Button } from '@/components/ui/button';
import type { AccountCombinationEditorState } from './use-account-strategy-combination';

export function TeamDecisionRefList({ refs, zh }: { refs: TeamDecisionRef[]; zh: boolean }) {
  return <ul className="space-y-2 text-sm">{refs.map(ref => <li key={`${ref.proposalId}:${ref.proposalRevision}:${ref.decisionId}`} className="break-words">
    <span className="font-medium">{zh ? '提案' : 'Proposal'} {ref.proposalId} · {zh ? '修订' : 'revision'} {ref.proposalRevision}</span>
    <p className="mt-1 text-xs text-muted-foreground">{zh ? '采用决定' : 'Adoption decision'} {ref.decisionId}</p>
  </li>)}</ul>;
}

export function TeamDecisionSourcePanel({ editor }: { editor: AccountCombinationEditorState }) {
  const { zh, teamDecisionRefs, decisionContext, decisionSource, teamSourceBlocked } = editor;
  if (!teamDecisionRefs.length && !decisionContext.invalid) return null;
  const decision = decisionSource.data;
  return <section className="space-y-3 rounded-xl border bg-muted/25 p-5" aria-label={zh ? '团队采用来源' : 'Adopted team source'}>
    <h2 className="font-semibold">{zh ? '固定团队研究来源' : 'Pinned team research source'}</h2>
    <TeamDecisionRefList refs={teamDecisionRefs} zh={zh} />
    {decisionContext.invalid ? <p role="alert" className="text-sm text-destructive">{zh ? '来源链接不完整或修订无效，不能保存、预览或应用。请回团队重新打开精确决定。' : 'The source link is incomplete or its revision is invalid. Saving, previewing and applying are blocked. Reopen the exact decision from its team.'}</p>
      : decisionContext.ref && decisionSource.isPending ? <p role="status" className="text-sm text-muted-foreground">{zh ? '正在核对原账户与精确采用版本…' : 'Checking the original account and exact adopted revision…'}</p>
      : teamSourceBlocked ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{zh ? '无法核实此账户的精确采用来源。原引用已保留，不能替换为其他版本或直接应用。' : 'The exact adopted source could not be verified for this account. Its reference is retained; no other revision can replace it or authorize an apply.'}</p><Button size="sm" variant="outline" onClick={() => void decisionSource.refetch()}>{zh ? '重试读取来源' : 'Retry source read'}</Button></div>
      : decision && <div className="space-y-2 text-xs text-muted-foreground"><p className="break-words">{zh ? '团队版本' : 'Team version'} {decision.basis.teamVersionId} · {zh ? '研究委托' : 'Commission'} {decision.basis.commissionId}</p>{decision.basis.reportVersionId && <p className="break-words">{zh ? '报告版本' : 'Report version'} {decision.basis.reportVersionId}</p>}{decision.reason && <p className="break-words">{decision.reason}</p>}</div>}
    {!decisionContext.ref && <p className="text-xs text-muted-foreground">{zh ? '以上为已保存的来源引用，服务端将在预览与应用时重新核验权限、版本和账户。' : 'These saved source references will be revalidated for authority, revision and account during preview and apply.'}</p>}
    <p className="text-sm text-muted-foreground">{zh ? '采用仅固定研究来源。策略组合仍需保存草稿、核对预览并明确应用；不代表已生效或成交。' : 'Adoption pins research provenance. The combination will still require an explicit review and apply; this is not an active policy or a fill.'}</p>
    {decisionContext.teamId && <Button asChild size="sm" variant="ghost"><Link to={`/teams/${encodeURIComponent(decisionContext.teamId)}?proposalId=${encodeURIComponent(decisionContext.ref?.proposalId ?? '')}`}>{zh ? '查看来源团队与决定' : 'View source team and decision'}</Link></Button>}
  </section>;
}
