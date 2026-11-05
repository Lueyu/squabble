import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ReportReference, ResearchReportCategory } from '@shared/research-document.interface';
import { fetchResearchDocuments } from '@/api/research-documents';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';

export default function CouncilReportPicker({ value, onChange, historical = true }: {
  value: ReportReference[]; onChange: (refs: ReportReference[]) => void; historical?: boolean;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState<ResearchReportCategory | 'all'>('all');
  const [offset, setOffset] = useState(0);
  const query = { search, from: from || undefined, to: to || undefined, category, history: true, offset, limit: 30 };
  const reports = useQuery({ queryKey: ['research-documents', 'picker', query], queryFn: () => fetchResearchDocuments(query), retry: false });
  return <details className="rounded-md border border-border p-3">
    <summary className="cursor-pointer text-sm font-medium">{zh ? '选择报告固定版本' : 'Choose fixed report versions'} · {value.length}/20</summary>
    <p className="my-2 text-xs text-muted-foreground">{zh ? '可组合日报 v1、单股深报 v3 等多个版本；日期筛选使用版本保存日期。' : 'Combine daily v1, stock research v3, and other exact versions. Dates filter when versions were saved.'}</p>
    <div className="grid gap-2 sm:grid-cols-2">
      <Input aria-label={zh ? '搜索报告' : 'Search reports'} placeholder={zh ? '标题、股票代码' : 'Title or ticker'} value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} />
      <select aria-label={zh ? '报告类型' : 'Report category'} value={category} onChange={event => { setCategory(event.target.value as typeof category); setOffset(0); }} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
        <option value="all">{zh ? '全部类型' : 'All categories'}</option><option value="daily">{zh ? '组合日报' : 'Daily portfolio'}</option>
        <option value="stock">{zh ? '个股研究' : 'Stock research'}</option><option value="review">{zh ? '讨论与复盘' : 'Discussion and reviews'}</option>
      </select>
      <Label className="space-y-1 text-xs">{zh ? '保存日期从' : 'Saved from'}<Input type="date" value={from} onChange={event => { setFrom(event.target.value); setOffset(0); }} /></Label>
      <Label className="space-y-1 text-xs">{zh ? '保存日期至' : 'Saved through'}<Input type="date" value={to} onChange={event => { setTo(event.target.value); setOffset(0); }} /></Label>
    </div>
    {reports.isPending && <p role="status" className="mt-2 text-xs">{zh ? '加载报告…' : 'Loading reports…'}</p>}
    {reports.isError && <p role="alert" className="mt-2 text-xs text-destructive">{errorMessage(reports.error, zh ? '报告加载失败' : 'Reports could not be loaded')}</p>}
    <div className="mt-3 max-h-60 space-y-2 overflow-y-auto">
      {reports.data?.items.map(item => {
        const checked = value.some(ref => ref.versionId === item.id);
        const invalid = item.status !== 'valid' || item.sourceStatus !== 'available';
        return <div key={item.id} className="flex items-start gap-2 rounded-md border border-border p-2 text-xs">
          <input type="checkbox" checked={checked} aria-label={`${item.title} v${item.version}`}
            disabled={!checked && (value.length >= 20 || invalid && !historical)} onChange={() => onChange(checked ? value.filter(ref => ref.versionId !== item.id) : [...value, { versionId: item.id }])} />
          <div className="min-w-0 flex-1"><Link className="text-primary underline" target="_blank" to={`/analysis/reports/${encodeURIComponent(item.id)}`}>{item.title} · v{item.version}</Link>
            <p className="mt-1 text-muted-foreground">{item.ticker ?? (zh ? '组合' : 'Portfolio')} · {new Date(item.createdAt).toLocaleDateString(i18n.language)}</p>
            {invalid && <p className="mt-1 text-destructive">{zh ? '已撤销或缺源，仅作历史待核实材料' : 'Revoked or missing source: historical claims to verify only'}</p>}
          </div>
        </div>;
      })}
      {reports.isSuccess && reports.data.items.length === 0 && <p className="text-xs">{zh ? '没有匹配版本' : 'No matching versions'}</p>}
    </div>
    <div className="mt-2 flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>{zh ? '上一页' : 'Previous'}</Button>
      <Button type="button" size="sm" variant="outline" disabled={!reports.data || offset + 30 >= reports.data.total} onClick={() => setOffset(offset + 30)}>{zh ? '下一页' : 'Next'}</Button>
      {reports.data?.moreLegacySources && <Button type="button" size="sm" variant="outline" onClick={() => void reports.refetch()}>{zh ? '载入更多历史报告' : 'Load more historical reports'}</Button>}
    </div>
    {value.length > 0 && <div className="mt-2 space-y-1">{value.map((ref, index) => <div key={`${ref.versionId}:${index}`} className="flex items-center justify-between gap-2 text-xs">
      <Link className="truncate text-primary underline" to={`/analysis/reports/${encodeURIComponent(ref.versionId)}`}>{reports.data?.items.find(item => item.id === ref.versionId)?.title ?? ref.versionId}{ref.sectionId ? ` · ${ref.sectionId}` : ''}</Link>
      <Button type="button" size="sm" variant="ghost" onClick={() => onChange(value.filter((_, position) => position !== index))}>{zh ? '移除' : 'Remove'}</Button>
    </div>)}</div>}
  </details>;
}
