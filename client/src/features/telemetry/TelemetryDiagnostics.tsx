import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, Pause, Play, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TelemetryDiagnosticEvent, TelemetryDiagnosticStage, TelemetryDiagnostics as Diagnostics, TelemetryTaskDiagnostic } from '@shared/telemetry-diagnostics.interface';
import { TelemetryEmpty, TelemetryPanel } from './TelemetryPrimitives';
import { useTelemetryDiagnostics } from './use-telemetry';
import { diagnosticAccessDenied, diagnosticEvidence, diagnosticPack, formatDiagnosticTime } from './telemetry-diagnostics-state';
import { formatDuration } from './telemetry-state';
import { diagnosticEventSummary, diagnosticFailureExplanation, diagnosticFailureStageLabel, diagnosticRecoveryLabel } from './telemetry-copy';

function stageLabel(stage: TelemetryDiagnosticStage | null, zh: boolean): string {
  const labels: Record<TelemetryDiagnosticStage, [string, string]> = {
    queue: ['排队', 'Queue'], preflight: ['启动前检查', 'Preflight'], dispatch: ['派发 / 启动', 'Dispatch / launch'],
    execution: ['执行', 'Execution'], result: ['结果读取', 'Result collection'], acceptance: ['结果验收', 'Result acceptance'], publication: ['报告发布', 'Publication'],
  };
  return stage ? labels[stage][zh ? 0 : 1] : (zh ? '未知' : 'Unknown');
}

function stateLabel(state: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    staged: ['待派发', 'Staged'], queued: ['排队中', 'Queued'], running: ['运行中', 'Running'], cancelling: ['取消中', 'Cancelling'],
    completed: ['执行完成', 'Execution completed'], failed: ['失败', 'Failed'], cancelled: ['已取消', 'Cancelled'],
    succeeded: ['成功', 'Succeeded'], interrupted: ['已中断', 'Interrupted'], unavailable: ['不可用', 'Unavailable'], unknown: ['未知', 'Unknown'],
    pending: ['待验收', 'Pending'], accepted: ['已接受', 'Accepted'], rejected: ['已拒绝', 'Rejected'],
  };
  return labels[state]?.[zh ? 0 : 1] ?? (zh ? '未知' : 'Unknown');
}

function processLabel(state: TelemetryTaskDiagnostic['processState'], zh: boolean): string {
  const labels: Record<TelemetryTaskDiagnostic['processState'], [string, string]> = {
    running: ['已启动，尚未记录退出', 'Started; exit not recorded'], exited: ['已记录退出', 'Exit recorded'],
    not_observed: ['未观测到进程启动', 'Process launch not observed'], unknown: ['未知', 'Unknown'],
  };
  return labels[state][zh ? 0 : 1];
}

function capabilityLabel(capability: TelemetryTaskDiagnostic['activityCapability'], zh: boolean): string {
  const labels: Record<TelemetryTaskDiagnostic['activityCapability'], [string, string]> = {
    tools: ['公开工具活动', 'Public tool activity'], starts_only: ['仅记录工具开始，结束状态未知', 'Tool starts only; completion is unknown'],
    phases: ['仅阶段信息，无工具明细', 'Stages only; tool details unavailable'], none: ['活动明细不可用', 'Activity detail unavailable'],
  };
  return labels[capability][zh ? 0 : 1];
}

function publicationLabel(state: Diagnostics['publication'], zh: boolean): string {
  const labels: Record<Diagnostics['publication'], [string, string]> = {
    published: ['已发布', 'Published'], pending: ['待发布', 'Pending publication'], failed: ['发布失败', 'Publication failed'], unknown: ['未知', 'Unknown'],
  };
  return labels[state]?.[zh ? 0 : 1] ?? (zh ? '未知' : 'Unknown');
}

function EventRow({ event, language, memberName }: { event: TelemetryDiagnosticEvent; language: string; memberName?: string }) {
  const zh = language.startsWith('zh');
  return <li className={`telemetry-diagnostic-event telemetry-event-${event.status}`}>
    <div><time className="telemetry-mono" dateTime={event.at}>{formatDiagnosticTime(event.at, language)}</time>
      <span className="telemetry-diagnostic-stage">{stageLabel(event.stage, zh)}</span>
      <span className={event.status === 'failed' ? 'telemetry-negative' : 'telemetry-muted'}>{stateLabel(event.status, zh)}</span>
      {memberName && <strong>{memberName}</strong>}</div>
    <p>{event.toolName && <strong className="telemetry-mono">{event.toolName} · </strong>}{diagnosticEventSummary(event.summary, zh)}</p>
    <details className="telemetry-event-metadata"><summary>{zh ? '事件元数据' : 'Event metadata'}</summary>
      <dl className="telemetry-facts"><dt>{zh ? '事件 / 序号' : 'Event / sequence'}</dt><dd className="telemetry-mono">{event.id} / {event.sequence}</dd>
        <dt>{zh ? '耗时' : 'Duration'}</dt><dd>{formatDuration(event.durationMs ?? null)}</dd>
        {event.callId && <><dt>{zh ? '工具调用 ID' : 'Tool call ID'}</dt><dd className="telemetry-mono">{event.callId}</dd></>}
        {event.code && <><dt>{zh ? '错误代码' : 'Error code'}</dt><dd className="telemetry-error-code">{event.code}</dd></>}
        {event.exitCode !== undefined && <><dt>{zh ? '退出码' : 'Exit code'}</dt><dd>{event.exitCode}</dd></>}
        {event.outputBytes !== undefined && <><dt>{zh ? '输出字节数' : 'Output bytes'}</dt><dd>{event.outputBytes}</dd></>}
        {event.stderrBytes !== undefined && <><dt>{zh ? '错误流字节数' : 'Stderr bytes'}</dt><dd>{event.stderrBytes}</dd></>}
        {event.terminalEvent !== undefined && <><dt>{zh ? '终结事件' : 'Terminal event'}</dt><dd>{event.terminalEvent ? (zh ? '已记录' : 'Recorded') : (zh ? '未记录' : 'Not recorded')}</dd></>}
      </dl></details>
  </li>;
}

function TaskDetail({ task, data, sessionId, language }: { task: TelemetryTaskDiagnostic; data: Diagnostics; sessionId: string | null; language: string }) {
  const zh = language.startsWith('zh');
  const evidence = diagnosticEvidence(task);
  const unknown = zh ? '未知' : 'Unknown';
  const activityAge = task.lastActivityAt ? Date.parse(data.generatedAt) - Date.parse(task.lastActivityAt) : NaN;
  const failure = task.failure;
  return <div className="telemetry-diagnostic-detail" aria-label={zh ? '所选任务诊断' : 'Selected task diagnostics'}>
    <div className="telemetry-row-between"><h3>{task.memberName} · {zh ? '第' : 'Attempt'} {task.attempt}{zh ? ' 次' : ''}</h3>
      <span className={`telemetry-status telemetry-status-${task.state}`}>{stateLabel(task.state, zh)}</span></div>
    <dl className="telemetry-diagnostic-summary">
      <div><dt>{zh ? '当前记录阶段' : 'Current recorded stage'}</dt><dd>{stageLabel(evidence.stage, zh)}</dd><small>{evidence.latestEvent ? formatDiagnosticTime(evidence.latestEvent.at, language) : (zh ? '未保存阶段事件' : 'No saved stage events')}</small></div>
      <div><dt>{zh ? '实际进程状态' : 'Observed process state'}</dt><dd>{processLabel(task.processState, zh)}</dd><small>{zh ? '执行完成不代表验收通过' : 'Completion does not establish acceptance'}</small></div>
      <div><dt>{zh ? '结果验收' : 'Result acceptance'}</dt><dd>{stateLabel(task.acceptance ?? 'unknown', zh)}</dd><small>{zh ? '报告发布' : 'Publication'}: {publicationLabel(data.publication, zh)}</small></div>
    </dl>
    <dl className="telemetry-facts">
      <dt>{zh ? '最近公开活动' : 'Last public activity'}</dt><dd>{task.lastActivityAt ? formatDiagnosticTime(task.lastActivityAt, language) : unknown}</dd>
      <dt>{zh ? '桥接最近心跳' : 'Last bridge heartbeat'}</dt><dd>{task.heartbeatAt ? formatDiagnosticTime(task.heartbeatAt, language) : (zh ? '未记录；连接状态未知' : 'Not recorded; connectivity unknown')}</dd>
      <dt>{zh ? '最后成功步骤' : 'Last successful step'}</dt><dd>{evidence.lastSuccess ? `${stageLabel(evidence.lastSuccess.stage, zh)} · ${diagnosticEventSummary(evidence.lastSuccess.summary, zh)}` : unknown}</dd>
      <dt>{zh ? '执行器 / 通道' : 'Executor / transport'}</dt><dd>{task.provider ?? unknown} / {task.transport ?? unknown}</dd>
      <dt>{zh ? '配置 / 观测模型' : 'Configured / observed model'}</dt><dd>{task.configuredModel ?? unknown} / {task.observedModel ?? unknown}</dd>
      <dt>{zh ? '任务 ID' : 'Task ID'}</dt><dd className="telemetry-mono">{task.taskId}</dd>
    </dl>
    <p className="telemetry-muted">{Number.isFinite(activityAge) && activityAge >= 60_000 && `${zh ? '快照中距离最近活动已超过 60 秒。' : 'The snapshot is over 60 seconds past the last recorded activity.'} `}
      {zh ? '桥接心跳只说明连接活动，不代表任务有进展。没有新活动本身不能证明卡死；进程和验收状态分别依据已有记录。' : 'Bridge heartbeat shows connection activity, not task progress. Silence alone does not establish a stall; process and acceptance use separate recorded evidence.'}</p>
    {failure && <section className="telemetry-diagnostic-failure" aria-label={zh ? '失败证据' : 'Failure evidence'}>
      <h3>{zh ? '失败证据' : 'Failure evidence'}</h3><p className="telemetry-error-code">{failure.code}</p>
      <p>{diagnosticFailureExplanation(failure, zh)}</p>
      <dl className="telemetry-facts"><dt>{zh ? '失败阶段' : 'Failure stage'}</dt><dd>{diagnosticFailureStageLabel(failure.stage, zh)}</dd>
        <dt>{zh ? '退出码' : 'Exit code'}</dt><dd>{failure.exitCode ?? unknown}</dd>
        <dt>{zh ? '输出字节数' : 'Output bytes'}</dt><dd>{failure.outputBytes ?? unknown}</dd>
        <dt>{zh ? '错误流字节数' : 'Stderr bytes'}</dt><dd>{failure.stderrBytes ?? unknown}</dd>
        <dt>{zh ? '终结事件' : 'Terminal event'}</dt><dd>{failure.terminalEvent === undefined ? unknown : failure.terminalEvent ? (zh ? '已记录' : 'Recorded') : (zh ? '未记录' : 'Not recorded')}</dd>
        {failure.fieldPath && <><dt>{zh ? '验收字段' : 'Validation field'}</dt><dd>{failure.fieldPath}</dd></>}
        {(failure.expectedType || failure.actualType) && <><dt>{zh ? '预期 / 实际类型' : 'Expected / actual type'}</dt><dd>{failure.expectedType ?? unknown} / {failure.actualType ?? unknown}</dd></>}
      </dl>
      {failure.recoveries.length > 0 && <div><h3>{zh ? '建议下一步' : 'Recommended next steps'}</h3><ul className="telemetry-recovery-recommendations">{failure.recoveries.map(action => <li key={action}>{diagnosticRecoveryLabel(action, zh)}</li>)}</ul></div>}
      {sessionId && failure.recoveries.length > 0 && <Button asChild variant="outline" size="sm"><Link to={`/research?session=${encodeURIComponent(sessionId)}`}>{zh ? '打开会话恢复控制' : 'Open recovery controls'}</Link></Button>}
    </section>}
    <details className="telemetry-diagnostic-stages" open key={task.taskId}><summary>{zh ? '实际阶段与工具时间线' : 'Recorded stages and tools'} ({task.events.length})</summary>
      {task.events.length ? <ol>{[...task.events].sort((a, b) => a.sequence - b.sequence).map(event => <EventRow key={event.id} event={event} language={language} />)}</ol>
        : <p className="telemetry-muted">{zh ? '没有保存内部步骤，历史阶段保持未知。' : 'No internal steps were saved. Historical stages remain unknown.'}</p>}
    </details>
    <p className="telemetry-muted">{capabilityLabel(task.activityCapability, zh)}. {zh ? '模型内部请求与私密推理不可见。' : 'Internal model requests and private reasoning are not visible.'}
      {!task.retained && ` ${zh ? '任务日志未保留，无法还原进程证据。' : 'Task journal was not retained; process evidence is unavailable.'}`}
      {task.eventsTruncated && ` ${zh ? '事件已截断，仅展示保留部分。' : 'Events were truncated; only the retained portion is shown.'}`}</p>
  </div>;
}

export default function TelemetryDiagnostics({ id, sessionId, active }: { id: string; sessionId: string | null; active: boolean }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const query = useTelemetryDiagnostics(id, active);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agent, setAgent] = useState<string>('all');
  const [filter, setFilter] = useState<'all' | 'tools' | 'exceptions'>('all');
  const [following, setFollowing] = useState<boolean>(true);
  const recordsRef = useRef<HTMLOListElement>(null);
  // A transient read error retains the last snapshot; a visibility denial must hide it.
  const denied = diagnosticAccessDenied(query.error);
  const data = !denied && Array.isArray(query.data?.tasks) ? query.data : undefined;
  const selected = data?.tasks.find(task => task.taskId === selectedId) ?? data?.tasks.find(task => task.failure) ?? data?.tasks[0];
  const records = data?.tasks.flatMap(task => task.events.map(event => ({ task, event })))
    .filter(({ task, event }) => (agent === 'all' || task.taskId === agent)
      && (filter !== 'tools' || event.kind === 'tool')
      && (filter !== 'exceptions' || ['failed', 'interrupted', 'cancelled', 'unavailable'].includes(event.status) || Boolean(event.code)))
    .sort((a, b) => Date.parse(a.event.at) - Date.parse(b.event.at) || a.event.sequence - b.event.sequence) ?? [];
  useEffect(() => {
    if (following && recordsRef.current) recordsRef.current.scrollTop = recordsRef.current.scrollHeight;
  }, [data?.cursor, following, agent, filter]);
  const download = (): void => {
    if (!data) return;
    const url = window.URL.createObjectURL(new window.Blob([diagnosticPack(id, data)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `telemetry-diagnostics-${id.replace(/[^a-zA-Z0-9_-]/gu, '_')}.json`;
    anchor.click();
    window.URL.revokeObjectURL(url);
  };
  return <TelemetryPanel title={zh ? '执行诊断' : 'Execution diagnostics'} description={zh ? '读取已保存的真实阶段与公开活动；运行中每 2 秒刷新。' : 'Saved execution stages and public activity; refreshes every 2 seconds while active.'}
    action={<div className="telemetry-timeline-actions"><Button variant="ghost" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={14} />{zh ? '刷新诊断' : 'Refresh diagnostics'}</Button>
      <Button variant="outline" size="sm" disabled={!data} onClick={download}><Download size={14} />{zh ? '下载诊断包' : 'Download diagnostics'}</Button></div>}>
    {query.isError && !denied && <p className="telemetry-banner" role="status">{zh ? '重新连接中，保留上次成功读取的诊断记录。' : 'Reconnecting. The last successfully read diagnostics remain visible.'}</p>}
    {!data ? <TelemetryEmpty>{query.isPending ? (zh ? '正在读取诊断记录…' : 'Loading diagnostic records…') : (zh ? '诊断记录不可用，未保留的历史步骤无法还原。' : 'Diagnostic records are unavailable. Unretained historical steps cannot be reconstructed.')}</TelemetryEmpty> : <>
      <div className="telemetry-row-between telemetry-muted"><span>{zh ? '观测覆盖' : 'Coverage'}: {data.coverage === 'available' ? (zh ? '已保留' : 'Retained') : data.coverage === 'partial' ? (zh ? '部分记录 / 历史信息缺失' : 'Partial records / missing history') : (zh ? '不可用' : 'Unavailable')}</span>
        <span>{zh ? '最近成功读取' : 'Last successful read'}: {formatDiagnosticTime(data.generatedAt, i18n.language)}</span></div>
      {data.tasks.length ? <>
        <div className="telemetry-diagnostic-task-list" aria-label={zh ? '选择执行任务' : 'Select execution task'}>{data.tasks.map(task => <Button key={task.taskId} variant={selected?.taskId === task.taskId ? 'secondary' : 'outline'} aria-pressed={selected?.taskId === task.taskId} onClick={() => setSelectedId(task.taskId)}>
          <span>{task.memberName}<small>{zh ? '第' : 'Attempt'} {task.attempt}{zh ? ' 次' : ''} · {stateLabel(task.state, zh)}</small></span>
        </Button>)}</div>
        {selected && <TaskDetail task={selected} data={data} sessionId={sessionId} language={i18n.language} />}
      </> : <p className="telemetry-muted">{zh ? '没有保留可关联的本地任务，执行状态保持未知。' : 'No retained local task could be associated. Execution detail remains unknown.'}</p>}
      <section className="telemetry-diagnostic-records" aria-label={zh ? '诊断事件记录' : 'Diagnostic event records'}>
        <div className="telemetry-panel-heading"><h3>{zh ? '事件记录' : 'Event records'} ({records.length})</h3>
          <Button variant="outline" size="sm" aria-pressed={following} onClick={() => setFollowing(value => !value)}>{following ? <Pause size={14} /> : <Play size={14} />}{following ? (zh ? '暂停跟随' : 'Pause follow') : (zh ? '继续跟随' : 'Resume follow')}</Button></div>
        <div className="telemetry-diagnostic-filters"><label>{zh ? '成员 / 任务' : 'Member / task'}<select value={agent} onChange={event => setAgent(event.target.value)}><option value="all">{zh ? '全部成员' : 'All members'}</option>{data.tasks.map(task => <option key={task.taskId} value={task.taskId}>{task.memberName} · {task.attempt}</option>)}</select></label>
          <div className="telemetry-timeline-actions">{(['all', 'tools', 'exceptions'] as const).map(value => <Button key={value} size="sm" variant={filter === value ? 'secondary' : 'ghost'} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? (zh ? '全部记录' : 'All records') : value === 'tools' ? (zh ? '仅工具' : 'Tools only') : (zh ? '仅异常记录' : 'Exceptions only')}</Button>)}</div></div>
        <p className="telemetry-muted">{following ? (zh ? '新事件自动滚动；读取已有记录时可暂停跟随。' : 'New events scroll into view. Pause follow to read earlier records.') : (zh ? '已暂停自动滚动，诊断记录仍会刷新。' : 'Automatic scrolling paused; diagnostics still refresh.')}</p>
        {records.length ? <ol ref={recordsRef} tabIndex={0} aria-label={zh ? '公开事件列表' : 'Public event list'} onScroll={event => {
          const element = event.currentTarget;
          if (element.scrollHeight - element.scrollTop - element.clientHeight > 24) setFollowing(false);
        }}>{records.map(({ task, event }) => <EventRow key={`${task.taskId}:${event.id}`} event={event} memberName={task.memberName} language={i18n.language} />)}</ol>
          : <p className="telemetry-muted">{zh ? '当前筛选下没有已记录事件。' : 'No recorded events match these filters.'}</p>}
      </section>
    </>}
  </TelemetryPanel>;
}
