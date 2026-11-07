import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useEffect, useRef,useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchToday, refreshCurrentResearch } from '@/api/simple-experience';
import { Button } from '@/components/ui/button';
import { highlightedAttention } from '@/utils/simple-experience';
import { questionPath } from '@/utils/simple-experience';
import { readableResearchText } from '@/utils/research-experience';
import { latestTodayReport } from '@/utils/today-report';
import AttentionCard from './AttentionCard';
import CurrentAnalysisPanel from './CurrentAnalysisPanel';
import AssetOverview from './AssetOverview';
import InvestmentStrategySourceDialog from './InvestmentStrategySourceDialog';
import type { StrategySourceInput } from '@shared/user-investment-strategy.interface';

export default function TodayPage() {
  const [params] = useSearchParams();
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [strategySource,setStrategySource]=useState<StrategySourceInput|null>(null);
  const query = useQuery({ queryKey: ['today'], queryFn: fetchToday, refetchInterval: current => current.state.data?.analysis.state === 'generating' ? 2000 : current.state.data?.assetMetrics?.refreshing?5000:30_000 });
  const todayData = query.data; const refetch = query.refetch;
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    const data = todayData;
    if (!data) return;
    if (data.analysis.state === 'generating' || data.analysis.cancelling || ('cancelled' in data.analysis && data.analysis.cancelled === true)) {
      attempted.current.add(data.date); return;
    }
    if (!data.aiAvailable || !data.overview.holdingCount || data.analysis.state !== 'empty' || attempted.current.has(data.date)) return;
    attempted.current.add(data.date);
    void refreshCurrentResearch({ topicKey: 'portfolio', date: data.date, requestKey: `today-first-open:${data.date}`, trigger: 'first_open' })
      .then(() => refetch()).catch(() => {});
  }, [todayData, refetch]);
  if (params.has('investmentStrategyId')) return <Navigate replace to={`/paper?${params.toString()}#investment-strategy`} />;
  if (query.isPending) return <p role="status" className="p-6">{zh ? '正在读取今日持仓…' : 'Loading today’s portfolio…'}</p>;
  if (!query.data) return <div role="alert" className="space-y-3 p-6"><p>{zh ? '今日资料暂时无法读取。' : 'Today’s data is unavailable.'}</p><Button onClick={() => void query.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>;
  const data = query.data;
  const report = latestTodayReport(data);
  if (data.overview.holdingCount === 0 && !(data.assetMetrics?.knownValueUsd || data.overview.cashUsd)) return <div className="mx-auto w-full max-w-4xl space-y-6 p-3 sm:p-6">
    <header><h1 className="text-2xl font-semibold">{zh ? '今日' : 'Today'}</h1><p className="mt-1 text-sm text-muted-foreground">{data.date} · {data.timezone}</p></header>
    <section className="space-y-5 rounded-2xl border bg-card px-5 py-8 sm:p-10"><h2 className="text-xl font-semibold">{zh ? '先把持仓带进来，一起看懂每天的变化' : 'Bring in your holdings to understand what changes each day'}</h2>
      <p className="max-w-xl text-sm leading-7 text-muted-foreground">{zh ? '导入后，今日会显示持仓概况、值得关注的变化和 AI 股友的研究。也可以先在频道核对一个具体事实。' : 'After import, Today shows your portfolio, changes that deserve attention and your AI team’s research. You can also check one specific fact in the channel.'}</p>
      <div className="flex flex-wrap gap-3"><Button asChild><Link to="/import">{zh ? '导入持仓' : 'Import holdings'}</Link></Button><Button asChild variant="outline" className="h-auto whitespace-normal"><Link to="/council">{zh ? '先到频道问一句' : 'Check one fact in the channel'}</Link></Button></div>
    </section>
    <AssetOverview data={data}/>
    <nav className="flex flex-wrap gap-5 text-sm"><Link className="text-primary underline" to="/holdings">{zh ? '手动添加持仓' : 'Add holdings manually'}</Link><Link className="text-primary underline" to="/paper">{zh ? '管理模拟策略' : 'Manage simulation strategy'}</Link></nav>
  </div>;
  return <div className="mx-auto w-full max-w-6xl space-y-6 px-3 py-5 pb-12 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">{zh ? '今日' : 'Today'}</h1><p className="mt-1 text-sm text-muted-foreground">{data.date} · {data.timezone}</p></div>
      <div className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link to="/holdings">{zh ? '我的持仓' : 'My holdings'}</Link></Button><Button asChild><Link to={questionPath(report.documentId ? { versionId: report.documentId } : { date: data.date })}>{zh ? '到频道问一句' : 'Ask in the channel'}</Link></Button></div></header>
    <nav className="flex flex-wrap gap-2" aria-label={zh ? '每日投资流程' : 'Daily investing journey'}><Button asChild variant="outline" size="sm"><a href="#today-report" aria-current="step">{zh ? '1 · 看今日报告' : '1 · Read today’s report'}</a></Button><Button asChild variant="outline" size="sm"><Link to="/paper#investment-strategy">{zh ? '2 · 管理模拟策略' : '2 · Manage simulation strategy'}</Link></Button><Button asChild variant="outline" size="sm"><Link to="/council">{zh ? '3 · 看频道动态' : '3 · Follow the channel'}</Link></Button></nav>
    <div id="today-report" className="scroll-mt-6"><CurrentAnalysisPanel primary view={report} activityView={data.analysis} topicKey="portfolio" date={data.date} aiAvailable={data.aiAvailable} summary={report.summary} onAddToStrategy={setStrategySource}/></div>
    <InvestmentStrategySourceDialog source={strategySource} onClose={()=>setStrategySource(null)}/>
    <AssetOverview data={data}/>
    {data.currencyTotals && (data.currencyTotals.length > 1 || data.overview.totalValueUsd === null) && <section className="flex min-w-0 flex-wrap gap-3" aria-label={zh ? '已知的分币种持仓市值' : 'Known holdings value by currency'}>{data.currencyTotals.map(item => <div key={item.currency} className="min-w-0 rounded-xl border bg-card px-4 py-3"><p className="text-xs text-muted-foreground">{item.currency} · {zh ? '已知持仓市值' : 'Known holdings value'}</p><p className="mt-1 font-semibold tabular-nums">{item.holdingsValue === null ? '—' : new Intl.NumberFormat(i18n.language, { style: 'currency', currency: item.currency, maximumFractionDigits: 2 }).format(item.holdingsValue)}</p></div>)}</section>}
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"><span>{zh ? '资料读取于：' : 'Captured: '}{new Date(data.asOf).toLocaleString(i18n.language)}</span>{data.marketTimes.map(item => <span key={item.market}>{item.market} · {item.dataAsOf || (zh ? '行情时间未知' : 'Quote time unknown')}</span>)}</div>
    {data.dailyBaselineMissing && <p className="text-xs text-muted-foreground">{zh ? '首次导入，暂无可比历史。' : 'First import: no comparable history yet.'}</p>}
    {!!data.gaps.length && <details className="min-w-0 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm"><summary className="cursor-pointer font-medium">{zh ? `部分数字暂时无法计算 · ${data.gaps.length} 处资料缺口` : `Some values are unavailable · ${data.gaps.length} data gaps`}</summary><ul className="mt-3 list-inside list-disc space-y-1 text-muted-foreground">{data.gaps.map(gap => <li className="[overflow-wrap:anywhere]" key={gap}>{gap}</li>)}</ul></details>}
    <section className="space-y-3"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{zh ? '值得关注' : 'Worth your attention'}</h2>{data.attention.length > 3 && <Link className="text-sm text-primary underline" to="/analysis">{zh ? '查看全部' : 'View all'}</Link>}</div>
      {data.attention.length ? <div className="grid gap-3 md:grid-cols-3">{highlightedAttention(data.attention).map(item => <AttentionCard key={item.id} item={item} date={data.date} />)}</div>
        : <p className="rounded-xl border p-5 text-sm text-muted-foreground">{zh ? '暂无需要特别关注的新变化。' : 'No new changes need special attention.'}</p>}</section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">{zh ? '团队今天做了什么' : 'What the team did today'}</h2>
      {data.teamActivity?.length || data.recentActions?.length ? <div className="grid gap-3 md:grid-cols-2">
        {data.teamActivity?.map(activity => <article key={activity.id} className="space-y-2 rounded-xl border bg-card p-4"><h3 className="break-words font-medium">{activity.title}</h3><p className="line-clamp-3 break-words text-sm leading-6 text-muted-foreground">{readableResearchText(activity.summary) || (zh ? '打开讨论查看已记录的观点。' : 'Open the discussion to read the recorded views.')}</p>{activity.hasDisagreement && <p className="text-xs text-muted-foreground">{zh ? '有不同看法' : 'Different views were recorded'}</p>}<Link className="text-sm text-primary underline" to={`/council?session=${encodeURIComponent(activity.sessionId)}`}>{zh ? '查看实际讨论' : 'View the actual discussion'}</Link></article>)}
        {data.recentActions?.map(action => <article key={action.id} className="space-y-2 rounded-xl border bg-card p-4"><h3 className="font-medium">{action.ticker} · {action.side === 'buy' ? (zh ? '模拟买入' : 'Simulated buy') : (zh ? '模拟卖出' : 'Simulated sell')}</h3><p className="line-clamp-3 break-words text-sm leading-6 text-muted-foreground">{action.reason || (zh ? '当时未保存理由' : 'No reason was saved at the time')}</p><Link className="text-sm text-primary underline" to={questionPath({ decisionId: action.id })}>{zh ? '问问原因' : 'Ask why'}</Link></article>)}
      </div> : <p className="rounded-xl border p-4 text-sm text-muted-foreground">{zh ? '今天暂无新的讨论结论或模拟行动。' : 'No new discussion findings or simulated actions today.'}</p>}
    </section>
    <nav className="flex flex-wrap gap-x-5 gap-y-3 text-sm" aria-label={zh ? '持仓与记录' : 'Portfolio and records'}>{[['/analysis', zh ? '按日查看分析' : 'Analysis by date'], ['/watchlist', zh ? '关注列表' : 'Watchlist'], ['/transactions', zh ? '真实交易' : 'Real transactions'], ['/journal', zh ? '我的记录' : 'My notes'], ['/import', zh ? '导入持仓' : 'Import holdings']].map(([to, text]) => <Link key={to} className="text-primary underline" to={to}>{text}</Link>)}</nav>
  </div>;
}
