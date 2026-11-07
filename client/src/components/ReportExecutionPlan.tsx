import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ReportExecutionPlan as ExecutionPlan } from '@shared/report-execution-plan.interface';
import type { StrategyDraftInput, StrategySourceInput } from '@shared/user-investment-strategy.interface';
import { strategyImportReadableContent } from '@shared/strategy-source-reading';
import { fetchResearchDocument } from '@/api/research-documents';
import { investmentStrategiesApi } from '@/api/investment-strategies';
import { Button } from '@/components/ui/button';
import InvestmentStrategySourceDialog from '@/pages/Today/InvestmentStrategySourceDialog';
import { businessTime } from '@/utils/strategy-dates';

type Limits = NonNullable<StrategyDraftInput['limits']>;
function limitLabels(zh: boolean): Record<keyof Limits, string> {
  return { maxPositionPct: zh ? '单股仓位上限' : 'Single-position cap', maxOrderPct: zh ? '单笔资金上限' : 'Single-order cap',
    maxDailyIncreasePct: zh ? '每日新增仓位上限' : 'Daily increase cap', maxDailyTurnoverPct: zh ? '每日交易金额上限' : 'Daily turnover cap',
    minCashPct: zh ? '最低现金比例' : 'Minimum cash', maxGrossExposurePct: zh ? '总仓位上限' : 'Gross exposure cap' };
}
function savedPlan(value: unknown): ExecutionPlan | null {
  if (!value || typeof value !== 'object') return null;
  const plan = value as ExecutionPlan;
  return plan.schemaVersion === 1 && ['ai_proposed', 'system_observation'].includes(plan.parameterOrigin) && ['ready', 'needs_info', 'no_trade'].includes(plan.readiness)
    && Array.isArray(plan.strategy?.entries) && Array.isArray(plan.gaps) && Array.isArray(plan.preview?.entries) && Array.isArray(plan.preview.issues) ? plan : null;
}
function statusText(plan: ExecutionPlan, zh: boolean) {
  if (plan.parameterOrigin === 'system_observation') return zh ? '仅观察，不自动交易' : 'Observation only; no automatic trades';
  return plan.readiness === 'ready' ? (zh ? '可核对' : 'Ready for review') : plan.readiness === 'no_trade'
    ? (zh ? '暂不交易' : 'No trade proposed') : (zh ? '待补信息' : 'Needs information');
}
function period(startsAt: string, endsAt: string, timezone: string) {
  return `${businessTime(startsAt, timezone)} — ${businessTime(endsAt, timezone)} · ${timezone}`;
}
function strategyText(plan: ExecutionPlan, zh: boolean): string {
  const labels = limitLabels(zh); const language = zh ? 'zh-CN' : 'en'; const content = plan.strategy;
  const observation = plan.parameterOrigin === 'system_observation';
  return [observation ? (zh ? '系统保留的观察计划（不含自动买卖指令）' : 'System observation plan (no automatic trading instructions)') : zh ? '执行策略草案（AI 提议，应用前需核对）' : 'Execution strategy draft (AI proposed; review before applying)', content.title, statusText(plan, zh),
    content.body, period(content.startsAt, content.endsAt, content.timezone), plan.noTradeReason,
    ...content.entries.flatMap((entry, index) => [`${index + 1}. ${entry.text}`, plan.preview.entries.find(item => item.id === entry.id)?.explanation[language],
      period(entry.startsAt ?? content.startsAt, entry.endsAt ?? content.endsAt, entry.timezone ?? content.timezone)]),
    observation ? '' : zh ? 'AI 提议的风险边界' : 'AI-proposed risk limits',
    ...Object.entries(content.limits ?? {}).map(([key, value]) => `${labels[key as keyof Limits]}: ${value}%`),
    ...plan.gaps.map(gap => `${zh ? '待补信息' : 'Needs information'}: ${gap}`),
    ...plan.preview.issues.map(issue => issue.message[language]),
  ].filter(Boolean).join('\n\n');
}
function importError(error: unknown, zh: boolean): string {
  const payload = (error as { response?: { data?: { message?: string; error?: { message?: string } } } })?.response?.data;
  const message = String(payload?.error?.message ?? payload?.message ?? '');
  if (/not ready for readable publication/iu.test(message)) return zh ? '这份报告没有可复制的可读研究正文，请重新读取报告后再试。' : 'This saved report has no readable research to copy. Reload the report and try again.';
  if (/revoked|not available|not ready/iu.test(message)) return zh ? '这份报告已撤回或暂不可用，请重新读取报告。' : 'This report is withdrawn or unavailable. Reload the report.';
  if (/exceeds 200000|at most 20/iu.test(message)) return zh ? '报告内容过长，请从报告中选择较短章节加入草稿。' : 'This report is too long. Choose a smaller report section for your draft.';
  return zh ? '策略复制暂未完成，请重试。已有策略不会被替换。' : 'Could not copy the strategy. Please retry. Your current strategy has not been replaced.';
}

/** Importing preserves the immutable proposal as a draft; application remains a separate investor action. */
export default function ReportExecutionPlan({ versionId, onAddToStrategy }: { versionId: string; onAddToStrategy?: (source: StrategySourceInput) => void }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const navigate = useNavigate(); const client = useQueryClient(); const importLock = useRef(false);
  const [source, setSource] = useState<StrategySourceInput | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [importing, setImporting] = useState(false); const [importFailed, setImportFailed] = useState('');
  const query = useQuery({ queryKey: ['research-document', versionId], queryFn: () => fetchResearchDocument(versionId), enabled: Boolean(versionId), retry: false });
  const version = query.data?.version; const candidate = savedPlan(version?.snapshot?.executionPlan);
  const plan = version?.snapshot?.executionPlanError && candidate?.parameterOrigin !== 'system_observation' ? null : candidate;
  if (query.isPending) return <p role="status" className="text-xs text-muted-foreground">{zh ? '正在读取策略草案…' : 'Loading strategy draft…'}</p>;
  if (!version) return <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{zh ? '策略草案暂时不可用。' : 'Strategy draft is unavailable.'}</span><Button size="sm" variant="ghost" onClick={() => void query.refetch()}>{zh ? '重试读取' : 'Retry loading'}</Button></div>;
  const available = version.status !== 'revoked' && version.sourceStatus !== 'missing';
  const importPlan = async () => {
    if (importLock.current || !available) return;
    importLock.current = true; setImporting(true); setImportFailed('');
    try {
      const draft = await investmentStrategiesApi.importSource({ kind: 'report', versionId, ...(plan ? { sectionId: 'execution-strategy' } : {}) });
      await client.invalidateQueries({ queryKey: ['investment-strategies'] });
      navigate(`/paper?investmentStrategyId=${encodeURIComponent(draft.id)}#investment-strategy`);
    } catch (error) { setImportFailed(importError(error, zh)); }
    finally { importLock.current = false; setImporting(false); }
  };
  if (!plan) {
    const error = version.snapshot?.executionPlanError;
    const message = error === 'invalid' ? (zh ? '本次策略参数未通过校验，暂无可执行方案。' : 'The strategy parameters did not pass validation. No executable plan is available.')
      : error === 'missing' ? (zh ? '本次报告未返回结构化策略草案，暂无可执行方案。' : 'This report did not return a structured strategy proposal. No executable plan is available.')
      : (zh ? '本报告未包含执行策略草案，可更新分析生成。' : 'This report has no execution strategy draft. Update the analysis to generate one.');
    const readable = strategyImportReadableContent(version).trim();
    return <div role="region" aria-label={zh ? '报告观察草稿' : 'Report observation draft'} className="space-y-3 rounded-xl bg-muted/30 p-3 text-xs leading-6 text-muted-foreground">
      <p>{message}</p><p>{zh ? '可将已有研究正文复制到模拟盘作为观察事项，不会生成买卖条件或自动交易。' : 'Copy the existing research to your simulation as observation items. This does not create trading conditions or automatic trades.'}</p>
      {!readable && <p role="alert">{zh ? '这份报告没有可复制的可读研究正文，请重新读取报告后再试。' : 'This saved report has no readable research to copy. Reload the report and try again.'}</p>}
      {!available && <p role="alert">{zh ? '这份报告已撤回或暂不可用，无法复制。' : 'This report is withdrawn or unavailable and cannot be copied.'}</p>}
      <Button size="sm" disabled={!available || !readable || importing} onClick={() => void importPlan()}>{importing ? (zh ? '正在复制…' : 'Copying…') : (zh ? '复制报告为观察草稿' : 'Copy report as observation draft')}</Button>
      {importFailed && <p role="alert" className="text-destructive">{importFailed}</p>}
    </div>;
  }
  const content = plan.strategy; const language = zh ? 'zh-CN' : 'en'; const labels = limitLabels(zh);
  const observation = plan.parameterOrigin === 'system_observation';
  const copy = async () => {
    try { await window.navigator.clipboard.writeText(strategyText(plan, zh)); setCopyState('copied'); }
    catch { setCopyState('failed'); }
  };
  return <section aria-label={zh ? '执行策略草案' : 'Execution strategy draft'} className="min-w-0 space-y-4 rounded-xl border bg-primary/5 p-4">
    <header className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{observation ? (zh ? '系统保留的观察计划' : 'System observation plan') : zh ? '执行策略草案' : 'Execution strategy draft'}</h3><p className="mt-1 text-xs leading-6 text-muted-foreground">{observation ? (zh ? 'AI 策略暂不可用，系统保留待核查事项。可复制到模拟盘，不含自动买卖指令。' : 'The AI proposal is unavailable. Copy this system follow-up to your simulation as an observation, with no automatic trading instructions.') : zh ? '股票、条件、数量及风险边界由 AI 提议，请先核对草稿，再确认应用到模拟盘。' : 'AI proposes the securities, conditions, amounts and risk limits. Review the draft before confirming application to your simulation.'}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${plan.readiness === 'ready' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>{statusText(plan, zh)}</span></header>
    <div className="space-y-1 text-sm"><h4 className="font-medium [overflow-wrap:anywhere]">{content.title}</h4>{content.body && <p className="whitespace-pre-wrap leading-6 [overflow-wrap:anywhere]">{content.body}</p>}<p className="text-xs leading-6 text-muted-foreground">{period(content.startsAt, content.endsAt, content.timezone)}</p></div>
    {plan.noTradeReason && <p className="rounded-lg bg-background/70 p-3 text-sm leading-6 [overflow-wrap:anywhere]">{plan.noTradeReason}</p>}
    <div className="space-y-3">{content.entries.map((entry, index) => { const preview = plan.preview.entries.find(item => item.id === entry.id); return <article key={entry.id} className="min-w-0 space-y-2 rounded-xl border bg-background/70 p-3"><div className="flex flex-wrap justify-between gap-2 text-xs"><span className="font-medium">{entry.directive?.ticker ?? entry.ticker ?? (zh ? `策略 ${index + 1}` : `Strategy ${index + 1}`)}</span><span className="text-muted-foreground">{preview?.state === 'executable' && plan.readiness === 'ready' ? (zh ? '待核对后应用' : 'Review before applying') : preview?.state === 'expired' ? (zh ? '已到期' : 'Expired') : (zh ? '待补信息或仅观察' : 'Needs information or observation only')}</span></div><p className="whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{entry.text}</p>{preview && <p className="text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">{preview.explanation[language]}</p>}<p className="text-xs leading-6 text-muted-foreground">{period(entry.startsAt ?? content.startsAt, entry.endsAt ?? content.endsAt, entry.timezone ?? content.timezone)}</p></article>; })}</div>
    {!observation && (content.limits || plan.readiness !== 'no_trade') && <div className="space-y-2 rounded-xl border bg-background/50 p-3"><h4 className="text-sm font-medium">{zh ? 'AI 提议的风险边界' : 'AI-proposed risk limits'}</h4>{content.limits ? <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">{Object.entries(content.limits).map(([key, value]) => <div className="flex justify-between gap-2" key={key}><dt className="text-muted-foreground">{labels[key as keyof Limits]}</dt><dd>{value}%</dd></div>)}</dl> : <p className="text-xs text-muted-foreground">{zh ? '尚未明确，应用前需补充并核对。' : 'Not specified. Complete and review limits before applying.'}</p>}</div>}
    {(plan.gaps.length > 0 || plan.preview.issues.length > 0) && <div className="space-y-2 text-sm text-amber-700 dark:text-amber-300"><h4 className="font-medium">{zh ? '待补信息与核对事项' : 'Information and checks needed'}</h4><ul className="list-disc space-y-1 pl-5">{[...new Set([...plan.gaps, ...plan.preview.issues.map(issue => issue.message[language])])].map(item => <li className="[overflow-wrap:anywhere]" key={item}>{item}</li>)}</ul></div>}
    {!available && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{zh ? '报告依据已撤回或不可用，请重新研究后再加入草稿。' : 'Report evidence is withdrawn or unavailable. Update the research before adding it to a draft.'}</p>}
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!available || importing} onClick={() => void importPlan()}>{importing ? (zh ? '正在复制…' : 'Copying…') : (zh ? '一键复制到 AI 模拟盘' : 'Copy to AI simulation')}</Button><Button size="sm" variant="outline" onClick={() => void copy()}>{zh ? '复制策略文本' : 'Copy strategy text'}</Button></div>
    <p className="text-xs leading-6 text-muted-foreground">{zh ? '复制后直接打开模拟盘中的草稿，核对并确认后才开始执行。' : 'Opens the copied draft in your simulation. Review and confirm it there to begin execution.'}</p>
    {importFailed && <p role="alert" className="text-sm text-destructive">{importFailed}</p>}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{zh ? '合并到已有草稿' : 'Add to an existing draft'}</summary><Button className="mt-2" size="sm" variant="ghost" disabled={!available || importing} onClick={() => { const selected: StrategySourceInput = { kind: 'report', versionId, sectionId: 'execution-strategy' }; if (onAddToStrategy) onAddToStrategy(selected); else setSource(selected); }}>{zh ? '选择草稿' : 'Choose a draft'}</Button></details>
    {copyState === 'copied' && <p role="status" className="text-xs text-muted-foreground">{zh ? '策略文本已复制。' : 'Strategy text copied.'}</p>}
    {copyState === 'failed' && <div className="space-y-2"><p role="status" className="text-xs text-muted-foreground">{zh ? '自动复制未完成，请选择下方策略文本复制。' : 'Automatic copy failed. Select the strategy text below to copy it.'}</p><textarea aria-label={zh ? '可复制的策略文本' : 'Strategy text for copying'} readOnly className="min-h-40 w-full rounded-lg border bg-background p-3 text-xs leading-6" value={strategyText(plan, zh)} onFocus={event => event.target.select()} /></div>}
    <InvestmentStrategySourceDialog source={source} onClose={() => setSource(null)} />
  </section>;
}
