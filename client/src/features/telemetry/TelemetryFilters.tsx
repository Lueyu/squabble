import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DateRange } from 'react-day-picker';
import { CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { NativeSelect } from '@/components/ui/native-select';
import { Input } from '@/components/ui/input';
import type { TelemetryFilters as Filters, TelemetryWorkspace } from '@shared/telemetry.interface';
import { formatTime } from './telemetry-state';

export default function TelemetryFilters({ filters, data, update }: {
  filters: Filters; data?: TelemetryWorkspace; update: (changes: Record<string, string | undefined>) => void;
}) {
  const { i18n } = useTranslation();
  const zh: boolean = i18n.language.startsWith('zh');
  const [open, setOpen] = useState<boolean>(false);
  const [draft, setDraft] = useState<DateRange | undefined>();
  const agents = data?.agents ?? [];
  const modes: string[] = [...new Set(agents.map(agent => agent.executionMode))].filter(Boolean);
  const scenes: string[] = [...new Set(data?.runs.map(run => run.scene) ?? [])];
  const from: string | undefined = filters.from ?? data?.range.from;
  const to: string | undefined = filters.to ?? data?.range.to;
  const dateLabel: string = from && to
    ? `${formatTime(from, i18n.language, true)} — ${formatTime(to, i18n.language, true)}`
    : (zh ? '最近 7 天' : 'Last 7 days');
  const chooseRange = (range: DateRange | undefined): void => setDraft(range);
  const apply = (): void => {
    if (!draft?.from || !draft.to) return;
    const end: Date = new Date(draft.to);
    end.setHours(23, 59, 59, 999);
    update({ from: draft.from.toISOString(), to: end.toISOString() });
    setOpen(false);
  };
  return <div className="telemetry-filters" aria-label={zh ? '运行筛选' : 'Telemetry filters'}>
    <Popover open={open} onOpenChange={value => {
      setOpen(value);
      if (value) setDraft(from && to ? { from: new Date(from), to: new Date(to) } : undefined);
    }}><PopoverTrigger asChild><Button variant="outline" aria-label={zh ? '选择时间范围' : 'Choose date range'}>
      <CalendarDays size={14} />{dateLabel}</Button></PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start"><Calendar mode="range" selected={draft} onSelect={chooseRange} />
        <div className="telemetry-calendar-actions"><Button size="sm" variant="ghost" onClick={() => { update({ from: undefined, to: undefined }); setOpen(false); }}>{zh ? '最近 7 天' : 'Last 7 days'}</Button>
          <Button size="sm" disabled={!draft?.from || !draft.to} onClick={apply}>{zh ? '应用' : 'Apply'}</Button></div>
      </PopoverContent>
    </Popover>
    <label className="telemetry-scene"><span className="sr-only">{zh ? '业务场景' : 'Scene'}</span>
      <Input value={filters.scene ?? ''} maxLength={120} list="telemetry-scenes" placeholder={zh ? '全部业务场景' : 'All scenes'}
        onChange={event => update({ scene: event.target.value || undefined })} />
      <datalist id="telemetry-scenes">{scenes.map((scene: string) => <option key={scene} value={scene} />)}</datalist>
    </label>
    <NativeSelect aria-label={zh ? 'Agent' : 'Agent'} value={filters.agentId ?? ''}
      onChange={event => update({ agentId: event.target.value || undefined })}>
      <option value="">{zh ? '全部 Agent' : 'All agents'}</option>
      {filters.agentId && !agents.some(agent => agent.id === filters.agentId) && <option value={filters.agentId}>{filters.agentId}</option>}
      {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
    </NativeSelect>
    <NativeSelect aria-label={zh ? '执行方式' : 'Execution mode'} value={filters.executionMode ?? ''}
      onChange={event => update({ executionMode: event.target.value || undefined })}>
      <option value="">{zh ? '全部执行方式' : 'All execution modes'}</option>
      {filters.executionMode && !modes.includes(filters.executionMode) && <option value={filters.executionMode}>{filters.executionMode}</option>}
      {modes.map((mode: string) => <option key={mode} value={mode}>{mode}</option>)}
    </NativeSelect>
    <span className="telemetry-updated telemetry-muted">{data
      ? `${zh ? '最后更新' : 'Updated'} ${formatTime(data.generatedAt, i18n.language)}` : ''}</span>
  </div>;
}
