import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AiInvestmentView } from '@shared/investment-policy.interface';
import type { StrategyRouteRecord } from '@shared/strategy-mandate.interface';
import { questionPath } from '@/utils/simple-experience';
import { Button } from '@/components/ui/button';
import { fetchInvestmentDecision, type InvestmentDecision } from '@/api/ai-investment';

export function DecisionEvidence({ data, ticker }: { data: InvestmentDecision; ticker: string }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const executors = data.actualExecutors || [];
  const research = (data.actualResearch || []).filter(item => item.ticker === ticker);
  const name = (memberId: string) => executors.find(executor => executor.memberId === memberId)?.connection || memberId;
  return <div className="mt-3 space-y-4 text-sm">
    {data.strategy && <section className="space-y-2 rounded-lg bg-muted/40 p-3"><h4 className="font-medium">{data.strategy.title} · {data.strategy.entryId}</h4><p className="whitespace-pre-wrap break-words leading-6">{data.strategy.text}</p>{data.strategy.route === 'direct' && <p className="text-xs text-muted-foreground">{zh ? '已确认的明确规则通过风险检查后直接执行，无需模型批准。' : 'The confirmed measurable rule passed the risk checks and executed directly without model approval.'}</p>}</section>}
    {executors.length > 0 && <section className="space-y-2"><h4 className="font-medium">{zh ? '当时实际参与的来源' : 'Sources that actually participated'}</h4>{executors.map(executor => <div key={executor.memberId} className="break-words rounded-lg bg-muted/40 p-3"><strong className="font-medium">{executor.connection}</strong><p className="mt-1 text-xs text-muted-foreground">{executor.provider} · {executor.model}</p>{executors.filter(item => item.identity === executor.identity).length > 1 && <p className="mt-1 text-xs text-muted-foreground">{zh ? '共享同一执行来源' : 'Shares one execution source'}</p>}</div>)}</section>}
    {research.map((item, index) => <section key={`${item.ticker}:${index}`} className="space-y-3">
      {!!item.drafts?.length && <div className="space-y-2"><h4 className="font-medium">{zh ? '交易前的独立研究' : 'Independent research before the trade'}</h4>{item.drafts.map((entry, i) => <div key={`${entry.memberId}:${i}`} className="rounded-lg border p-3"><p className="text-xs font-medium">{name(entry.memberId)}</p><p className="mt-1 whitespace-pre-wrap break-words leading-6">{entry.draft.summary}</p></div>)}</div>}
      {!!item.reviews?.length && <div className="space-y-2"><h4 className="font-medium">{zh ? '当时的复核与疑点' : 'Cross-checks and concerns at the time'}</h4>{item.reviews.map((entry, i) => <div key={`${entry.memberId}:${i}`} className="rounded-lg border p-3"><p className="text-xs font-medium">{name(entry.memberId)}</p><p className="mt-1 whitespace-pre-wrap break-words leading-6">{entry.summary}</p>{entry.unresolvedDisagreements?.length > 0 && <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted-foreground">{entry.unresolvedDisagreements.map((point, n) => <li key={n}>{point}</li>)}</ul>}{entry.completedAt && <p className="mt-2 text-xs text-muted-foreground">{new Date(entry.completedAt).toLocaleString(i18n.language)}</p>}</div>)}</div>}
      {item.reason && <p className="break-words text-xs text-muted-foreground">{item.reason}</p>}
    </section>)}
    {data.discussionId && <Link className="block text-primary underline" to={`/council?session=${encodeURIComponent(data.discussionId)}`}>{zh ? '查看实际讨论' : 'View the actual discussion'}</Link>}
    {(data.evidence || []).map((ref, index) => <Link className="block text-primary underline" key={`${ref.versionId}:${index}`} to={`/analysis/reports/${encodeURIComponent(ref.versionId)}${ref.sectionId ? `#${encodeURIComponent(ref.sectionId)}` : ''}`}>{zh ? '当时保存的研究依据' : 'Research evidence saved at the time'}</Link>)}
    {!data.strategy && !executors.length && !research.length && !data.discussionId && <p className="text-xs text-muted-foreground">{zh ? '未保存可验证的交易前参与者或研究记录；原始操作理由仍保留。' : 'No verifiable pre-trade participant or research record was saved. The original action rationale remains available.'}</p>}
  </div>;
}

export default function DecisionCard({ action, decision }: { action: AiInvestmentView['actions'][number]; decision?: StrategyRouteRecord }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [expanded, setExpanded] = useState(false);
  const details = useQuery({ queryKey: ['investment-decision', action.id], queryFn: () => fetchInvestmentDecision(action.id), enabled: expanded, retry: false, staleTime: Infinity });
  const statuses = { filled: zh ? '已成交' : 'Filled', pending: zh ? '等待处理' : 'Pending', pending_approval: zh ? '等待复核' : 'Awaiting review', rejected_risk: zh ? '风险检查未通过' : 'Risk checks blocked', cancelled: zh ? '已取消' : 'Cancelled', failed: zh ? '未完成' : 'Failed' };
  return <article className="space-y-3 rounded-xl border bg-card p-4"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{action.ticker} · {action.side === 'buy' ? (zh ? '买入' : 'Buy') : (zh ? '卖出' : 'Sell')} {action.quantity}</h3><span className="text-xs text-muted-foreground">{statuses[action.status] || action.status}</span></div>
    <p className="whitespace-pre-wrap break-words text-sm leading-6">{action.reason || (zh ? '未保存当时的理由。' : 'No rationale was recorded at the time.')}</p>
    {action.filledPrice && <p className="text-xs text-muted-foreground">{zh ? '成交价' : 'Fill price'} {action.filledPrice} · {zh ? '费用（美元）' : 'Fee (USD)'} {action.fee ?? '—'}</p>}
    {action.strategyId && <p className="break-words text-xs text-muted-foreground">{zh ? '策略条目' : 'Strategy entry'}: {action.strategyEntryId} · <Link to={`/paper?investmentStrategyId=${encodeURIComponent(action.strategyId)}#investment-strategy`} className="text-primary underline">{zh ? '查看当时策略' : 'View strategy at the time'}</Link></p>}
    <p className="text-xs text-muted-foreground">{new Date(action.createdAt).toLocaleString(i18n.language)}</p>
    <div className="flex flex-wrap gap-3"><Button asChild size="sm" variant="outline"><Link to={questionPath({ decisionId: action.id })}>{zh ? '问问原因' : 'Ask why'}</Link></Button>
      {decision?.councilSessionId && <Link className="self-center text-sm text-primary underline" to={`/council?session=${encodeURIComponent(decision.councilSessionId)}`}>{zh ? '查看实际讨论' : 'View the actual discussion'}</Link>}
      {decision?.references.map((ref, index) => <Link key={`${ref.versionId}:${index}`} className="self-center text-sm text-primary underline" to={`/analysis/reports/${encodeURIComponent(ref.versionId)}`}>{zh ? '当时依据' : 'Evidence at the time'}</Link>)}</div>
    <details className="border-t pt-3" onToggle={event => setExpanded(event.currentTarget.open)}><summary className="cursor-pointer text-xs font-medium text-primary">{zh ? '查看当时判断与参与者' : 'View the judgment and participants at the time'}</summary>
      {details.isPending && expanded && <p role="status" className="mt-3 text-xs text-muted-foreground">{zh ? '正在读取当时记录…' : 'Loading the original record…'}</p>}
      {details.data && <DecisionEvidence data={details.data} ticker={action.ticker} />}
      {details.isError && <div role="alert" className="mt-3 space-y-2 text-xs"><p>{zh ? '当时记录暂时无法读取。' : 'The original record is temporarily unavailable.'}</p><Button size="sm" variant="outline" onClick={() => void details.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>}
    </details>
  </article>;
}
