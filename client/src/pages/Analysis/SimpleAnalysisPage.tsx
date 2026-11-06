import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchCurrentResearch } from '@/api/simple-experience';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import CurrentAnalysisPanel from '@/pages/Today/CurrentAnalysisPanel';
import ReportHistory from './ReportHistory';

export default function SimpleAnalysisPage() {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [params] = useSearchParams(); const ticker = params.get('ticker');
  const [date, setDate] = useState(params.get('date') || ''); const topicKey = ticker ? `ticker:${ticker}` : 'portfolio';
  const query = useQuery({ queryKey: ['current-research', topicKey, date || undefined], queryFn: () => fetchCurrentResearch(topicKey, date || undefined),
    refetchInterval: q => q.state.data?.state === 'generating' ? 3000 : 30_000 });
  return <div className="mx-auto w-full max-w-4xl space-y-5 p-3 sm:p-6"><h1 className="text-2xl font-semibold">{ticker || (zh ? '每日分析' : 'Daily analysis')}</h1>
    {!ticker && <label className="flex max-w-xs flex-col gap-2 text-sm"><span>{zh ? '查看日期' : 'View date'}</span><Input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>}
    {query.isPending ? <p role="status">{zh ? '正在读取分析…' : 'Loading analysis…'}</p> : query.data ? <CurrentAnalysisPanel key={`${topicKey}:${date}`} view={query.data} topicKey={topicKey} date={date || undefined} />
      : <div role="alert" className="space-y-3"><p>{zh ? '分析暂时不可用。' : 'Analysis is unavailable.'}</p><Button onClick={() => void query.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>}
    <ReportHistory topic={ticker?topicKey:undefined} date={date||undefined}/>
  </div>;
}
