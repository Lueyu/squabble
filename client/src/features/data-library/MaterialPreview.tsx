import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw, Trash2 } from 'lucide-react';
import DocumentExtractionStatus from './DocumentExtractionStatus';
import { dataLibraryApi, dataLibraryKey } from '@/api/data-library';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { DataLibrarySource, DataLibraryVersion } from '@shared/data-library.interface';
import { dataError, dataFailure, dataTime, materialKind, materialState, safeSourceUrl } from './data-library-labels';

function SavedImage({ source }: { source: DataLibrarySource }) {
  const [url, setUrl] = useState('');
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const file = useQuery({ queryKey: [...dataLibraryKey, 'file', source.id, source.latestVersionId], queryFn: () => dataLibraryApi.file(source.id), retry: false });
  useEffect(() => {
    if (!file.data) return;
    const next = URL.createObjectURL(file.data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file.data]);
  if (file.isError) return <p role="alert" className="text-sm text-destructive">{dataError(file.error, zh)}</p>;
  return url ? <img src={url} alt={source.description || source.title} className="max-h-72 w-full rounded-lg object-contain" /> : <p role="status">{zh ? '正在读取图片…' : 'Loading image…'}</p>;
}

function EditMaterial({ source, version, onClose }: { source: DataLibrarySource; version?: DataLibraryVersion; onClose: () => void }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const [title, setTitle] = useState(source.title), [description, setDescription] = useState(source.description);
  const [content, setContent] = useState(version?.extractedText ?? '');
  const editableText = source.kind === 'page' && source.format === 'text' && !source.url;
  const save = useMutation({ retry: false, mutationFn: () => dataLibraryApi.update(source.id, { title, description, ...(editableText ? { text: content } : {}) }), onSuccess: async () => { await client.invalidateQueries({ queryKey: dataLibraryKey }); onClose(); } });
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{zh ? '编辑资料' : 'Edit source'}</DialogTitle><DialogDescription>{zh ? '来源版本会保留；修改内容不会改写已保存的研究报告。' : 'Source versions are retained; edits do not rewrite saved research reports.'}</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <label className="data-field">{zh ? '名称' : 'Name'}<Input required value={title} maxLength={200} onChange={event => setTitle(event.target.value)} /></label>
      <label className="data-field">{zh ? '说明' : 'Description'}<Textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>
      {editableText && <label className="data-field">{zh ? '正文' : 'Content'}<Textarea required rows={10} value={content} onChange={event => setContent(event.target.value)} /></label>}
      {save.isError && <p role="alert" className="text-sm text-destructive">{dataError(save.error, zh)}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" type="button" disabled={save.isPending} onClick={onClose}>{zh ? '取消' : 'Cancel'}</Button><Button disabled={save.isPending || (editableText && !version)}>{zh ? '保存' : 'Save'}</Button></div>
    </form>
  </DialogContent></Dialog>;
}

export default function MaterialPreview({ sourceId, onRemoved }: { sourceId: string; onRemoved: () => void }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const [selectedVersion, setSelectedVersion] = useState('');
  const [raw, setRaw] = useState(false), [editing, setEditing] = useState(false), [deleting, setDeleting] = useState(false);
  const detail = useQuery({ queryKey: [...dataLibraryKey, 'source', sourceId], queryFn: () => dataLibraryApi.detail(sourceId), retry: false });
  const source = detail.data?.source;
  const versionId = selectedVersion || source?.latestVersionId || '';
  const version = useQuery({ queryKey: [...dataLibraryKey, 'version', sourceId, versionId], queryFn: () => dataLibraryApi.version(sourceId, versionId), enabled: !!versionId, retry: false });
  const invalidate = () => client.invalidateQueries({ queryKey: dataLibraryKey });
  const sync = useMutation({ retry: false, mutationFn: () => dataLibraryApi.sync(sourceId), onSettled: invalidate });
  const toggle = useMutation({ retry: false, mutationFn: () => dataLibraryApi.update(sourceId, { enabled: !source?.enabled }), onSuccess: invalidate });
  const remove = useMutation({ retry: false, mutationFn: () => dataLibraryApi.remove(sourceId), onSuccess: async () => { await invalidate(); onRemoved(); } });
  const download = useMutation({ retry: false, mutationFn: async () => {
    const blob = await dataLibraryApi.file(sourceId);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = source?.fileName || 'source'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  if (detail.isPending) return <aside className="data-panel" role="status">{zh ? '正在读取资料…' : 'Loading source…'}</aside>;
  if (!source) return <aside className="data-panel" role="alert"><p>{dataError(detail.error, zh)}</p><Button variant="outline" onClick={() => void detail.refetch()}>{zh ? '重试' : 'Retry'}</Button></aside>;
  const sourceUrl = safeSourceUrl(source.url);
  const capturedUrl = safeSourceUrl(version.data?.finalUrl);
  return <aside className="data-panel data-preview" aria-label={zh ? '资料预览' : 'Source preview'}>
    <div className="flex flex-wrap gap-2"><Badge variant="secondary">{materialKind(source.kind, zh)}</Badge><Badge variant="outline">{materialState(source.state, zh)}</Badge></div>
    <h2>{source.title}</h2>
    <dl><dt>{zh ? '来源' : 'Source'}</dt><dd>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">{new URL(sourceUrl).hostname}</a> : source.fileName || (zh ? '手动页面' : 'Written page')}</dd>
      <dt>{zh ? '最近入库' : 'Last saved'}</dt><dd>{dataTime(source.lastSuccessAt || source.updatedAt, i18n.language)}</dd>
      <dt>{zh ? '保存版本' : 'Saved versions'}</dt><dd>{source.versionCount}</dd></dl>
    {source.description && <p className="text-sm leading-7 whitespace-pre-wrap break-words">{source.description}</p>}
    {source.kind === 'image' && <SavedImage source={source} />}
    {source.kind === 'image' && source.state === 'needs-text' && <p className="data-notice data-warning">{zh ? '原图已保存，尚未 OCR。研究只能使用你补充的说明，不能当作已识别的图中文字。' : 'Original image saved without OCR. Research can use your description, not inferred image text.'}</p>}
    {(source.format === 'pdf' || source.format === 'docx') && <DocumentExtractionStatus sourceId={sourceId} versionId={versionId} enabled={source.enabled} zh={zh} />}
    <label className="data-field">{zh ? '版本历史' : 'Version history'}<select className="data-select" value={versionId} onChange={event => setSelectedVersion(event.target.value)} disabled={!detail.data?.versions.length}>
      {!detail.data?.versions.length && <option value="">{zh ? '等待首次同步' : 'Awaiting first sync'}</option>}
      {detail.data?.versions.map(item => <option key={item.id} value={item.id}>v{item.version} · {dataTime(item.observedAt, i18n.language)}</option>)}
    </select></label>
    {version.data?.acquisition && <section className="data-notice space-y-2" aria-label={zh ? '版本采集信息' : 'Version acquisition details'}>
      <p className="font-medium">{version.data.acquisition === 'browser-rendered'
        ? zh ? '浏览器渲染正文' : 'Browser-rendered content'
        : version.data.acquisition === 'http' ? zh ? 'HTTP 静态采集' : 'HTTP static capture'
          : zh ? '导入或手动保存' : 'Imported or written document'}</p>
      <dl><dt>{zh ? '采集时间' : 'Captured at'}</dt><dd>{dataTime(version.data.observedAt, i18n.language)}</dd>
        {version.data.pageTitle && <><dt>{zh ? '页面标题' : 'Page title'}</dt><dd>{version.data.pageTitle}</dd></>}
        {capturedUrl && <><dt>{zh ? '实际页面' : 'Captured page'}</dt><dd><a className="underline" href={capturedUrl} target="_blank" rel="noopener noreferrer">{capturedUrl}</a></dd></>}
      </dl>
    </section>}
    <div className="border-t pt-4 space-y-3"><h3 className="text-sm font-medium">{zh ? '内容预览' : 'Content preview'}</h3>
      {version.isFetching && <p role="status" className="text-xs text-muted-foreground">{zh ? '正在读取版本…' : 'Loading version…'}</p>}
      {version.isError && <p role="alert" className="text-sm text-destructive">{dataError(version.error, zh)}</p>}
      {version.data ? <div className="data-preview-text">{version.data.extractedText || (zh ? '没有可检索正文。' : 'No searchable text.')}</div> : !versionId && <p className="text-sm text-muted-foreground">{zh ? '保存来源后，请同步取得正文。' : 'Sync this source to save its content.'}</p>}
    </div>
    {version.data && source.enabled && <Button asChild><Link to={`/research?sourceId=${encodeURIComponent(sourceId)}&versionId=${encodeURIComponent(versionId)}`} state={{ returnTo: `/data?source=${encodeURIComponent(sourceId)}` }}>{zh ? '在研究室使用此版本' : 'Research this version'}</Link></Button>}
    <div className="flex flex-wrap gap-2">
      {version.data && <Button variant="outline" size="sm" onClick={() => setRaw(true)}>{zh ? '查看原文' : 'Original text'}</Button>}
      {source.fileName && <Button variant="outline" size="sm" disabled={download.isPending} onClick={() => download.mutate()}><Download size={14} />{zh ? '下载原件' : 'Download'}</Button>}
      <Button variant="outline" size="sm" disabled={source.format === 'text' && (version.isFetching || versionId !== source.latestVersionId)} onClick={() => setEditing(true)}>{zh ? '编辑' : 'Edit'}</Button>
      {source.url && <Button variant="outline" size="sm" disabled={sync.isPending || !source.enabled} onClick={() => sync.mutate()}><RefreshCw size={14} className={sync.isPending ? 'animate-spin' : ''} />{zh ? '同步' : 'Sync'}</Button>}
      <Button variant="ghost" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate()}>{source.enabled ? zh ? '停用来源' : 'Exclude source' : zh ? '恢复来源' : 'Restore source'}</Button>
      <Button variant="ghost" size="sm" onClick={() => setDeleting(true)} aria-label={zh ? `删除资料 ${source.title}` : `Delete ${source.title}`}><Trash2 size={14} />{zh ? '删除' : 'Delete'}</Button>
    </div>
    {[sync, toggle, download].some(item => item.isError) && <p role="alert" className="text-sm text-destructive">{dataError(sync.error || toggle.error || download.error, zh)}</p>}
    {sync.data && <p role="status" className="data-notice">{sync.data.job.state === 'succeeded' ? sync.data.job.outcome === 'unchanged' ? zh ? '同步完成，内容未变化。' : 'Sync complete; content unchanged.' : zh ? '新版本已入库。' : 'New version saved.' : dataFailure(sync.data.job.errorCode, zh)}</p>}
    {editing && <EditMaterial source={source} version={version.data} onClose={() => setEditing(false)} />}
    <Dialog open={raw} onOpenChange={setRaw}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{source.title} · v{version.data?.version}</DialogTitle><DialogDescription>{zh ? '原文以纯文本显示；不会执行网页脚本。' : 'Original content displayed as text; web scripts are never executed.'}</DialogDescription></DialogHeader><pre className="data-preview-text">{version.data?.rawContent}</pre></DialogContent></Dialog>
    <Dialog open={deleting} onOpenChange={open => { if (!remove.isPending) setDeleting(open); }}><DialogContent><DialogHeader><DialogTitle>{zh ? '删除这份资料？' : 'Delete this source?'}</DialogTitle><DialogDescription>{zh ? '该来源将停止同步和未来研究召回。已有报告保留原有引用记录，不会被改写。' : 'This source will stop syncing and will be excluded from future research retrieval. Existing reports retain their historical citations.'}</DialogDescription></DialogHeader>{remove.isError && <p role="alert">{dataError(remove.error, zh)}</p>}<div className="flex justify-end gap-2"><Button variant="ghost" disabled={remove.isPending} onClick={() => setDeleting(false)}>{zh ? '取消' : 'Cancel'}</Button><Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>{zh ? '确认删除' : 'Confirm deletion'}</Button></div></DialogContent></Dialog>
  </aside>;
}
