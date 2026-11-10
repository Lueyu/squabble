import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { TelemetryFilters, TelemetryRun, TelemetryWorkspace } from '@shared/telemetry.interface';
import { TelemetryEmpty, TelemetryPanel, RunStatus } from './TelemetryPrimitives';
import { formatAmount, formatCost, formatDuration, formatTime, TELEMETRY_PAGE_SIZE, telemetryRunPath } from './telemetry-state';
import { sceneLabel, statusLabel } from './telemetry-copy';

export default function TelemetryRuns({ data, params, filters, update }: {
  data: TelemetryWorkspace; params: URLSearchParams; filters: TelemetryFilters;
  update: (changes: Record<string, string | undefined>, resetPage?: boolean) => void;
}) {
  const { i18n } = useTranslation();
  const zh: boolean = i18n.language.startsWith('zh');
  const [search, setSearch] = useState<string>(filters.search ?? '');
  const offset: number = filters.offset ?? 0;
  return <>
    <div className="telemetry-search-row"><form onSubmit={event => { event.preventDefault(); update({ search: search.trim() || undefined }); }}>
      <Input aria-label={zh ? '搜索运行 ID、标题或成员' : 'Search run ID, title or member'} value={search} maxLength={200}
        onChange={event => setSearch(event.target.value)} placeholder={zh ? '搜索运行 ID、标题或成员' : 'Search run ID, title or member'} />
      <Button type="submit" variant="outline" aria-label={zh ? '搜索运行' : 'Search runs'}><Search size={15} /></Button>
    </form><NativeSelect aria-label={zh ? '运行状态' : 'Run status'} value={filters.status ?? ''} onChange={event => update({ status: event.target.value || undefined })}>
      <option value="">{zh ? '全部状态' : 'All statuses'}</option>
      {(['failed', 'running', 'queued', 'completed', 'cancelled', 'unknown'] as const).map(status => <option value={status} key={status}>{statusLabel(status, zh)}</option>)}
    </NativeSelect><span className="telemetry-muted">{zh ? '按开始时间排序' : 'Sorted by start time'}</span></div>
    <TelemetryPanel title={zh ? '运行记录' : 'Run history'} description={zh ? '每行是一次运行；进入执行详情查看成员、重试与工具事件。' : 'Each row is a run. Open its detail to inspect members, retries and tool events.'}>
      {data.runs.length ? <div className="telemetry-table-scroll"><Table className="telemetry-table telemetry-runs-table"><TableHeader><TableRow>
        {[zh ? '运行 / 场景' : 'Run / scene', zh ? '发起时间' : 'Started', zh ? '成员' : 'Members', zh ? '状态' : 'Status', zh ? '总耗时' : 'Duration', zh ? '已知 tokens' : 'Known tokens', zh ? '估算费用' : 'Est. cost'].map((label: string) => <TableHead key={label}>{label}</TableHead>)}
      </TableRow></TableHeader><TableBody>{data.runs.map((run: TelemetryRun) => <TableRow key={run.id}>
        <TableCell><Link className="telemetry-run-link" to={telemetryRunPath(run.id, params)}>{run.title || run.id}</Link>
          <p className="telemetry-muted">{sceneLabel(run.scene, zh)} · <span className="telemetry-mono">{run.id}</span></p></TableCell>
        <TableCell>{formatTime(run.startedAt, i18n.language)}</TableCell><TableCell>{run.agentCount}</TableCell>
        <TableCell><RunStatus status={run.status} />{run.eventsTruncated && <p className="telemetry-amber">{zh ? '事件不完整' : 'Partial events'}</p>}</TableCell>
        <TableCell>{run.durationMs === null && ['running', 'queued'].includes(run.status) ? (zh ? '进行中' : 'In progress') : formatDuration(run.durationMs)}</TableCell>
        <TableCell>{formatAmount(run.totalTokens, true)}{!run.usageKnown && <p className="telemetry-muted">{zh ? '用量未知' : 'Usage unknown'}</p>}</TableCell>
        <TableCell>{formatCost(run.estimatedCostUsd)}</TableCell>
      </TableRow>)}</TableBody></Table></div> : <TelemetryEmpty />}
      <div className="telemetry-pagination"><p className="telemetry-muted">{zh ? '显示' : 'Showing'} {data.runs.length ? offset + 1 : 0}–{offset + data.runs.length} / {data.total} {zh ? '次运行' : 'runs'}</p>
        <div><Button variant="outline" disabled={!offset} onClick={() => update({ offset: String(Math.max(0, offset - TELEMETRY_PAGE_SIZE)) }, false)}>{zh ? '上一页' : 'Previous'}</Button>
          <Button variant="outline" disabled={offset + TELEMETRY_PAGE_SIZE >= data.total} onClick={() => update({ offset: String(offset + TELEMETRY_PAGE_SIZE) }, false)}>{zh ? '下一页' : 'Next'}</Button></div></div>
    </TelemetryPanel>
    <TelemetryPanel title={zh ? '状态与消耗分别记录' : 'Status and usage are recorded separately'}>
      <p className="telemetry-muted">{zh ? '已完成的运行仍可能包含失败重试；失败的运行也可能已经产生消耗。用量未知显示“—”，不会推断为零。未知状态保留最后活动时间。' : 'Completed runs may include failed retries; failed runs may consume resources. Unknown usage is shown as “—”, never inferred as zero. Unknown states retain the last recorded activity time.'}</p>
    </TelemetryPanel>
  </>;
}
