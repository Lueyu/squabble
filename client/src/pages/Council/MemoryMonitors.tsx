import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResearchThesis } from '@shared/research-memory.interface';
import type { MonitorCondition, MonitorObservation, ResearchMonitorRule, ResearchMonitorView, WriteResearchMonitor } from '@shared/research-monitor.interface';
import { fetchResearchMonitors, writeResearchMonitor } from '@/api/research-memory';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { MemoryCopy } from './memory-copy';
import { formatMemoryDate, latestMonitorRules, memoryErrorCode, memoryErrorText } from './memory-presentation';

const observationReasons: Record<string, [string, string]> = {
  invalid_rule: ['Invalid condition', '条件无效'], symbol_mismatch: ['Symbol does not match', '标的不匹配'],
  outside_validity: ['Outside the condition validity period', '不在条件适用期内'], source_unavailable: ['Market source unavailable', '行情来源不可用'],
  unit_mismatch: ['Market unit does not match', '行情单位不匹配'], invalid_observation: ['Observation is invalid', '观测数据无效'],
  stale_or_missing_data: ['Market data is stale or missing', '行情过时或缺失'], history_stale: ['Daily indicator history is stale', '日线指标历史过时'],
};
function Observation({ observation, copy, locale }: { observation?: MonitorObservation | null; copy: MemoryCopy; locale: string }) {
  if (!observation) return <p>{copy.noObservation}</p>;
  return <div><p>{observation.state === 'unknown' ? copy.unknownObservationState : copy[observation.state]} · {observation.value ?? copy.unknown}</p>
    <p>{copy.observedAt}: {formatMemoryDate(observation.observedAt, locale, copy.unknown)}</p>
    {observation.reason && <p>{observationReasons[observation.reason]?.[locale === 'zh-CN' ? 1 : 0] ?? copy.unknownObservationState}</p>}</div>;
}

export function MonitorStatus({ view, thesis, copy, locale }: { view: ResearchMonitorView; thesis: ResearchThesis; copy: MemoryCopy; locale: string }) {
  return <div className="space-y-2 text-xs leading-5">
    <p>{copy.monitorScope}</p><p>{view.executionEligible ? copy.executionEligible : copy.executionBlocked}</p>
    <p className={view.breached ? 'font-medium text-destructive' : 'text-muted-foreground'}>{view.breached ? copy.latched : copy.noBreach}</p>
    <p>{view.configuration === 'configured' ? copy.configured : copy.unconfigured}</p>
    {!!view.unsupportedConditions.length && <div><h5 className="font-medium">{copy.unsupported}</h5>
      <ul className="list-inside list-disc">{view.unsupportedConditions.map(index => <li key={index}>{thesis.invalidationConditions[index] ?? copy.unknown}</li>)}</ul>
      <p className="text-muted-foreground">{copy.unsupportedHint}</p></div>}
    <div><h5 className="font-medium">{copy.replacement}</h5>
      <p>{view.replacementState === 'reviewed' ? copy.replacementReviewed : view.replacementState === 'stale' ? copy.replacementStale
        : view.replacementState === 'proposed' ? copy.replacementProposed : copy.replacementNone}</p>
      {view.replacement && <><p className="whitespace-pre-wrap">{view.replacement.reason}</p><details><summary>{copy.technical}</summary>
        <p>{view.replacement.thesisId} · {copy.version} {view.replacement.version}</p></details></>}
    </div>
    <details><summary className="cursor-pointer">{copy.events} ({view.events.length})</summary>
      {!view.events.length && <p>{copy.noEvents}</p>}
      <ol className="mt-2 space-y-2">{view.events.map(event => <li key={event.id} className="rounded-md border p-2">
        <p>{copy.thesisVersion} {event.thesisVersion} · {copy.ruleVersion} {event.ruleVersion}</p>
        <Observation observation={event} copy={copy} locale={locale} />
        <p>{formatMemoryDate(event.createdAt, locale, copy.unknown)}</p><details><summary>{copy.technical}</summary>{event.id} · {event.ruleId}</details>
      </li>)}</ol>
    </details>
  </div>;
}

export function MonitorRule({ rule, copy, locale, children }: { rule: ResearchMonitorRule; copy: MemoryCopy; locale: string; children?: React.ReactNode }) {
  return <article className="space-y-2 rounded-md border p-3 text-xs leading-5 [overflow-wrap:anywhere]">
    <p className="font-medium">{copy.metrics[rule.condition.metric]} {({ lt: '<', lte: '≤', gt: '>', gte: '≥' })[rule.condition.operator]} {rule.condition.threshold} {copy.units[rule.condition.unit]}</p>
    <p>{rule.origin === 'user' ? copy.userRule : copy.agentRule} · {rule.enabled ? copy.enabled : copy.disabled}</p>
    <p>{copy.thesisVersion} {rule.thesisVersion} · {copy.ruleVersion} {rule.version}</p>
    <p>{rule.condition.rationale}</p>
    <p>{copy.startAt}: {formatMemoryDate(rule.condition.validFrom, locale, copy.unknown)}<br />{copy.endAt}: {formatMemoryDate(rule.condition.validUntil, locale, copy.unknown)}</p>
    <div><h6 className="font-medium">{copy.latestObservation}</h6><Observation observation={rule.lastObservation} copy={copy} locale={locale} /></div>
    <details><summary className="cursor-pointer">{copy.lastValid}</summary><Observation observation={rule.lastValidObservation} copy={copy} locale={locale} /></details>
    {children}
    <details><summary className="cursor-pointer">{copy.technical}</summary><p>{rule.id} · {rule.rootId}</p><p>{rule.condition.evidenceIds.join(' · ')}</p></details>
  </article>;
}

export function MemoryMonitors({ thesis, copy, locale }: { thesis: ResearchThesis; copy: MemoryCopy; locale: string }) {
  const client = useQueryClient();
  // Keep the condition indices, citations and version from opening the draft together.
  const [editing, setEditing] = useState<{ thesis: ResearchThesis; rule?: ResearchMonitorRule } | null>(null);
  const query = useQuery({ queryKey: ['research-memory', 'monitors', thesis.id], queryFn: () => fetchResearchMonitors(thesis.id), refetchInterval: 15_000, retry: false });
  const mutation = useMutation({ mutationFn: (input: WriteResearchMonitor) => writeResearchMonitor(thesis.id, input), retry: false,
    onSuccess: async () => { setEditing(null); await client.invalidateQueries({ queryKey: ['research-memory'] }); },
    onError: () => { void client.invalidateQueries({ queryKey: ['research-memory'] }); } });
  if (query.isError) return <p role="alert" className="text-sm">{memoryErrorText(query.error, copy)}</p>;
  if (!query.data) return <p role="status">{copy.loading}</p>;
  const grouped = latestMonitorRules(query.data.rules);
  const current = grouped.latest.filter(rule => rule.thesisVersion === thesis.version);
  const historical = [...grouped.history, ...grouped.latest.filter(rule => rule.thesisVersion !== thesis.version)];
  const canWrite = ['accepted', 'confirmed'].includes(thesis.status) && !thesis.excluded && thesis.sourceStatus === 'available'
    && !thesis.flags.includes('unverified') && thesis.supportingEvidence.length + (thesis.evidenceRelations?.length ?? 0) > 0;
  const staleEdit = Boolean(editing && (!canWrite || editing.thesis.id !== thesis.id || editing.thesis.version !== thesis.version
    || editing.thesis.memoryId !== thesis.memoryId || editing.thesis.source?.reportId !== thesis.source?.reportId
    || editing.thesis.source?.reportVersion !== thesis.source?.reportVersion || editing.thesis.source?.reportRevision !== thesis.source?.reportRevision
    || editing.rule && !current.some(rule => rule.id === editing.rule!.id && rule.version === editing.rule!.version)
    || memoryErrorCode(mutation.error).includes('VERSION_CONFLICT')));
  return <div className="min-w-0 space-y-3 pt-3 [overflow-wrap:anywhere]">
    <MonitorStatus view={query.data} thesis={thesis} copy={copy} locale={locale} />
    {mutation.error && <p role="alert" className="text-xs text-destructive">{memoryErrorText(mutation.error, copy)}</p>}
    {current.map(rule => <MonitorRule key={rule.id} rule={rule} copy={copy} locale={locale}>
      {canWrite && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={mutation.isPending || Boolean(editing)} onClick={() => { mutation.reset(); setEditing({ thesis, rule }); }}>{copy.editRule}</Button>
        <Button size="sm" variant="outline" disabled={mutation.isPending || Boolean(editing)} onClick={() => { mutation.reset(); mutation.mutate({ expectedVersion: thesis.version,
          condition: rule.condition, ruleId: rule.id, ruleVersion: rule.version, enabled: !rule.enabled }); }}>{rule.enabled ? copy.disableRule : copy.enableRule}</Button></div>}
    </MonitorRule>)}
    {!!historical.length && <details><summary className="cursor-pointer text-sm">{copy.historicalRules} ({historical.length})</summary>
      <div className="mt-2 space-y-2">{historical.map(rule => <MonitorRule key={rule.id} rule={rule} copy={copy} locale={locale} />)}</div></details>}
    {canWrite && !editing && <Button size="sm" variant="outline" disabled={!thesis.invalidationConditions.length || mutation.isPending}
      onClick={() => { mutation.reset(); setEditing({ thesis }); }}>{copy.addRule}</Button>}
    {staleEdit && <div role="alert"><p>{copy.monitorConflict}</p><Button size="sm" variant="outline" onClick={() => {
      setEditing(null); mutation.reset(); void query.refetch(); void client.invalidateQueries({ queryKey: ['research-memory'] });
    }}>{copy.restartMonitorDraft}</Button></div>}
    {editing && <MonitorEditor key={`${editing.thesis.id}:${editing.thesis.version}:${editing.rule?.id ?? 'new'}`} thesis={editing.thesis} rule={editing.rule} copy={copy}
      busy={mutation.isPending} blocked={staleEdit} onCancel={() => setEditing(null)} onSave={input => {
        if (!staleEdit && canWrite && !mutation.isPending && input.expectedVersion === editing.thesis.version) mutation.mutate(input);
      }} />}
  </div>;
}

function MonitorEditor({ thesis, rule, copy, busy, blocked, onSave, onCancel }: { thesis: ResearchThesis; rule?: ResearchMonitorRule; copy: MemoryCopy;
  busy: boolean; blocked: boolean; onSave: (input: WriteResearchMonitor) => void; onCancel: () => void }) {
  const [condition, setCondition] = useState<MonitorCondition>(() => rule?.condition ?? { conditionIndex: 0, metric: 'price', unit: thesis.market === 'HK' ? 'HKD' : thesis.market === 'CN' ? 'CNY' : 'USD',
    operator: 'lt', threshold: 0, validFrom: '', validUntil: '', evidenceIds: [], rationale: '' });
  const [invalid, setInvalid] = useState(false);
  const selectClass = 'w-full min-w-0 rounded-md border bg-background p-2 text-sm';
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (blocked || busy) return;
    const validDates = [condition.validFrom, condition.validUntil].every(value => /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(value) && Number.isFinite(Date.parse(value)));
    const badMetric = ['price', 'sma20'].includes(condition.metric) ? !['USD', 'HKD', 'CNY'].includes(condition.unit) || condition.threshold <= 0
      : condition.metric === 'rsi14' ? condition.unit !== 'points' || condition.threshold > 100 : condition.unit !== 'ratio';
    if (!validDates || Date.parse(condition.validFrom) >= Date.parse(condition.validUntil) || !condition.evidenceIds.length || !condition.rationale.trim()
      || !Number.isFinite(condition.threshold) || condition.threshold < 0 || condition.threshold > 1e12 || badMetric) { setInvalid(true); return; }
    onSave({ expectedVersion: thesis.version, condition: { ...condition, rationale: condition.rationale.trim() },
      ...(rule ? { ruleId: rule.id, ruleVersion: rule.version, enabled: rule.enabled } : {}) });
  };
  return <form className="space-y-3 rounded-md border p-3" onSubmit={save}>
    <p className="text-xs text-muted-foreground">{copy.userRule} · {copy.monitorScope}</p>
    <Label className="grid gap-1">{copy.condition}<select className={selectClass} value={condition.conditionIndex} onChange={event => setCondition({ ...condition, conditionIndex: Number(event.target.value) })}>
      {thesis.invalidationConditions.map((text, index) => <option key={index} value={index}>{text}</option>)}</select></Label>
    <Label className="grid gap-1">{copy.metric}<select className={selectClass} value={condition.metric} onChange={event => setCondition({ ...condition, metric: event.target.value as MonitorCondition['metric'] })}>
      {Object.entries(copy.metrics).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></Label>
    <div className="grid gap-2 sm:grid-cols-2"><Label className="grid gap-1">{copy.operator}<select className={selectClass} value={condition.operator} onChange={event => setCondition({ ...condition, operator: event.target.value as MonitorCondition['operator'] })}>
      {Object.entries({ lt: '<', lte: '≤', gt: '>', gte: '≥' }).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></Label>
      <Label className="grid gap-1">{copy.threshold}<Input type="number" min={0} max={1e12} step="any" value={condition.threshold} onChange={event => setCondition({ ...condition, threshold: Number(event.target.value) })} /></Label></div>
    <Label className="grid gap-1">{copy.unit}<select className={selectClass} value={condition.unit} onChange={event => setCondition({ ...condition, unit: event.target.value as MonitorCondition['unit'] })}>
      {Object.entries(copy.units).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></Label>
    <p className="text-xs text-muted-foreground">{copy.monitorDateInput}</p>
    {(['validFrom', 'validUntil'] as const).map(key => <Label key={key} className="grid gap-1">{key === 'validFrom' ? copy.startAt : copy.endAt}
      <Input value={condition[key]} placeholder="2027-01-01T00:00:00Z" onChange={event => setCondition({ ...condition, [key]: event.target.value })} /></Label>)}
    <fieldset className="space-y-2"><legend className="text-sm">{copy.supportingEvidence}</legend>{thesis.citations.map(citation => <Label key={citation.evidenceId} className="flex items-start gap-2">
      <Checkbox checked={condition.evidenceIds.includes(citation.evidenceId)} onCheckedChange={checked => setCondition({ ...condition, evidenceIds: checked === true
        ? [...condition.evidenceIds, citation.evidenceId] : condition.evidenceIds.filter(id => id !== citation.evidenceId) })} />{citation.title}</Label>)}</fieldset>
    <Label className="grid gap-1">{copy.rationale}<Textarea maxLength={1000} value={condition.rationale} onChange={event => setCondition({ ...condition, rationale: event.target.value })} /></Label>
    {invalid && <p role="alert" className="text-xs text-destructive">{copy.monitorInvalid}</p>}
    <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={busy || blocked}>{copy.monitorSave}</Button><Button type="button" size="sm" variant="outline" onClick={onCancel}>{copy.cancel}</Button></div>
  </form>;
}
