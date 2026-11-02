import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Bot, CheckCircle2, Download, Loader2, Monitor, RefreshCw, Unplug } from 'lucide-react';
import type { LocalAgentConnection, LocalAgentPairing } from '@shared/local-agents.interface';
import { connectLocalAgent, createLocalAgentPairing, disconnectLocalAgent, disconnectLocalCompanion,
  fetchLocalAgentsStatus, loginLocalAgent } from '@/api/local-agents';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';

const QUERY_KEY = ['settings', 'local-agents'];
const STATUS_KEY = [...QUERY_KEY, 'status'];
interface AgentAction { id: string; kind: 'connect' | 'disconnect' | 'login' }

export default function LocalAgentsPanel() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [pairing, setPairing] = useState<LocalAgentPairing | null>(null);
  const [now, setNow] = useState(Date.now());
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const key = (name: string) => t(`council.localAgents.${name}`);
  const pairingActive = Boolean(pairing && Date.parse(pairing.expiresAt) > now);
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: fetchLocalAgentsStatus, retry: false,
    refetchInterval: pairingActive ? 2000 : 10000 });
  const companion = status.data?.companion;
  const hasCompanion = Boolean(companion?.connected || companion?.name
    || status.data?.items.some((agent: LocalAgentConnection) => agent.source === 'companion' && agent.connected));
  const refresh = async () => {
    await Promise.all([client.invalidateQueries({ queryKey: QUERY_KEY, exact: true }),
      client.invalidateQueries({ queryKey: STATUS_KEY })]);
  };

  useEffect(() => {
    if (!pairingActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairingActive]);
  useEffect(() => {
    if (!companion?.connected) return;
    setPairing(null);
    void client.invalidateQueries({ queryKey: QUERY_KEY, exact: true });
  }, [companion?.connected, client]);

  const action = useMutation({
    retry: false,
    mutationFn: ({ id, kind }: AgentAction) => kind === 'connect' ? connectLocalAgent(id)
      : kind === 'disconnect' ? disconnectLocalAgent(id) : loginLocalAgent(id),
    onSuccess: async (_result, request: AgentAction) => {
      setNotice(request.kind === 'login' ? 'loginOpened' : request.kind === 'connect' ? 'connectedNotice' : 'disconnectedNotice');
      await refresh();
    },
    onError: (error: unknown) => setFailure(errorMessage(error, key('actionFailed'))),
  });
  const pair = useMutation({
    retry: false, mutationFn: createLocalAgentPairing,
    onSuccess: async (result: LocalAgentPairing) => {
      setPairing(result); setNow(Date.now()); setNotice(''); await refresh();
    },
    onError: () => setFailure(key('pairFailed')),
  });
  const unpair = useMutation({
    retry: false, mutationFn: disconnectLocalCompanion,
    onSuccess: async () => { setPairing(null); setNotice('companionRemoved'); await refresh(); },
    onError: (error: unknown) => setFailure(errorMessage(error, key('actionFailed'))),
  });
  const run = (id: string, kind: AgentAction['kind']) => {
    setFailure(''); setNotice(''); return action.mutate({ id, kind });
  };
  const pairUrl = pairing && pairingActive
    ? `squabble://pair?${new URLSearchParams({ origin: window.location.origin, code: pairing.code }).toString()}` : undefined;

  return <Card id="local-agents" className="min-w-0 scroll-mt-6">
    <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
      <div className="max-w-2xl space-y-2">
        <CardTitle className="flex items-center gap-2"><Bot className="size-5 text-primary" />{key('title')}</CardTitle>
        <CardDescription>{key('intro')}</CardDescription>
      </div>
      <Button type="button" variant="outline" size="sm" disabled={status.isFetching} onClick={() => void refresh()}>
        <RefreshCw className={status.isFetching ? 'animate-spin' : ''} />{key('refresh')}
      </Button>
    </CardHeader>
    <CardContent className="space-y-4">
      {status.isPending && <p role="status" className="text-sm text-muted-foreground">{t('council.loading')}</p>}
      {status.isError && <p role="alert" className="text-sm text-destructive">{key('loadFailed')}</p>}
      {failure && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{failure}</p>}
      {notice && <p role="status" className="rounded-lg bg-muted/40 p-3 text-sm leading-6">{key(notice)}</p>}
      {status.data?.mode === 'companion' && <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Monitor className="size-4 text-primary" />{key('companionTitle')}</h3>
          {hasCompanion && <Badge variant={companion?.connected ? 'secondary' : 'outline'}>
            {key(companion?.connected ? 'states.connected' : 'states.offline')}</Badge>}
        </div>
        <p className="text-sm leading-6 text-muted-foreground">{key(companion?.connected ? 'companionConnected'
          : hasCompanion ? 'companionOffline' : 'companionIntro')}</p>
        {!companion?.connected && <div className="flex flex-wrap items-center gap-2">
          {pairUrl ? <Button asChild size="sm"><a href={pairUrl}><ArrowUpRight className="size-3.5" />{key('openCompanion')}</a></Button>
            : <Button type="button" size="sm" disabled={pair.isPending || unpair.isPending} onClick={() => {
              setFailure(''); setNotice(''); return pair.mutate();
            }}>{pair.isPending && <Loader2 className="size-3.5 animate-spin" />}{key(pairing ? 'pairAgain' : 'pair')}</Button>}
          <Button asChild size="sm" variant="outline"><a href="https://github.com/Lueyu/squabble/releases/latest" target="_blank" rel="noreferrer">
            <Download className="size-3.5" />{key('downloadCompanion')}</a></Button>
        </div>}
        {pairing && !companion?.connected && <p role="status" className="text-xs leading-5 text-muted-foreground">
          {key(pairingActive ? 'pairWaiting' : 'pairExpired')}</p>}
        {hasCompanion && <Button type="button" variant="ghost" size="sm" disabled={unpair.isPending || action.isPending || pair.isPending}
          className="px-0 text-muted-foreground" onClick={() => { setFailure(''); setNotice(''); return unpair.mutate(); }}>
          {unpair.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}{key('unpair')}</Button>}
      </div>}
      <div className="grid gap-3 sm:grid-cols-2">
        {status.data?.items.map((agent: LocalAgentConnection) => {
          const offline = (agent.source === 'companion' && !companion?.connected)
            || (agent.connected && agent.state === 'ready' && !agent.available);
          const state = offline ? 'offline' : agent.busy ? 'busy'
            : agent.state === 'ready' && agent.connected ? 'connected' : agent.state;
          const pending = action.isPending && action.variables?.id === agent.id;
          const agentHelp = t(`council.localAgents.providerHelp.${agent.provider}`, { defaultValue: agent.configurationHelp ?? '' });
          return <article key={agent.id} aria-label={agent.name} className="flex min-w-0 flex-col rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0"><h3 className="flex items-center gap-2 break-words font-semibold">
                {agent.connected && !offline ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <Bot className="size-4 shrink-0 text-muted-foreground" />}
                {agent.name}</h3>
                {agent.version && <p className="mt-1 break-words text-xs text-muted-foreground">{agent.version}</p>}
              </div>
              <Badge variant={state === 'connected' ? 'secondary' : state === 'error' ? 'destructive' : 'outline'}>{key(`states.${state}`)}</Badge>
            </div>
            <p className="mt-3 flex-1 text-xs leading-5 text-muted-foreground">{key(`stateHints.${state}`)}</p>
            {agentHelp && <p className="mt-2 break-words text-xs leading-5 text-muted-foreground">{agentHelp}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              {!offline && agent.state === 'not_installed' && <Button asChild size="sm" variant="outline">
                <a href={agent.installUrl} target="_blank" rel="noreferrer" aria-label={`${key('install')} · ${agent.name}`}>
                  <Download className="size-3.5" />{key('install')}</a></Button>}
              {!offline && agent.state === 'login_required' && <Button type="button" size="sm" disabled={action.isPending || unpair.isPending}
                aria-label={`${key('login')} · ${agent.name}`} onClick={() => run(agent.id, 'login')}>
                {pending && <Loader2 className="size-3.5 animate-spin" />}{key('login')}</Button>}
              {!offline && agent.state === 'ready' && !agent.connected && <Button type="button" size="sm"
                disabled={action.isPending || unpair.isPending || agent.busy} aria-label={`${key('connect')} · ${agent.name}`}
                onClick={() => run(agent.id, 'connect')}>
                {pending && <Loader2 className="size-3.5 animate-spin" />}{key('connect')}</Button>}
              {agent.connected && <Button type="button" size="sm" variant="outline" disabled={action.isPending || unpair.isPending}
                aria-label={`${key('disconnect')} · ${agent.name}`} onClick={() => run(agent.id, 'disconnect')}>
                {pending && <Loader2 className="size-3.5 animate-spin" />}{key('disconnect')}</Button>}
            </div>
          </article>;
        })}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{key('budgetHint')}{' '}
        <Link to="/settings#research-budget" className="font-medium text-primary hover:underline">{t('council.budget.open')}</Link>
      </p>
    </CardContent>
  </Card>;
}
