import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchCurrentResearch } from '@/api/simple-experience';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import CurrentAnalysisPanel from '@/pages/Today/CurrentAnalysisPanel';

export default function SimpleAnalysisPage() {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams(); const ticker = params.get('ticker');
  const date = params.get('date') || ''; const topicKey = ticker ? `ticker:${ticker}` : 'portfolio';
  const setDate = (value: string) => { const next = new URLSearchParams(params); if (value) next.set('date', value); else next.delete('date'); setParams(next, { replace: true }); };
  const historyParams = new URLSearchParams({ topic: topicKey }); if (date) historyParams.set('date', date);
  const query = useQuery({ queryKey: ['current-research', topicKey, date || undefined], queryFn: () => fetchCurrentResearch(topicKey, date || undefined),
    refetchInterval: q => q.state.data?.state === 'generating' ? 3000 : 30_000 });
  return <div className="portfolio-workspace research-workspace">
    <header className="portfolio-page-heading">
      <div><p className="portfolio-eyebrow">{zh ? '研究 · 判断 · 复盘' : 'Research · Decisions · Review'}</p>
        <h1>{ticker || (zh ? '持仓研究' : 'Portfolio research')}</h1>
        <p>{zh ? '先读结论与依据，再决定是否加入模拟账户的策略。' : 'Read the findings and evidence, then decide what belongs in a simulation strategy.'}</p>
      </div>
      {!ticker && <label className="flex min-w-44 flex-col gap-2 text-sm"><span>{zh ? '查看日期' : 'View date'}</span><Input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>}
    </header>
    {query.isPending ? <p role="status">{zh ? '正在读取分析…' : 'Loading analysis…'}</p> : query.data ? <CurrentAnalysisPanel key={`${topicKey}:${date}`} view={query.data} topicKey={topicKey} date={date || undefined} />
      : <div role="alert" className="space-y-3"><p>{zh ? '分析暂时不可用。' : 'Analysis is unavailable.'}</p><Button onClick={() => void query.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>}
    <Button asChild variant="ghost"><Link to={`/analysis?${historyParams.toString()}`}>{zh ? '查看报告历史' : 'View report history'}</Link></Button>
  </div>;
}
