import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { BellRing, Bot, Plus, Trash2 } from 'lucide-react';
import { fetchNotificationChannels, createNotificationChannel, deleteNotificationChannel,
  setNotificationChannelEnabled, testNotificationChannel, fetchAgentSessions,
  createAgentSession, updateAgentSession, revokeAgentSession } from '@/api/index';
import type { NotificationChannelType } from '@shared/api.interface';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const CHANNEL_META: Record<NotificationChannelType, { name: string; hint: string; fields: Array<{ key: string; label: string; placeholder: string }> }> = {
  webhook: {
    name: 'Webhook',
    hint: 'ui.paper.channelHints.webhook',
    fields: [{ key: 'url', label: 'Webhook URL', placeholder: 'https://example.com/hook' }],
  },
  bark: {
    name: 'Bark (iOS)',
    hint: 'ui.paper.channelHints.bark',
    fields: [
      { key: 'key', label: 'Bark Key', placeholder: 'ui.paper.fieldPlaceholders.deviceKey' },
      { key: 'server', label: 'ui.paper.fieldLabels.customServer', placeholder: 'https://api.day.app' },
    ],
  },
  serverchan: {
    name: 'ServerChan (WeChat)',
    hint: 'ui.paper.channelHints.serverchan',
    fields: [{ key: 'key', label: 'SendKey', placeholder: 'SCT...' }],
  },
  smtp: {
    name: 'Email (SMTP)',
    hint: 'ui.paper.channelHints.smtp',
    fields: [
      { key: 'host', label: 'ui.paper.fieldLabels.smtpServer', placeholder: 'smtp.example.com' },
      { key: 'port', label: 'ui.paper.fieldLabels.port', placeholder: '465' },
      { key: 'user', label: 'ui.paper.fieldLabels.username', placeholder: 'you@example.com' },
      { key: 'pass', label: 'ui.paper.fieldLabels.password', placeholder: '••••••' },
      { key: 'to', label: 'ui.paper.fieldLabels.recipientEmail', placeholder: 'you@example.com' },
    ],
  },
  telegram: {
    name: 'Telegram',
    hint: 'ui.paper.channelHints.telegram',
    fields: [
      { key: 'token', label: 'Bot Token', placeholder: '123456:ABC-...' },
      { key: 'chatId', label: 'ui.paper.fieldLabels.chatId', placeholder: 'ui.paper.fieldPlaceholders.chatId' },
    ],
  },
};

/** Notification channel manager card. */
export function NotificationChannelsCard({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [channelType, setChannelType] = useState<NotificationChannelType>('webhook');
  const [label, setLabel] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const channelsQuery = useQuery({
    queryKey: ['notifications', 'channels'],
    queryFn: fetchNotificationChannels,
    enabled: active,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });

  const addChannel = async () => {
    const config: Record<string, string> = {};
    for (const f of CHANNEL_META[channelType].fields) {
      const v = (fieldValues[f.key] ?? '').trim();
      if (v) config[f.key] = v;
    }
    if (Object.keys(config).length === 0) {
      toast.warning(t('ui.paper.channelFieldRequired'));
      return;
    }
    try {
      setSubmitting(true);
      await createNotificationChannel({ channelType, label: label.trim() || undefined, config });
      toast.success(t('ui.paper.channelAdded'));
      setAddOpen(false);
      setFieldValues({});
      setLabel('');
      invalidate();
    } catch {
      toast.error(t('ui.paper.channelAddFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card id="notifications" className="scroll-mt-4">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <BellRing size={14} /> {t('ui.paper.notificationChannels')}
        </CardTitle>
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus size={14} className="mr-1" /> {t('ui.paper.addChannel')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 p-4">
        {channelsQuery.isError && <div role="alert" className="space-y-2 text-sm">
          <p>{i18n.language.startsWith('zh') ? '提醒渠道暂时无法读取。' : 'Notification channels could not be loaded.'}</p>
          <Button variant="outline" onClick={() => void channelsQuery.refetch()}>{i18n.language.startsWith('zh') ? '重试' : 'Retry'}</Button>
        </div>}
        {channelsQuery.isPending && <p role="status">{i18n.language.startsWith('zh') ? '正在读取提醒渠道…' : 'Loading notification channels…'}</p>}
        <p className="text-xs text-muted-foreground">
          {t('ui.paper.channelsIntro')}
        </p>
        {(channelsQuery.data ?? []).map((ch) => (
          <div key={ch.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <Badge variant="outline" className="shrink-0 text-[10px]">{CHANNEL_META[ch.channelType]?.name ?? ch.channelType}</Badge>
            <span className="truncate text-foreground/90">{ch.label || (i18n.language.startsWith('zh') ? '未命名渠道' : 'Unnamed channel')}</span>
            <div className="ml-auto flex items-center gap-2">
              <Switch checked={ch.enabled} onCheckedChange={async (v) => { await setNotificationChannelEnabled(ch.id, v); invalidate(); }} />
              <Button
                variant="ghost" size="sm"
                onClick={async () => {
                  const r = await testNotificationChannel(ch.id);
                  if (r.ok) toast.success(t('ui.paper.testSent'));
                  else toast.error(t('ui.paper.testFailed', { reason: t('ui.paper.unknownError') }));
                }}
              >
                {t('ui.paper.testMessage')}
              </Button>
              <Button
                variant="ghost" size="sm"
                onClick={async () => { await deleteNotificationChannel(ch.id); invalidate(); }}
              >
                <Trash2 size={14} className="text-destructive" />
              </Button>
            </div>
          </div>
        ))}
        {!channelsQuery.isError && !channelsQuery.isPending && (channelsQuery.data ?? []).length === 0 && (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t('ui.paper.notificationsEmpty')}
          </div>
        )}
      </CardContent>

      <Dialog open={active && addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('ui.paper.addNotificationChannel')}</DialogTitle>
            <DialogDescription>{t(CHANNEL_META[channelType].hint)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t('ui.paper.channelType')}</Label>
              <Select value={channelType} onValueChange={(v) => { setChannelType(v as NotificationChannelType); setFieldValues({}); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(CHANNEL_META) as NotificationChannelType[]).map((k) => (
                    <SelectItem key={k} value={k}>{CHANNEL_META[k].name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('ui.paper.labelOptional')}</Label>
              <Input placeholder={t('ui.paper.labelPlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            {CHANNEL_META[channelType].fields.map((f) => (
              <div key={f.key} className="space-y-2">
                <Label>{f.label.startsWith('ui.') ? t(f.label) : f.label}</Label>
                <Input type={/key|token|pass|url/iu.test(f.key) ? 'password' : 'text'} autoComplete="off"
                  placeholder={f.placeholder.startsWith('ui.') ? t(f.placeholder) : f.placeholder}
                  value={fieldValues[f.key] ?? ''}
                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={addChannel} disabled={submitting}>{submitting ? t('ui.paper.creating') : t('ui.paper.addChannel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** The token remains available for explicit copy without being printed into the page. */
export function AgentSessionToken({ token, baseUrl, onClose }: { token: string; baseUrl: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  return <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
    <div className="font-medium text-emerald-600 dark:text-emerald-400">✓ {t('ui.paper.agentCreated')}</div>
    <div className="mt-2 space-y-1 text-xs">
      <div><span className="text-muted-foreground">{t('ui.paper.mcpAddress')}</span><code className="break-all">{baseUrl}/mcp</code></div>
      <div><span className="text-muted-foreground">{t('ui.paper.token')}</span><code>••••••••{token.slice(-4)}</code></div>
    </div>
    <p className="mt-2 text-xs text-muted-foreground">{t('ui.paper.tokenOneTime')}</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={async () => {
        try {
          await navigator.clipboard.writeText(token);
          toast.success(zh ? '连接密钥已复制。' : 'Connection token copied.');
        } catch { toast.error(zh ? '复制未完成，请重试。' : 'Copy failed. Please retry.'); }
      }}>{zh ? '复制密钥' : 'Copy token'}</Button>
      <Button variant="ghost" size="sm" onClick={onClose}>{t('ui.paper.agentTokenClose')}</Button>
    </div>
  </div>;
}

/** AI agent sessions management card (MCP connections). */
export function AgentSessionsCard({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [dailyLimit, setDailyLimit] = useState('500');
  const [permission, setPermission] = useState<'read' | 'trade'>('trade');
  const [approvalMode, setApprovalMode] = useState<'auto' | 'require_approval'>('require_approval');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sessionsQuery = useQuery({
    queryKey: ['mcp', 'sessions'],
    queryFn: fetchAgentSessions,
    enabled: active,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['mcp'] });

  const add = async () => {
    if (!name.trim()) {
      toast.warning(t('ui.paper.agentNameRequired'));
      return;
    }
    try {
      setSubmitting(true);
      const session = await createAgentSession({
        name: name.trim(),
        dailyLimitUsd: Number(dailyLimit) || 500,
        permission,
        approvalMode,
      });
      setNewToken(session.token ?? null);
      setAddOpen(false);
      setName('');
      invalidate();
    } catch {
      toast.error(t('ui.paper.agentCreateFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const sessions = sessionsQuery.data ?? [];
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Bot size={14} /> {t('ui.paper.agentSessions')}
        </CardTitle>
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus size={14} className="mr-1" /> {t('ui.paper.connectAgent')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 p-4">
        {sessionsQuery.isError && <div role="alert" className="space-y-2 text-sm">
          <p>{i18n.language.startsWith('zh') ? 'MCP 连接暂时无法读取。' : 'MCP connections could not be loaded.'}</p>
          <Button variant="outline" onClick={() => void sessionsQuery.refetch()}>{i18n.language.startsWith('zh') ? '重试' : 'Retry'}</Button>
        </div>}
        {sessionsQuery.isPending && <p role="status">{i18n.language.startsWith('zh') ? '正在读取 MCP 连接…' : 'Loading MCP connections…'}</p>}
        <p className="text-xs text-muted-foreground">
          {t('ui.paper.agentIntro')}
        </p>
        {newToken && <AgentSessionToken token={newToken} baseUrl={baseUrl} onClose={() => setNewToken(null)} />}
        {sessions.map((s) => (
          <div key={s.id} className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${s.status === 'revoked' ? 'border-border opacity-50' : 'border-border'}`}>
            <Badge variant="outline" className={`shrink-0 text-[10px] ${s.permission === 'trade' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-slate-500/15 text-muted-foreground'}`}>
              {s.permission === 'trade' ? t('ui.paper.tradePermission') : t('ui.paper.readOnlyPermission')}
            </Badge>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{s.name}</div>
              <div className="text-xs text-muted-foreground">
                {t('ui.paper.dailyLimit', { amount: Number(s.dailyLimitUsd).toLocaleString() })} · {s.approvalMode === 'require_approval' ? t('ui.paper.requiresApproval') : t('ui.paper.automatic')}
                {s.lastUsedAt && ` · ${t('ui.paper.lastUsed', { time: new Date(s.lastUsedAt).toLocaleString(undefined, { hour12: false }) })}`}
              </div>
            </div>
            {s.status === 'active' ? (
              <div className="flex items-center gap-2">
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={s.approvalMode}
                  onChange={async (e) => {
                    await updateAgentSession(s.id, { approvalMode: e.target.value as 'auto' | 'require_approval' });
                    invalidate();
                  }}
                >
                  <option value="require_approval">{t('ui.paper.requiresApproval')}</option>
                  <option value="auto">{t('ui.paper.automaticFill')}</option>
                </select>
                <Button variant="ghost" size="sm" onClick={async () => { await revokeAgentSession(s.id); invalidate(); }}>
                  <Trash2 size={14} className="text-destructive" />
                </Button>
              </div>
            ) : (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">{t('ui.paper.revoked')}</Badge>
            )}
          </div>
        ))}
        {!sessionsQuery.isError && !sessionsQuery.isPending && sessions.length === 0 && !newToken && (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t('ui.paper.agentsEmpty')}
          </div>
        )}
      </CardContent>

      <Dialog open={active && addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('ui.paper.agentConnectTitle')}</DialogTitle>
            <DialogDescription>
              {t('ui.paper.agentConnectDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t('ui.paper.agentName')}</Label>
              <Input placeholder={t('ui.paper.agentNamePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{t('ui.paper.dailySpendLimit')}</Label>
              <Input type="number" min={1} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t('ui.paper.dailySpendLimitHint')}</p>
            </div>
            <div className="space-y-2">
              <Label>{t('ui.paper.permission')}</Label>
              <Select value={permission} onValueChange={(v) => setPermission(v as 'read' | 'trade')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="trade">{t('ui.paper.canTrade')}</SelectItem>
                  <SelectItem value="read">{t('ui.paper.canRead')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('ui.paper.approvalMode')}</Label>
              <Select value={approvalMode} onValueChange={(v) => setApprovalMode(v as 'auto' | 'require_approval')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="require_approval">{t('ui.paper.manualApproval')}</SelectItem>
                  <SelectItem value="auto">{t('ui.paper.autoFillGuarded')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={add} disabled={submitting}>{submitting ? t('ui.paper.creating') : t('ui.paper.connectAgent')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
