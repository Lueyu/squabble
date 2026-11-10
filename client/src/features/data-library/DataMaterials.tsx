import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileText, Globe2, Image, Library, Plus, Presentation } from 'lucide-react';
import type { DataLibrarySourceKind } from '@shared/data-library.interface';
import { dataLibraryApi, dataLibraryKey } from '@/api/data-library';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useIsMobile } from '@/hooks/use-mobile';
import { dataError, dataTime, materialKind, materialState } from './data-library-labels';
import MaterialPreview from './MaterialPreview';
import SourceForm from './SourceForm';
import './data-library.css';

const typeIcons = { page: FileText, website: Globe2, slides: Presentation, image: Image, file: FileText };

export default function DataMaterials({ memory = false }: { memory?: boolean }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const [kind, setKind] = useState<DataLibrarySourceKind | ''>(''), [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim());
  const [offset, setOffset] = useState(0), [adding, setAdding] = useState(false);
  const selected = params.get('source') || '';
  const mobile = useIsMobile();
  const container = useRef<HTMLElement | null>(null);
  const listScroll = useRef<number | null>(null);
  const returnPending = useRef(false);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const select = (id: string, button?: HTMLButtonElement) => {
    if (id && !selected) {
      listScroll.current = container.current?.closest('.app-content')?.scrollTop ?? 0;
      selectedButton.current = button ?? null;
    }
    if (!id) returnPending.current = mobile;
    const next = new URLSearchParams(params);
    if (id) next.set('source', id); else next.delete('source');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if (!mobile) return;
    const scroller = container.current?.closest('.app-content');
    if (!scroller || (!selected && !returnPending.current)) return;
    // Apply after the workspace's route scroll reset. The list stays mounted,
    // so its search, filters, page and exact return position survive the detail.
    const frame = requestAnimationFrame(() => {
      scroller.scrollTop = selected ? 0 : listScroll.current ?? 0;
      if (!selected) {
        if (selectedButton.current?.isConnected) selectedButton.current.focus({ preventScroll: true });
        returnPending.current = false;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, mobile]);
  const list = useQuery({ queryKey: [...dataLibraryKey, 'list', kind, query, offset], queryFn: () => dataLibraryApi.list({ kind: kind || undefined, q: query || undefined, offset, limit: 20 }), retry: false, refetchInterval: 30000 });
  return <section ref={container} className={`data-materials space-y-5${selected ? ' has-selection' : ''}`}>
    {memory && <p className="data-notice">{zh ? '这里是采集和导入的资料来源，可查看原文、版本或停用。入库不代表股友已经认可其中的观点。' : 'Collected and imported sources with originals, versions and exclusion controls. Saving a source does not endorse its claims.'}</p>}
    <div className="data-toolbar data-material-toolbar">
      <div className="data-material-filters" role="group" aria-label={zh ? '筛选资料' : 'Filter materials'}>
      {(['', 'page', 'slides', 'website', 'image', 'file'] as const).map(value => <Button key={value} size="sm" variant={kind === value ? 'secondary' : 'ghost'} aria-pressed={kind === value} onClick={() => { setKind(value); setOffset(0); }}>{value ? materialKind(value, zh) : zh ? '全部' : 'All'}</Button>)}
      </div>
      <div className="data-material-search">
      <Input aria-label={zh ? '搜索资料' : 'Search materials'} placeholder={zh ? '搜索名称或正文…' : 'Search titles or content…'} value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} />
      <Button onClick={() => setAdding(true)}><Plus size={16} />{zh ? '添加资料' : 'Add source'}</Button>
      </div>
    </div>
    <div className="data-library-layout">
      <div className="data-panel data-material-list space-y-4">
        <div className="flex items-center justify-between gap-4"><h2 className="font-semibold">{zh ? '保存的资料' : 'Saved materials'}</h2><span className="text-xs text-muted-foreground">{list.data?.total ?? '—'} {zh ? '项' : 'sources'}</span></div>
        {list.isPending && <p role="status">{zh ? '正在读取资料…' : 'Loading materials…'}</p>}
        {list.isError && <div role="alert"><p>{dataError(list.error, zh)}</p><Button variant="outline" onClick={() => void list.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>}
        <div className="data-list">{list.data?.items.map(source => {
          const Icon = typeIcons[source.kind];
          return <button type="button" className="data-item" key={source.id} aria-pressed={selected === source.id} onClick={event => select(source.id, event.currentTarget)}>
            <span className={`data-type-icon data-type-${source.kind}`}><Icon size={21} /></span>
            <span className="data-item-copy"><strong>{source.title}</strong><p>{materialKind(source.kind, zh)} · {dataTime(source.lastSuccessAt || source.updatedAt, i18n.language)}</p></span>
            <Badge variant="secondary">{materialState(source.state, zh)}</Badge>
          </button>;
        })}</div>
        {list.data && !list.data.items.length && <div className="data-empty"><Library size={34} /><h3 className="font-medium text-foreground">{query || kind ? zh ? '没有匹配的资料' : 'No matching sources' : zh ? '给研究添一点依据' : 'Give your research a source'}</h3><p className="text-sm leading-7">{zh ? '保存页面、上传幻灯片和图片，或订阅网站。每次更新都会保留可核对的版本。' : 'Write a page, upload slides or images, or subscribe to a site. Updates retain inspectable versions.'}</p></div>}
        {list.data && list.data.total > 20 && <div className="flex items-center justify-between gap-2 border-t pt-4"><Button variant="outline" size="sm" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 20))}>{zh ? '上一页' : 'Previous'}</Button><span className="text-xs">{offset + 1}–{Math.min(offset + 20, list.data.total)}</span><Button variant="outline" size="sm" disabled={offset + 20 >= list.data.total} onClick={() => setOffset(value => value + 20)}>{zh ? '下一页' : 'Next'}</Button></div>}
      </div>
      {selected ? <div className="data-material-detail">
        <Button className="data-material-back" variant="outline" onClick={() => select('')}><ArrowLeft size={16} />{zh ? '返回资料库' : 'Back to library'}</Button>
        <MaterialPreview key={selected} sourceId={selected} onRemoved={() => select('')} />
      </div> : <aside className="data-panel data-empty data-material-placeholder"><FileText size={32} /><p>{zh ? '选择资料，在这里查看原文和版本' : 'Select a source to preview its content and versions'}</p></aside>}
    </div>
    {adding && <SourceForm onClose={() => setAdding(false)} />}
  </section>;
}
