import type { TelemetryFilters, TelemetryWorkspace } from '@shared/telemetry.interface';
import { Input } from '@/components/ui/input';

const dimensions = [
  ['rosterAgentId', '股友 ID', 'Friend ID'], ['rosterAgentVersionId', '能力版本 ID', 'Capability version ID'],
  ['teamId', '团队 ID', 'Team ID'], ['teamVersionId', '团队版本 ID', 'Team version ID'],
  ['commissionId', '委托 ID', 'Commission ID'], ['workKey', '工作项', 'Work item'],
  ['attemptId', '尝试 ID', 'Attempt ID'], ['memberId', '岗位成员 ID', 'Seat member ID'],
] as const;

export default function TelemetryIdentityFilters({ filters, data, update, zh }: {
  filters: TelemetryFilters; data?: TelemetryWorkspace; zh: boolean; update: (changes: Record<string, string | undefined>) => void;
}) {
  return <details className="telemetry-identity-filters">
    <summary>{zh ? '按股友、版本和团队筛选（高级）' : 'Filter by friend, version and team (advanced)'}</summary>
    <p className="telemetry-muted">{zh
      ? '使用固定运行记录中的关联。旧记录没有个人身份时保持未知。上方总览与运行费用包含命中运行的全部成员；股友对比只统计匹配的成员执行。'
      : 'Uses frozen execution references. Unlinked legacy people remain unknown. Overview and run costs include every member of matching runs; friend comparison includes matching executions only.'}</p>
    <div className="telemetry-identity-filter-grid">{dimensions.map(([key, chinese, english]) => {
      const choices = [...new Set([...(data?.agents.map(agent => agent[key]) ?? []),
        ...((key === 'teamId' || key === 'teamVersionId' || key === 'commissionId') ? data?.runs.map(run => run[key]) ?? [] : [])].filter(Boolean))];
      return <label key={key}><span>{zh ? chinese : english}</span><Input value={filters[key] ?? ''} maxLength={120}
        list={`telemetry-${key}`} placeholder={zh ? '全部' : 'All'} onChange={event => update({ [key]: event.target.value || undefined })} />
        <datalist id={`telemetry-${key}`}>{choices.map(value => <option key={value} value={value ?? ''} />)}</datalist>
      </label>;
    })}</div>
  </details>;
}
