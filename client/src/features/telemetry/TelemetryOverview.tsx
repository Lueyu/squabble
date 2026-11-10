import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { TelemetryAgent, TelemetryRun, TelemetryWorkspace } from '@shared/telemetry.interface';
import { TelemetryEmpty, TelemetryMetric, TelemetryPanel, RunStatus } from './TelemetryPrimitives';
import { formatAmount, formatCost, formatDuration, formatRate, formatTrendDate, telemetryRunPath } from './telemetry-state';

export default function TelemetryOverview({ data, params, showRuns }: {
  data: TelemetryWorkspace; params: URLSearchParams; showRuns: () => void;
}) {
  const { i18n } = useTranslation();
  const zh: boolean = i18n.language.startsWith('zh');
  const overview = data.overview;
  const attention: TelemetryRun[] = data.runs.filter((run: TelemetryRun) => run.status === 'failed' || run.eventsTruncated || run.status === 'unknown').slice(0, 3);
  const usage: TelemetryAgent[] = data.agents.filter((agent: TelemetryAgent) => agent.totalTokens !== null).sort((a: TelemetryAgent, b: TelemetryAgent) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0)).slice(0, 6);
  const maxTokens: number = Math.max(1, ...usage.map((agent: TelemetryAgent) => agent.totalTokens ?? 0));
  return <>
    <dl className="telemetry-metrics" data-ai-section-type="card-stat">
      <TelemetryMetric label={zh ? '运行总数' : 'Total runs'} value={formatAmount(overview.totalRuns)}
        note={zh ? `${overview.completedRuns} 完成 · ${overview.failedRuns} 失败 · ${overview.cancelledRuns} 取消 · ${overview.runningRuns} 运行中`
          : `${overview.completedRuns} completed · ${overview.failedRuns} failed · ${overview.cancelledRuns} cancelled · ${overview.runningRuns} active`} />
      <TelemetryMetric label={zh ? '运行完成率' : 'Completion rate'} value={formatRate(overview.completionRate)}
        note={`${overview.completedRuns} / ${overview.completedRuns + overview.failedRuns} ${zh ? '已结束且未取消的运行' : 'completed or failed runs'}`} />
      <TelemetryMetric label={zh ? 'P95 完成耗时' : 'P95 duration'} value={formatDuration(overview.p95DurationMs)}
        note={zh ? '仅统计有耗时记录的已完成运行' : 'Completed runs with recorded durations'} />
      <TelemetryMetric label={zh ? '估算费用 · 已知用量' : 'Estimated cost · known usage'} value={formatCost(overview.estimatedCostUsd)}
        note={`${formatAmount(overview.totalTokens, true)} tokens · ${zh ? '覆盖' : 'coverage'} ${overview.knownUsageRuns} / ${overview.totalRuns}`} />
    </dl>
    <div className="telemetry-two-columns">
      <TelemetryPanel title={zh ? '运行趋势' : 'Run trend'} description={zh ? '按运行开始日期归组 · UTC' : 'Grouped by run start date · UTC'} className="telemetry-trend-panel">
        <div className="telemetry-legend"><span className="telemetry-positive">{zh ? '已完成' : 'Completed'}</span><span className="telemetry-negative">{zh ? '失败' : 'Failed'}</span><span className="telemetry-amber">{zh ? '其他状态' : 'Other states'}</span></div>
        {overview.trends.length ? <div className="telemetry-trend" role="img" aria-label={zh ? '每日运行数量，下面列出各日期与状态数量' : 'Daily run counts by status; values listed by date'}>
          {overview.trends.map((day, index: number) => {
            const max: number = Math.max(1, ...overview.trends.map(item => item.completed + item.failed + item.other));
            return <div className="telemetry-trend-day" key={day.date} title={`${day.date}: ${day.completed} / ${day.failed} / ${day.other}`}>
              <div className="telemetry-trend-stack"><i className="telemetry-trend-other" style={{ height: `${day.other / max * 100}%` }} />
                <i className="telemetry-trend-failed" style={{ height: `${day.failed / max * 100}%` }} />
                <i className="telemetry-trend-completed" style={{ height: `${day.completed / max * 100}%` }} /></div>
              <span className={index % Math.ceil(overview.trends.length / 7) === 0 || index === overview.trends.length - 1 ? '' : 'sr-only'}>{formatTrendDate(day.date, i18n.language)}</span>
              <span className="sr-only">{day.completed} {zh ? '完成' : 'completed'}, {day.failed} {zh ? '失败' : 'failed'}, {day.other} {zh ? '其他' : 'other'}</span>
            </div>;
          })}
        </div> : <TelemetryEmpty />}
      </TelemetryPanel>
      <TelemetryPanel title={zh ? '消耗分布' : 'Usage distribution'} description={zh ? '已记录 token · 按实际成员聚合' : 'Recorded tokens · grouped by actual member'}>
        <div className="telemetry-distribution">{usage.map((agent: TelemetryAgent, index: number) => <div key={agent.id}>
          <span title={agent.name}>{agent.name}</span><div className="telemetry-progress"><i className={`telemetry-color-${index % 4}`} style={{ width: `${(agent.totalTokens ?? 0) / maxTokens * 100}%` }} /></div>
          <span className="telemetry-mono">{formatAmount(agent.totalTokens, true)}</span>
        </div>)}</div>
        {!usage.length && <p className="telemetry-muted">{zh ? '没有可归属到成员的已知用量。' : 'No known usage can be attributed to members.'}</p>}
        <p className="telemetry-muted">{zh ? '未知用量保持未知，不计入费用估算。' : 'Unknown usage remains unknown and is excluded from estimates.'}</p>
      </TelemetryPanel>
    </div>
    <div className="telemetry-two-columns">
      <TelemetryPanel title={zh ? '需要关注' : 'Needs attention'} action={<Button variant="outline" onClick={showRuns}>{zh ? '查看全部运行' : 'View all runs'}</Button>}>
        {attention.length ? <div className="telemetry-attention">{attention.map((run: TelemetryRun) => <Link key={run.id} to={telemetryRunPath(run.id, params)}>
          <div><h3>{run.title || run.id}</h3><p className="telemetry-muted telemetry-mono">{run.id} · {formatDuration(run.durationMs)}</p>
            {run.eventsTruncated && <p className="telemetry-amber">{zh ? '历史事件不完整' : 'Incomplete event history'}</p>}</div><RunStatus status={run.status} />
        </Link>)}</div> : <p className="telemetry-muted">{zh ? '当前页没有失败、未知状态或事件截断的运行。' : 'No failed, unknown or truncated runs on this page.'}</p>}
        <p className="telemetry-muted">{zh ? '此处仅列出当前页，请在运行记录筛选全部结果。' : 'This section covers the current page. Filter run history to inspect all results.'}</p>
      </TelemetryPanel>
      <TelemetryPanel title={zh ? '数据覆盖' : 'Data coverage'} description={zh ? '让未知保持可见' : 'Keep unknown measurements visible'}>
        <div className="telemetry-coverage-value"><strong>{formatRate(overview.tokenCoverageRate)}</strong><span className="telemetry-muted">{zh ? '用量已记录' : 'Usage recorded'}</span></div>
        <div className="telemetry-progress" role="meter" aria-label={zh ? '用量覆盖率' : 'Usage coverage'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={overview.tokenCoverageRate === null ? undefined : overview.tokenCoverageRate * 100}>
          <i style={{ width: `${(overview.tokenCoverageRate ?? 0) * 100}%` }} /></div>
        <p className="telemetry-muted">{zh ? `${overview.knownUsageRuns} 次已知 · ${overview.totalRuns - overview.knownUsageRuns} 次未知` : `${overview.knownUsageRuns} known · ${overview.totalRuns - overview.knownUsageRuns} unknown`}<br />
          {zh ? '费用为已记录用量的估算，不是供应商账单。' : 'Costs estimate recorded usage, not provider invoices.'}</p>
      </TelemetryPanel>
    </div>
  </>;
}
