import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, RefreshCw } from 'lucide-react';
import type { DataBrowserStatus } from '@shared/data-library.interface';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { dataError, dataFailure, dataTime } from './data-library-labels';

export default function BrowserConnectionPanel({ status, pending, error, disabled, hasSession,
  working, onOpen, onConfirm, onDisconnect, onRefresh }: {
  status?: DataBrowserStatus; pending: boolean; error: unknown; disabled: boolean;
  hasSession: boolean; working: boolean; onOpen: () => void; onConfirm: () => void;
  onDisconnect: () => void; onRefresh: () => void;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [disconnecting, setDisconnecting] = useState(false);
  const state = status?.state;
  const label = state ? ({
    'not-connected': zh ? '未连接' : 'Not connected',
    'login-open': zh ? '登录窗口已打开' : 'Sign-in window open',
    connected: zh ? '已连接' : 'Connected',
    'needs-login': zh ? '登录过期' : 'Sign-in expired',
    unavailable: zh ? '浏览器不可用' : 'Browser unavailable',
  })[state] : zh ? '待检查' : 'Not checked';
  const unavailable = status?.available === false || state === 'unavailable';
  const cannotOpen = unavailable || status?.canOpenInteractive === false;
  return <section className="data-browser-connection" aria-label={zh ? '浏览器连接' : 'Browser connection'}>
    <header className="flex flex-wrap items-center gap-2">
      <Monitor size={18} aria-hidden="true" /><h3 className="text-sm font-semibold">{zh ? '浏览器连接' : 'Browser connection'}</h3>
      <Badge variant="secondary">{label}</Badge>
    </header>
    {disabled ? <p role="status">{zh ? '请先保存设置，再打开浏览器或采集。' : 'Save settings before opening the browser or capturing.'}</p>
      : pending ? <p role="status">{zh ? '正在检查浏览器连接…' : 'Checking browser connection…'}</p>
        : unavailable ? <p role="status">{dataFailure(status?.reason || 'UNAVAILABLE', zh)}</p>
          : <p>{state === 'login-open'
            ? zh ? '请在运行 Squabble 服务的电脑上完成专用浏览器登录，再回到这里保存连接。' : 'Complete sign-in in the dedicated browser on the server computer, then return here to save the connection.'
            : state === 'connected'
              ? zh ? '连接已保存。点击“立即采集”取得当前页面正文。' : 'Connection saved. Use Capture now to read the current page.'
              : zh ? '打开专用浏览器，按网站正常流程登录。登录完成后，回到这里保存连接。' : 'Open the dedicated browser and sign in normally, then return here to save the connection.'}</p>}
    {!disabled && !unavailable && status?.canOpenInteractive === false && <p className="text-xs text-muted-foreground">{dataFailure(status.reason || 'BROWSER_LOGIN_UNAVAILABLE', zh)}</p>}
    {!!error && <p role="alert" className="text-destructive">{dataError(error, zh)}</p>}
    <div className="data-browser-actions">
      {state === 'login-open' && <Button type="button" disabled={disabled || working || pending}
        onClick={onConfirm}>{zh ? '我已登录，保存连接' : 'I signed in; save connection'}</Button>}
      <Button type="button" variant={state === 'not-connected' || state === 'needs-login' ? 'default' : 'outline'}
        disabled={disabled || working || pending || cannotOpen || !status} onClick={onOpen}>
        {state === 'needs-login' ? zh ? '重新登录' : 'Sign in again'
          : state === 'login-open' || state === 'connected' ? zh ? '重新打开浏览器' : 'Reopen browser'
            : zh ? '打开浏览器并登录' : 'Open browser and sign in'}
      </Button>
      {(hasSession || status?.loginWindowOpen) && <Button type="button" variant="ghost"
        disabled={working} onClick={() => setDisconnecting(true)}>{zh ? '断开浏览器连接' : 'Disconnect browser'}</Button>}
      <Button type="button" variant="ghost" size="sm" disabled={disabled || working || pending} onClick={onRefresh}>
        <RefreshCw size={14} aria-hidden="true" />{zh ? '刷新状态' : 'Refresh status'}
      </Button>
    </div>
    {status?.connectedAt && <p className="text-xs text-muted-foreground">{zh ? '连接保存于' : 'Connection saved'} {dataTime(status.connectedAt, i18n.language)}</p>}
    <p className="text-xs leading-6 text-muted-foreground">{zh
      ? '登录信息仅在服务端加密保存，不会传到前端或作为研究资料。保存连接不会开始采集。'
      : 'Sign-in data is encrypted on the server and excluded from the frontend and research material. Saving a connection does not start capture.'}</p>
    <Dialog open={disconnecting} onOpenChange={open => { if (!working) setDisconnecting(open); }}>
      <DialogContent><DialogHeader><DialogTitle>{zh ? '断开浏览器连接？' : 'Disconnect this browser?'}</DialogTitle>
        <DialogDescription>{zh ? '将删除这个来源保存的浏览器登录信息并关闭登录窗口。已保存版本会保留，重新采集前需再次连接。' : 'Delete the saved browser sign-in data for this source and close its sign-in window. Saved versions are retained; reconnect before capturing again.'}</DialogDescription>
      </DialogHeader><div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={working} onClick={() => setDisconnecting(false)}>{zh ? '取消' : 'Cancel'}</Button>
        <Button type="button" variant="destructive" disabled={working} onClick={() => { setDisconnecting(false); onDisconnect(); }}>{zh ? '确认断开' : 'Confirm disconnect'}</Button>
      </div></DialogContent>
    </Dialog>
  </section>;
}
