import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PortfolioExecutionProvenance } from '@shared/portfolio-workspace.interface';

/** The account's current team is deliberately absent: these are immutable execution links. */
export function ExecutionProvenance({ entries }: { entries?: PortfolioExecutionProvenance[] }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  if (!entries) return <p className="mt-3 text-xs text-muted-foreground">{zh ? '此服务未返回历史判断关联，当前无法确认。' : 'This server did not return historical judgment links; their presence is unknown.'}</p>;
  if (!entries.length) return <p className="mt-3 text-xs text-muted-foreground">{zh ? '未记录当时团队判断关联。' : 'Historical judgment not recorded.'}</p>;
  return <div className="mt-3 space-y-3 border-t pt-3">{entries.map(item => {
    const params = new URLSearchParams({ panel: 'history', commissionId: item.commissionId });
    if (item.decision) { params.set('proposalId', item.decision.proposalId); params.set('decisionId', item.decision.id); }
    const path = `/teams/${encodeURIComponent(item.teamId)}?${params}`;
    return <section key={`${item.commissionId}:${item.targetId}:${item.decision?.id ?? item.workKey}`} className="space-y-2 break-words text-sm">
      <p className="font-medium">{zh ? '当时团队与判断' : 'Team and judgment at execution'} · {item.teamName ?? (zh ? '团队名称未记录' : 'Team name not recorded')} · {item.teamVersion === null ? item.teamVersionId : `v${item.teamVersion}`}</p>
      {item.decision ? <><p>{item.decision.reason}</p><p className="text-xs text-muted-foreground">{zh ? '原决策记录时间' : 'Original decision recorded'} {item.decision.createdAt} · {zh ? '提案修订' : 'Proposal revision'} {item.decision.proposalRevision}</p></>
        : <p className="text-muted-foreground">{zh ? '原决定记录不可用，保留已有执行关联。' : 'Original decision unavailable; the saved execution link is retained.'}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-2"><Link className="text-primary underline" to={path}>{zh ? '查看确切团队交付与决定' : 'Open exact team delivery and decision'}</Link>
        {item.reportAvailability === 'available' && item.decision?.basis.reportVersionId && <Link className="text-primary underline" to={`/analysis/reports/${encodeURIComponent(item.decision.basis.reportVersionId)}`}>{zh ? '当时报告版本' : 'Report version at the time'}</Link>}
        {item.reportAvailability === 'unavailable' && <span className="text-muted-foreground">{zh ? '当时报告来源不可用' : 'Original report source unavailable'}</span>}
        {item.reportAvailability === 'not_recorded' && <span className="text-muted-foreground">{zh ? '未记录报告版本关联' : 'Report version not recorded'}</span>}
      </div>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{zh ? '原工作、尝试与论点版本' : 'Original work, attempt and thesis versions'}</summary><dl className="mt-2 space-y-1">
        <div><dt>{zh ? '工作项' : 'Work item'}</dt><dd>{item.workKey ?? '—'}</dd></div><div><dt>{zh ? '接受的尝试' : 'Accepted attempt'}</dt><dd>{item.attemptId ?? '—'}</dd></div>
        {item.decision?.basis.thesisVersions.map(thesis => <div key={thesis.versionId}><dt>{zh ? '固定论点版本' : 'Pinned thesis version'}</dt><dd>{thesis.thesisId} · {thesis.versionId}</dd></div>)}
        {!item.decision?.basis.thesisVersions.length && <p>{zh ? '未记录论点版本关联' : 'Thesis version not recorded'}</p>}
      </dl></details>
    </section>;
  })}</div>;
}
