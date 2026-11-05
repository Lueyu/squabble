import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bot, ArrowRight, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type { AgentRunStatus } from '@shared/api.interface';
import type { NativeAgentConfiguration } from '@shared/local-agents.interface';
import { fetchIntegrationSettings } from '@/api/settings';
import { fetchLocalAgents } from '@/api/local-agents';
import { cancelAnalysisRun, fetchRecentAnalysisRuns, runPortfolioAnalysis, runStockAnalysis } from '@/api/analysis-runner';
import { AGENT_MODEL_MAX_LENGTH, agentReasoningEfforts } from '@/utils/local-agent-settings';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { displayCompanyName } from '@/utils/company-name';
import AgentRunDetailModal from '@/components/MultiAgent/AgentRunDetailModal';
import { analysisRouteOverride, analysisRouteProblem, type AnalysisRouteChoice } from './analysis-route';

const ACTIVE: AgentRunStatus[] = ['pending', 'fetching', 'debating', 'critiquing', 'risk_check'];
const STATUS_KEYS: Record<AgentRunStatus, string> = {
  pending: 'agent.pending', fetching: 'agent.fetching', debating: 'agent.debating',
  critiquing: 'agent.critiquing', risk_check: 'agent.riskCheck', awaiting_human: 'agent.awaitingHuman',
  completed: 'agent.completed', failed: 'agent.failed', cancelled: 'agent.cancelled',
};

function requestError(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    const data: unknown = error.response?.data;
    if (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string') return data.message;
  }
  return fallback;
}

export default function AnalysisRunner({ onFinished }: { onFinished: () => void }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language.startsWith('en') ? 'en' : 'zh-CN';
  const queryClient = useQueryClient();
  const [singleOpen, setSingleOpen] = useState(false);
  const [ticker, setTicker] = useState('');
  const [tickerError, setTickerError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [routeChoice, setRouteChoice] = useState<AnalysisRouteChoice>('default');
  const [agentId, setAgentId] = useState('');
  const [agentSettings, setAgentSettings] = useState<NativeAgentConfiguration>({});
  const [reviewRunId, setReviewRunId] = useState<string | null>(null);
  const previousCompleted = useRef<string | null>(null);
  const settings = useQuery({ queryKey: ['settings', 'integrations'], queryFn: fetchIntegrationSettings });
  const localAgents = useQuery({ queryKey: ['settings', 'local-agents'], queryFn: fetchLocalAgents, refetchInterval: 10000 });
  const runs = useQuery({
    queryKey: ['analysis', 'recent-runs'], queryFn: fetchRecentAnalysisRuns,
    refetchInterval: (query) => (query.state.data?.activeTotal ?? 0) > 0 ? 2500 : false,
  });
  const completed = (runs.data?.items ?? [])
    .map(run => `${run.id}:${run.status}`).join('|');
  useEffect(() => {
    if (previousCompleted.current !== null && previousCompleted.current !== completed) onFinished();
    previousCompleted.current = completed;
  }, [completed, onFinished]);

  const llm = settings.data?.llm;
  // `available` describes the selected default route; an offline local Agent
  // must not hide an independently configured API connection.
  const apiReady = Boolean(llm?.hasApiKey && !llm.needsReentry);
  const override = analysisRouteOverride(routeChoice, agentId, agentSettings);
  const route = override ?? llm?.route;
  const selectedAgent = localAgents.data?.find(agent => agent.id === (route?.mode === 'local' ? route.agentId : ''));
  const routeProblem = analysisRouteProblem(route, localAgents.data ?? [], apiReady);
  const routeNeedsAgents = route?.mode === 'local';
  const usesAi = route?.mode !== 'basic';
  const routeName = route?.mode === 'local' ? selectedAgent?.name ?? t('analysisFlow.localAgent')
    : t(route?.mode === 'api' ? 'analysisFlow.apiRoute' : 'analysisFlow.basic');
  const defaultRoute = llm?.route;
  const defaultRouteName = defaultRoute?.mode === 'local'
    ? localAgents.data?.find(agent => agent.id === defaultRoute.agentId)?.name ?? t('analysisFlow.localAgent')
    : t(defaultRoute?.mode === 'api' ? 'analysisFlow.apiRoute' : 'analysisFlow.basic');
  const reasoningEfforts = agentReasoningEfforts(selectedAgent, agentSettings.model);
  const busy = (runs.data?.activeTotal ?? 0) > 0;
  const start = useMutation({
    mutationFn: async (symbol?: string) => {
      const result = symbol
        ? await runStockAnalysis({ scope: 'custom', tiered: false, tickers: [symbol], language, ...(override ? { route: override } : {}) })
        : await runPortfolioAnalysis(language, override);
      return { count: 'totalCreated' in result ? result.totalCreated : result.created, errors: result.errors };
    },
    onMutate: () => setSubmitError(''),
    onSuccess: (result) => {
      setSingleOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['analysis', 'recent-runs'] });
      if (result.count > 0) toast.success(t('analysisFlow.submitted', { count: result.count }));
      else if (!result.errors.length) setSubmitError(t('analysisFlow.noTickers'));
      if (result.errors.length) setSubmitError(`${t('analysisFlow.partial')}: ${result.errors.map(item => `${item.ticker}: ${item.error}`).join('; ')}`);
      onFinished();
    },
    onError: (error) => setSubmitError(requestError(error, t('analysisFlow.failed'))),
  });
  const cancel = useMutation({
    mutationFn: cancelAnalysisRun,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['analysis', 'recent-runs'] }); },
    onError: () => toast.error(t('analysisFlow.failed')),
  });
  const disabled = start.isPending || busy || runs.isPending || runs.isError || settings.isPending || settings.isError
    || (routeNeedsAgents && (localAgents.isPending || localAgents.isError)) || Boolean(routeProblem);
  const submitStock = (event: React.FormEvent) => {
    event.preventDefault();
    const symbol = ticker.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.^-]{0,19}$/u.test(symbol)) { setTickerError(t('analysisFlow.invalidTicker')); return; }
    setTickerError('');
    start.mutate(symbol);
  };

  return (
    <Card className="min-w-0">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="analysis-route">{t('analysisFlow.route')}</Label>
            <select id="analysis-route" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={routeChoice} disabled={start.isPending || busy}
              onChange={event => { setRouteChoice(event.target.value as AnalysisRouteChoice); setSubmitError(''); }}>
              <option value="default">{t('analysisFlow.followDefault', { route: defaultRouteName })}</option>
              <option value="basic">{t('analysisFlow.basic')}</option>
              <option value="api" disabled={!apiReady}>{t('analysisFlow.apiRoute')}{!apiReady ? ` · ${t('analysisFlow.unavailable')}` : ''}</option>
              <option value="local">{t('analysisFlow.localAgent')}</option>
            </select>
          </div>
          {routeChoice === 'local' && <div className="space-y-1.5">
            <Label htmlFor="analysis-agent">{t('analysisFlow.agent')}</Label>
            <select id="analysis-agent" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={agentId} disabled={start.isPending || busy || localAgents.isPending}
              onChange={event => { setAgentId(event.target.value); setAgentSettings({}); setSubmitError(''); }}>
              <option value="">{t('analysisFlow.chooseAgent')}</option>
              {(localAgents.data ?? []).map(agent => <option key={agent.id} value={agent.id} disabled={!agent.connected || !agent.available || agent.busy}>
                {agent.name}{!agent.connected || !agent.available ? ` · ${t('analysisFlow.unavailable')}` : agent.busy ? ` · ${t('analysisFlow.agentBusy')}` : ''}
              </option>)}
            </select>
          </div>}
        </div>
        {routeChoice === 'local' && selectedAgent && <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="analysis-agent-model">{t('analysisFlow.agentModel')}</Label>
            <Input id="analysis-agent-model" list="analysis-agent-models" value={agentSettings.model ?? ''}
              maxLength={AGENT_MODEL_MAX_LENGTH} disabled={selectedAgent.models === undefined || start.isPending || busy}
              placeholder={t('analysisFlow.agentDefault')} onChange={event => {
                const model = event.target.value;
                setAgentSettings(current => ({ model, reasoningEffort: agentReasoningEfforts(selectedAgent, model)?.includes(current.reasoningEffort ?? '')
                  ? current.reasoningEffort : undefined }));
              }} />
            <datalist id="analysis-agent-models">{selectedAgent.models?.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="analysis-agent-effort">{t('analysisFlow.reasoningEffort')}</Label>
            <select id="analysis-agent-effort" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={agentSettings.reasoningEffort ?? ''} disabled={!reasoningEfforts?.length || start.isPending || busy}
              onChange={event => setAgentSettings(current => ({ ...current, reasoningEffort: event.target.value || undefined }))}>
              <option value="">{t('analysisFlow.agentDefault')}</option>
              {reasoningEfforts?.map(effort => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </div>
        </div>}
        {routeChoice === 'local' && localAgents.isPending && <p className="text-xs text-muted-foreground">{t('analysisFlow.loadingAgents')}</p>}
        {routeChoice === 'local' && !localAgents.isPending && !localAgents.data?.length && <p className="text-xs text-muted-foreground">{t('analysisFlow.noAgents')} <Link to="/settings/agents" className="underline underline-offset-4">{t('analysisFlow.manageAgents')}</Link></p>}
        {routeNeedsAgents && localAgents.isError && <p role="alert" className="text-sm text-destructive">{t('analysisFlow.agentsLoadError')}</p>}
        {routeProblem && <p role="alert" className="text-sm text-destructive">{t(`analysisFlow.routeProblems.${routeProblem}`)}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => start.mutate(undefined)} disabled={disabled} className="h-auto min-h-9 whitespace-normal text-left">
              {start.isPending || busy ? <LoaderCircle className="mr-2 size-4 shrink-0 animate-spin" /> : <Bot className="mr-2 size-4 shrink-0" />}
              {t(busy ? 'analysisFlow.running' : 'analysisFlow.runPortfolio')}
            </Button>
            <Button variant="outline" onClick={() => setSingleOpen(true)} disabled={disabled}>
              <Search className="mr-2 size-4" />{t('analysisFlow.runStock')}
            </Button>
          </div>
          {llm && <Badge variant="secondary">{routeName}</Badge>}
        </div>
        <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          <p>{t(!usesAi ? 'analysisFlow.basicHint' : route?.mode === 'local' ? 'analysisFlow.localHint' : 'analysisFlow.aiHint')}</p>
          <p>{t('analysisFlow.language', { language: t(language === 'en' ? 'analysisFlow.english' : 'analysisFlow.chinese') })}{' '}
            <Link to="/settings" className="underline underline-offset-4">{t('analysisFlow.settings')}</Link>
          </p>
        </div>
        {settings.isError && <p role="alert" className="text-sm text-destructive">{t('analysisFlow.missingSettings')}</p>}
        {route?.mode === 'api' && llm?.needsReentry && <p role="alert" className="text-sm text-destructive">{t('analysisFlow.keyUnavailable')}</p>}
        {submitError && <p role="alert" className="break-words text-sm text-destructive">{submitError}</p>}
        <div className="border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('analysisFlow.recent')}</h2>
            <Button size="icon" variant="ghost" aria-label={t('analysisFlow.refresh')} onClick={() => { void runs.refetch(); void settings.refetch(); void localAgents.refetch(); }}>
              <RefreshCw className={`size-3.5 ${runs.isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          {runs.isError && <p role="alert" className="text-xs text-destructive">{t('analysisFlow.loadError')}</p>}
          <div className="max-h-72 space-y-2 overflow-y-auto" aria-live="polite">
            {(runs.data?.items ?? []).map(run => (
              <div key={run.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-2">
                <div className="min-w-0 flex-1 basis-36">
                  <p className="truncate text-sm font-semibold">{run.ticker} <span className="font-normal text-muted-foreground">{displayCompanyName(run.tickerName, run.ticker, language)}</span></p>
                  <p className="text-xs text-muted-foreground">{t(STATUS_KEYS[run.status])}</p>
                  {run.errorMessage && <p className="mt-1 break-words text-xs text-destructive">{run.errorMessage}</p>}
                </div>
                {ACTIVE.includes(run.status) && <><LoaderCircle className="size-4 animate-spin text-primary" /><Button size="icon" variant="ghost" aria-label={`${t('analysisFlow.cancel')} ${run.ticker}`} disabled={cancel.isPending} onClick={() => cancel.mutate(run.id)}><X className="size-4" /></Button></>}
                {run.status === 'awaiting_human' && <Button variant="outline" size="sm" onClick={() => setReviewRunId(run.id)}>{t('analysisFlow.reviewDecision')}</Button>}
                {run.hasReport && <Button asChild variant="ghost" size="sm"><Link to={`/analysis/deep-report/${run.id}`}>{t('analysisFlow.openReport')}<ArrowRight className="ml-1 size-3.5" /></Link></Button>}
              </div>
            ))}
          </div>
        </div>
      </CardContent>
      <Dialog open={singleOpen} onOpenChange={setSingleOpen}>
        <DialogContent>
          <form onSubmit={submitStock} className="space-y-4">
            <DialogHeader><DialogTitle>{t('analysisFlow.stockTitle')}</DialogTitle><DialogDescription>{t('analysisFlow.stockDescription')}</DialogDescription></DialogHeader>
            <div className="space-y-2"><Label htmlFor="analysis-ticker">{t('analysisFlow.ticker')}</Label><Input id="analysis-ticker" value={ticker} onChange={event => setTicker(event.target.value)} autoComplete="off" maxLength={20} placeholder="AAPL" /><p className="text-xs text-muted-foreground">{t('analysisFlow.tickerHint')}</p></div>
            {tickerError && <p role="alert" className="text-sm text-destructive">{tickerError}</p>}
            {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
            <DialogFooter><Button type="button" variant="outline" onClick={() => setSingleOpen(false)}>{t('common.cancel')}</Button><Button type="submit" disabled={disabled}>{start.isPending && <LoaderCircle className="mr-2 size-4 animate-spin" />}{t('analysisFlow.start')}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AgentRunDetailModal open={reviewRunId !== null} runId={reviewRunId} onOpenChange={open => {
        if (!open) { setReviewRunId(null); void queryClient.invalidateQueries({ queryKey: ['analysis', 'recent-runs'] }); onFinished(); }
      }} />
    </Card>
  );
}
