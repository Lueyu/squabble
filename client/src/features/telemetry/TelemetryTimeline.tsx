import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import AnimalAvatar from '@/components/AnimalAvatar';
import type { TelemetryRun, TelemetrySpan } from '@shared/telemetry.interface';
import { TelemetryEmpty, TelemetryPanel, RunStatus } from './TelemetryPrimitives';
import { formatAmount, formatCost, formatDuration, formatTime, spanGeometry, telemetryAvatar } from './telemetry-state';

export default function TelemetryTimeline({ run, spans }: { run: TelemetryRun; spans: TelemetrySpan[] }) {
  const { i18n } = useTranslation();
  const zh: boolean = i18n.language.startsWith('zh');
  const [exceptions, setExceptions] = useState<boolean>(false);
  const [selectedId, setSelectedId] = useState<string | null>(spans.find(span => span.status === 'failed')?.id ?? spans[0]?.id ?? null);
  const selected: TelemetrySpan | undefined = spans.find(span => span.id === selectedId);
  const visible: TelemetrySpan[] = exceptions ? spans.filter(span => span.status === 'failed' || span.errorCode !== null) : spans;
  const kindLabels: Record<TelemetrySpan['kind'], string> = {
    task: zh ? '任务' : 'Task', agent: zh ? '成员执行' : 'Agent execution',
    model: zh ? '模型调用' : 'Model call', tool: zh ? '工具调用' : 'Tool call',
  };
  return <div className="telemetry-two-columns telemetry-trace-layout">
    <TelemetryPanel title={zh ? '执行时间线' : 'Execution timeline'} description={zh ? '并行步骤按实际开始时间排列，点击查看元数据。' : 'Steps use their recorded start times. Select a step to inspect metadata.'}
      action={<div className="telemetry-timeline-actions"><Button size="sm" variant={exceptions ? 'ghost' : 'secondary'} aria-pressed={!exceptions} onClick={() => setExceptions(false)}>{zh ? '全部事件' : 'All events'}</Button>
        <Button size="sm" variant={exceptions ? 'secondary' : 'ghost'} aria-pressed={exceptions} onClick={() => setExceptions(true)}>{zh ? '仅异常' : 'Exceptions'}</Button></div>}>
      {!visible.length ? <TelemetryEmpty>{exceptions ? (zh ? '没有已记录的异常事件。' : 'No recorded exception events.') : (zh ? '没有保存步骤明细，历史执行链路保持未知。' : 'No step details were saved. Historical execution remains unknown.')}</TelemetryEmpty> : <>
        <div className="telemetry-timeline-axis" aria-hidden="true"><span>{zh ? '成员 / 步骤' : 'Member / step'}</span><div><span>0 s</span><span>{run.durationMs === null ? '—' : formatDuration(run.durationMs / 2)}</span><span>{formatDuration(run.durationMs)}</span></div><span /></div>
        <ol className="telemetry-timeline">{visible.map((span: TelemetrySpan) => {
          const geometry = spanGeometry(run, span);
          return <li key={span.id}><button type="button" aria-pressed={selectedId === span.id} onClick={() => setSelectedId(span.id)} className={span.parentId ? 'telemetry-nested-span' : ''}>
            <div className="telemetry-span-label"><AnimalAvatar avatar={telemetryAvatar(`${span.agentId ?? ''} ${span.name}`)} role="researcher" className="size-7 telemetry-mobile-avatar" />
              <span className="telemetry-span-copy">{span.parentId && <span aria-hidden="true">↳ </span>}{span.name}<small className="telemetry-muted">{span.agentName && span.name !== span.agentName ? span.agentName : kindLabels[span.kind]}</small></span></div>
            <div className="telemetry-span-track" aria-hidden="true">{geometry.known ? <i className={`telemetry-span-${span.status} telemetry-kind-${span.kind}`} style={{ marginLeft: `${geometry.left}%`, width: `${geometry.width}%` }} /> : <span className="telemetry-muted">{zh ? '耗时未知' : 'Unknown duration'}</span>}</div>
            <span className="telemetry-span-duration telemetry-mono">{formatDuration(span.durationMs)}</span>
            <span className="telemetry-mobile-span-status"><RunStatus status={span.status} /></span>
          </button></li>;
        })}</ol>
      </>}
      <p className="telemetry-muted">{zh ? '并行步骤的时长不可相加作为总耗时。仅展示已保存事件；历史事件截断时不补造缺失步骤。' : 'Parallel step durations do not add to total duration. Only saved events appear; missing historical steps are not reconstructed.'}</p>
    </TelemetryPanel>
    <TelemetryPanel title={selected ? `${selected.name} · ${zh ? '第' : 'attempt'} ${selected.attempt}${zh ? ' 次' : ''}` : (zh ? '步骤详情' : 'Step detail')}>
      {selected ? <>
        <RunStatus status={selected.status} />
        {selected.errorCode && <p className="telemetry-error-code">{selected.errorCode}</p>}
        <p className="telemetry-muted telemetry-mono telemetry-wrap">span / {selected.id}</p>
        <dl className="telemetry-facts"><dt>{zh ? '执行成员' : 'Member'}</dt><dd>{selected.agentName ?? '—'}</dd>
          <dt>{zh ? '实际执行器' : 'Executor'}</dt><dd>{selected.provider ?? selected.executionMode ?? '—'}</dd>
          <dt>{zh ? '模型' : 'Model'}</dt><dd>{selected.model ?? (zh ? '未知' : 'Unknown')}</dd>
          <dt>{zh ? '步骤类型' : 'Step type'}</dt><dd>{kindLabels[selected.kind]}</dd>
          <dt>{zh ? '开始 / 耗时' : 'Started / duration'}</dt><dd>{formatTime(selected.startedAt, i18n.language)} / {formatDuration(selected.durationMs)}</dd>
          <dt>{zh ? '父步骤' : 'Parent span'}</dt><dd className="telemetry-mono">{selected.parentId ?? '—'}</dd>
          <dt>{zh ? '已知 tokens' : 'Known tokens'}</dt><dd>{formatAmount(selected.totalTokens, true)}</dd>
          <dt>{zh ? '估算费用' : 'Est. cost'}</dt><dd>{formatCost(selected.estimatedCostUsd)}</dd></dl>
        <p className="telemetry-muted telemetry-divider">{zh ? '仅展示运行元数据，不展示工具参数、提示词或私密正文。失败事件不代表整次运行失败，最终状态以运行结果为准。' : 'Metadata only: tool arguments, prompts and private content are not displayed. A failed event does not imply the whole run failed; consult its final status.'}</p>
      </> : <p className="telemetry-muted">{zh ? '选择一个已保存步骤查看详情。' : 'Select a saved step to inspect its details.'}</p>}
    </TelemetryPanel>
  </div>;
}
