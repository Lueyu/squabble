import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ResearchDocumentIndexQuery, ReportSource } from '@shared/research-document.interface';
import { fetchResearchDocuments } from '@/api/research-documents';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import DeleteReportRecord from '@/features/research-history/DeleteReportRecord';

/** Each row points to its immutable version; the list never loads current research. */
export default function ReportHistoryPage() {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [deleted, setDeleted] = useState<string[]>([]);
  const source = params.get('source');
  const date = params.get('date') || undefined;
  const offsetValue = Number(params.get('offset') ?? 0);
  const offset = Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
  const filters: ResearchDocumentIndexQuery = { category: 'all', history: true, limit: 30, offset, date,
    source: ['portfolio', 'council', 'deep', 'daily'].includes(source ?? '') ? source as ReportSource['type'] : undefined,
    topic: params.get('topic') || (params.get('ticker') ? `ticker:${params.get('ticker')}` : undefined) };
  const query = useQuery({ queryKey: ['report-history', filters], queryFn: () => fetchResearchDocuments(filters) });
  const visible = query.data?.items.filter(item => !deleted.includes(item.id)) ?? [];
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  const labels = { portfolio: zh ? '持仓研究' : 'Portfolio research', council: zh ? '研究室报告' : 'Research room', deep: zh ? '单股研究' : 'Stock research', daily: zh ? '每日研究' : 'Daily research' };
  const page = (next: number) => {
    const value = new URLSearchParams(params);
    if (next) value.set('offset', String(next)); else value.delete('offset');
    setParams(value);
  };
  return <section id="report-history" className="portfolio-page max-w-4xl" aria-label={zh ? '报告历史' : 'Report history'}>
    <header className="space-y-2"><h1 className="text-2xl font-semibold">{zh ? '报告历史' : 'Report history'}</h1>
      <p className="text-sm text-muted-foreground">{date ? `${date} · ` : ''}{zh ? '点击报告，阅读当时保存的原版本。' : 'Select a report to read its original saved version.'}</p></header>
    {query.isPending && <p role="status">{zh ? '正在读取报告…' : 'Loading reports…'}</p>}
    {query.isError && <div role="alert" className="space-y-3"><p>{zh ? '报告列表暂时无法读取。' : 'The report list could not be loaded.'}</p><Button variant="outline" onClick={() => void query.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>}
    {!query.isError && query.data && <>
      <ul className="divide-y rounded-xl border bg-card px-4 sm:px-5">{visible.map(item => <li className="flex items-start gap-2" key={item.id}>
        <Link className="flex min-w-0 flex-1 flex-col gap-1 py-4 hover:text-primary focus-visible:outline-primary" to={`/analysis/reports/${encodeURIComponent(item.id)}?returnTo=${encodeURIComponent(returnTo)}`} state={{ returnTo }}>
          <span className="break-words font-medium">{item.title}</span><span className="text-xs text-muted-foreground">{new Date(item.generatedAt ?? item.createdAt).toLocaleString(i18n.language)} · {labels[item.source?.type ?? item.kind]} · v{item.version}</span>
        </Link><DeleteReportRecord id={item.id} title={item.title} version={item.version} onDeleted={() => {
          setDeleted(ids => [...ids, item.id]);
          if (visible.length === 1 && offset > 0) page(Math.max(0, offset - 30));
        }} /></li>)}</ul>
      {!visible.length && <p className="text-sm text-muted-foreground">{zh ? '还没有已保存的报告。' : 'No saved reports yet.'}</p>}
      {(offset > 0 || query.data.total > 30) && <nav className="flex justify-between" aria-label={zh ? '报告列表分页' : 'Report pages'}><Button variant="ghost" disabled={!offset} onClick={() => page(Math.max(0, offset - 30))}>{zh ? '上一页' : 'Previous'}</Button><Button variant="ghost" disabled={offset + 30 >= query.data.total} onClick={() => page(offset + 30)}>{zh ? '下一页' : 'Next'}</Button></nav>}
      {query.data.moreLegacySources && <Button variant="ghost" onClick={() => void query.refetch()}>{zh ? '读取更早的报告' : 'Load earlier reports'}</Button>}
    </>}
  </section>;
}
