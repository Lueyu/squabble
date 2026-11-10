import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Globe2, Plus, RefreshCw } from 'lucide-react';
import type { DataLibraryCaptureMode, DataLibrarySource } from '@shared/data-library.interface';
import { dataLibraryApi, dataLibraryKey } from '@/api/data-library';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { dataError, dataFailure, dataTime, materialState } from './data-library-labels';
import SourceForm, { CredentialFields, credentialInput, emptyCredential, type CredentialDraft } from './SourceForm';
import CaptureModeFields from './CaptureModeFields';
import BrowserConnectionPanel from './BrowserConnectionPanel';

function SubscriptionDetail({ source }: { source: DataLibrarySource }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const [title, setTitle] = useState(source.title);
  const [interval, setInterval] = useState(String(source.syncIntervalMinutes ?? ''));
  const [captureMode, setCaptureMode] = useState<DataLibraryCaptureMode>(source.captureMode || 'http');
  const [credential, setCredential] = useState<CredentialDraft>({ ...emptyCredential, authKind: source.authKind });
  const [showJobs, setShowJobs] = useState(false), [saved, setSaved] = useState(false);
  const browserKey = [...dataLibraryKey, 'browser', source.id];
  const savedBrowserMode = source.captureMode === 'browser';
  const browser = useQuery({ queryKey: browserKey, queryFn: () => dataLibraryApi.browserStatus(source.id),
    enabled: savedBrowserMode, retry: false, refetchInterval: 5000 });
  const jobs = useQuery({ queryKey: [...dataLibraryKey, 'jobs', source.id], queryFn: () => dataLibraryApi.jobs(source.id), enabled: showJobs, retry: false });
  const invalidate = () => client.invalidateQueries({ queryKey: dataLibraryKey });
  const sync = useMutation({ retry: false, mutationFn: () => dataLibraryApi.sync(source.id), onSettled: invalidate });
  const save = useMutation({ retry: false, mutationFn: async (retrySync: boolean) => {
    await dataLibraryApi.update(source.id, { title: title.trim(), captureMode,
      syncIntervalMinutes: interval ? Number(interval) : null,
      ...(captureMode === 'http' ? credentialInput(credential) : { authKind: 'none' as const }) });
    setCredential({ ...emptyCredential, authKind: captureMode === 'browser' ? 'none' : credential.authKind });
    if (retrySync) return dataLibraryApi.sync(source.id);
    return null;
  }, onSuccess: () => setSaved(true), onSettled: invalidate });
  const browserAction = useMutation({ retry: false,
    mutationFn: (action: 'open' | 'confirm' | 'disconnect') => action === 'open'
      ? dataLibraryApi.openBrowser(source.id) : action === 'confirm'
        ? dataLibraryApi.confirmBrowser(source.id) : dataLibraryApi.disconnectBrowser(source.id),
    onSuccess: status => client.setQueryData(browserKey, status), onSettled: invalidate });
  const toggle = useMutation({ retry: false, mutationFn: () => dataLibraryApi.update(source.id, { enabled: !source.enabled }), onSuccess: invalidate });
  const working = save.isPending || sync.isPending || toggle.isPending || browserAction.isPending;
  // Only persisted settings may drive side effects; drafts must never silently use an old mode.
  const dirty = title.trim() !== source.title || interval !== String(source.syncIntervalMinutes ?? '')
    || captureMode !== (source.captureMode || 'http')
    || (captureMode === 'http' && (credential.authKind !== source.authKind
      || !!credential.credential || !!credential.username || !!credential.password));
  const browserReady = !savedBrowserMode || (browser.data?.state === 'connected' && browser.data.available);
  const result = save.data || sync.data;
  const failed = save.isError || sync.isError || toggle.isError;
  const edited = () => { setSaved(false); save.reset(); sync.reset(); };
  return <article className="data-panel data-subscription-article space-y-5">
    <header className="flex flex-wrap items-center gap-3"><h2 className="text-xl font-semibold break-words">{source.title}</h2><Badge variant="secondary">{materialState(source.state, zh)}</Badge></header>
    {(source.needsReentry || source.state === 'needs-auth' || source.lastErrorCode) && <div className="data-notice data-warning" role="status">
      <p className="font-medium">{source.needsReentry || source.state === 'needs-auth'
        ? zh ? '登录授权需要更新' : 'Sign-in authorization needs renewal'
        : zh ? '上次采集没有完成' : 'The last capture did not complete'}</p>
      <p>{source.versionCount > 0
        ? zh ? '已保存的版本仍可查看。恢复连接后可以重新采集。' : 'Saved versions remain available. Restore the connection and capture again.'
        : zh ? '尚未保存内容。恢复连接后可重试采集。' : 'No content has been saved yet. Restore the connection and try again.'}</p>
      {source.lastErrorCode && <p>{dataFailure(source.lastErrorCode, zh)}</p>}
    </div>}
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(false); }}>
      <fieldset className="space-y-4" disabled={working}>
        <label className="data-field">{zh ? '订阅名称' : 'Subscription name'}<Input required maxLength={200} value={title} onChange={event => { setTitle(event.target.value); edited(); }} /></label>
        <label className="data-field">{zh ? '网站地址' : 'Site URL'}<Input value={source.url || ''} readOnly /><span className="text-xs text-muted-foreground">{zh ? '登录信息绑定此来源地址。更换站点请新建订阅。' : 'Sign-in data is bound to this source address. Add a new subscription for another site.'}</span></label>
        <CaptureModeFields value={captureMode} onChange={value => { setCaptureMode(value); edited(); }} />
        <label className="data-field">{zh ? '更新频率' : 'Update frequency'}<select className="data-select" value={interval} onChange={event => { setInterval(event.target.value); edited(); }}><option value="">{zh ? '仅手动采集' : 'Manual only'}</option><option value="60">{zh ? '每小时' : 'Every hour'}</option><option value="360">{zh ? '每 6 小时' : 'Every 6 hours'}</option><option value="1440">{zh ? '每天' : 'Every day'}</option>{interval && !['60', '360', '1440'].includes(interval) && <option value={interval}>{interval} {zh ? '分钟' : 'minutes'}</option>}</select></label>
        {captureMode === 'http' ? <CredentialFields value={credential} saved={source.hasCredential} onChange={value => { setCredential(value); edited(); }} />
          : <p className="text-sm">{zh ? '认证方式：在专用浏览器中登录' : 'Authentication: sign in using the dedicated browser'}</p>}
      </fieldset>
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={working || !title.trim()}>{save.isPending ? zh ? '正在保存…' : 'Saving…' : zh ? '保存设置' : 'Save settings'}</Button>
        {captureMode === 'http' && <Button type="button" variant="outline" disabled={working || !source.enabled || !title.trim()} onClick={() => save.mutate(true)}>{zh ? '保存并采集' : 'Save and capture'}</Button>}
      </div>
    </form>
    {dirty && <p role="status" className="text-xs text-muted-foreground">{zh ? '有未保存的变更。请先保存，再打开浏览器或采集。' : 'Unsaved changes. Save settings before opening the browser or capturing.'}</p>}
    {captureMode === 'browser' && <BrowserConnectionPanel status={browser.data}
      pending={savedBrowserMode && browser.isPending} error={browserAction.error || browser.error}
      disabled={dirty} hasSession={source.hasBrowserSession} working={working}
      onOpen={() => browserAction.mutate('open')} onConfirm={() => browserAction.mutate('confirm')}
      onDisconnect={() => browserAction.mutate('disconnect')} onRefresh={() => void browser.refetch()} />}
    <div className="data-subscription-actions">
      <Button type="button" disabled={working || dirty || !source.enabled || !browserReady} onClick={() => { save.reset(); sync.mutate(); }}><RefreshCw size={14} className={sync.isPending ? 'animate-spin' : ''} />{sync.isPending ? zh ? '正在采集…' : 'Capturing…' : zh ? '立即采集' : 'Capture now'}</Button>
      <Button type="button" variant="ghost" disabled={working} onClick={() => toggle.mutate()}>{source.enabled ? zh ? '停用订阅' : 'Disable subscription' : zh ? '恢复订阅' : 'Enable subscription'}</Button>
    </div>
    {failed && <p role="alert" className="text-sm text-destructive">{dataError(save.error || sync.error || toggle.error, zh)}</p>}
    {saved && !result && <p role="status" className="data-notice">{zh ? '订阅设置已保存。' : 'Subscription settings saved.'}</p>}
    {result && <p role="status" className="data-notice">{result.job.state === 'succeeded'
      ? result.job.outcome === 'unchanged' ? zh ? '采集完成，内容未变化。' : 'Capture complete; content unchanged.'
        : zh ? '采集完成，新版本已入库。' : 'Capture complete; new version saved.'
      : dataFailure(result.job.errorCode, zh)}</p>}
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border-t pt-4 text-xs text-muted-foreground"><dt>{zh ? '最近成功' : 'Last success'}</dt><dd>{dataTime(source.lastSuccessAt, i18n.language)}</dd><dt>{zh ? '下次采集' : 'Next capture'}</dt><dd>{dataTime(source.nextSyncAt, i18n.language)}</dd><dt>{zh ? '已保存版本' : 'Saved versions'}</dt><dd>{source.versionCount}</dd></dl>
    {!source.versionCount && !source.lastErrorCode && <p className="text-sm text-muted-foreground">{zh ? '尚未保存内容。' : 'No content has been saved yet.'}</p>}
    <p className="text-xs leading-6 text-muted-foreground">{zh ? '定时任务在应用运行期间执行。停用后停止采集与研究召回。' : 'Scheduled jobs run while the application is running. Disabling stops capture and research retrieval.'}</p>
    <Button variant="outline" size="sm" aria-expanded={showJobs} onClick={() => setShowJobs(value => !value)}>{showJobs ? zh ? '收起采集记录' : 'Hide capture history' : zh ? '查看采集记录' : 'View capture history'}</Button>
    {showJobs && <section className="space-y-3 border-t pt-4"><h3 className="text-sm font-medium">{zh ? '最近采集记录' : 'Recent capture history'}</h3>{jobs.isPending && <p role="status">{zh ? '正在读取…' : 'Loading…'}</p>}{jobs.isError && <p role="alert">{dataError(jobs.error, zh)}</p>}{jobs.data?.items.map(job => <div key={job.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-muted/40 p-3 text-xs"><span>{dataTime(job.startedAt, i18n.language)}</span><span>{({ running: zh ? '运行中' : 'Running', succeeded: zh ? '成功' : 'Succeeded', failed: zh ? '失败' : 'Failed', cancelled: zh ? '已取消' : 'Cancelled' })[job.state]}{job.outcome === 'unchanged' ? zh ? ' · 内容未变化' : ' · Unchanged' : job.outcome === 'updated' ? zh ? ' · 新版本' : ' · New version' : ''}{job.errorCode && ` · ${dataFailure(job.errorCode, zh)}`}</span></div>)}{jobs.data && !jobs.data.items.length && <p className="text-sm text-muted-foreground">{zh ? '还没有采集记录。' : 'No capture history yet.'}</p>}</section>}
  </article>;
}

export default function SubscriptionWorkspace() {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false), [offset, setOffset] = useState(0);
  const container = useRef<HTMLDivElement | null>(null);
  const listScroll = useRef(0);
  const returnPending = useRef(false);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const selection = params.get('subscription') || '';
  const select = (id: string, button?: HTMLButtonElement) => {
    if (id && !selection) {
      listScroll.current = container.current?.closest('.app-content')?.scrollTop ?? window.scrollY;
      selectedButton.current = button ?? null;
    }
    if (!id) returnPending.current = true;
    const next = new URLSearchParams(params);
    if (id) next.set('subscription', id); else next.delete('subscription');
    setParams(next, { replace: true });
  };
  useEffect(() => {
    if (!window.matchMedia?.('(max-width: 720px)').matches || (!selection && !returnPending.current)) return;
    const scroller = container.current?.closest('.app-content');
    const frame = window.requestAnimationFrame(() => {
      const top = selection ? 0 : listScroll.current;
      if (scroller) scroller.scrollTop = top; else window.scrollTo({ top });
      if (!selection) {
        if (selectedButton.current?.isConnected) selectedButton.current.focus({ preventScroll: true });
        returnPending.current = false;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selection]);
  const list = useQuery({ queryKey: [...dataLibraryKey, 'subscriptions', offset], queryFn: () => dataLibraryApi.list({ kind: 'website', limit: 30, offset }), retry: false, refetchInterval: 30000 });
  const selectedId = params.get('subscription') || list.data?.items[0]?.id || '';
  const detail = useQuery({ queryKey: [...dataLibraryKey, 'source', selectedId], queryFn: () => dataLibraryApi.detail(selectedId), enabled: !!selectedId, retry: false });
  return <div ref={container} className={`data-config-layout data-subscriptions${selection ? ' has-selection' : ''}`}>
    <aside className="data-panel data-subscription-list space-y-4"><Button className="w-full" onClick={() => setAdding(true)}><Plus size={16} />{zh ? '添加订阅' : 'Add subscription'}</Button>
      {list.isPending && <p role="status">{zh ? '正在读取订阅…' : 'Loading subscriptions…'}</p>}
      {list.isError && <div role="alert"><p>{dataError(list.error, zh)}</p><Button onClick={() => void list.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>}
      <div className="data-list">{list.data?.items.map(source => <button key={source.id} className="data-item" aria-pressed={selectedId === source.id} onClick={event => select(source.id, event.currentTarget)}><span className="data-item-copy"><strong>{source.title}</strong><p>{materialState(source.state, zh)} · {source.captureMode === 'browser' ? zh ? '浏览器' : 'Browser' : 'HTTP'} · {source.syncIntervalMinutes ? `${source.syncIntervalMinutes} ${zh ? '分钟' : 'min'}` : zh ? '手动采集' : 'Manual capture'}</p></span></button>)}</div>
      {list.data && list.data.total > 30 && <div className="flex justify-between gap-2"><Button variant="ghost" size="sm" disabled={!offset} onClick={() => setOffset(value => value - 30)}>{zh ? '上一页' : 'Previous'}</Button><Button variant="ghost" size="sm" disabled={offset + 30 >= list.data.total} onClick={() => setOffset(value => value + 30)}>{zh ? '下一页' : 'Next'}</Button></div>}
      <p className="text-xs leading-6 text-muted-foreground">{zh ? '采集内容会自动进入资料库，并可在记忆的“资料来源”中查看。' : 'Captured content appears in the library and in Memory’s Sources view.'}</p>
    </aside>
    <div className="data-subscription-detail space-y-4">
      <Button type="button" variant="ghost" className="data-subscription-back" onClick={() => select('')}><ArrowLeft size={16} />{zh ? '返回网站订阅' : 'Back to subscriptions'}</Button>
      {detail.data ? <SubscriptionDetail key={detail.data.source.id} source={detail.data.source} />
        : detail.isError ? <div className="data-panel" role="alert"><p>{dataError(detail.error, zh)}</p><Button onClick={() => void detail.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>
          : <div className="data-panel data-empty"><Globe2 size={36} /><h2 className="text-lg font-medium text-foreground">{selectedId ? zh ? '正在读取订阅…' : 'Loading subscription…' : zh ? '把关注的网站留在这里' : 'Keep the sites you follow here'}</h2><p className="max-w-md text-sm leading-7">{zh ? '添加地址、采集方式与更新频率，查看每次采集结果。网站内容会保存为可追溯版本。' : 'Add an address, collection method and update schedule. Each capture retains traceable content versions.'}</p></div>}
    </div>
    {adding && <SourceForm subscription onClose={() => setAdding(false)} />}
  </div>;
}
