import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { TelemetryView } from './telemetry-state';
import { telemetryFilters, telemetryView, updateTelemetryParams } from './telemetry-state';
import { useTelemetryWorkspace } from './use-telemetry';
import { CoverageNotes, TelemetryEmpty, TelemetryError, TelemetryLoading } from './TelemetryPrimitives';
import TelemetryFilters from './TelemetryFilters';
import TelemetryOverview from './TelemetryOverview';
import TelemetryAgents from './TelemetryAgents';
import TelemetryRuns from './TelemetryRuns';
import TelemetryQuality, { qualityDefinitions } from './TelemetryQuality';
import './telemetry.css';

export default function TelemetryPage() {
  const { i18n } = useTranslation();
  const zh: boolean = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const [definitionsOpen, setDefinitionsOpen] = useState<boolean>(false);
  const view: TelemetryView = telemetryView(params.get('view'));
  const filters = telemetryFilters(params);
  const query = useTelemetryWorkspace(filters);
  const update = (changes: Record<string, string | undefined>, resetPage = true): void => {
    setParams(updateTelemetryParams(params, changes, resetPage));
  };
  const labels: Record<TelemetryView, string> = {
    overview: zh ? '综合总览' : 'Overview', agents: zh ? 'Agent 对比' : 'Agents',
    runs: zh ? '运行记录' : 'Run history', quality: zh ? '效果评估' : 'Quality',
  };
  const descriptions: Record<TelemetryView, string> = {
    overview: zh ? '从整体表现，定位到每一次研究运行。' : 'From overall performance to every research run.',
    agents: zh ? '在同类任务中，比较效率与交付表现。' : 'Compare efficiency and delivery for similar tasks.',
    runs: zh ? '找到异常，查看完整的执行上下文。' : 'Find exceptions and inspect their execution context.',
    quality: zh ? '从可追溯交付，到有依据的效果评估。' : 'From traceable delivery to evidence-based evaluation.',
  };
  return <section className="telemetry-workspace" aria-label={zh ? '运行分析工作区' : 'Telemetry workspace'}>
    <header className="telemetry-page-heading"><div><h1>{view === 'overview' ? (zh ? '运行分析' : 'Run analytics') : labels[view]}</h1>
      <p className="telemetry-muted">{descriptions[view]}</p></div><Button variant="outline" onClick={() => setDefinitionsOpen(true)}>{zh ? '指标说明' : 'Metric guide'}</Button></header>
    <nav className="telemetry-tabs" aria-label={zh ? '运行分析页面' : 'Telemetry pages'}>{(['overview', 'agents', 'runs', 'quality'] as const).map((item: TelemetryView) => <Button key={item}
      variant="ghost" aria-current={view === item ? 'page' : undefined} onClick={() => update({ view: item }, false)}>{labels[item]}</Button>)}</nav>
    <TelemetryFilters filters={filters} data={query.data} update={update} />
    {query.isPending && <TelemetryLoading />}
    {query.isError && !query.data && <TelemetryError retry={() => void query.refetch()} />}
    {query.data && <>
      {query.isError && <div className="telemetry-banner" role="alert"><p>{zh ? '更新失败，下面保留上次成功读取的数据。' : 'Refresh failed. The last successfully loaded data is shown below.'}</p><Button variant="outline" onClick={() => void query.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>}
      {query.data.total === 0 && view !== 'runs' && <TelemetryEmpty />}
      {view === 'overview' && <TelemetryOverview data={query.data} params={params} showRuns={() => update({ view: 'runs' }, false)} />}
      {view === 'agents' && <TelemetryAgents data={query.data} selectAgent={id => update({ view: 'runs', agentId: id })} />}
      {view === 'runs' && <TelemetryRuns key={params.get('search') ?? ''} data={query.data} params={params} filters={filters} update={update} />}
      {view === 'quality' && <TelemetryQuality data={query.data} params={params} />}
      <CoverageNotes limitations={query.data.limitations} />
      <p className="telemetry-footer telemetry-muted">{zh ? '仅显示当前工作区可访问的真实运行。费用为已记录用量估算；缺失记录保持未知。' : 'Only real runs accessible in this workspace are shown. Costs estimate recorded usage; missing measurements remain unknown.'}</p>
    </>}
    <Dialog open={definitionsOpen} onOpenChange={setDefinitionsOpen}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><DialogHeader>
      <DialogTitle>{zh ? '指标说明' : 'Metric guide'}</DialogTitle><DialogDescription>{zh ? '先核对统计单位、分母与数据覆盖，再比较结果。' : 'Check units, denominators and coverage before comparing results.'}</DialogDescription>
    </DialogHeader><div className="telemetry-guide"><h3>{zh ? '运行与成员执行分别计数' : 'Runs and member executions are counted separately'}</h3>
      <p>{zh ? '一次研究可包含多个成员、模型调用与工具步骤。并行步骤时长不可相加作为总耗时；失败与重试的用量仍可能计入估算。' : 'A research run can contain multiple members, model calls and tools. Parallel durations do not add to wall time. Failed attempts and retries can still consume resources.'}</p>
      {qualityDefinitions(zh).map(row => <article key={row.label}><h3>{row.label}</h3><p>{row.basis}</p><p className="telemetry-muted">{row.excluded}</p></article>)}
    </div></DialogContent></Dialog>
  </section>;
}
