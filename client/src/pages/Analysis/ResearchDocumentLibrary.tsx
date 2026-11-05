import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ResearchDocumentIndexQuery } from '@shared/research-document.interface';
import { fetchResearchDocuments } from '@/api/research-documents';
import { researchDiscussionPath } from '@/utils/research-documents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

export default function ResearchDocumentLibrary() {
  const { i18n } = useTranslation(); const en = Boolean(i18n.resolvedLanguage?.startsWith('en'));
  const text = (english: string, chinese: string) => en ? english : chinese;
  const [filters, setFilters] = useState<ResearchDocumentIndexQuery>({ category: 'all', state: 'all', limit: 12, offset: 0 });
  const query = useQuery({ queryKey: ['research-document-index', filters], queryFn: () => fetchResearchDocuments(filters) });
  const change = (patch: ResearchDocumentIndexQuery) => setFilters(current => ({ ...current, ...patch, offset: 0 }));
  const selectClass = 'h-9 min-w-0 rounded-md border bg-background px-2 text-sm';
  return <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="research-library-title">
    <div className="flex flex-wrap items-start justify-between gap-3"><div>
      <h2 id="research-library-title" className="font-serif text-xl font-semibold">{text('Research library', '研究报告总览')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{text('Browse saved evidence, review revisions and continue the discussion.', '按主题查阅固定版本、检查修订，并进入或继续研究讨论。')}</p>
    </div><Button size="sm" variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>{text('Refresh', '刷新')}</Button></div>
    <div className="flex flex-wrap gap-2" role="group" aria-label={text('Report type', '报告类型')}>
      {(['all', 'daily', 'stock', 'review'] as const).map(category => <Button key={category} size="sm" variant={filters.category === category ? 'default' : 'outline'} onClick={() => change({ category })}>
        {{ all: text('All reports', '全部报告'), daily: text('Daily / portfolio', '日报 / 组合'), stock: text('Single stock', '单股研究'), review: text('Period review', '期间复盘') }[category]}</Button>)}
    </div>
    <div className="grid gap-2 sm:grid-cols-3">
      <Input aria-label={text('Search report title', '搜索报告标题')} placeholder={text('Search report title', '搜索报告标题')} value={filters.search ?? ''} onChange={event => change({ search: event.target.value || undefined })} />
      <select className={selectClass} aria-label={text('Research topic', '研究主题')} value={filters.topic ?? ''} onChange={event => change({ topic: event.target.value || undefined })}>
        <option value="">{text('All topics', '全部主题')}</option>{(query.data?.topics ?? []).map(topic => <option key={topic.key} value={topic.key}>{topic.key === 'portfolio' ? text('Portfolio', '投资组合') : topic.label} ({topic.count})</option>)}
      </select>
      <select className={selectClass} aria-label={text('Report state', '报告状态')} value={filters.state} onChange={event => change({ state: event.target.value as ResearchDocumentIndexQuery['state'] })}>
        <option value="all">{text('All states', '全部状态')}</option><option value="adopted">{text('Adopted', '已采纳')}</option><option value="draft">{text('Revision in progress', '待修订 / 有草稿')}</option><option value="strategy">{text('Linked to strategy', '已关联策略')}</option>
      </select>
    </div>
    <div className="flex flex-wrap items-end gap-3 text-xs text-muted-foreground">
      <label className="space-y-1">{text('Saved from (UTC)', '保存起日（UTC）')}<Input className="h-8" type="date" value={filters.from ?? ''} onChange={event => change({ from: event.target.value || undefined })} /></label>
      <label className="space-y-1">{text('Saved through (UTC)', '保存止日（UTC）')}<Input className="h-8" type="date" value={filters.to ?? ''} onChange={event => change({ to: event.target.value || undefined })} /></label>
      <label className="flex h-8 items-center gap-2"><input type="checkbox" checked={filters.history ?? false} onChange={event => change({ history: event.target.checked })} />{text('Include historical versions', '包含历史版本')}</label>
    </div>
    {query.isPending && <p role="status" className="py-4 text-sm text-muted-foreground">{text('Loading reports…', '正在加载报告…')}</p>}
    {query.isError && <p role="alert" className="text-sm text-destructive">{text('Reports could not be loaded. Refresh to retry.', '报告加载失败，请刷新重试。')}</p>}
    {!query.isPending && !query.isError && query.data?.items.length === 0 && <p className="py-4 text-sm text-muted-foreground">{text('No reports match these filters. Generate a report below to start.', '没有符合条件的报告，可在下方生成报告。')}</p>}
    <div className="grid gap-3 xl:grid-cols-2">{(query.data?.items ?? []).map(item => <article key={item.id} className="flex min-w-0 flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2"><Link className="min-w-0 break-words font-medium hover:underline" to={`/analysis/reports/${item.id}`}>{item.title}</Link><Badge variant="secondary">v{item.version}</Badge></div>
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{item.topicKey === 'portfolio' ? text('Portfolio', '投资组合') : item.ticker}</span><span>{text('Saved', '保存于')} {new Date(item.createdAt).toLocaleString()}</span></div>
      <div className="flex flex-wrap gap-2">{item.adoptedVersionId === item.id && <Badge>{text('Adopted', '已采纳')}</Badge>}{item.draftCount > 0 && <Badge variant="outline">{text('Drafts', '修订草稿')} {item.draftCount}</Badge>}{item.strategyUseCount > 0 && <Badge variant="outline">{text('Strategies', '关联策略')} {item.strategyUseCount}</Badge>}{item.status === 'revoked' && <Badge variant="destructive">{text('Invalidated', '已作废')}</Badge>}{item.sourceStatus === 'missing' && <Badge variant="destructive">{text('Source missing', '原始来源已缺失')}</Badge>}</div>
      {item.updatesAvailable && <p className="text-xs text-amber-700 dark:text-amber-300">{text('A linked strategy uses an older version. New evidence awaits review; the strategy remains pinned.', '关联策略仍使用旧版本，有更新待复核；策略继续固定原引用。')}</p>}
      <p className="text-xs text-muted-foreground">{text('First available', '首次可用')}：{item.availableAt ? new Date(item.availableAt).toLocaleString() : text('Unknown', '未知')}</p>
      <div className="mt-auto flex flex-wrap gap-2"><Button asChild size="sm" variant="outline"><Link to={`/analysis/reports/${item.id}`}>{text('Read version', '阅读此版本')}</Link></Button>
        {item.status === 'valid' && item.sourceStatus === 'available' && <Button asChild size="sm" variant="secondary"><Link to={researchDiscussionPath(item)}>{text('Discuss / continue', '进入 / 继续讨论')}</Link></Button>}</div>
    </article>)}</div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{text('Matching versions', '匹配版本')}：{query.data?.total ?? 0}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={!filters.offset || query.isFetching} onClick={() => setFilters(current => ({ ...current, offset: Math.max(0, (current.offset ?? 0) - 12) }))}>{text('Previous', '上一页')}</Button><Button size="sm" variant="outline" disabled={query.isFetching || (filters.offset ?? 0) + 12 >= (query.data?.total ?? 0)} onClick={() => setFilters(current => ({ ...current, offset: (current.offset ?? 0) + 12 }))}>{text('Next', '下一页')}</Button></div></div>
    {query.data?.moreLegacySources && <Button size="sm" variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>{text('Register more historical reports', '继续收录历史报告')}</Button>}
  </section>;
}
