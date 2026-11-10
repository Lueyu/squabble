import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Globe2, Plus, RefreshCw } from 'lucide-react';
import type { DataLibrarySource } from '@shared/data-library.interface';
import { dataLibraryApi, dataLibraryKey } from '@/api/data-library';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { dataError, dataTime, materialState } from './data-library-labels';
import SourceForm, { CredentialFields, credentialInput, emptyCredential, type CredentialDraft } from './SourceForm';

function SubscriptionDetail({ source }: { source: DataLibrarySource }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const [title, setTitle] = useState(source.title);
  const [interval, setInterval] = useState(String(source.syncIntervalMinutes ?? ''));
  const [credential, setCredential] = useState<CredentialDraft>({ ...emptyCredential, authKind: source.authKind });
  const [showJobs, setShowJobs] = useState(false), [saved, setSaved] = useState(false);
  const jobs = useQuery({ queryKey: [...dataLibraryKey, 'jobs', source.id], queryFn: () => dataLibraryApi.jobs(source.id), enabled: showJobs, retry: false });
  const invalidate = () => client.invalidateQueries({ queryKey: dataLibraryKey });
  const sync = useMutation({ retry: false, mutationFn: () => dataLibraryApi.sync(source.id), onSettled: invalidate });
  const save = useMutation({ retry: false, mutationFn: async (retrySync: boolean) => {
    await dataLibraryApi.update(source.id, { title, syncIntervalMinutes: interval ? Number(interval) : null, ...credentialInput(credential) });
    setCredential(current => ({ ...emptyCredential, authKind: current.authKind }));
    if (retrySync) return dataLibraryApi.sync(source.id);
    return null;
  }, onSuccess: () => setSaved(true), onSettled: invalidate });
  const toggle = useMutation({ retry: false, mutationFn: () => dataLibraryApi.update(source.id, { enabled: !source.enabled }), onSuccess: invalidate });
  const working = save.isPending || sync.isPending || toggle.isPending;
  const result = save.data || sync.data;
  const failed = save.isError || sync.isError || toggle.isError;
  return <article className="data-panel space-y-5">
    <header className="flex flex-wrap items-center gap-3"><h2 className="text-xl font-semibold break-words">{source.title}</h2><Badge variant="secondary">{materialState(source.state, zh)}</Badge></header>
    {(source.needsReentry || source.state === 'needs-auth' || source.lastErrorCode) && <div className="data-notice data-warning" role="status"><p className="font-medium">{source.needsReentry || source.state === 'needs-auth' ? zh ? '登录授权需要更新' : 'Sign-in authorization needs renewal' : zh ? '上次同步没有完成' : 'The last sync did not complete'}</p><p>{zh ? '已保存的版本仍可查看。更新凭据后，可以在这里重新同步。' : 'Saved versions remain available. Update credentials and retry the sync here.'}</p>{source.lastErrorCode && <p className="text-xs">{source.lastErrorCode}</p>}</div>}
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(false); }}>
      <label className="data-field">{zh ? '订阅名称' : 'Subscription name'}<Input required maxLength={200} value={title} onChange={event => { setTitle(event.target.value); setSaved(false); }} /></label>
      <label className="data-field">{zh ? '网站地址' : 'Site URL'}<Input value={source.url || ''} readOnly /><span className="text-xs text-muted-foreground">{zh ? '登录凭据绑定此来源地址。更换站点请新建订阅。' : 'Credentials are bound to this source address. Add a new subscription for another site.'}</span></label>
      <label className="data-field">{zh ? '更新频率' : 'Update frequency'}<select className="data-select" value={interval} onChange={event => { setInterval(event.target.value); setSaved(false); }}><option value="">{zh ? '仅手动同步' : 'Manual only'}</option><option value="60">{zh ? '每小时' : 'Every hour'}</option><option value="360">{zh ? '每 6 小时' : 'Every 6 hours'}</option><option value="1440">{zh ? '每天' : 'Every day'}</option>{interval && !['60', '360', '1440'].includes(interval) && <option value={interval}>{interval} {zh ? '分钟' : 'minutes'}</option>}</select></label>
      <CredentialFields value={credential} saved={source.hasCredential} onChange={value => { setCredential(value); setSaved(false); }} />
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={working || !title.trim()}>{save.isPending ? zh ? '正在保存…' : 'Saving…' : zh ? '保存设置' : 'Save settings'}</Button>
        <Button type="button" variant="outline" disabled={working || !source.enabled || !title.trim()} onClick={() => save.mutate(true)}>{zh ? '保存并同步' : 'Save and sync'}</Button>
        <Button type="button" variant="outline" disabled={working || !source.enabled} onClick={() => sync.mutate()}><RefreshCw size={14} className={sync.isPending ? 'animate-spin' : ''} />{zh ? '立即同步' : 'Sync now'}</Button>
        <Button type="button" variant="ghost" disabled={working} onClick={() => toggle.mutate()}>{source.enabled ? zh ? '停用订阅' : 'Disable subscription' : zh ? '恢复订阅' : 'Enable subscription'}</Button></div>
    </form>
    {failed && <p role="alert" className="text-sm text-destructive">{dataError(save.error || sync.error || toggle.error, zh)}</p>}
    {saved && !result && <p role="status" className="data-notice">{zh ? '订阅设置已保存。' : 'Subscription settings saved.'}</p>}
    {result && <p role="status" className="data-notice">{result.job.state === 'succeeded' ? result.job.outcome === 'unchanged' ? zh ? '同步完成，内容未变化。' : 'Sync complete; content unchanged.' : zh ? '同步完成，新版本已入库。' : 'Sync complete; new version saved.' : `${zh ? '同步未完成' : 'Sync incomplete'} · ${result.job.errorCode ?? result.job.state}`}</p>}
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border-t pt-4 text-xs text-muted-foreground"><dt>{zh ? '最近成功' : 'Last success'}</dt><dd>{dataTime(source.lastSuccessAt, i18n.language)}</dd><dt>{zh ? '下次同步' : 'Next sync'}</dt><dd>{dataTime(source.nextSyncAt, i18n.language)}</dd><dt>{zh ? '已保存版本' : 'Saved versions'}</dt><dd>{source.versionCount}</dd></dl>
    <p className="text-xs leading-6 text-muted-foreground">{zh ? '定时任务在应用运行期间执行。停用后停止同步与研究召回，已存原文仍可查看。' : 'Scheduled jobs run while the application is running. Disabling stops sync and research retrieval; saved originals remain inspectable.'}</p>
    <Button variant="outline" size="sm" aria-expanded={showJobs} onClick={() => setShowJobs(value => !value)}>{showJobs ? zh ? '收起同步记录' : 'Hide sync history' : zh ? '查看同步记录' : 'View sync history'}</Button>
    {showJobs && <section className="space-y-3 border-t pt-4"><h3 className="text-sm font-medium">{zh ? '最近同步记录' : 'Recent sync history'}</h3>{jobs.isPending && <p role="status">{zh ? '正在读取…' : 'Loading…'}</p>}{jobs.isError && <p role="alert">{dataError(jobs.error, zh)}</p>}{jobs.data?.items.map(job => <div key={job.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-muted/40 p-3 text-xs"><span>{dataTime(job.startedAt, i18n.language)}</span><span>{({ running: zh ? '运行中' : 'Running', succeeded: zh ? '成功' : 'Succeeded', failed: zh ? '失败' : 'Failed', cancelled: zh ? '已取消' : 'Cancelled' })[job.state]}{job.outcome === 'unchanged' ? zh ? ' · 内容未变化' : ' · Unchanged' : job.outcome === 'updated' ? zh ? ' · 新版本' : ' · New version' : ''}{job.errorCode && ` · ${job.errorCode}`}</span></div>)}{jobs.data && !jobs.data.items.length && <p className="text-sm text-muted-foreground">{zh ? '还没有同步记录。' : 'No sync history yet.'}</p>}</section>}
  </article>;
}

export default function SubscriptionWorkspace() {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false), [offset, setOffset] = useState(0);
  const list = useQuery({ queryKey: [...dataLibraryKey, 'subscriptions', offset], queryFn: () => dataLibraryApi.list({ kind: 'website', limit: 30, offset }), retry: false, refetchInterval: 30000 });
  const selectedId = params.get('subscription') || list.data?.items[0]?.id || '';
  const detail = useQuery({ queryKey: [...dataLibraryKey, 'source', selectedId], queryFn: () => dataLibraryApi.detail(selectedId), enabled: !!selectedId, retry: false });
  return <div className="data-config-layout">
    <aside className="data-panel space-y-4"><Button className="w-full" onClick={() => setAdding(true)}><Plus size={16} />{zh ? '添加订阅' : 'Add subscription'}</Button>
      {list.isPending && <p role="status">{zh ? '正在读取订阅…' : 'Loading subscriptions…'}</p>}
      {list.isError && <div role="alert"><p>{dataError(list.error, zh)}</p><Button onClick={() => void list.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>}
      <div className="data-list">{list.data?.items.map(source => <button key={source.id} className="data-item" aria-pressed={selectedId === source.id} onClick={() => { const next = new URLSearchParams(params); next.set('subscription', source.id); setParams(next, { replace: true }); }}><span className="data-item-copy"><strong>{source.title}</strong><p>{materialState(source.state, zh)} · {source.syncIntervalMinutes ? `${source.syncIntervalMinutes} ${zh ? '分钟' : 'min'}` : zh ? '手动同步' : 'Manual sync'}</p></span></button>)}</div>
      {list.data && list.data.total > 30 && <div className="flex justify-between gap-2"><Button variant="ghost" size="sm" disabled={!offset} onClick={() => setOffset(value => value - 30)}>{zh ? '上一页' : 'Previous'}</Button><Button variant="ghost" size="sm" disabled={offset + 30 >= list.data.total} onClick={() => setOffset(value => value + 30)}>{zh ? '下一页' : 'Next'}</Button></div>}
      <p className="text-xs leading-6 text-muted-foreground">{zh ? '采集内容会自动进入资料库，并可在记忆的“资料来源”中查看。' : 'Synced content appears in the library and in Memory’s Sources view.'}</p>
    </aside>
    {detail.data ? <SubscriptionDetail key={detail.data.source.id} source={detail.data.source} /> : detail.isError ? <div className="data-panel" role="alert"><p>{dataError(detail.error, zh)}</p><Button onClick={() => void detail.refetch()}>{zh ? '重试' : 'Retry'}</Button></div> : <div className="data-panel data-empty"><Globe2 size={36} /><h2 className="text-lg font-medium text-foreground">{selectedId ? zh ? '正在读取订阅…' : 'Loading subscription…' : zh ? '把关注的网站留在这里' : 'Keep the sites you follow here'}</h2><p className="max-w-md text-sm leading-7">{zh ? '添加地址、授权方式与更新频率，查看每次采集结果。网站内容会保存为可追溯版本。' : 'Add the address, authorization and update schedule. Each sync retains traceable content versions.'}</p></div>}
    {adding && <SourceForm subscription onClose={() => setAdding(false)} />}
  </div>;
}
