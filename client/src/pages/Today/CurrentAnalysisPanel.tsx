import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CurrentResearchView, TodayView } from '@shared/simple-experience.interface';
import { cancelCurrentResearch, refreshCurrentResearch,reformatCurrentResearch } from '@/api/simple-experience';
import { Button } from '@/components/ui/button';
import { createRequestIntent, questionPath } from '@/utils/simple-experience';
import { readableResearchText } from '@/utils/research-experience';
import ResearchMarkdown from '@/components/ResearchMarkdown';
import TodaySummary from './TodaySummary';
import CouncilMemberAvatar from '../Council/CouncilMemberAvatar';
import type { StrategySourceInput } from '@shared/user-investment-strategy.interface';
import InvestmentStrategySourceDialog from './InvestmentStrategySourceDialog';
import ReportExecutionPlan from '@/components/ReportExecutionPlan';
import ResumeDailyReportButton from './ResumeDailyReportButton';

export default function CurrentAnalysisPanel({ view, topicKey, date, aiAvailable = true, primary = false, summary,activityView,onAddToStrategy }: {
  view: CurrentResearchView; topicKey: string; date?: string; aiAvailable?: boolean; primary?: boolean; summary?: string | null;
  activityView?:CurrentResearchView;onAddToStrategy?:(source:StrategySourceInput)=>void;
}) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const cancelIntent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const [now, setNow] = useState(Date.now);
  const [strategySource,setStrategySource]=useState<StrategySourceInput|null>(null);
  const reformatIntent=useRef(createRequestIntent(()=>crypto.randomUUID()));
  const applyResearch = (data: CurrentResearchView) => {
    client.setQueryData(['current-research', topicKey, date], data);
    if (topicKey === 'portfolio') client.setQueryData<TodayView>(['today'], previous => previous ? { ...previous, analysis: data } : previous);
    void client.invalidateQueries({ queryKey: ['today'] });
  };
  const refresh = useMutation({ mutationFn: () => {
    const payload = { topicKey, ...(date ? { date } : {}), trigger: 'manual' as const };
    return refreshCurrentResearch({ ...payload, requestKey: intent.current.keyFor(payload) });
  }, retry: false, onSuccess: data => {
    intent.current.complete(); applyResearch(data);
  } });
  const reformat=useMutation({mutationFn:()=>{
    const payload={topicKey,...(date?{date}:{})};return reformatCurrentResearch({...payload,requestKey:reformatIntent.current.keyFor({...payload,taskId:(activityView??view).taskId})});
  },retry:false,onSuccess:data=>{reformatIntent.current.complete();applyResearch(data);}});
  const cancel = useMutation({ mutationFn: () => {
    const payload = { topicKey, ...(date ? { date } : {}) };
    return cancelCurrentResearch({ ...payload, requestKey: cancelIntent.current.keyFor({ ...payload, taskId: view.taskId, startedAt: view.startedAt }) });
  }, retry: false, onSuccess: data => { cancelIntent.current.complete(); applyResearch(data); } });
  // The live query remains authoritative after the initial dispatch receipt.
  const current = view;
  const activity=activityView??current;
  const formattingPending=activity.state==='failed'&&activity.readingState==='pending'&&(!activity.sessionId||Boolean(activity.returnedDocumentId));
  const updating = activity.state === 'generating' || activity.cancelling === true || refresh.isPending;
  useEffect(() => {
    if (!updating || !activity.startedAt) return;
    setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [updating, activity.startedAt]);
  const elapsed = activity.startedAt ? Math.max(0, Math.floor((now - Date.parse(activity.startedAt)) / 1000)) : null;
  const factsOnly = current.researchLevel === 'facts_only' || current.state === 'empty';
  const content = readableResearchText(current.content);
  const readableSummary = readableResearchText(current.summary) || readableResearchText(summary);
  const points = current.keyPoints?.map(readableResearchText).filter(Boolean).slice(0, 3) || [];
  const savedDocumentId = formattingPending ? activity.returnedDocumentId ?? current.documentId : current.documentId;
  const askPath = questionPath(current.documentId ? { versionId: current.documentId } : topicKey.startsWith('ticker:') ? { ticker: topicKey.slice(7) } : { date });
  const title=primary?(zh?'最新持仓报告':'Latest portfolio report'):current.title||(zh?'当前分析':'Current analysis');
  return <section className="research-analysis min-w-0 space-y-4 rounded-2xl border bg-card p-4 sm:p-6" aria-label={title}>
    <header className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-3"><CouncilMemberAvatar avatar="technical" role="researcher" className="mt-1 size-12" /><div className="min-w-0">
      <div className="mb-2 inline-flex rounded-full bg-primary/8 px-2.5 py-1 text-[11px] font-medium text-primary">{formattingPending ? (zh ? '研究已返回 · 内容待整理' : 'Research returned · Formatting pending') : factsOnly ? (zh ? '持仓事实 · 等待 AI 研究' : 'Portfolio facts · AI research pending') : (zh ? 'AI 股友研究' : 'Research by your AI stock friends')}</div>
      <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{title}</h2>
      {current.updatedAt && <p className="mt-1 text-xs text-muted-foreground">{zh ? '更新于 ' : 'Updated '}{new Date(current.updatedAt).toLocaleString(i18n.language)}</p>}
    </div></div><div className="flex min-w-0 flex-wrap gap-2">{!formattingPending&&<Button size="sm" disabled={updating || !aiAvailable} onClick={() => refresh.mutate()}>{updating ? (zh ? '更新中…' : 'Updating…') : activity.state === 'failed' || refresh.isError ? (zh ? '重试分析' : 'Retry analysis') : factsOnly ? (zh ? '开始分析' : 'Start analysis') : (zh ? '更新分析' : 'Update analysis')}</Button>}
      {updating && topicKey === 'portfolio' && <Button size="sm" variant="outline" disabled={cancel.isPending || activity.cancelling} onClick={() => cancel.mutate()}>{cancel.isPending || activity.cancelling ? (zh ? '正在停止…' : 'Stopping…') : (zh ? '停止分析' : 'Stop analysis')}</Button>}
      <Button size="sm" variant="outline" asChild><Link to={askPath}>{zh ? '和股友聊聊' : 'Discuss with stock friends'}</Link></Button>{current.documentId&&current.readingState!=='pending'&&<Button size="sm" variant="outline" onClick={()=>{const source:StrategySourceInput={kind:'report',versionId:current.documentId!};if(onAddToStrategy)onAddToStrategy(source);else setStrategySource(source);}}>{zh?'加入投资策略':'Add to investment strategy'}</Button>}</div></header>
    {updating && <div className="rounded-xl bg-primary/5 p-3 text-sm"><p role="status" className="font-medium">{activity.cancelling ? (zh ? '正在确认执行任务已停止，尚未重新发送。' : 'Confirming that the original task has stopped. No new request has been sent.') : readableResearchText(activity.progress?.message) || (zh ? '分析请求已收到，等待执行股友的最新进度。' : 'Analysis requested. Waiting for the latest status from your stock friends.')}</p>{activity.executorLabel && <p className="mt-1 text-xs text-muted-foreground">{activity.executorLabel}</p>}{elapsed !== null && Number.isFinite(elapsed) && <p aria-live="off" className="mt-1 text-xs tabular-nums text-muted-foreground">{zh ? '已用时 ' : 'Elapsed '}{elapsed < 60 ? `${elapsed}${zh ? '秒' : 's'}` : `${Math.floor(elapsed / 60)}${zh ? '分' : 'm'} ${elapsed % 60}${zh ? '秒' : 's'}`}</p>}</div>}
    {cancel.isError && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{zh ? '停止操作尚未确认，可以重试。原任务的资料继续保留。' : 'Stopping is not confirmed. Retry; the original research remains available.'}</p>}
    {(!formattingPending || readableSummary) && <TodaySummary summary={readableSummary} aiAvailable={aiAvailable} factsOnly={factsOnly} />}
    {formattingPending&&<div role="status" className="space-y-2 text-sm"><p>{zh?'研究已返回，内容整理待核对。原始材料已保留。':'Research returned; formatting needs review. The original material is preserved.'}</p><Button size="sm" variant="outline" disabled={reformat.isPending} onClick={()=>reformat.mutate()}>{zh?'重新整理已有结果':'Reformat saved result'}</Button></div>}
    {formattingPending && reformat.isError && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{zh ? '暂时无法整理已有结果。可以先阅读已保存报告，稍后再试。' : 'Could not reformat the saved result. Read the saved report and retry later.'}</p>}
    {topicKey === 'portfolio' && activity.state === 'failed' && activity.sessionId && !formattingPending && <ResumeDailyReportButton sessionId={activity.sessionId} />}
    {savedDocumentId && <Button size="sm" variant="outline" asChild><Link to={`/analysis/reports/${encodeURIComponent(savedDocumentId)}`}>{zh ? '阅读已保存报告' : 'Read saved report'}</Link></Button>}
    {points.length > 0 && <ol className="grid min-w-0 gap-3 sm:grid-cols-3" aria-label={zh ? '最多三条重点' : 'Up to three key points'}>{points.map((point, index) => <li key={point} className="min-w-0 rounded-xl bg-primary/5 p-3 text-sm leading-6 [overflow-wrap:anywhere]"><span className="mb-2 flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{index + 1}</span>{point}</li>)}</ol>}
    {(current.risks?.length || current.nextChecks?.length) ? <div className="grid gap-4 text-sm sm:grid-cols-2">{[[zh ? '主要风险' : 'Main risks', current.risks], [zh ? '接下来关注' : 'Next checks', current.nextChecks]].map(([label, items]) => Array.isArray(items) && items.length > 0 && <div key={String(label)} className="min-w-0"><h3 className="mb-1 font-medium">{String(label)}</h3><ul className="list-disc space-y-1 pl-4 text-muted-foreground">{items.slice(0, 2).map(item => <li key={item} className="[overflow-wrap:anywhere]">{readableResearchText(item)}</li>)}</ul></div>)}</div> : null}
    {readableResearchText(current.changeSummary) && <p className="rounded-lg bg-primary/5 p-3 text-sm">{readableResearchText(current.changeSummary)}</p>}
    {content && (primary || readableSummary ? <details className="min-w-0 border-t pt-3 text-sm"><summary className="cursor-pointer font-medium">{zh ? '展开完整研究' : 'Read full research'}</summary><div className="mt-4 min-w-0"><ResearchMarkdown>{content}</ResearchMarkdown></div></details> : <ResearchMarkdown>{content}</ResearchMarkdown>)}
    {current.documentId && current.readingState !== 'pending' && <ReportExecutionPlan key={current.documentId} versionId={current.documentId} onAddToStrategy={source => { if (onAddToStrategy) onAddToStrategy(source); else setStrategySource(source); }} />}
    {!formattingPending&&(activity.state === 'failed' || refresh.isError) && <div role="alert" className="space-y-1 rounded-xl bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-300"><p>{zh ? '本次更新未完成，上次完整分析继续保留。可以重试本次分析。' : 'The update did not complete. The last complete analysis remains available. Retry this analysis when ready.'}</p>{readableResearchText(activity.error) && <p className="[overflow-wrap:anywhere]">{readableResearchText(activity.error).slice(0, 280)}</p>}</div>}
    <InvestmentStrategySourceDialog source={strategySource} onClose={()=>setStrategySource(null)}/>
    {current.dataAsOf && <p className="text-xs text-muted-foreground">{zh ? '数据截至：' : 'Data as of: '}{current.dataAsOf}</p>}
    <div className="flex justify-end"><Link className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" to="/analysis#report-history">{zh?'报告历史':'Report history'}</Link></div>
  </section>;
}
