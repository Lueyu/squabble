import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, BookOpen, FileCheck2, FlaskConical } from 'lucide-react';
import type { CouncilReport, CouncilSession } from '@shared/council.interface';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { isCurrentCouncilReport } from '@/utils/council-state';
import { workflowCopy } from './workflow-copy';
import { threadCopy } from './thread-copy';
import { Button } from '@/components/ui/button';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { archiveCouncilReport, forkCouncilSession } from '@/api/council';
import { toast } from 'sonner';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';

import CouncilRevisionDialog from './CouncilRevisionDialog';
import CouncilContinuationDialog from './CouncilContinuationDialog';

function safeSourceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export default function CouncilReportCard({ report, session, profileVersion }: {
  report: CouncilReport; session: CouncilSession; profileVersion?: number;
}) {
  const { t, i18n } = useTranslation();
  const current = isCurrentCouncilReport(report, session, profileVersion);
  const copy = workflowCopy[i18n.language.startsWith('zh') ? 'zh-CN' : 'en'];
  const thread = threadCopy(i18n.language);
  const navigate = useNavigate();
  const queries = useQueryClient();
  const archive = useMutation({ mutationFn: () => archiveCouncilReport(session.id, report.id), retry: false,
    onSuccess: version => { void queries.invalidateQueries({ queryKey: ['council'] }); navigate(`/analysis/reports/${encodeURIComponent(version.id)}`); },
    onError: cause => toast.error(errorMessage(cause, t('council.actionFailed'))) });
  const [revisionParent, setRevisionParent] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  const branchPoint = session.messages.filter(message => message.role !== 'system' && message.revision <= report.revision).at(-1);
  return <Card id={`report-${report.id}-v${report.version}`} className={`min-w-0 ${current ? 'border-primary/30' : 'border-border'}`}>
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2 font-serif text-lg"><FileCheck2 className="size-5 text-primary" />
          {t('council.report.title', { version: report.version })}</CardTitle>
        <Badge variant={current ? 'default' : 'secondary'}>{t(current ? 'council.report.current' : 'council.report.obsolete')}</Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge variant="outline">{t(report.researchStance ? `council.report.stances.${report.researchStance}` : `council.report.decisions.${report.decision}`)}</Badge>
        <Badge variant="outline">{t(`council.report.engines.${report.engine}`)}</Badge>
        <span className="self-center text-xs text-muted-foreground">{new Date(report.createdAt).toLocaleString(i18n.language)}</span>
      </div>
    </CardHeader>
    <CardContent className="space-y-4">
      <p className="text-xs text-muted-foreground">{thread.summaryHint}</p>
      {branchPoint && report.publicationOutcome !== 'failed' && <Button size="sm" variant="outline" onClick={() => setContinuing(true)}>{i18n.language.startsWith('zh') ? '审阅总结并继续分支' : 'Review summary and continue in branch'}</Button>}
      {report.publicationOutcome !== 'failed' && <div className="flex flex-wrap gap-2">
        {current && session.resolvedReferences?.filter((ref, index, all) => all.findIndex(item => item.versionId === ref.versionId) === index).map(ref =>
          <Button key={ref.versionId} variant="outline" size="sm" disabled={session.scene === 'trade_pre_review' && (ref.status !== 'valid' || ref.sourceStatus !== 'available')}
            onClick={() => setRevisionParent(ref.versionId)}>{i18n.language.startsWith('zh') ? '修订引用报告' : 'Revise source report'} · v{ref.version}</Button>)}
        {report.researchVersionId ? <>
          <Button variant="outline" size="sm" asChild><Link to={`/analysis/reports/${encodeURIComponent(report.researchVersionId)}`}>{thread.open}</Link></Button>
          <Button size="sm" asChild><Link to={`/paper?sourceReportVersionId=${encodeURIComponent(report.researchVersionId)}&sourceSessionId=${encodeURIComponent(session.id)}&draft=1`}>{thread.draft}</Link></Button>
          <p className="w-full text-xs text-muted-foreground">{thread.generated}</p>
        </> : <Button size="sm" variant="outline" disabled={archive.isPending} onClick={() => archive.mutate()}>{thread.archive}</Button>}
      </div>}
      {report.coverage && <p className={`rounded-lg border p-3 text-sm ${report.coverage.complete ? 'border-border' : 'border-destructive/30 text-destructive'}`}>
        {report.coverage.complete ? copy.complete : copy.incomplete}</p>}
      {!current && <p className="rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground">{t('council.report.obsoleteHint')}</p>}
      <p className="whitespace-pre-wrap break-words text-sm leading-7">{report.summary}</p>
      {report.candidate && <div className="rounded-lg border border-border p-3 text-sm">
        <p className="font-semibold">{t('council.report.candidate')}</p>
        <p className="mt-2 font-mono">{report.candidate.ticker} · {t(`ui.builder.side.${report.candidate.side}`)}
          {' '}{report.candidate.quantity} × {report.candidate.price}</p>
        <p className="mt-2 break-words text-xs leading-5 text-muted-foreground">{report.candidate.reason}</p>
      </div>}
      {report.dissent.length > 0 && <div>
        <h4 className="text-sm font-semibold">{t('council.report.dissent')}</h4>
        <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
          {report.dissent.map((point: string, index: number) => <li className="break-words" key={index}>{point}</li>)}
        </ul>
      </div>}
      <div className="rounded-lg bg-primary/5 p-3">
        <h4 className="text-xs font-semibold text-primary">{t('council.report.nextReview')}</h4>
        <p className="mt-1 break-words text-sm leading-6">{report.nextReviewCondition || t('council.report.noCondition')}</p>
      </div>
      <details className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">{t('council.report.evidence', { count: report.evidence.length })}</summary>
        <div className="mt-3 space-y-3">
          {report.evidence.length === 0 && <p className="text-xs text-muted-foreground">{t('council.report.noEvidence')}</p>}
          {report.evidence.map((item) => {
            const url = safeSourceUrl(item.sourceUrl);
            return <div id={`evidence-${report.id}-${item.id}`} key={item.id} className="min-w-0 border-t border-border pt-3">
              <p className="break-words text-sm font-medium">[{item.id}] {item.title}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">{item.content}</p>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span>{new Date(item.fetchedAt).toLocaleString(i18n.language)}</span>
                {url && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                  {t('council.report.source')}<ArrowUpRight className="size-3" /></a>}
              </div>
            </div>;
          })}
        </div>
      </details>
      <p className="text-xs leading-5 text-muted-foreground">{t('council.report.frozenEvidence')}</p>
      <div className="flex flex-wrap gap-3 text-xs text-primary">
        {report.sourceRunId && <Link className="inline-flex items-center gap-1 hover:underline"
          to={`/analysis/deep-report/${encodeURIComponent(report.sourceRunId)}`}>
          <BookOpen className="size-3.5" />{t('council.report.sourceRun')}</Link>}
        {report.paperOrderId && <Link className="inline-flex items-center gap-1 hover:underline"
          to={`/paper?orderId=${encodeURIComponent(report.paperOrderId)}`}>
          <FlaskConical className="size-3.5" />{t('council.report.paperOrder')} · {report.paperOrderId.slice(0, 8)}</Link>}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{report.externalUsageUnknown ? t('council.report.externalUsageUnknown') : t(report.engine === 'local' || report.engine === 'a2a' || report.engine === 'mixed' ? 'council.report.externalReportedTokens' : 'council.report.tokens', {
        count: report.tokensUsed.toLocaleString(i18n.language),
      })}</p>
      <p className="text-xs leading-5 text-muted-foreground">{t(report.researchStance ? 'council.report.manualHint' : 'council.report.executionHint')}</p>
      {revisionParent && <CouncilRevisionDialog sessionId={session.id} reportId={report.id} parentVersionId={revisionParent} onClose={() => setRevisionParent(null)} />}
      {continuing && branchPoint && <CouncilContinuationDialog session={session} reportId={report.id} messageId={branchPoint.id} onClose={() => setContinuing(false)} onFork={input => forkCouncilSession(session.id, input)} />}
    </CardContent>
  </Card>;
}
