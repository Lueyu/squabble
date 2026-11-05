import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Play, Pause, GitBranch, FileText, ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { fetchBuilderProfiles } from '@/api/builder';
import { fetchResearchDocument, fetchResearchDocuments } from '@/api/research-documents';
import * as api from '@/api/strategy-mandates';
import type { MandateRule, StrategyMandate, StrategyMandateInput } from '@shared/strategy-mandate.interface';
import { STRATEGY_TRIGGER_KINDS } from '@shared/strategy.interface';
import { businessTime, resolveZonedInput, strategyPeriodDates, zonedInput, type ZonedInputResult } from '@/utils/strategy-dates';
import StrategyTeamSetup from './StrategyTeamSetup';

const inputStyle = 'w-full rounded-md border bg-background px-3 py-2 text-sm';
type DateField = 'startsAt' | 'endsAt';
function BusinessDateField({ id, label, value, result, timezone, text, onChange, onChoose }: {
  id: string; label: string; value: string; result: ZonedInputResult; timezone: string;
  text: (zh: string, english: string) => string; onChange: (value: string) => void; onChoose: (iso: string) => void;
}) {
  return <div><Label htmlFor={id}>{label}</Label><Input id={id} type="datetime-local" value={value} aria-invalid={Boolean(result.error)} aria-describedby={result.error ? id + '-error' : undefined} onChange={event => onChange(event.target.value)} />
    {result.error && <p id={id + '-error'} role="alert" className="mt-1 text-xs text-destructive">{result.error === 'nonexistent' ? text('此时间因夏令时切换而不存在，请选择其他时间。', 'This time does not exist because clocks move forward. Choose another time.')
      : result.error === 'ambiguous' ? text('此时间在夏令时切换时重复出现，请选择具体时点。', 'This time occurs twice when clocks move back. Choose an occurrence.')
        : text('请输入有效的日期、时间和业务时区。', 'Enter a valid date, time and business timezone.')}</p>}
    {result.candidates.length > 1 && <select aria-label={text('选择重复时段的具体时点', 'Choose occurrence of repeated time')} className={inputStyle + ' mt-2'} value={result.iso ?? ''} onChange={event => onChoose(event.target.value)}><option value="">{text('请选择', 'Choose an occurrence')}</option>{result.candidates.map(iso => <option key={iso} value={iso}>{businessTime(iso, timezone)} · {iso}</option>)}</select>}
  </div>;
}
const blankRule = (source: string, endsAt: string): MandateRule => ({
  id: 'rule_' + crypto.randomUUID().slice(0, 8), ticker: '', side: 'buy', trigger: { kind: 'price_below', value: 0 },
  referencePrice: 0, minPrice: 0, maxPrice: 0, maxPositionPct: 10, stopLossPrice: 0,
  expiresAt: endsAt, evidenceIds: source ? [source] : [], rationale: '', reviewMode: 'deterministic', semanticCondition: '',
});

export function StrategyWorkbench({ accountId }: { accountId?: string }) {
  const { i18n } = useTranslation(); const en = i18n.language.startsWith('en');
  const text = (zh: string, english: string) => en ? english : zh;
  const [params] = useSearchParams(); const cache = useQueryClient();
  const sourceId = params.get('sourceReportVersionId') ?? '';
  const sourceSectionId = params.get('sourceSectionId') ?? undefined;
  const linkedStrategyId = params.get('strategyId');
  const [open, setOpen] = useState(params.get('draft') === '1');
  const [editing, setEditing] = useState<StrategyMandate | null>(null);
  const [form, setForm] = useState<StrategyMandateInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishTarget, setPublishTarget] = useState<StrategyMandate | null>(null);
  const [reportSearch, setReportSearch] = useState('');
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');
  const [showTeamSetup, setShowTeamSetup] = useState(false);
  const [newTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');
  const [initialDates] = useState(() => strategyPeriodDates('day', newTimezone));
  const [dateEdits, setDateEdits] = useState<Partial<Record<DateField, string>>>({});
  const [dateChoices, setDateChoices] = useState<Partial<Record<DateField, string>>>({});
  const [advancedText, setAdvancedText] = useState<Record<string, string>>({});
  const [eventDateEdits, setEventDateEdits] = useState<Record<string, string>>({});
  const [eventDateChoices, setEventDateChoices] = useState<Record<string, string>>({});
  const reportLibrary = useQuery({ queryKey: ['mandate-report-picker', reportSearch, reportFrom, reportTo],
    queryFn: () => fetchResearchDocuments({ history: true, search: reportSearch, from: reportFrom || undefined,
      to: reportTo || undefined, limit: 50 }), enabled: open });
  const workspace = useQuery({ queryKey: ['strategy-mandates', accountId],
    queryFn: () => api.fetchStrategyMandates(accountId!), enabled: Boolean(accountId), refetchInterval: 15000 });
  const linkedStrategy = useQuery({ queryKey: ['strategy-mandate-version', linkedStrategyId],
    queryFn: () => api.fetchStrategyMandate(linkedStrategyId!), enabled: Boolean(linkedStrategyId) });
  const profiles = useQuery({ queryKey: ['builder', 'profiles'], queryFn: fetchBuilderProfiles });
  const source = useQuery({ queryKey: ['research-document', sourceId], queryFn: () => fetchResearchDocument(sourceId), enabled: Boolean(sourceId) });
  const active = workspace.data?.items.find(item => item.status === 'published');
  const defaultProfile = profiles.data?.find(profile => profile.status === 'active') ?? profiles.data?.[0];
  const newForm: StrategyMandateInput = {
    title: source.data ? text('基于报告的模拟策略：', 'Paper strategy: ') + source.data.version.title : text('新的期间策略', 'New period strategy'),
    objective: '', period: 'day', timezone: newTimezone,
    ...initialDates, accountId: accountId ?? '', profileId: defaultProfile?.id ?? '',
    references: sourceId ? [{ versionId: sourceId, sectionId: sourceSectionId }] : [], sourceSessionId: params.get('sourceSessionId') ?? undefined,
    rules: [], limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20 },
    routePolicy: { councilPositionCapRatio: 0.8, councilIncrementPct: 3, rollingWindowMinutes: 60, candidateTtlSeconds: 1200 },
    dailyPlanMode: 'fixed_rules',
  };
  const current = form ?? newForm;
  const set = (change: Partial<StrategyMandateInput>) => setForm({ ...current, ...change });
  const dateResult = (field: DateField): ZonedInputResult => dateEdits[field] === undefined ? { iso: current[field], candidates: [] }
    : resolveZonedInput(dateEdits[field], current.timezone, dateChoices[field]);
  const eventDateResult = (id: string, field: DateField, iso: string): ZonedInputResult => eventDateEdits[`${id}:${field}`] === undefined ? { iso, candidates: [] }
    : resolveZonedInput(eventDateEdits[`${id}:${field}`], current.timezone, eventDateChoices[`${id}:${field}`]);
  const datesInvalid = Boolean(dateResult('startsAt').error || dateResult('endsAt').error || Date.parse(current.endsAt) <= Date.parse(current.startsAt)
    || current.eventWindows?.some(event => eventDateResult(event.id, 'startsAt', event.startsAt).error || eventDateResult(event.id, 'endsAt', event.endsAt).error || Date.parse(event.endsAt) <= Date.parse(event.startsAt)));
  const advancedInvalid = current.exposureGroups?.some(group => !group.label.trim() || !group.tickers.length)
    || current.eventWindows?.some(event => !event.label.trim() || !event.tickers.length);
  const evidenceInvalid = current.rules.some(rule => !rule.evidenceIds.length || rule.evidenceIds.some(id => !current.references.some(ref => ref.versionId === id)));
  const clearDateEdits = () => { setDateEdits({}); setDateChoices({}); setEventDateEdits({}); setEventDateChoices({}); };
  const updateDate = (field: DateField, value: string, choice?: string) => {
    setDateEdits(previous => ({ ...previous, [field]: value })); setDateChoices(previous => ({ ...previous, [field]: choice }));
    const parsed = resolveZonedInput(value, current.timezone, choice);
    if (parsed.iso) set(field === 'startsAt' ? { startsAt: parsed.iso } : { endsAt: parsed.iso, rules: current.rules.map(rule => ({ ...rule, expiresAt: parsed.iso })) });
  };
  const tickersFromText = (value: string) => [...new Set(value.toUpperCase().split(/[\s,，]+/u).filter(Boolean))];
  const updateEvent = (id: string, patch: Partial<NonNullable<StrategyMandateInput['eventWindows']>[number]>) => set({ eventWindows: current.eventWindows?.map(event => event.id === id ? { ...event, ...patch } : event) });
  const updateEventDate = (id: string, field: DateField, value: string, choice?: string) => {
    const key = `${id}:${field}`; setEventDateEdits(previous => ({ ...previous, [key]: value }));
    setEventDateChoices(previous => ({ ...previous, [key]: choice ?? '' }));
    const parsed = resolveZonedInput(value, current.timezone, choice);
    if (parsed.iso) updateEvent(id, { [field]: parsed.iso });
  };
  const errorText = (error: unknown) => {
    const e = error as { response?: { data?: { message?: string | string[] } }; message?: string };
    const message = e.response?.data?.message ?? e.message;
    if (message === 'REPORT_TRANSITIVE_SOURCE_INVALID') return text('包含失效引用，请用新资料修订可执行结论。', 'Evidence includes an invalid dependency. Revise the executable conclusion using current sources.');
    return Array.isArray(message) ? message.join('; ') : String(message ?? text('操作失败', 'Request failed'));
  };
  const reload = async () => { await cache.invalidateQueries({ queryKey: ['strategy-mandates', accountId] });
    if (linkedStrategyId) await cache.invalidateQueries({ queryKey: ['strategy-mandate-version', linkedStrategyId] });
    await cache.invalidateQueries({ queryKey: ['builder', 'profiles'] }); await cache.invalidateQueries({ queryKey: ['paper', 'overview'] }); };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); try { await action(); await reload(); } catch (error) { toast.error(errorText(error)); } finally { setBusy(false); }
  };
  const save = async () => {
    if (datesInvalid) throw new Error(text('请先修正日期或明确夏令时重复时段。', 'Correct the dates and resolve any repeated DST time first.'));
    if (advancedInvalid) throw new Error(text('请补全篮子和事件窗口的名称与标的。', 'Complete names and tickers for each basket and event window.'));
    if (evidenceInvalid) throw new Error(text('请为每条规则选择至少一份固定依据。', 'Select at least one pinned source for every rule.'));
    const saved = editing ? await api.updateStrategyMandate(editing.id, current, editing.revision) : await api.createStrategyMandate(current);
    setEditing(saved); setForm(saved); toast.success(text('草稿已保存；发布后才开始授权范围内的模拟', 'Draft saved. Publish to authorize bounded paper execution.'));
    return saved;
  };
  const edit = (item: StrategyMandate) => { clearDateEdits(); setAdvancedText({}); setEditing(item); setForm(item); setOpen(true); };
  const statusName = (status: string) => ({ draft: text('草稿', 'Draft'), extracting: text('AI 提炼中', 'AI drafting'), published: text('已发布', 'Published'),
    paused: text('已暂停', 'Paused'), expired: text('已到期', 'Expired'), superseded: text('已替换', 'Superseded') }[status] ?? status);
  const routeName = (route: string) => ({ direct: text('硬规则直达', 'Rule execution'), ai: text('AI 补判', 'AI review'),
    council: text('多 Agent 研讨', 'Council review'), blocked: text('已阻止', 'Blocked') }[route] ?? route);
  const updateRule = (index: number, change: Partial<MandateRule>) => set({ rules: current.rules.map((rule, i) => i === index ? { ...rule, ...change } : rule) });
  return <Card id="strategy-workbench">
    <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
      <div><CardTitle>{text('研究策略与执行', 'Research strategy & execution')}</CardTitle>
        <p className="mt-2 text-sm text-muted-foreground">{text('固定报告版本 → 发布期间策略 → 每日规则监控 → 执行复盘', 'Pinned research → Period mandate → Daily monitoring → Execution review')}</p></div>
      <Button variant="outline" disabled={!accountId} onClick={() => { clearDateEdits(); setAdvancedText({}); setEditing(null); setForm({ ...newForm, ...strategyPeriodDates('day', newTimezone) }); setOpen(true); }}>
        <Plus className="mr-2 size-4" />{text('新建策略', 'New strategy')}</Button>
    </CardHeader>
    <CardContent className="space-y-5">
      {linkedStrategyId && linkedStrategy.isPending && <p role="status" className="text-sm">{text('正在读取关联策略版本…', 'Loading the linked strategy version…')}</p>}
      {linkedStrategyId && linkedStrategy.isError && <p role="alert" className="text-sm text-destructive">{text('关联策略不存在或不属于当前账户。', 'The linked strategy is unavailable or belongs to another workspace.')}</p>}
      {linkedStrategyId && linkedStrategy.data && <article className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4" data-strategy-version={linkedStrategy.data.id} data-read-only={true}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{linkedStrategy.data.title} · V{linkedStrategy.data.version}</h3><Badge variant="outline">{text('关联版本 · 只读', 'Linked version · read only')}</Badge></div>
        <p className="text-sm text-muted-foreground">{text('查看历史依据不会切换模拟账户或启动、暂停任何交易。', 'Viewing this history does not switch accounts, start or stop trading.')}</p>
        <p className="break-all text-xs">{text('所属实验：', 'Experiment: ')}{linkedStrategy.data.accountId} · {statusName(linkedStrategy.data.status)}</p>
        <p className="text-sm">{linkedStrategy.data.objective}</p>
        <p className="text-xs">{businessTime(linkedStrategy.data.startsAt, linkedStrategy.data.timezone)} — {businessTime(linkedStrategy.data.endsAt, linkedStrategy.data.timezone)} · {linkedStrategy.data.timezone}</p>
        <p className="text-xs">{text('单股 / 日增险 / 日换手上限：', 'Position / daily increase / turnover caps: ')}{linkedStrategy.data.limits.maxPositionPct}% / {linkedStrategy.data.limits.maxDailyIncreasePct}% / {linkedStrategy.data.limits.maxDailyTurnoverPct}%</p>
        <ul className="space-y-2 text-sm">{linkedStrategy.data.rules.map(rule => <li key={rule.id} className="rounded border p-2"><strong>{rule.ticker} · {rule.side}</strong> · {rule.id}<p>{rule.trigger.kind} {rule.trigger.value} · {text('价格带', 'Price band')} {rule.minPrice}–{rule.maxPrice} · {text('止损', 'Stop')} {rule.stopLossPrice}</p><p className="text-muted-foreground">{rule.rationale}</p></li>)}</ul>
        <div className="flex flex-wrap gap-3 text-xs">{linkedStrategy.data.references.map(ref => <Link key={ref.versionId + ref.sectionId} className="underline" to={'/analysis/reports/' + ref.versionId + (ref.sectionId ? '#' + ref.sectionId : '')}>{text('固定报告', 'Pinned report')} {ref.sectionId ?? ref.versionId.slice(0, 8)}</Link>)}
          {linkedStrategy.data.sourceSessionId && <Link className="underline" to={'/council?session=' + linkedStrategy.data.sourceSessionId}>{text('来源讨论', 'Source discussion')}</Link>}</div>
      </article>}
      <div className="rounded-lg border p-3 text-sm">
        <strong>{text('运行状态', 'Monitor health')}</strong>
        <p className="mt-1 text-muted-foreground">{text('最后心跳：', 'Last heartbeat: ')}{workspace.data?.monitor?.lastHeartbeat
          ? new Date(workspace.data.monitor.lastHeartbeat).toLocaleString() : text('尚未启动监控', 'Monitoring has not started')}
          {workspace.data?.monitor?.lastHeartbeat && Date.now() - Date.parse(workspace.data.monitor.lastHeartbeat) > 180000
            ? text(' · 心跳已中断，当前无法确认持续监控', ' · Heartbeat interrupted; monitoring continuity is unconfirmed') : ''}</p>
        {!!workspace.data?.monitor?.gaps.length && <details className="mt-2"><summary>{text('离线缺口与恢复记录', 'Offline gaps & recovery')}</summary>
          {workspace.data.monitor.gaps.map(gap => <p key={gap.from} className="mt-1 text-xs">{new Date(gap.from).toLocaleString()} → {new Date(gap.to).toLocaleString()}</p>)}
          <p className="mt-1 text-xs text-muted-foreground">{text('过期候选已取消并释放额度；未补记任何历史成交。', 'Expired candidates release their reservations. No historical fills are fabricated.')}</p></details>}
        {!!workspace.data?.monitor?.reviews.length && <div className="mt-2 flex flex-wrap gap-3">{workspace.data.monitor.reviews.map(review => review.reportVersionId
          ? <Link className="text-xs underline" key={review.id} to={'/analysis/reports/' + review.reportVersionId}>{text('自动复盘', 'Automatic review')} {review.from} — {review.to}</Link>
          : <span key={review.id} className="text-xs text-muted-foreground">{review.from} · {review.state}</span>)}</div>}
      </div>
      <div className="grid gap-3 rounded-lg bg-muted/40 p-4 text-sm md:grid-cols-3">
        <div><strong>{text('1. 硬规则直达', '1. Direct rules')}</strong><p className="mt-1 text-muted-foreground">{text('条件明确、风险较低时直接模拟执行；保护性退出优先。', 'Measurable, low-risk rules execute directly. Protective exits take priority.')}</p></div>
        <div><strong>{text('2. AI 补判', '2. AI review')}</strong><p className="mt-1 text-muted-foreground">{text('存在定性条件时检查证据；无法判断则等待或升级。', 'Qualitative conditions require evidence. Uncertainty waits or escalates.')}</p></div>
        <div><strong>{text('3. 多 Agent 研讨', '3. Council')}</strong><p className="mt-1 text-muted-foreground">{text('大额增仓或高持仓占比先研讨；所有路径重新通过硬风控。', 'Large exposure increases require deliberation. Every route rechecks hard limits.')}</p></div>
      </div>
      {workspace.isError && <p role="alert" className="text-sm text-destructive">{errorText(workspace.error)}</p>}
      {!workspace.data?.items.length && <p className="text-sm text-muted-foreground">{text('从单股报告、组合日报或研讨结论生成策略草稿，再在这里确认范围与规则。', 'Create a draft from a stock report, portfolio report or research discussion, then review its scope and rules here.')} <Link className="underline" to="/analysis">{text('查看报告', 'View reports')}</Link></p>}
      <div className="space-y-3">{workspace.data?.items.map(item => <article key={item.id} className="rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">{item.title} <span className="text-muted-foreground">V{item.version}</span></h3><Badge variant={item.status === 'published' ? 'default' : 'outline'}>{statusName(item.status)}</Badge>
        </div>
        <p className="mt-2 text-sm">{item.objective}</p>
        <p className="mt-1 text-xs text-muted-foreground">{businessTime(item.startsAt, item.timezone)} — {businessTime(item.endsAt, item.timezone)} · {item.timezone} · {item.rules.length} {text('条规则', 'rules')}</p>
        <div className="mt-3 flex flex-wrap gap-2">{item.references.map(ref => <Link key={ref.versionId + ref.sectionId} to={'/analysis/reports/' + ref.versionId} className="inline-flex items-center gap-1 text-xs underline"><FileText className="size-3" />{text('依据报告', 'Pinned report')} {ref.sectionId ?? ref.versionId.slice(0, 8)}</Link>)}
          {item.sourceSessionId && <Link className="text-xs underline" to={'/council?sessionId=' + item.sourceSessionId}>{text('来源研讨', 'Source discussion')}</Link>}</div>
        {!!item.sourceWarnings.length && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{item.sourceWarnings.join(' · ')}</p>}
        {!!item.researchAlerts?.length && <div className="mt-2 space-y-1">{item.researchAlerts.map(alert => <p key={alert.ruleId} className="text-xs">
          <Link className="underline" to={'/council?session=' + alert.sessionId}>{text('补充研讨：', 'Evidence review: ')}{alert.ruleId}</Link>
          <span className="ml-2 text-muted-foreground">{text('资料失效，增加风险的规则已冻结；请补充资料并发布新版本。', 'Evidence invalid. New exposure is frozen; publish a revision using current sources.')}</span>
        </p>)}</div>}
        <div className="mt-3 flex flex-wrap gap-2">
          {item.status === 'draft' && <><Button size="sm" variant="outline" onClick={() => edit(item)}>{text('编辑草稿', 'Edit draft')}</Button>
            <Button size="sm" disabled={busy} onClick={() => setPublishTarget(item)}><Play className="mr-1 size-3" />{text('检查并发布', 'Review & publish')}</Button></>}
          {item.status === 'published' && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { await api.pauseStrategyMandate(item.id); })}><Pause className="mr-1 size-3" />{text('暂停新交易', 'Pause new trades')}</Button>}
          {item.status === 'extracting' && <Button size="sm" variant="outline" onClick={() => run(async () => { await api.cancelStrategyExtraction(item.id, item.revision); })}>{text('取消或恢复中断的提炼', 'Cancel or recover interrupted drafting')}</Button>}
          {!['draft', 'extracting'].includes(item.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => {
            const dates = strategyPeriodDates(item.period, item.timezone);
            const next = await api.createStrategyMandate({ ...item, ...dates,
              rules: item.rules.map(rule => ({ ...rule, expiresAt: dates.endsAt })) }, item.id);
            edit(next);
          })}><GitBranch className="mr-1 size-3" />{text('修订新版', 'Revise')}</Button>}
        </div>
        {item.status === 'draft' && profiles.data?.filter(profile => profile.id === item.profileId && profile.version !== item.profileVersion).map(profile => <div key={profile.id} className="mt-3 space-y-2 rounded border border-amber-500/40 p-3 text-sm">
          <p>{text('执行团队已变化：', 'The execution team changed: ')}{profile.config.name} V{item.profileVersion} → V{profile.version}。{text('请查看当前团队配置，再明确重新绑定并复核策略。', 'Review the current team configuration, then explicitly rebind and review the strategy.')}</p>
          <Link className="mr-3 text-xs underline" to="/agent-builder">{text('查看团队配置', 'Review team configuration')}</Link>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { const rebound = await api.rebindStrategyProfile(item.id, item.revision, profile.version); edit(rebound); })}>{text('重新绑定团队 V', 'Rebind team V') + profile.version + text(' 并复核', ' & review')}</Button>
        </div>)}
      </article>)}</div>
      {!!workspace.data?.decisions.length && <div className="space-y-2">
        <h3 className="font-medium">{text('最近的候选与路由', 'Recent candidates & routes')}</h3>
        {workspace.data.decisions.slice(0, 20).map(decision => <div key={decision.signalId} className="rounded-md border px-3 py-2 text-sm"><div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{routeName(decision.route)}</Badge><strong>{decision.ticker}</strong>
          <span>{decision.side === 'buy' ? text('买入', 'Buy') : text('卖出', 'Sell')} {decision.quantity}</span>
          <span className="text-muted-foreground">{decision.state} · {decision.reason}</span>
          {decision.councilSessionId && <Link className="ml-auto underline" to={'/council?sessionId=' + decision.councilSessionId}>{text('查看研讨', 'Discussion')}</Link>}
          {decision.orderId && <Link className="underline" to={'/paper?orderId=' + decision.orderId}>{text('成交记录', 'Order')}</Link>}
          </div><details className="mt-2 text-xs"><summary>{text('查看当时依据与最终结果', 'Inspect decision evidence & outcome')}</summary>
            <p className="mt-2">{text('规则 / 日计划版本：', 'Rule / daily plan version: ')}{decision.ruleId} / V{decision.planVersion}</p>
            <p>{text('行情时间 / 候选截止：', 'Quote / candidate expiry: ')}{decision.quoteAt} / {decision.expiresAt}</p>
            <p>{text('最终结果：', 'Final outcome: ')}{decision.finalReason}</p>
            <div className="mt-2 flex flex-wrap gap-3">{decision.references?.map(ref => <Link key={ref.versionId + ref.sectionId} className="underline"
              to={'/analysis/reports/' + ref.versionId + (ref.sectionId ? '#' + ref.sectionId : '')}>{text('原报告与快照', 'Original report & snapshot')} {ref.sectionId ?? ref.versionId.slice(0, 8)}</Link>)}
              {decision.sourceSessionId && <Link className="underline" to={'/council?sessionId=' + decision.sourceSessionId}>{text('来源讨论', 'Source discussion')}</Link>}</div>
          </details>
        </div>)}
      </div>}
    </CardContent>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{text('期间策略草稿', 'Period strategy draft')}</DialogTitle><DialogDescription>{text('保存草稿不会启动交易。发布固定账户、证据版本、期限与额度；每日计划仅使用这些规则。', 'Saving does not authorize trades. Publication freezes the account, evidence versions, period and limits; daily plans use these rules.')}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div><Label htmlFor="mandate-title">{text('策略名称', 'Title')}</Label><Input id="mandate-title" value={current.title} onChange={e => set({ title: e.target.value })} /></div>
          <div><Label htmlFor="mandate-objective">{text('策略目标与失效条件', 'Objective & invalidation')}</Label><textarea id="mandate-objective" className={inputStyle} rows={3} value={current.objective} onChange={e => set({ objective: e.target.value })} /></div>
          <div><Label htmlFor="mandate-profile">{text('执行 Agent', 'Execution agent')}</Label><select id="mandate-profile" className={inputStyle} disabled={Boolean(editing)} value={current.profileId} onChange={e => set({ profileId: e.target.value })}><option value="">{text('请选择', 'Select')}</option>{profiles.data?.map(p => <option value={p.id} key={p.id}>{p.config.name} · {p.status} · V{p.version}</option>)}</select>
            <p className="mt-1 text-xs text-muted-foreground">{text('发布时会同时启动选定 Agent 与当前模拟账户监控；模型连接需已配置。', 'Publication also starts the selected agent and account monitoring. Model connections must be configured.')} <Link to="/agent-builder" className="underline">{text('配置 Agent', 'Configure agent')}</Link></p></div>
          {profiles.isError && <p role="alert" className="text-sm text-destructive">{text('团队列表加载失败，请刷新后重试。', 'Teams could not be loaded. Refresh and try again.')}</p>}
          {profiles.data?.length === 0 && !showTeamSetup && <div className="space-y-2 rounded-lg border border-dashed p-3"><p className="text-sm text-muted-foreground">{text('尚未创建执行团队，可先建立默认研究团队草稿，再继续填写策略。', 'Create your first research team draft, then continue the strategy.')}</p><Button size="sm" variant="outline" onClick={() => setShowTeamSetup(true)}>{text('创建默认研究执行团队', 'Create default research team')}</Button></div>}
          {showTeamSetup && <StrategyTeamSetup onCancel={() => setShowTeamSetup(false)} onCreated={profile => {
            cache.setQueryData<typeof profiles.data>(['builder', 'profiles'], previous => [...(previous ?? []), profile]);
            set({ profileId: profile.id }); setShowTeamSetup(false);
            toast.success(text('团队草稿已创建，尚未启动监控。', 'Team draft created. Monitoring has not started.'));
          }} />}
          <div><Label htmlFor="mandate-timezone">{text('业务时区', 'Business timezone')}</Label><select id="mandate-timezone" className={inputStyle} value={current.timezone} onChange={event => { clearDateEdits(); set({ timezone: event.target.value }); }}>
            {[...new Set([current.timezone, 'Asia/Shanghai', 'Asia/Hong_Kong', 'America/New_York', 'UTC'])].map(zone => <option value={zone} key={zone}>{zone}</option>)}
          </select><p className="mt-1 text-xs text-muted-foreground">{text('下列时间均按此时区解释。当日和当月按此时区划分；切换时区保留已选实际时点。市场交易时段仍按各交易所日历判断。', 'Dates below use this zone. Today and this month follow its calendar. Changing zones preserves the selected instants; market sessions still follow each exchange calendar.')}</p></div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label htmlFor="mandate-period">{text('期间', 'Period')}</Label><select id="mandate-period" className={inputStyle} value={current.period} onChange={e => {
              const period = e.target.value as StrategyMandateInput['period']; const dates = strategyPeriodDates(period, current.timezone); clearDateEdits();
              set({ period, ...dates, rules: current.rules.map(rule => ({ ...rule, expiresAt: dates.endsAt })) });
            }}><option value="day">{text('当日', 'Today')}</option><option value="month">{text('当月', 'This month')}</option><option value="custom">{text('自定义', 'Custom')}</option></select></div>
            {(['startsAt', 'endsAt'] as const).map(field => <BusinessDateField key={field} id={field === 'startsAt' ? 'mandate-start' : 'mandate-end'} label={field === 'startsAt' ? text('生效时间', 'Starts') : text('到期时间', 'Expires')}
              value={dateEdits[field] ?? zonedInput(current[field], current.timezone)} result={dateResult(field)} timezone={current.timezone} text={text}
              onChange={value => updateDate(field, value)} onChoose={choice => updateDate(field, dateEdits[field] ?? zonedInput(current[field], current.timezone), choice)} />)}
          </div>
          {Date.parse(current.endsAt) <= Date.parse(current.startsAt) && <p role="alert" className="text-xs text-destructive">{text('到期时间必须晚于生效时间。', 'Expiry must be after the start time.')}</p>}
          <div className="rounded-md bg-muted/50 p-3 text-sm">{text('固定依据：', 'Pinned sources: ')}{current.references.length ? current.references.map(ref => <Link key={ref.versionId} className="mr-3 underline" to={'/analysis/reports/' + ref.versionId}>{source.data?.version.id === ref.versionId ? source.data.version.title : ref.versionId.slice(0, 8)}</Link>) : <Link to="/analysis" className="underline">{text('请从报告页选择“形成策略”', 'Choose “Create strategy” on a report')}</Link>}</div>
          <details className="rounded-md border p-3"><summary className="text-sm">{text('选择更多报告或历史版本', 'Select more reports or historical versions')}</summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-3"><Input aria-label={text('搜索报告', 'Search reports')} value={reportSearch} onChange={e => setReportSearch(e.target.value)} placeholder={text('标题或股票代码', 'Title or ticker')} />
              <Input type="date" aria-label={text('报告开始日期', 'Reports from')} value={reportFrom} onChange={e => setReportFrom(e.target.value)} />
              <Input type="date" aria-label={text('报告结束日期', 'Reports to')} value={reportTo} onChange={e => setReportTo(e.target.value)} /></div>
            <div className="mt-3 max-h-48 space-y-2 overflow-auto">{reportLibrary.data?.items.map(report => {
              const checked = current.references.some(ref => ref.versionId === report.id);
              return <label key={report.id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={checked} data-report-version={report.id}
                disabled={!checked && (report.status !== 'valid' || report.sourceStatus !== 'available' || current.references.length >= 20)}
                onChange={e => set({ references: e.target.checked ? [...current.references, { versionId: report.id }]
                  : current.references.filter(ref => ref.versionId !== report.id),
                  ...(!e.target.checked ? { rules: current.rules.map(rule => ({ ...rule, evidenceIds: rule.evidenceIds.filter(id => id !== report.id) })) } : {}) })} /><span>{report.title} · V{report.version} · {new Date(report.createdAt).toLocaleDateString()}</span></label>;
            })}</div>
            {reportLibrary.isError && <p className="mt-2 text-xs text-destructive">{errorText(reportLibrary.error)}</p>}
          </details>
          <div className="grid gap-3 sm:grid-cols-3">{([
            ['maxPositionPct', text('单股持仓上限 %', 'Position cap %')], ['maxDailyIncreasePct', text('每日新增风险上限 %', 'Daily increase %')],
            ['maxDailyTurnoverPct', text('每日换手上限 %', 'Daily turnover %')],
          ] as const).map(([key, label]) => <div key={key}><Label htmlFor={'limit-' + key}>{label}</Label><Input id={'limit-' + key} type="number" min="0.1" max={key === 'maxDailyTurnoverPct' ? 200 : 100} step="0.1" value={current.limits[key]} onChange={e => set({ limits: { ...current.limits, [key]: Number(e.target.value) } })} /></div>)}</div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label htmlFor="route-position">{text('达到仓位上限的多少 % 时研讨', 'Council at % of position cap')}</Label><Input id="route-position" type="number" min="10" max="100" value={Math.round(current.routePolicy.councilPositionCapRatio * 100)} onChange={e => set({ routePolicy: { ...current.routePolicy, councilPositionCapRatio: Number(e.target.value) / 100 } })} /></div>
            <div><Label htmlFor="route-increase">{text('累计新增占净值 % 时研讨', 'Council at cumulative NAV %')}</Label><Input id="route-increase" type="number" min="0.1" step="0.1" value={current.routePolicy.councilIncrementPct} onChange={e => set({ routePolicy: { ...current.routePolicy, councilIncrementPct: Number(e.target.value) } })} /></div>
            <div><Label htmlFor="route-window">{text('累计窗口（分钟）', 'Rolling window (minutes)')}</Label><Input id="route-window" type="number" min="1" max="1440" value={current.routePolicy.rollingWindowMinutes} onChange={e => set({ routePolicy: { ...current.routePolicy, rollingWindowMinutes: Number(e.target.value) } })} /></div>
          </div>
          <details className="space-y-4 rounded-lg border p-4"><summary className="cursor-pointer font-medium">{text('高级授权：每日计划、组合上限与事件', 'Advanced authorization: daily plans, portfolio caps & events')}</summary>
            <div className="mt-4"><Label htmlFor="mandate-daily-plan-mode">{text('每日计划权限', 'Daily planning authorization')}</Label><select id="mandate-daily-plan-mode" className={inputStyle} value={current.dailyPlanMode ?? 'fixed_rules'} onChange={event => set({ dailyPlanMode: event.target.value as StrategyMandateInput['dailyPlanMode'] })}>
              <option value="fixed_rules">{text('固定已发布规则', 'Keep published rules fixed')}</option><option value="bounded_ai">{text('允许 AI 每日收紧规则', 'Allow AI to tighten rules daily')}</option>
            </select><p className="mt-1 text-xs text-muted-foreground">{current.dailyPlanMode === 'bounded_ai'
              ? text('AI 只可缩小价格带、降低仓位、提高止损或暂停规则；不能增加标的或改变方向。模型失败时当日等待，下一日或新策略再评估。', 'AI may narrow price bands, reduce exposure, raise stops or suspend rules. It cannot add tickers or change direction. A model failure waits until the next day or a new mandate.')
              : text('每日沿用发布时的规则，新的市场观点须修订并发布新版本。', 'Daily plans retain the published rules. New market views require a newly published version.')}</p></div>
            <div className="grid gap-3 sm:grid-cols-3">{([
              ['minCashPct', text('最低现金占比 %', 'Minimum cash %'), 0, 0], ['maxGrossExposurePct', text('总持仓敞口上限 %', 'Gross exposure cap %'), 100, 0.1], ['maxOrderPct', text('单笔金额占净值上限 %', 'Order / NAV cap %'), 100, 0.1],
            ] as const).map(([key, label, fallback, minimum]) => <div key={key}><Label htmlFor={'limit-' + key}>{label}</Label><Input id={'limit-' + key} type="number" min={minimum} max={100} step="0.1" value={current.limits[key] ?? fallback} onChange={event => set({ limits: { ...current.limits, [key]: Number(event.target.value) } })} /></div>)}</div>
            <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{text('行业或自定义篮子上限', 'Sector or custom basket caps')}</h4><Button size="sm" variant="outline" disabled={(current.exposureGroups?.length ?? 0) >= 20} onClick={() => set({ exposureGroups: [...(current.exposureGroups ?? []), { id: 'group_' + crypto.randomUUID().slice(0, 8), label: '', tickers: [], maxExposurePct: 30 }] })}>{text('添加篮子', 'Add basket')}</Button></div><p className="text-xs text-muted-foreground">{text('明确填写每组标的，系统不推断行业归属。重叠标的同时受各组上限约束。', 'List each group’s tickers explicitly. Industry membership is not inferred. Overlapping tickers must satisfy every group cap.')}</p>
              {(current.exposureGroups ?? []).map(group => <fieldset className="grid gap-2 rounded-md border p-3 sm:grid-cols-3" key={group.id}><div><Label htmlFor={group.id + '-label'}>{text('篮子名称', 'Basket name')}</Label><Input id={group.id + '-label'} maxLength={120} value={group.label} onChange={event => set({ exposureGroups: current.exposureGroups?.map(item => item.id === group.id ? { ...item, label: event.target.value } : item) })} /></div>
                <div><Label htmlFor={group.id + '-tickers'}>{text('标的（逗号分隔）', 'Tickers (comma-separated)')}</Label><Input id={group.id + '-tickers'} placeholder="AAPL, MSFT" value={advancedText[group.id] ?? group.tickers.join(', ')} onChange={event => { const value = event.target.value; setAdvancedText(previous => ({ ...previous, [group.id]: value })); set({ exposureGroups: current.exposureGroups?.map(item => item.id === group.id ? { ...item, tickers: tickersFromText(value) } : item) }); }} /></div>
                <div><Label htmlFor={group.id + '-cap'}>{text('合计敞口上限 %', 'Combined exposure cap %')}</Label><Input id={group.id + '-cap'} type="number" min="0.1" max="100" step="0.1" value={group.maxExposurePct} onChange={event => set({ exposureGroups: current.exposureGroups?.map(item => item.id === group.id ? { ...item, maxExposurePct: Number(event.target.value) } : item) })} /></div><Button variant="ghost" size="sm" onClick={() => set({ exposureGroups: current.exposureGroups?.filter(item => item.id !== group.id) })}>{text('移除篮子', 'Remove basket')}</Button>
              </fieldset>)}
            </section>
            <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{text('重大事件窗口', 'Material event windows')}</h4><Button size="sm" variant="outline" disabled={(current.eventWindows?.length ?? 0) >= 30} onClick={() => set({ eventWindows: [...(current.eventWindows ?? []), { id: 'event_' + crypto.randomUUID().slice(0, 8), label: '', tickers: [], startsAt: current.startsAt, endsAt: current.endsAt }] })}>{text('添加事件窗口', 'Add event window')}</Button></div><p className="text-xs text-muted-foreground">{text('在明确指定的事件窗口内，相关普通候选须升级至多 Agent 研讨；保护性退出仍优先。时间使用上方业务时区。', 'During an explicit event window, ordinary candidates for these tickers require Council review. Protective exits retain priority. Times use the business timezone above.')}</p>
              {(current.eventWindows ?? []).map(event => <fieldset key={event.id} className="space-y-3 rounded-md border p-3"><div className="grid gap-2 sm:grid-cols-2"><div><Label htmlFor={event.id + '-label'}>{text('事件名称', 'Event name')}</Label><Input id={event.id + '-label'} maxLength={120} value={event.label} onChange={change => updateEvent(event.id, { label: change.target.value })} /></div><div><Label htmlFor={event.id + '-tickers'}>{text('相关标的（逗号分隔）', 'Affected tickers (comma-separated)')}</Label><Input id={event.id + '-tickers'} value={advancedText[event.id] ?? event.tickers.join(', ')} onChange={change => { const value = change.target.value; setAdvancedText(previous => ({ ...previous, [event.id]: value })); updateEvent(event.id, { tickers: tickersFromText(value) }); }} /></div></div>
                <div className="grid gap-2 sm:grid-cols-2">{(['startsAt', 'endsAt'] as const).map(field => <BusinessDateField key={field} id={event.id + '-' + field} label={field === 'startsAt' ? text('窗口开始', 'Window starts') : text('窗口结束', 'Window ends')}
                  value={eventDateEdits[`${event.id}:${field}`] ?? zonedInput(event[field], current.timezone)} result={eventDateResult(event.id, field, event[field])} timezone={current.timezone} text={text}
                  onChange={value => updateEventDate(event.id, field, value)} onChoose={choice => updateEventDate(event.id, field, eventDateEdits[`${event.id}:${field}`] ?? zonedInput(event[field], current.timezone), choice)} />)}</div>
                {Date.parse(event.endsAt) <= Date.parse(event.startsAt) && <p role="alert" className="text-xs text-destructive">{text('窗口结束时间必须晚于开始时间。', 'The event window must end after it starts.')}</p>}<Button size="sm" variant="ghost" onClick={() => set({ eventWindows: current.eventWindows?.filter(item => item.id !== event.id) })}>{text('移除窗口', 'Remove window')}</Button>
              </fieldset>)}
            </section>
          </details>
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{text('可执行规则', 'Executable rules')}</h3><div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy || datesInvalid || advancedInvalid || !current.references.length || !current.profileId} onClick={() => run(async () => { const saved = await save(); const result = await api.extractStrategyMandate(saved.id, saved.revision); setEditing(result); setForm(result); })}>{busy && <Loader2 className="mr-1 size-3 animate-spin" />}{text('AI 提炼草稿', 'Draft with AI')}</Button>
            <Button variant="outline" size="sm" onClick={() => set({ rules: [...current.rules, blankRule(current.references[0]?.versionId ?? '', current.endsAt)] })}>{text('添加规则', 'Add rule')}</Button>
          </div></div>
          {current.rules.map((rule, index) => <fieldset key={rule.id} className="space-y-3 rounded-lg border p-3">
            <legend className="px-2 text-sm font-medium">{text('规则', 'Rule')} {index + 1}</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              <div><Label htmlFor={rule.id + '-ticker'}>{text('股票代码', 'Ticker')}</Label><Input id={rule.id + '-ticker'} value={rule.ticker} placeholder="AAPL / 0700.HK / 600519.SS" onChange={e => updateRule(index, { ticker: e.target.value.toUpperCase() })} /></div>
              <div><Label htmlFor={rule.id + '-side'}>{text('方向', 'Side')}</Label><select id={rule.id + '-side'} className={inputStyle} value={rule.side} onChange={e => updateRule(index, { side: e.target.value as 'buy' | 'sell' })}><option value="buy">{text('买入', 'Buy')}</option><option value="sell">{text('卖出', 'Sell')}</option></select></div>
              <div><Label htmlFor={rule.id + '-trigger'}>{text('触发条件', 'Trigger')}</Label><select id={rule.id + '-trigger'} className={inputStyle} value={rule.trigger.kind} onChange={e => updateRule(index, { trigger: { ...rule.trigger, kind: e.target.value as MandateRule['trigger']['kind'] } })}>{STRATEGY_TRIGGER_KINDS.map(kind => <option value={kind} key={kind}>{({ price_above: text('价格 ≥', 'Price ≥'), price_below: text('价格 ≤', 'Price ≤'), sma20_above: text('价格 ≥ 均线 ×', 'Price ≥ SMA20 ×'), sma20_below: text('价格 ≤ 均线 ×', 'Price ≤ SMA20 ×'), rsi14_above: 'RSI14 ≥', rsi14_below: 'RSI14 ≤', volume_ratio_above: text('量比 ≥', 'Volume ratio ≥') })[kind]}</option>)}</select></div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3"><div><Label htmlFor={rule.id + '-value'}>{text('触发阈值', 'Threshold')}</Label><Input id={rule.id + '-value'} type="number" step="any" value={rule.trigger.value} onChange={e => updateRule(index, { trigger: { ...rule.trigger, value: Number(e.target.value) } })} /></div>
              {([['referencePrice', text('参考价', 'Reference price')], ['minPrice', text('有效价格下界', 'Minimum price')], ['maxPrice', text('有效价格上界', 'Maximum price')], ['stopLossPrice', text('保护止损价', 'Protective stop')], ['maxPositionPct', text('该股仓位上限 %', 'Position cap %')]] as const).map(([key, label]) => <div key={key}><Label htmlFor={rule.id + '-' + key}>{label}</Label><Input id={rule.id + '-' + key} type="number" step="any" value={rule[key]} onChange={e => updateRule(index, { [key]: Number(e.target.value) })} /></div>)}</div>
            <div><Label htmlFor={rule.id + '-reason'}>{text('报告依据与理由', 'Report evidence & rationale')}</Label><Input id={rule.id + '-reason'} value={rule.rationale} onChange={e => updateRule(index, { rationale: e.target.value })} /></div>
            <fieldset className="space-y-2 rounded border p-3"><legend className="px-1 text-xs">{text('这条规则的固定依据', 'Pinned evidence for this rule')}</legend>
              {current.references.filter((ref, i, all) => all.findIndex(item => item.versionId === ref.versionId) === i).map(ref => <label key={ref.versionId} className="flex items-start gap-2 text-xs">
                <input id={rule.id + '-evidence-' + ref.versionId} type="checkbox" checked={rule.evidenceIds.includes(ref.versionId)} onChange={event => updateRule(index, { evidenceIds: event.target.checked ? [...rule.evidenceIds, ref.versionId] : rule.evidenceIds.filter(id => id !== ref.versionId) })} />
                <span>{reportLibrary.data?.items.find(report => report.id === ref.versionId)?.title ?? (source.data?.version.id === ref.versionId ? source.data.version.title : ref.versionId.slice(0, 8))}{ref.sectionId ? ' · ' + ref.sectionId : ''}</span>
              </label>)}
              {!rule.evidenceIds.length && <p role="alert" className="text-xs text-destructive">{text('依据已移除，请重新选择后保存；不会自动改用另一份报告。', 'The source was removed. Select evidence before saving; another report is never substituted automatically.')}</p>}
            </fieldset>
            <div><Label htmlFor={rule.id + '-semantic'}>{text('需要 AI 补判的条件（可留空）', 'Qualitative condition for AI (optional)')}</Label><Input id={rule.id + '-semantic'} value={rule.semanticCondition ?? ''} placeholder={text('例如：核实财报未推翻盈利假设', 'For example: confirm earnings did not invalidate the thesis')} onChange={e => updateRule(index, { semanticCondition: e.target.value, reviewMode: e.target.value.trim() ? 'ai' : 'deterministic' })} /></div>
            <Button size="sm" variant="ghost" onClick={() => set({ rules: current.rules.filter((_, i) => i !== index) })}>{text('移除规则', 'Remove rule')}</Button>
          </fieldset>)}
        </div>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{text('关闭', 'Close')}</Button><Button disabled={busy || datesInvalid || advancedInvalid || evidenceInvalid || !current.references.length || !current.profileId} onClick={() => run(async () => { await save(); })}>{busy && <Loader2 className="mr-2 size-4 animate-spin" />}{text('保存草稿', 'Save draft')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(publishTarget)} onOpenChange={value => { if (!value && !busy) setPublishTarget(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{text('发布模拟策略', 'Publish paper strategy')}</DialogTitle><DialogDescription>{text('确认后，AI 可在下列范围内自动模拟交易。超出范围必须发布新版本。', 'After confirmation, AI may simulate trades within these bounds. Changes require a new published version.')}</DialogDescription></DialogHeader>
        {publishTarget && <div className="space-y-3 text-sm">
          <p className="font-medium">{publishTarget.title} · V{publishTarget.version}</p>
          <p>{text('账户：', 'Account: ')}{publishTarget.accountId.slice(0, 8)} · {publishTarget.rules.map(r => r.ticker).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</p>
          <p>{businessTime(publishTarget.startsAt, publishTarget.timezone)} <ArrowRight className="inline size-3" /> {businessTime(publishTarget.endsAt, publishTarget.timezone)} · {publishTarget.timezone}</p>
          <p>{text('仓位 / 日增险 / 日换手上限：', 'Position / daily increase / turnover caps: ')}{publishTarget.limits.maxPositionPct}% / {publishTarget.limits.maxDailyIncreasePct}% / {publishTarget.limits.maxDailyTurnoverPct}%</p>
          <p>{text('最低现金 / 总敞口 / 单笔上限：', 'Minimum cash / gross exposure / order caps: ')}{publishTarget.limits.minCashPct ?? 0}% / {publishTarget.limits.maxGrossExposurePct ?? 100}% / {publishTarget.limits.maxOrderPct ?? 100}%</p>
          <p>{text('每日计划权限：', 'Daily planning: ')}{publishTarget.dailyPlanMode === 'bounded_ai' ? text('AI 可每日收紧规则，不能增加标的、改变方向或放宽上限；失败时当日等待。', 'AI may tighten rules daily. No added tickers, changed direction or relaxed limits; failures wait for the day.') : text('固定已发布规则。', 'Published rules stay fixed.')}</p>
          {!!publishTarget.exposureGroups?.length && <div className="rounded-md border p-3"><strong>{text('篮子敞口上限', 'Basket exposure limits')}</strong>{publishTarget.exposureGroups.map(group => <p key={group.id}>{group.label} · {group.tickers.join(', ')} · ≤ {group.maxExposurePct}% NAV</p>)}</div>}
          {!!publishTarget.eventWindows?.length && <div className="rounded-md border p-3"><strong>{text('需升级研讨的事件窗口', 'Event windows requiring Council review')}</strong>{publishTarget.eventWindows.map(event => <p className="mt-2" key={event.id}>{event.label} · {event.tickers.join(', ')}<span className="block text-xs text-muted-foreground">{businessTime(event.startsAt, publishTarget.timezone)} — {businessTime(event.endsAt, publishTarget.timezone)} · {publishTarget.timezone}</span></p>)}</div>}
          <p>{text('研讨阈值：达到单股上限的', 'Council threshold: ')} {publishTarget.routePolicy.councilPositionCapRatio * 100}% · {publishTarget.routePolicy.rollingWindowMinutes} {text('分钟累计增仓', 'minute cumulative increase')} {publishTarget.routePolicy.councilIncrementPct}% NAV</p>
          {active && <p className="rounded-md bg-amber-500/10 p-3">{text('将替换：', 'Replaces: ')}{active.title} V{active.version}。{text('旧候选和待成交增险指令取消；已有持仓及保护规则保留。', 'Old candidates and pending risk increases are cancelled. Existing holdings and protective stops remain.')}</p>}
          {active && <div className="rounded-md border p-3"><strong>{text('变更明细', 'Publication changes')}</strong>
            <p>{text('单股上限：', 'Position cap: ')}{active.limits.maxPositionPct}% → {publishTarget.limits.maxPositionPct}%</p>
            <p>{text('日增险 / 日换手：', 'Daily increase / turnover: ')}{active.limits.maxDailyIncreasePct}% / {active.limits.maxDailyTurnoverPct}% → {publishTarget.limits.maxDailyIncreasePct}% / {publishTarget.limits.maxDailyTurnoverPct}%</p>
            <p>{text('最低现金 / 总敞口 / 单笔：', 'Cash floor / gross exposure / order: ')}{active.limits.minCashPct ?? 0}% / {active.limits.maxGrossExposurePct ?? 100}% / {active.limits.maxOrderPct ?? 100}% → {publishTarget.limits.minCashPct ?? 0}% / {publishTarget.limits.maxGrossExposurePct ?? 100}% / {publishTarget.limits.maxOrderPct ?? 100}%</p>
            <p>{text('每日计划 / 篮子 / 事件：', 'Daily mode / baskets / events: ')}{active.dailyPlanMode === 'bounded_ai' ? text('AI 收紧', 'AI tightening') : text('固定规则', 'Fixed')} / {active.exposureGroups?.length ?? 0} / {active.eventWindows?.length ?? 0} → {publishTarget.dailyPlanMode === 'bounded_ai' ? text('AI 收紧', 'AI tightening') : text('固定规则', 'Fixed')} / {publishTarget.exposureGroups?.length ?? 0} / {publishTarget.eventWindows?.length ?? 0}</p>
            {publishTarget.rules.map(rule => { const before = active.rules.find(r => r.id === rule.id);
              return <p key={rule.id}>{rule.ticker} · {rule.id} · {before ? JSON.stringify(before) === JSON.stringify(rule) ? text('保留', 'Unchanged') : text('条件或额度有修改', 'Conditions or limits changed') : text('新增', 'Added')}</p>; })}
            {active.rules.filter(rule => !publishTarget.rules.some(next => next.id === rule.id)).map(rule => <p key={rule.id}>{rule.ticker} · {rule.id} · {text('移除', 'Removed')}</p>)}</div>}
          <p>{text('将启用此草稿绑定的 Agent 日策略模式与当前账户监控；其他活动 Agent 将暂停。', 'This enables daily strategy mode and monitoring for the selected agent/account; other active agents are paused.')}</p>
          <p className="text-muted-foreground">{text('到期停止新交易并取消未执行指令；已有保护性退出仍监控。模型离线或评审不确定时等待，不降级自动成交。', 'Expiry cancels new trades and pending instructions; protective exits remain monitored. Model outages or uncertainty wait without bypassing review.')}</p>
        </div>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setPublishTarget(null)}>{text('返回修改', 'Go back')}</Button><Button disabled={busy || !publishTarget?.rules.length} onClick={() => run(async () => { await api.publishStrategyMandate(publishTarget!.id, publishTarget!.revision, active?.id ?? null); setPublishTarget(null); toast.success(text('策略已发布', 'Strategy published')); })}>{text('发布并授权模拟', 'Publish & authorize paper trading')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </Card>;
}
