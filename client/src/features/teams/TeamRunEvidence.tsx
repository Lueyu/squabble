import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { teamLedgerHref } from './team-ledger-link';
import { teamRunsApi } from '@/api/team-runs';
import { Button } from '@/components/ui/button';
import type { TradingMarket } from '@shared/trading-market.interface';

const marketZones: Record<TradingMarket, string> = {
  CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong', US: 'America/New_York',
};

export function runTime(at: string, market: string | undefined, zh: boolean) {
  const timeZone = marketZones[market as TradingMarket] ?? 'UTC';
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en', {
    timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).format(new Date(at));
}

function ReadError({ zh, message, retry }: { zh: boolean; message: string; retry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
    {message}<Button variant="outline" size="sm" onClick={retry}>{zh ? '重新读取' : 'Retry'}</Button>
  </div>;
}

export function TeamRunEvidence({ teamId, teamName, market, zh }: {
  teamId: string; teamName: string; market?: string; zh: boolean;
}) {
  const fills = useQuery({ queryKey: ['team-run-fills', teamId], queryFn: () => teamRunsApi.fills(teamId),
    refetchInterval: 15_000, retry: false });
  const research = useQuery({ queryKey: ['team-run-research', teamId], queryFn: () => teamRunsApi.research(teamId),
    refetchInterval: 15_000, retry: false });
  const canShowLastRead = (error: unknown) => {
    const status = (error as { response?: { status?: number } })?.response?.status;
    return status === undefined || status >= 500 || status === 408 || status === 429;
  };
  const report = canShowLastRead(research.error) ? research.data?.report : null;
  const fillsLabel = zh ? '模拟成交' : 'Paper fills';
  const researchLabel = zh ? '最近研究' : 'Recent research';
  const items = canShowLastRead(fills.error) ? fills.data : undefined;
  const latest = items?.[0];
  const oneAccount = latest && items.every(row => row.accountId === latest.accountId);
  return <div className="grid items-start gap-4 md:grid-cols-2">
    <section className="run-evidence" aria-label={fillsLabel}>
      <h2>{fillsLabel}</h2>
      {fills.isPending && <p role="status">{zh ? '正在读取成交…' : 'Reading fills…'}</p>}
      {fills.isError && <ReadError zh={zh} message={zh ? '暂时无法读取成交' : 'Fills are temporarily unavailable'} retry={() => void fills.refetch()} />}
      {items && !latest && !fills.isError && <><p>{zh ? '暂无模拟成交' : 'No paper fills yet'}</p>
        <small>{zh ? '团队判断产生的成交将在这里显示。' : 'Recorded fills from team decisions will appear here.'}</small></>}
      {items && latest && <><small>{fills.isError && (zh ? '上次读取 · ' : 'Last read · ')}
        {oneAccount && latest.accountName + ' · '}
        {zh ? `最近 ${items.length} 笔` : `${items.length} recent ${items.length === 1 ? 'fill' : 'fills'}`}</small>
        <ul>{items.map(fill => <li key={fill.id}>
          <Link className="run-fill" to={teamLedgerHref(fill.accountId, { kind: 'trade', targetId: fill.id })}>
            <span><strong>{fill.ticker}</strong><small>{runTime(fill.createdAt, market ?? fill.market, zh)}{!oneAccount && ' · ' + fill.accountName}</small></span>
            <span><strong>{fill.side === 'buy' ? (zh ? '买入' : 'Buy') : fill.side === 'sell' ? (zh ? '卖出' : 'Sell') : fill.side} {fill.quantity}</strong>
              <small>{zh ? '成交价' : 'Fill price'} {fill.price} {fill.currency}</small></span>
          </Link></li>)}</ul>
        <Link className="run-evidence-link" to={teamLedgerHref(latest.accountId, { kind: 'trade', targetId: latest.id })}>
          {zh ? '查看交易账本' : 'View trade ledger'} <ArrowRight size={15} /></Link>
      </>}
    </section>
    <section className="run-evidence" aria-label={researchLabel}>
      <h2>{researchLabel}</h2>
      {research.isPending && <p role="status">{zh ? '正在读取报告…' : 'Reading report…'}</p>}
      {research.isError && <ReadError zh={zh} message={zh ? '暂时无法读取研究' : 'Research is temporarily unavailable'} retry={() => void research.refetch()} />}
      {research.data && !report && !research.isError && <><p>{research.data.visibilityLimited
        ? (zh ? '最近交付的研究暂不可读' : 'Recent research is unavailable')
        : (zh ? '暂无已发布研究' : 'No published research yet')}</p>
        <small>{zh ? '可读的报告版本将在这里显示。' : 'Published, readable report versions will appear here.'}</small></>}
      {report && <><small>{research.isError && (zh ? '上次读取 · ' : 'Last read · ')}{teamName} · {report.source === 'manual' && (zh ? '手动委托 · ' : 'Manual commission · ')}
        {runTime(report.publishedAt, market, zh)}</small>
        <div className="run-report"><h3>{report.title}</h3><p>{report.summary}</p>
          <Link className="run-evidence-link" to={`/analysis/reports/${encodeURIComponent(report.versionId)}`}>
            {zh ? '阅读完整报告' : 'Read full report'} <ArrowRight size={15} /></Link></div>
        {report.applied && <small className="border-t pt-4">{zh ? '执行组合已应用' : 'Policy applied'} · r{report.applied.revision} · {runTime(report.applied.at, market, zh)}</small>}
      </>}
    </section>
  </div>;
}
