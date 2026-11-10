import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useTelemetryRun } from './use-telemetry';
import { CoverageNotes, IntegrationStatus, RunStatus, TelemetryError, TelemetryLoading, TelemetryMetric, TelemetryPanel } from './TelemetryPrimitives';
import { formatAmount, formatCost, formatDuration, formatTime, updateTelemetryParams } from './telemetry-state';
import { sceneLabel } from './telemetry-copy';
import TelemetryTimeline from './TelemetryTimeline';
import TelemetryFeedback from './TelemetryFeedback';
import './telemetry.css';

export default function TelemetryRunPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const { i18n } = useTranslation();
  const zh: boolean = i18n.language.startsWith('zh');
  const query = useTelemetryRun(id);
  const back: string = `/telemetry?${updateTelemetryParams(params, { view: 'runs' }, false).toString()}`;
  const data = query.data;
  const accepted = data?.run.accepted;
  return <section className="telemetry-workspace telemetry-detail" aria-label={zh ? '执行详情' : 'Run detail'}>
    <header className="telemetry-page-heading"><div><h1>{zh ? '执行详情' : 'Run detail'}</h1><p className="telemetry-muted">{zh ? '每个步骤的状态、耗时与研究产物。' : 'The status, duration and outputs of each recorded step.'}</p></div>
      <Button asChild variant="outline"><Link to={back}><ArrowLeft size={14} />{zh ? '返回运行记录' : 'Back to runs'}</Link></Button></header>
    {query.isPending && <TelemetryLoading />}
    {query.isError && !data && <TelemetryError detail retry={() => void query.refetch()} />}
    {data && <>
      {query.isError && <p className="telemetry-banner" role="alert">{zh ? '更新暂时失败，当前展示上次成功读取的记录。' : 'Refresh failed. The last successfully loaded record is shown.'}</p>}
      <Card className="telemetry-run-heading"><div><h2>{data.run.title || data.run.id}</h2><p className="telemetry-muted"><span className="telemetry-mono">{data.run.id}</span> · {formatTime(data.run.startedAt, i18n.language)} · {sceneLabel(data.run.scene, zh)}</p></div>
        <div className="telemetry-run-badges"><RunStatus status={data.run.status} />
          {data.spans.some(span => span.attempt > 1) && <span className="telemetry-amber">{zh ? '含重试' : 'Includes retries'}</span>}
          {data.run.eventsTruncated && <span className="telemetry-amber">{zh ? '事件不完整' : 'Partial events'}</span>}</div></Card>
      <dl className="telemetry-metrics" data-ai-section-type="card-stat">
        <TelemetryMetric label={zh ? '端到端耗时' : 'Wall duration'} value={formatDuration(data.run.durationMs)} note={data.run.durationMs === null ? (zh ? '运行未结束或没有保存耗时' : 'Unfinished or duration not recorded') : (zh ? '并行步骤不重复相加' : 'Parallel steps are not added together')} />
        <TelemetryMetric label={zh ? '模型消耗' : 'Model usage'} value={formatAmount(data.run.totalTokens, true)}
          note={`${zh ? '输入' : 'Input'} ${formatAmount(data.run.inputTokens, true)} / ${zh ? '输出' : 'output'} ${formatAmount(data.run.outputTokens, true)}`} />
        <TelemetryMetric label={zh ? '估算费用' : 'Estimated cost'} value={formatCost(data.run.estimatedCostUsd)} note={zh ? '含已记录失败与重试 · 非供应商账单' : 'Includes recorded failures/retries · not an invoice'} />
        <TelemetryMetric label={zh ? '交付状态' : 'Delivery status'} value={accepted === null || accepted === undefined ? (zh ? '未知' : 'Unknown') : accepted ? (zh ? '已接受' : 'Accepted') : (zh ? '未接受' : 'Not accepted')}
          note={data.run.adopted === null ? (zh ? '报告采纳未知' : 'Report adoption unknown') : data.run.adopted ? (zh ? '报告当前已采纳' : 'Report currently adopted') : (zh ? '报告当前未采纳' : 'Report not currently adopted')} />
      </dl>
      {(!data.run.usageKnown || data.run.status === 'unknown' || data.run.eventsTruncated) && <div className="telemetry-banner"><p>{!data.run.usageKnown && (zh ? '本次运行缺少完整用量记录，未知不代表零。' : 'Complete usage is unavailable; unknown does not mean zero.')}
        {data.run.status === 'unknown' && ` ${zh ? '状态未知，最后活动' : 'Unknown status; last activity'} ${formatTime(data.run.lastActivityAt, i18n.language)}.`}
        {data.run.eventsTruncated && ` ${zh ? '仅展示已保存的部分事件。' : 'Only the saved portion of events is displayed.'}`}</p></div>}
      <TelemetryTimeline key={data.run.id} run={data.run} spans={data.spans} />
      <div className="telemetry-detail-actions"><div>
        {data.run.sessionId && <Button asChild variant="outline"><Link to={`/research?session=${encodeURIComponent(data.run.sessionId)}`}>{zh ? '返回研究会话' : 'Open research session'}</Link></Button>}
        {data.run.reportVersionId && <Button asChild className="telemetry-primary"><Link to={`/analysis/reports/${encodeURIComponent(data.run.reportVersionId)}`}>{zh ? '查看报告' : 'Read report'}</Link></Button>}
        <Button asChild variant="outline"><Link to={`/telemetry?${updateTelemetryParams(params, { view: 'quality' }, false).toString()}`}>{zh ? '报告与质量' : 'Reports & quality'}</Link></Button>
      </div><p className="telemetry-muted">{data.run.revision !== null ? `${zh ? '来源修订' : 'Source revision'} ${data.run.revision}` : (zh ? '来源修订未知' : 'Source revision unknown')}</p></div>
      <div className="telemetry-two-columns"><TelemetryFeedback key={data.run.id} id={data.run.id} feedback={data.feedback} />
        <TelemetryPanel title={zh ? '完整观测链路' : 'Full observability'}><IntegrationStatus integration={data.integration} traceId={data.run.traceId} /></TelemetryPanel></div>
      <CoverageNotes limitations={data.limitations} />
    </>}
  </section>;
}
