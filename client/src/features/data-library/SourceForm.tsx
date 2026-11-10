import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { DataLibraryAuthKind, DataLibraryCaptureMode, DataLibrarySourceCreate } from '@shared/data-library.interface';
import { dataLibraryApi, dataLibraryKey } from '@/api/data-library';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { dataError } from './data-library-labels';
import CaptureModeFields from './CaptureModeFields';

export interface CredentialDraft { authKind: DataLibraryAuthKind; credential: string; username: string; password: string }
export const emptyCredential: CredentialDraft = { authKind: 'none', credential: '', username: '', password: '' };

export function credentialInput(value: CredentialDraft) {
  return {
    authKind: value.authKind,
    ...(value.authKind === 'basic'
      ? value.password ? { username: value.username, password: value.password } : {}
      : value.authKind !== 'none' && value.credential ? { credential: value.credential } : {}),
  };
}

export function CredentialFields({ value, onChange, saved = false }: {
  value: CredentialDraft; onChange: (draft: CredentialDraft) => void; saved?: boolean;
}) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  return <div className="space-y-4">
    <label className="data-field">{zh ? '认证方式' : 'Authentication'}
      <select className="data-select" value={value.authKind} onChange={event => onChange({ ...emptyCredential, authKind: event.target.value as DataLibraryAuthKind })}>
        <option value="none">{zh ? '无需登录' : 'Public source'}</option>
        <option value="cookie">{zh ? '授权 Cookie' : 'Authorized cookie'}</option>
        <option value="bearer">Bearer token</option>
        <option value="basic">HTTP Basic</option>
      </select>
    </label>
    {value.authKind === 'basic' ? <div className="grid gap-4 sm:grid-cols-2">
      <label className="data-field">{zh ? 'HTTP Basic 用户名' : 'HTTP Basic username'}<Input autoComplete="off" value={value.username} onChange={event => onChange({ ...value, username: event.target.value })} /></label>
      <label className="data-field">{zh ? '密码' : 'Password'}<Input type="password" autoComplete="new-password" value={value.password} placeholder={saved ? zh ? '留空保留已存凭据' : 'Leave blank to keep saved credentials' : ''} onChange={event => onChange({ ...value, password: event.target.value })} /></label>
    </div> : value.authKind !== 'none' && <label className="data-field">{zh ? '登录凭据' : 'Credential'}
      <Input type="password" autoComplete="new-password" value={value.credential} placeholder={saved ? zh ? '已加密保存，留空保留' : 'Encrypted credential saved; leave blank to keep' : value.authKind === 'cookie' ? 'name=value; name2=value2' : 'Bearer token'} onChange={event => onChange({ ...value, credential: event.target.value })} />
    </label>}
    {value.authKind !== 'none' && <p className="text-xs leading-6 text-muted-foreground">{zh ? '凭据加密保存，仅发送到该网站，不进入研究材料。普通网页的邮箱密码登录不等于 HTTP Basic；登录过期后请更新授权凭据。' : 'Credentials are encrypted, sent only to this site and excluded from research material. A normal email/password sign-in is not HTTP Basic. Renew expired authorization here.'}</p>}
  </div>;
}

async function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('file-read-failed'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

export default function SourceForm({ subscription = false, onClose }: { subscription?: boolean; onClose: () => void }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const [mode, setMode] = useState<'text' | 'url' | 'file'>(subscription ? 'url' : 'text');
  const [title, setTitle] = useState(''), [description, setDescription] = useState('');
  const [text, setText] = useState(''), [url, setUrl] = useState('');
  const [format, setFormat] = useState<'html' | 'rss' | 'json'>('html');
  const [captureMode, setCaptureMode] = useState<DataLibraryCaptureMode>('http');
  const [interval, setInterval] = useState(subscription ? '1440' : '');
  const [credential, setCredential] = useState<CredentialDraft>(emptyCredential);
  const [file, setFile] = useState<File | null>(null), [fileError, setFileError] = useState('');
  const save = useMutation({
    retry: false,
    mutationFn: async () => {
      if (mode === 'file') {
        if (!file || file.size > 8 * 1024 * 1024) throw new Error('invalid-file');
        return dataLibraryApi.upload({ title: title.trim(), description, fileName: file.name, mimeType: file.type || 'application/octet-stream', data: await fileBase64(file) });
      }
      const input: DataLibrarySourceCreate = mode === 'text'
        ? { title: title.trim(), description, kind: 'page', format: 'text', text }
        : { title: title.trim(), description, kind: 'website', format, captureMode, url: url.trim(), enabled: true,
          syncIntervalMinutes: interval ? Number(interval) : null,
          ...(captureMode === 'http' ? credentialInput(credential) : { authKind: 'none' as const }) };
      return dataLibraryApi.create(input);
    },
    onSuccess: async () => {
      setCredential(emptyCredential);
      await client.invalidateQueries({ queryKey: dataLibraryKey });
      onClose();
    },
  });
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>{subscription ? zh ? '添加网站订阅' : 'Add a website subscription' : zh ? '添加研究资料' : 'Add research material'}</DialogTitle><DialogDescription>{zh ? '保存原文和来源版本，供研究检索与引用。' : 'Save the original and source versions for research retrieval and citation.'}</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      {!subscription && <div className="data-tabs" role="group" aria-label={zh ? '资料来源' : 'Source type'}>{(['text', 'url', 'file'] as const).map(item => <Button key={item} type="button" variant={mode === item ? 'secondary' : 'ghost'} aria-pressed={mode === item} onClick={() => setMode(item)}>{({ text: zh ? '新建页面' : 'Write a page', url: zh ? '网页链接' : 'Web page', file: zh ? '上传文件' : 'Upload file' })[item]}</Button>)}</div>}
      <label className="data-field">{zh ? '名称' : 'Name'}<Input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
      {mode === 'text' && <label className="data-field">{zh ? '页面内容' : 'Page content'}<Textarea required rows={9} value={text} onChange={event => setText(event.target.value)} /></label>}
      {mode === 'url' && <>
        <label className="data-field">{zh ? '来源地址' : 'Source URL'}<Input type="url" required placeholder="https://example.com/research" value={url} onChange={event => setUrl(event.target.value)} /></label>
        <CaptureModeFields value={captureMode} disabled={save.isPending} onChange={value => { setCaptureMode(value); if (value === 'browser') setFormat('html'); }} />
        <div className="grid gap-4 sm:grid-cols-2"><label className="data-field">{zh ? '内容格式' : 'Content format'}<select className="data-select" value={format} disabled={captureMode === 'browser'} onChange={event => setFormat(event.target.value as typeof format)}><option value="html">HTML</option><option value="rss">RSS / Atom</option><option value="json">JSON</option></select></label>
          <label className="data-field">{zh ? '更新频率' : 'Update frequency'}<select className="data-select" value={interval} onChange={event => setInterval(event.target.value)}><option value="">{zh ? '仅手动同步' : 'Manual only'}</option><option value="60">{zh ? '每小时' : 'Every hour'}</option><option value="360">{zh ? '每 6 小时' : 'Every 6 hours'}</option><option value="1440">{zh ? '每天' : 'Every day'}</option></select></label></div>
        {captureMode === 'http' ? <CredentialFields value={credential} onChange={setCredential} />
          : <p className="data-notice">{zh ? '认证方式：在专用浏览器中登录。先保存订阅，再打开浏览器并保存连接，最后手动采集。' : 'Authentication: sign in using the dedicated browser. Save the subscription, open the browser and save its connection, then capture.'}</p>}
        <p className="text-xs leading-6 text-muted-foreground">{zh ? '定时任务在应用运行期间执行。浏览器采集只保存配置地址的页面正文，不会自动遍历全站。' : 'Scheduled jobs run while the application is running. Browser capture saves only the configured page, without crawling the entire site.'}</p>
      </>}
      {mode === 'file' && <label className="data-field">{zh ? '文件 · 最大 8 MiB' : 'File · Up to 8 MiB'}<Input type="file" required accept=".txt,.md,.html,.htm,.json,.xml,.rss,.pptx,.png,.jpg,.jpeg,.webp" onChange={event => {
        const next = event.target.files?.[0] ?? null;
        setFile(next);
        setFileError(next && next.size > 8 * 1024 * 1024 ? zh ? '文件超过 8 MiB。' : 'File exceeds 8 MiB.' : '');
        if (next && !title) setTitle(next.name);
      }} /><span className="text-xs leading-6 text-muted-foreground">{zh ? '支持文本、网页、JSON、RSS、PPTX 和图片。图片保存原件，可补充说明；不会假装已经识别图片文字。' : 'Text, HTML, JSON, RSS, PPTX and images. Images preserve the original with your description; no OCR is implied.'}</span></label>}
      <label className="data-field">{zh ? '说明（可选）' : 'Description (optional)'}<Textarea rows={2} value={description} onChange={event => setDescription(event.target.value)} /></label>
      {(save.isError || fileError) && <p role="alert" className="text-sm text-destructive">{fileError || dataError(save.error, zh)}</p>}
      <footer className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={save.isPending} onClick={onClose}>{zh ? '取消' : 'Cancel'}</Button><Button type="submit" disabled={save.isPending || !!fileError || !title.trim()}>{save.isPending ? zh ? '正在保存…' : 'Saving…' : zh ? '保存资料' : 'Save source'}</Button></footer>
    </form>
  </DialogContent></Dialog>;
}
