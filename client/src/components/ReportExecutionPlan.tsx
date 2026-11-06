import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReportExecutionPlan as ExecutionPlan } from '@shared/report-execution-plan.interface';
import type { StrategyDraftInput, StrategySourceInput } from '@shared/user-investment-strategy.interface';
import { fetchResearchDocument } from '@/api/research-documents';
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
  return plan.schemaVersion === 1 && plan.parameterOrigin === 'ai_proposed' && ['ready', 'needs_info', 'no_trade'].includes(plan.readiness)
    && Array.isArray(plan.strategy?.entries) && Array.isArray(plan.gaps) && Array.isArray(plan.preview?.entries) && Array.isArray(plan.preview.issues) ? plan : null;
}
function statusText(plan: ExecutionPlan, zh: boolean) {
  return plan.readiness === 'ready' ? (zh ? '可核对' : 'Ready for review') : plan.readiness === 'no_trade'
    ? (zh ? '暂不交易' : 'No trade proposed') : (zh ? '待补信息' : 'Needs information');
}
function period(startsAt: string, endsAt: string, timezone: string) {
  return `${businessTime(startsAt, timezone)} — ${businessTime(endsAt, timezone)} · ${timezone}`;
}
function strategyText(plan: ExecutionPlan, zh: boolean): string {
  const labels = limitLabels(zh); const language = zh ? 'zh-CN' : 'en'; const content = plan.strategy;
  return [zh ? '执行策略草案（AI 提议，应用前需核对）' : 'Execution strategy draft (AI proposed; review before applying)', content.title, statusText(plan, zh),
    content.body, period(content.startsAt, content.endsAt, content.timezone), plan.noTradeReason,
    ...content.entries.flatMap((entry, index) => [`${index + 1}. ${entry.text}`, plan.preview.entries.find(item => item.id === entry.id)?.explanation[language],
      period(entry.startsAt ?? content.startsAt, entry.endsAt ?? content.endsAt, entry.timezone ?? content.timezone)]),
    zh ? 'AI 提议的风险边界' : 'AI-proposed risk limits',
    ...Object.entries(content.limits ?? {}).map(([key, value]) => `${labels[key as keyof Limits]}: ${value}%`),
    ...plan.gaps.map(gap => `${zh ? '待补信息' : 'Needs information'}: ${gap}`),
    ...plan.preview.issues.map(issue => issue.message[language]),
  ].filter(Boolean).join('\n\n');
}

/** Reads only the saved immutable plan; opening or copying it never interprets or applies a strategy. */
export default function ReportExecutionPlan({ versionId, onAddToStrategy }: { versionId: string; onAddToStrategy?: (source: StrategySourceInput) => void }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [source, setSource] = useState<StrategySourceInput | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const query = useQuery({ queryKey: ['research-document', versionId], queryFn: () => fetchResearchDocument(versionId), enabled: Boolean(versionId), retry: false });
  const version = query.data?.version; const plan = savedPlan(version?.snapshot?.executionPlan);
  if (query.isPending) return <p role="status" className="text-xs text-muted-foreground">{zh ? '正在读取策略草案…' : 'Loading strategy draft…'}</p>;
  if (!version) return <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{zh ? '策略草案暂时不可用。' : 'Strategy draft is unavailable.'}</span><Button size="sm" variant="ghost" onClick={() => void query.refetch()}>{zh ? '重试读取' : 'Retry loading'}</Button></div>;
  if (!plan) {
    const error = version.snapshot?.executionPlanError;
    const message = error === 'invalid' ? (zh ? '本次策略参数未通过校验，暂无可执行方案。' : 'The strategy parameters did not pass validation. No executable plan is available.')
      : error === 'missing' ? (zh ? '本次报告未返回结构化策略草案，暂无可执行方案。' : 'This report did not return a structured strategy proposal. No executable plan is available.')
      : (zh ? '本报告未包含执行策略草案，可更新分析生成。' : 'This report has no execution strategy draft. Update the analysis to generate one.');
    return <p className="rounded-xl bg-muted/30 p-3 text-xs leading-6 text-muted-foreground">{message}</p>;
  }
  const content = plan.strategy; const language = zh ? 'zh-CN' : 'en'; const labels = limitLabels(zh);
  const available = version.status !== 'revoked' && version.sourceStatus !== 'missing';
  const copy = async () => {
    try { await window.navigator.clipboard.writeText(strategyText(plan, zh)); setCopyState('copied'); }
    catch { setCopyState('failed'); }
  };
  return <section aria-label={zh ? '执行策略草案' : 'Execution strategy draft'} className="min-w-0 space-y-4 rounded-xl border bg-primary/5 p-4">
    <header className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{zh ? '执行策略草案' : 'Execution strategy draft'}</h3><p className="mt-1 text-xs leading-6 text-muted-foreground">{zh ? '股票、条件、数量及风险边界由 AI 提议，请先核对草稿，再确认应用到模拟盘。' : 'AI proposes the securities, conditions, amounts and risk limits. Review the draft before confirming application to your simulation.'}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${plan.readiness === 'ready' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>{statusText(plan, zh)}</span></header>
    <div className="space-y-1 text-sm"><h4 className="font-medium [overflow-wrap:anywhere]">{content.title}</h4>{content.body && <p className="whitespace-pre-wrap leading-6 [overflow-wrap:anywhere]">{content.body}</p>}<p className="text-xs leading-6 text-muted-foreground">{period(content.startsAt, content.endsAt, content.timezone)}</p></div>
    {plan.noTradeReason && <p className="rounded-lg bg-background/70 p-3 text-sm leading-6 [overflow-wrap:anywhere]">{plan.noTradeReason}</p>}
    <div className="space-y-3">{content.entries.map((entry, index) => { const preview = plan.preview.entries.find(item => item.id === entry.id); return <article key={entry.id} className="min-w-0 space-y-2 rounded-xl border bg-background/70 p-3"><div className="flex flex-wrap justify-between gap-2 text-xs"><span className="font-medium">{entry.directive?.ticker ?? entry.ticker ?? (zh ? `策略 ${index + 1}` : `Strategy ${index + 1}`)}</span><span className="text-muted-foreground">{preview?.state === 'executable' && plan.readiness === 'ready' ? (zh ? '待核对后应用' : 'Review before applying') : preview?.state === 'expired' ? (zh ? '已到期' : 'Expired') : (zh ? '待补信息或仅观察' : 'Needs information or observation only')}</span></div><p className="whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{entry.text}</p>{preview && <p className="text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">{preview.explanation[language]}</p>}<p className="text-xs leading-6 text-muted-foreground">{period(entry.startsAt ?? content.startsAt, entry.endsAt ?? content.endsAt, entry.timezone ?? content.timezone)}</p></article>; })}</div>
    <div className="space-y-2 rounded-xl border bg-background/50 p-3"><h4 className="text-sm font-medium">{zh ? 'AI 提议的风险边界' : 'AI-proposed risk limits'}</h4>{content.limits ? <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">{Object.entries(content.limits).map(([key, value]) => <div className="flex justify-between gap-2" key={key}><dt className="text-muted-foreground">{labels[key as keyof Limits]}</dt><dd>{value}%</dd></div>)}</dl> : <p className="text-xs text-muted-foreground">{zh ? '尚未明确，应用前需补充并核对。' : 'Not specified. Complete and review limits before applying.'}</p>}</div>
    {(plan.gaps.length > 0 || plan.preview.issues.length > 0) && <div className="space-y-2 text-sm text-amber-700 dark:text-amber-300"><h4 className="font-medium">{zh ? '待补信息与核对事项' : 'Information and checks needed'}</h4><ul className="list-disc space-y-1 pl-5">{[...new Set([...plan.gaps, ...plan.preview.issues.map(issue => issue.message[language])])].map(item => <li className="[overflow-wrap:anywhere]" key={item}>{item}</li>)}</ul></div>}
    {!available && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{zh ? '报告依据已撤回或不可用，请重新研究后再加入草稿。' : 'Report evidence is withdrawn or unavailable. Update the research before adding it to a draft.'}</p>}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => void copy()}>{zh ? '复制策略文本' : 'Copy strategy text'}</Button><Button size="sm" disabled={!available} onClick={() => { const selected: StrategySourceInput = { kind: 'report', versionId, sectionId: 'execution-strategy' }; if (onAddToStrategy) onAddToStrategy(selected); else setSource(selected); }}>{zh ? '加入投资策略草稿' : 'Add to investment draft'}</Button></div>
    {copyState === 'copied' && <p role="status" className="text-xs text-muted-foreground">{zh ? '策略文本已复制。' : 'Strategy text copied.'}</p>}
    {copyState === 'failed' && <div className="space-y-2"><p role="status" className="text-xs text-muted-foreground">{zh ? '自动复制未完成，请选择下方策略文本复制。' : 'Automatic copy failed. Select the strategy text below to copy it.'}</p><textarea aria-label={zh ? '可复制的策略文本' : 'Strategy text for copying'} readOnly className="min-h-40 w-full rounded-lg border bg-background p-3 text-xs leading-6" value={strategyText(plan, zh)} onFocus={event => event.target.select()} /></div>}
    <InvestmentStrategySourceDialog source={source} onClose={() => setSource(null)} />
  </section>;
}
