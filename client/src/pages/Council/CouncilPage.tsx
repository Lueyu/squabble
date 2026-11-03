import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BookOpen, CirclePause, FileText, History, Loader2, MessageCircle, Play, Plus, Users } from 'lucide-react';
import type { BuilderProfile } from '@shared/api.interface';
import type { CouncilConfig, CouncilSession, CreateCouncilSession } from '@shared/council.interface';
import { createCouncilPreset } from '@shared/council-templates';
import { fetchBuilderProfiles } from '@/api/builder';
import { fetchIntegrationSettings } from '@/api/settings';
import { fetchModelConnections } from '@/api/model-connections';
import { fetchLocalAgents } from '@/api/local-agents';
import { useCouncilActions, useCouncilSession, useCouncilSessions } from '@/hooks/use-council';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';
import CouncilConversation from './CouncilConversation';
import CouncilNewDialog from './CouncilNewDialog';
import CouncilReports from './CouncilReports';
import CouncilMembersSheet from './CouncilMembersSheet';
import { CouncilMemoryPanel } from './CouncilMemoryPanel';
import CouncilReportCard from './CouncilReportCard';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { workflowCopy } from './workflow-copy';

export default function CouncilPage() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [newOpen, setNewOpen] = useState(params.has('profileId') || params.has('ticker'));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const copy = workflowCopy[i18n.language.startsWith('zh') ? 'zh-CN' : 'en'];
  const sourceReportId = params.get('reportId');
  useEffect(() => { if (sourceReportId) setMemoryOpen(false); }, [sourceReportId]);
  const [newSeed, setNewSeed] = useState<{ key: number; ticker: string; team?: CouncilConfig }>({ key: 0, ticker: params.get('ticker') ?? '' });
  const profilesQuery = useQuery({ queryKey: ['builder', 'profiles'], queryFn: fetchBuilderProfiles });
  const integrations = useQuery({ queryKey: ['settings', 'integrations'], queryFn: fetchIntegrationSettings });
  const connections = useQuery({ queryKey: ['settings', 'model-connections'], queryFn: fetchModelConnections });
  const localAgents = useQuery({ queryKey: ['settings', 'local-agents'], queryFn: fetchLocalAgents });
  const sessionsQuery = useCouncilSessions();
  const selectedId = params.get('sessionId') ?? params.get('session') ?? sessionsQuery.data?.[0]?.id ?? null;
  const sessionQuery = useCouncilSession(selectedId);
  const actions = useCouncilActions();
  const session = sessionQuery.data;
  const profiles = profilesQuery.data ?? [];
  const selectedProfile = profiles.find((item: BuilderProfile) => item.id === session?.profileId);
  const defaultAvailable = integrations.data?.llm.available && integrations.data.llm.engine !== 'basic';
  const noModel = integrations.isSuccess && connections.isSuccess && (session?.members?.length
    ? session.members.every((member) => member.executionMode === 'local' ? false : member.connectionId
      ? !connections.data.some((connection) => connection.id === member.connectionId && connection.available) : !defaultAvailable)
    : localAgents.isSuccess && !localAgents.data.some(agent => agent.available)
      && !defaultAvailable && !connections.data.some((connection) => connection.available));
  const showError = (cause: unknown) => toast.error(errorMessage(cause, t('council.actionFailed')));

  const create = async (request: CreateCouncilSession) => {
    const created = await actions.create.mutateAsync(request);
    setParams({ session: created.id });
    setNewOpen(false);
    try { await actions.run.mutateAsync(created.id); } catch (cause) { showError(cause); }
  };

  return <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
    <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3 sm:px-5">
      <Tooltip><TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="shrink-0" aria-label={t('council.sessions')}
          onClick={() => setHistoryOpen(true)}><History className="size-4" /></Button>
      </TooltipTrigger><TooltipContent>{t('council.sessions')}</TooltipContent></Tooltip>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold">{session?.ticker ?? t('council.title')}</h1>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground" role="status">
          {session?.status === 'running' ? <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
            : <span className={`size-1.5 shrink-0 rounded-full ${session?.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground/60'}`} />}
          <span className="truncate">{session ? t(`council.status.${session.status}`) : t('council.chatWelcome')}
            {selectedProfile && <span className="hidden sm:inline"> · {selectedProfile.config.name}</span>}</span>
        </p>
      </div>
      {session && <Tooltip><TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="shrink-0"
          aria-label={t(session.status === 'running' ? 'council.pause' : 'council.continue')}
          disabled={actions.run.isPending || actions.pause.isPending}
          onClick={() => session.status === 'running'
            ? actions.pause.mutate(session.id, { onError: showError })
            : actions.run.mutate(session.id, { onError: showError })}>
          {actions.run.isPending || actions.pause.isPending ? <Loader2 className="size-4 animate-spin" />
            : session.status === 'running' ? <CirclePause className="size-4" /> : <Play className="size-4" />}
        </Button>
      </TooltipTrigger><TooltipContent>{t(session.status === 'running' ? 'council.pause' : 'council.continue')}</TooltipContent></Tooltip>}
      {session && <Tooltip><TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label={t('council.members.groupTitle', { count: session.members?.length ?? 0 })}
          onClick={() => setMembersOpen(true)}><Users className="size-4" /></Button>
      </TooltipTrigger><TooltipContent>{t('council.members.groupTitle', { count: session.members?.length ?? 0 })}</TooltipContent></Tooltip>}
      {session && <Button variant="ghost" size="icon" className="shrink-0 xl:hidden" aria-label={t('council.report.history')}
        onClick={() => setReportsOpen(true)}><FileText className="size-4" /></Button>}
      {session && <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label={copy.memoryManage}
        onClick={() => setMemoryOpen(true)}><BookOpen className="size-4" /></Button></TooltipTrigger><TooltipContent>{copy.memoryManage}</TooltipContent></Tooltip>}
      <Tooltip><TooltipTrigger asChild>
        <Button size="sm" className="shrink-0 gap-1.5" aria-label={t('council.newSession')} onClick={() => setNewOpen(true)}>
          <Plus className="size-4" /><span className="hidden sm:inline">{t('council.newSession')}</span></Button>
      </TooltipTrigger><TooltipContent>{t('council.newSession')}</TooltipContent></Tooltip>
    </header>

    {noModel && <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-2 text-xs leading-5 text-muted-foreground">
      {t('council.noModelShort')} <Link to="/settings" className="font-medium text-primary hover:underline">{t('council.apiSettings')}</Link>
    </div>}
    <div className="flex min-h-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('council.conversation')}>
        {sessionQuery.isLoading || sessionsQuery.isLoading ? <div className="m-auto flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />{t('council.loading')}</div>
          : !session && (sessionQuery.isError || sessionsQuery.isError) ? <div role="alert" className="m-auto space-y-3 p-6 text-center">
            <p className="text-sm text-destructive">{errorMessage(sessionQuery.error ?? sessionsQuery.error, t('council.loadFailed'))}</p>
            <Button variant="outline" size="sm" onClick={() => { void sessionsQuery.refetch(); if (selectedId) void sessionQuery.refetch(); }}>{t('council.retry')}</Button>
          </div>
            : session ? <CouncilConversation key={session.id} session={session} actions={actions}
              profileChanged={Boolean(selectedProfile && selectedProfile.version !== session.profileVersion)} />
              : <div className="m-auto max-w-md space-y-4 px-6 text-center">
                <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><MessageCircle className="size-7" /></div>
                <h2 className="text-lg font-semibold">{t('council.chatWelcome')}</h2>
                <p className="text-sm leading-6 text-muted-foreground">{t('council.chatWelcomeHint')}</p>
                <Button onClick={() => setNewOpen(true)}><Plus className="size-4" />{t('council.newSession')}</Button>
              </div>}
      </section>
      {session && <aside className="hidden min-h-0 w-[300px] shrink-0 border-l border-border bg-muted/20 xl:flex 2xl:w-[340px]"
        aria-label={t('council.report.history')}><CouncilReports session={session} profileVersion={selectedProfile?.version} /></aside>}
    </div>

    <Sheet open={memoryOpen} onOpenChange={setMemoryOpen}>
      <SheetContent className="w-[min(620px,96vw)] overflow-y-auto sm:max-w-[620px]">
        <SheetHeader><SheetTitle>{copy.memoryManage}</SheetTitle><SheetDescription>{copy.preferencesHint}</SheetDescription></SheetHeader>
        {session && <CouncilMemoryPanel ticker={session.ticker} />}
      </SheetContent>
    </Sheet>
    <Dialog open={Boolean(sourceReportId && session)} onOpenChange={open => {
      if (!open) { const next = new URLSearchParams(params); next.delete('reportId'); setParams(next, { replace: true }); }
    }}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>{copy.report}</DialogTitle><DialogDescription>{session?.ticker}</DialogDescription></DialogHeader>
        {session && (session.reports.some(report => report.id === sourceReportId)
          ? <CouncilReportCard session={session} report={session.reports.find(report => report.id === sourceReportId)!} profileVersion={selectedProfile?.version} />
          : <p>{copy.sourceMissing}</p>)}
      </DialogContent>
    </Dialog>
    <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
      <SheetContent side="left" className="w-[min(360px,90vw)] gap-0 p-0">
        <SheetHeader className="border-b border-border px-5 py-5 pr-12">
          <SheetTitle>{t('council.sessions')}</SheetTitle><SheetDescription>{t('council.historyHint')}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
          {sessionsQuery.isError && <div role="alert" className="space-y-2 p-2 text-sm">
            <p className="text-destructive">{t('council.loadFailed')}</p>
            <Button variant="outline" size="sm" onClick={() => void sessionsQuery.refetch()}>{t('council.retry')}</Button>
          </div>}
          {(sessionsQuery.data ?? []).map((savedItem: CouncilSession) => {
            const item = savedItem.id === session?.id ? session : savedItem;
            return <button key={item.id} type="button" aria-pressed={selectedId === item.id}
              onClick={() => { setParams({ session: item.id }); setHistoryOpen(false); }}
              className={`w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedId === item.id
                ? 'border-primary/30 bg-primary/10' : 'border-transparent hover:bg-muted'}`}>
              <span className="flex items-center justify-between gap-2"><span className="font-mono font-semibold">{item.ticker}</span>
                <span className="text-[11px] text-muted-foreground">{new Date(item.updatedAt).toLocaleDateString(i18n.language)}</span></span>
              <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                {item.status === 'running' && <Loader2 className="size-3 animate-spin" />}{t(`council.status.${item.status}`)}
                <span className="truncate">· {profiles.find((profile: BuilderProfile) => profile.id === item.profileId)?.config.name ?? t('council.members.standalone')}</span>
              </span>
            </button>;
          })}
          {sessionsQuery.isSuccess && sessionsQuery.data.length === 0 && <p className="px-2 py-6 text-sm text-muted-foreground">{t('council.noHistory')}</p>}
        </div>
        <div className="flex shrink-0 items-center justify-between border-t border-border p-4 text-xs">
          <Link to="/agent-builder" className="text-primary hover:underline">{t('council.builder')}</Link>
          <Link to="/settings/budget" className="text-muted-foreground hover:underline">{t('council.budget.open')}</Link>
        </div>
      </SheetContent>
    </Sheet>
    <Sheet open={reportsOpen} onOpenChange={setReportsOpen}>
      <SheetContent className="w-[min(420px,94vw)] gap-0 p-0 sm:max-w-[420px]">
        <SheetHeader className="sr-only"><SheetTitle>{t('council.report.history')}</SheetTitle>
          <SheetDescription>{t('council.report.detailHint')}</SheetDescription></SheetHeader>
        {session && <CouncilReports session={session} profileVersion={selectedProfile?.version} />}
      </SheetContent>
    </Sheet>
    {membersOpen && session && <CouncilMembersSheet session={session} onClose={() => setMembersOpen(false)} onUseTeam={() => {
      setNewSeed((current) => ({ key: current.key + 1, ticker: session.ticker, team: { enabled: true,
        members: (session.members?.length ? session.members : createCouncilPreset('balanced', i18n.language))
          .map((member) => ({ ...member, researchFocus: member.researchFocus ? [...member.researchFocus] : undefined })),
        webResearch: Boolean(session.webResearch) } }));
      setMembersOpen(false); setNewOpen(true);
    }} />}
    <CouncilNewDialog key={newSeed.key} open={newOpen} onOpenChange={setNewOpen} profiles={profiles}
      loading={profilesQuery.isLoading} error={profilesQuery.error} pending={actions.create.isPending}
      initialProfileId={params.get('profileId') ?? ''} initialTicker={newSeed.ticker} initialTeam={newSeed.team} onCreate={create} />
  </div>;
}
