import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RotateCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { fetchLocalAgents } from '@/api/local-agents';
import { AGENT_MODEL_MAX_LENGTH, agentReasoningEfforts, agentSettingsProblem, cleanAgentSettings } from '@/utils/local-agent-settings';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  fetchIntegrationSettings,
  removeFinancialIntegration,
  removeLlmIntegration,
  saveFinancialIntegration,
  saveLlmIntegration,
  saveLlmRoute,
  testFinancialIntegration,
  testLlmIntegration,
  type IntegrationSettings,
  type IntegrationTestResult,
  type ModelRoute,
  type UpdateLlmIntegrationRequest,
} from '@/api/settings';

interface LlmDraft {
  baseUrl: string;
  fastModel: string;
  slowModel: string;
  apiKey: string;
}

const EMPTY_LLM: LlmDraft = {
  baseUrl: '',
  fastModel: '',
  slowModel: '',
  apiKey: '',
};

function getErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    const payload: unknown = error.response?.data;
    if (typeof payload === 'object' && payload !== null && 'message' in payload) {
      const message: unknown = payload.message;
      if (typeof message === 'string' && message.trim()) return message;
    }
    if (typeof payload === 'object' && payload !== null && 'error' in payload) {
      const nested: unknown = payload.error;
      if (typeof nested === 'object' && nested !== null && 'message' in nested) {
        const message: unknown = nested.message;
        if (typeof message === 'string' && message.trim()) return message;
      }
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function IntegrationSettingsPanel({ section, active = true }: {
  section: 'models' | 'data'; active?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [llmDraft, setLlmDraft] = useState<LlmDraft>(EMPTY_LLM);
  const [llmDirty, setLlmDirty] = useState(false);
  const [financialKey, setFinancialKey] = useState('');
  const [financialDirty, setFinancialDirty] = useState(false);
  const [showLlmKey, setShowLlmKey] = useState(false);
  const [showFinancialKey, setShowFinancialKey] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [financialError, setFinancialError] = useState<string | null>(null);
  const [llmTestResult, setLlmTestResult] = useState<IntegrationTestResult | null>(null);
  const [financialTestResult, setFinancialTestResult] = useState<IntegrationTestResult | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<'llm' | 'financial' | null>(null);

  const settingsQuery = useQuery<IntegrationSettings>({
    queryKey: ['settings', 'integrations'],
    queryFn: fetchIntegrationSettings,
    retry: false,
  });
  const agentsQuery = useQuery({
    queryKey: ['settings', 'local-agents'], queryFn: fetchLocalAgents,
    enabled: section === 'models' && active, retry: false, refetchInterval: 10000,
  });
  const [routeDraft, setRouteDraft] = useState<ModelRoute>(settingsQuery.data?.llm.route ?? { mode: 'basic' });
  const [routeDirty, setRouteDirty] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [customRouteModel, setCustomRouteModel] = useState(false);

  useEffect(() => {
    if (!settingsQuery.data) return;
    if (!routeDirty) setRouteDraft(settingsQuery.data.llm.route ?? { mode: 'basic' });
    if (!llmDirty) {
      setLlmDraft({
        baseUrl: settingsQuery.data.llm.baseUrl ?? '',
        fastModel: settingsQuery.data.llm.fastModel ?? '',
        slowModel: settingsQuery.data.llm.slowModel ?? '',
        apiKey: '',
      });
    }
    if (!financialDirty) setFinancialKey('');
  }, [settingsQuery.data, llmDirty, financialDirty, routeDirty]);

  function syncSettings(saved: IntegrationSettings): void {
    queryClient.setQueryData(['settings', 'integrations'], saved);
    void queryClient.invalidateQueries({ queryKey: ['settings', 'integrations'] });
  }

  const saveLlm = useMutation<IntegrationSettings, Error, UpdateLlmIntegrationRequest>({
    mutationFn: saveLlmIntegration,
    retry: false,
    onSuccess: (saved: IntegrationSettings) => {
      syncSettings(saved);
      setLlmDirty(false);
      setLlmDraft({
        baseUrl: saved.llm.baseUrl,
        fastModel: saved.llm.fastModel,
        slowModel: saved.llm.slowModel,
        apiKey: '',
      });
      setShowLlmKey(false);
      setLlmError(null);
      setLlmTestResult(null);
      toast.success(t('ui.settings.saved'));
    },
    onError: (error: Error) => {
      const message = getErrorMessage(error, t('ui.settings.saveFailed'));
      setLlmError(message.startsWith('API base URL must use HTTPS')
        ? t('ui.settings.llm.invalidUrl') : message);
    },
  });
  const saveRoute = useMutation<IntegrationSettings, Error, ModelRoute>({
    mutationFn: saveLlmRoute, retry: false,
    onSuccess: (saved) => {
      syncSettings(saved);
      setRouteDraft(saved.llm.route);
      setRouteDirty(false);
      setRouteError(null);
      toast.success(t('ui.settings.saved'));
    },
    onError: (error) => setRouteError(getErrorMessage(error, t('ui.settings.saveFailed'))),
  });
  const saveFinancial = useMutation<IntegrationSettings, Error, { provider: 'finnhub'; apiKey?: string }>({
    mutationFn: saveFinancialIntegration,
    retry: false,
    onSuccess: (saved: IntegrationSettings) => {
      syncSettings(saved);
      setFinancialKey('');
      setFinancialDirty(false);
      setShowFinancialKey(false);
      setFinancialError(null);
      setFinancialTestResult(null);
      toast.success(t('ui.settings.saved'));
    },
    onError: (error: Error) => setFinancialError(getErrorMessage(error, t('ui.settings.saveFailed'))),
  });
  const testLlm = useMutation<IntegrationTestResult, Error, void>({
    mutationFn: () => testLlmIntegration(i18n.language.startsWith('zh') ? 'zh-CN' : 'en'),
    retry: false,
    onSuccess: setLlmTestResult,
    onError: (error: Error) => setLlmTestResult({
      ok: false,
      message: getErrorMessage(error, t('ui.settings.testFailed')),
    }),
  });
  const testFinancial = useMutation<IntegrationTestResult, Error, void>({
    mutationFn: testFinancialIntegration,
    retry: false,
    onSuccess: setFinancialTestResult,
    onError: (error: Error) => setFinancialTestResult({
      ok: false,
      message: getErrorMessage(error, t('ui.settings.testFailed')),
    }),
  });
  const deleteLlm = useMutation<IntegrationSettings, Error, void>({
    mutationFn: removeLlmIntegration,
    retry: false,
    onSuccess: (saved: IntegrationSettings) => {
      syncSettings(saved);
      setLlmDirty(false);
      setLlmDraft({
        baseUrl: saved.llm.baseUrl,
        fastModel: saved.llm.fastModel,
        slowModel: saved.llm.slowModel,
        apiKey: '',
      });
      setShowLlmKey(false);
      setLlmTestResult(null);
      setDeleteTarget(null);
      toast.success(t('ui.settings.removed'));
    },
    onError: (error: Error) => {
      setDeleteTarget(null);
      setLlmError(getErrorMessage(error, t('ui.settings.removeFailed')));
    },
  });
  const deleteFinancial = useMutation<IntegrationSettings, Error, void>({
    mutationFn: removeFinancialIntegration,
    retry: false,
    onSuccess: (saved: IntegrationSettings) => {
      syncSettings(saved);
      setFinancialDirty(false);
      setFinancialKey('');
      setShowFinancialKey(false);
      setFinancialTestResult(null);
      setDeleteTarget(null);
      toast.success(t('ui.settings.removed'));
    },
    onError: (error: Error) => {
      setDeleteTarget(null);
      setFinancialError(getErrorMessage(error, t('ui.settings.removeFailed')));
    },
  });

  const llm = settingsQuery.data?.llm;
  const financial = settingsQuery.data?.financial;
  const agents = agentsQuery.data ?? [];
  const selectedAgent = routeDraft.mode === 'local' ? agents.find(agent => agent.id === routeDraft.agentId) : undefined;
  const routeModel = routeDraft.mode === 'local' ? routeDraft.agentSettings?.model ?? '' : '';
  const routeEffort = routeDraft.mode === 'local' ? routeDraft.agentSettings?.reasoningEffort ?? '' : '';
  const routeModels = selectedAgent?.models ?? [];
  const routeModelSupported = selectedAgent?.models !== undefined;
  const showCustomRouteModel = customRouteModel || Boolean(routeModel && !routeModels.some(model => model.id === routeModel));
  const routeEfforts = agentReasoningEfforts(selectedAgent, routeModel);
  const routeEffortInvalid = Boolean(routeEffort && !routeEfforts?.includes(routeEffort));
  const apiConfigured = Boolean(llm?.hasApiKey && !llm?.needsReentry);

  function updateRoute(route: ModelRoute): void {
    setRouteDraft(route);
    setRouteDirty(true);
    setRouteError(null);
  }

  function handleSaveRoute(): void {
    if (routeDraft.mode === 'api' && !apiConfigured) {
      setRouteError(t('modelRoute.apiUnavailable'));
      return;
    }
    if (routeDraft.mode === 'local') {
      if (!selectedAgent?.available || !selectedAgent.connected) {
        setRouteError(t('modelRoute.agentUnavailable'));
        return;
      }
      if (selectedAgent.busy) {
        setRouteError(t('modelRoute.agentBusy'));
        return;
      }
      const problem = agentSettingsProblem(routeDraft.agentSettings, selectedAgent);
      if (problem) {
        setRouteError(t(`modelRoute.${problem}`));
        return;
      }
      saveRoute.mutate({ mode: 'local', agentId: selectedAgent.id,
        agentSettings: cleanAgentSettings(routeDraft.agentSettings) });
      return;
    }
    saveRoute.mutate(routeDraft);
  }

  function updateLlm(field: keyof LlmDraft, value: string): void {
    setLlmDraft((current: LlmDraft) => ({ ...current, [field]: value }));
    setLlmDirty(true);
    setLlmError(null);
    setLlmTestResult(null);
  }

  function handleSaveLlm(): void {
    const baseUrl = llmDraft.baseUrl.trim();
    const fastModel = llmDraft.fastModel.trim();
    const slowModel = llmDraft.slowModel.trim();
    const apiKey = llmDraft.apiKey.trim();
    if (!baseUrl || !fastModel || !slowModel) {
      setLlmError(t('ui.settings.llm.completeFields'));
      return;
    }
    if (!apiKey && (llm?.source !== 'user' || llm.needsReentry)) {
      setLlmError(t(llm?.needsReentry
        ? 'ui.settings.reentryRequired' : 'ui.settings.llm.keyRequired'));
      return;
    }
    if (!apiKey && llm?.source === 'user'
      && baseUrl.replace(/\/+$/u, '') !== llm.baseUrl.replace(/\/+$/u, '')) {
      setLlmError(t('integrations.providerChanged'));
      return;
    }
    const request: UpdateLlmIntegrationRequest = {
      baseUrl,
      fastModel,
      slowModel,
      ...(apiKey ? { apiKey } : {}),
    };
    saveLlm.mutate(request);
  }

  function handleSaveFinancial(): void {
    const apiKey = financialKey.trim();
    if (!apiKey && (financial?.source !== 'user' || financial.needsReentry)) {
      setFinancialError(t(financial?.needsReentry
        ? 'ui.settings.reentryRequired' : 'ui.settings.financial.keyRequired'));
      return;
    }
    saveFinancial.mutate({ provider: 'finnhub', ...(apiKey ? { apiKey } : {}) });
  }

  return (
    <div className="space-y-5">
      {section === 'models' && llm?.route?.mode === 'basic' && (
        <Card className="border-success/30 bg-success/5">
          <CardContent className="flex flex-col items-start gap-4 pt-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 flex-1 space-y-1">
              <h2 className="font-semibold">{t('integrations.readyTitle')}</h2>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('integrations.readyBody')}</p>
            </div>
            <Button asChild><Link to="/analysis">{t('integrations.runAnalysis')}</Link></Button>
          </CardContent>
        </Card>
      )}

      {settingsQuery.isLoading ? (
        <div className="flex min-h-56 items-center justify-center gap-2 text-muted-foreground" role="status">
          <LoaderCircle className="size-4 animate-spin" /> {t('ui.settings.loading')}
        </div>
      ) : settingsQuery.isError || !settingsQuery.data ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
            <p className="text-sm text-destructive">{t('ui.settings.loadFailed')}</p>
            <Button variant="outline" onClick={() => void settingsQuery.refetch()}>
              <RotateCw /> {t('ui.settings.retry')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {section === 'models' && <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="text-lg">{t('modelRoute.title')}</CardTitle>
              <CardDescription>{t('modelRoute.subtitle')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="llm-default-route">{t('modelRoute.default')}</Label>
                <NativeSelect id="llm-default-route" className="w-full" value={routeDraft.mode}
                  onChange={(event) => {
                    const mode = event.target.value;
                    setCustomRouteModel(false);
                    updateRoute(mode === 'local' ? { mode: 'local', agentId: agents.find(agent => agent.available && agent.connected)?.id ?? '' }
                      : mode === 'api' ? { mode: 'api' } : { mode: 'basic' });
                  }}>
                  <option value="basic">{t('modelRoute.basic')}</option>
                  <option value="api" disabled={!apiConfigured}>{t('modelRoute.api')}</option>
                  <option value="local">{t('modelRoute.local')}</option>
                </NativeSelect>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t(`modelRoute.${routeDraft.mode}Hint`)}
                </p>
                {!apiConfigured && <p className="text-xs leading-5 text-muted-foreground">{t('modelRoute.apiSetupHint')}</p>}
              </div>
              {routeDraft.mode === 'local' && <div className="space-y-4 rounded-lg border border-border p-4">
                {agentsQuery.isLoading && <p role="status" className="text-sm text-muted-foreground">{t('modelRoute.loadingAgents')}</p>}
                {agentsQuery.isError && <p role="alert" className="text-sm text-destructive">{t('modelRoute.agentsLoadFailed')}</p>}
                {!agentsQuery.isLoading && !agents.length && <p className="text-sm text-muted-foreground">{t('modelRoute.noAgents')}</p>}
                <div className="space-y-2">
                  <Label htmlFor="llm-route-agent">{t('modelRoute.agent')}</Label>
                  <NativeSelect id="llm-route-agent" className="w-full" value={routeDraft.agentId}
                    onChange={(event) => { setCustomRouteModel(false); updateRoute({ mode: 'local', agentId: event.target.value }); }}>
                    {!agents.some(agent => agent.id === routeDraft.agentId) &&
                      <option value={routeDraft.agentId}>{routeDraft.agentId
                        ? `${routeDraft.agentId} · ${t('modelRoute.unavailable')}` : t('modelRoute.chooseAgent')}</option>}
                    {agents.map(agent => <option key={agent.id} value={agent.id} disabled={!agent.available || !agent.connected}>
                      {agent.name}{!agent.available || !agent.connected
                        ? ` · ${t('modelRoute.unavailable')}`
                        : agent.busy ? ` · ${t('modelRoute.busy')}` : ''}
                    </option>)}
                  </NativeSelect>
                  {selectedAgent && (!selectedAgent.available || !selectedAgent.connected || selectedAgent.busy) &&
                    <p className="text-xs text-amber-600">{t(selectedAgent.busy && selectedAgent.available
                      ? 'modelRoute.agentBusy' : 'modelRoute.agentUnavailable')}</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="llm-route-model">{t('modelRoute.model')}</Label>
                  <NativeSelect id="llm-route-model" className="w-full" disabled={!routeModelSupported}
                    value={!routeModelSupported ? '' : showCustomRouteModel ? '__custom_model__' : routeModel}
                    onChange={(event) => {
                      const custom = event.target.value === '__custom_model__';
                      setCustomRouteModel(custom);
                      const model = custom ? '' : event.target.value;
                      updateRoute({ ...routeDraft, agentSettings: {
                        model, reasoningEffort: agentReasoningEfforts(selectedAgent, model)?.includes(routeEffort) ? routeEffort : undefined,
                      } });
                    }}>
                    <option value="">{t('modelRoute.agentDefault')}</option>
                    {routeModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
                    {routeModelSupported && <option value="__custom_model__">{t('modelRoute.customModel')}</option>}
                  </NativeSelect>
                  {routeModelSupported && showCustomRouteModel && <Input id="llm-route-custom-model"
                    value={routeModel} maxLength={AGENT_MODEL_MAX_LENGTH} autoComplete="off" spellCheck={false}
                    placeholder={t('modelRoute.modelId')}
                    onChange={(event) => updateRoute({ ...routeDraft, agentSettings: {
                      model: event.target.value,
                      reasoningEffort: agentReasoningEfforts(selectedAgent, event.target.value)?.includes(routeEffort) ? routeEffort : undefined,
                    } })} />}
                  <p className="text-xs text-muted-foreground">{t(routeModelSupported
                    ? 'modelRoute.modelHint' : 'modelRoute.modelUnsupportedHint')}</p>
                  {!routeModelSupported && routeModel && <Button type="button" size="sm" variant="outline"
                    onClick={() => { setCustomRouteModel(false); updateRoute({ ...routeDraft, agentSettings: {
                      ...routeDraft.agentSettings, model: undefined, reasoningEffort: undefined,
                    } }); }}>{t('modelRoute.agentDefault')}</Button>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="llm-route-effort">{t('modelRoute.reasoning')}</Label>
                  <NativeSelect id="llm-route-effort" className="w-full" value={routeEffortInvalid ? '' : routeEffort}
                    disabled={!routeEfforts?.length}
                    onChange={(event) => updateRoute({ ...routeDraft,
                      agentSettings: { ...routeDraft.agentSettings, reasoningEffort: event.target.value || undefined },
                    })}>
                    <option value="">{t('modelRoute.agentDefault')}</option>
                    {routeEfforts?.map(effort => <option key={effort} value={effort}>{effort}</option>)}
                  </NativeSelect>
                  {routeEffortInvalid && <p className="text-xs text-destructive">{t('modelRoute.reasoningInvalid')}</p>}
                  {routeEffortInvalid && <Button type="button" size="sm" variant="outline"
                    onClick={() => updateRoute({ ...routeDraft, agentSettings: {
                      ...routeDraft.agentSettings, reasoningEffort: undefined,
                    } })}>{t('modelRoute.agentDefault')}</Button>}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{t('modelRoute.localBilling')}</p>
                <Link to="/settings/agents" className="text-xs text-primary hover:underline">{t('modelRoute.manageAgents')}</Link>
              </div>}
              {routeError && <p role="alert" className="text-sm text-destructive">{routeError}</p>}
              <div className="border-t border-border pt-5">
                <Button type="button" onClick={handleSaveRoute} disabled={saveRoute.isPending}>
                  {saveRoute.isPending && <LoaderCircle className="animate-spin" />}
                  {t('modelRoute.save')}
                </Button>
              </div>
            </CardContent>
          </Card>}
          {section === 'models' && <Card className="min-w-0">
            <CardHeader className="gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-primary/10 p-2 text-primary"><Sparkles size={19} /></div>
                  <div>
                    <CardTitle className="text-lg leading-snug">{t('ui.settings.llm.title')}</CardTitle>
                    <CardDescription className="mt-1">{t('ui.settings.llm.subtitle')}</CardDescription>
                  </div>
                </div>
                <Badge variant={llm?.hasApiKey ? 'secondary' : 'outline'}>
                  {llm?.source === 'local' ? t(llm.hasApiKey ? 'ui.settings.savedKey' : 'ui.settings.source.none') : t(llm?.needsReentry
                    ? 'ui.settings.source.needsReentry'
                    : llm?.source === 'builtin' ? 'integrations.basicBadge'
                    : `ui.settings.source.${llm?.source ?? 'none'}`)}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <p className="text-sm leading-6 text-muted-foreground">
                {t('modelRoute.apiConfigHint')}
              </p>
              {llm?.needsReentry && (
                <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm leading-6 text-foreground">
                  {t('ui.settings.reentryWarning')}
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor="llm-base-url">{t('ui.settings.llm.baseUrl')}</Label>
                <Input id="llm-base-url" type="url" value={llmDraft.baseUrl}
                  onChange={(event) => updateLlm('baseUrl', event.target.value)}
                  placeholder="https://api.openai.com/v1" autoComplete="url" />
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('ui.settings.llm.baseHint')}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="outline" type="button"
                    onClick={() => {
                      setLlmDraft({
                        baseUrl: 'https://openrouter.ai/api/v1',
                        fastModel: 'openrouter/free',
                        slowModel: 'openrouter/free',
                        apiKey: '',
                      });
                      setLlmDirty(true);
                      setLlmError(null);
                      setLlmTestResult(null);
                    }}>
                    {t('integrations.openRouterPreset')}
                  </Button>
                  <Button size="sm" variant="outline" type="button"
                    onClick={() => updateLlm('baseUrl', 'https://api.openai.com/v1')}>
                    OpenAI
                  </Button>
                  <Button size="sm" variant="outline" type="button"
                    onClick={() => {
                      setLlmDraft((current: LlmDraft) => ({ ...current,
                        baseUrl: 'https://api.deepseek.com', fastModel: 'deepseek-flash', slowModel: 'deepseek-flash',
                        apiKey: /^https:\/\/api\.deepseek\.com(?:\/|$)/iu.test(current.baseUrl.trim()) ? current.apiKey : '',
                      }));
                      setLlmDirty(true);
                      setLlmError(null);
                      setLlmTestResult(null);
                    }}>
                    DeepSeek
                  </Button>
                  <Button size="sm" variant="outline" type="button"
                    onClick={() => updateLlm('baseUrl', 'https://ark.cn-beijing.volces.com/api/v3')}>
                    {t('ui.settings.llm.doubao')}
                  </Button>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{t('integrations.presetHint')}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="llm-fast-model">{t('ui.settings.llm.fastModel')}</Label>
                  <Input id="llm-fast-model" value={llmDraft.fastModel}
                    onChange={(event) => updateLlm('fastModel', event.target.value)}
                    placeholder={t('ui.settings.llm.modelPlaceholder')} autoComplete="off" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="llm-slow-model">{t('ui.settings.llm.slowModel')}</Label>
                  <Input id="llm-slow-model" value={llmDraft.slowModel}
                    onChange={(event) => updateLlm('slowModel', event.target.value)}
                    placeholder={t('ui.settings.llm.modelPlaceholder')} autoComplete="off" />
                </div>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('ui.settings.llm.modelHint')}
              </p>
              {/^https:\/\/api\.deepseek\.com(?:\/|$)/iu.test(llmDraft.baseUrl.trim()) &&
                <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">
                  <p>{t('integrations.deepSeekModelHint')}</p>
                  <p className="mt-1">{t('integrations.deepSeekModeHint')}</p>
                </div>}
              <div className="space-y-2">
                <Label htmlFor="llm-api-key">{t('ui.settings.apiKey')}</Label>
                <div className="flex gap-2">
                  <Input id="llm-api-key" type={showLlmKey ? 'text' : 'password'}
                    value={llmDraft.apiKey}
                    onChange={(event) => updateLlm('apiKey', event.target.value)}
                    placeholder={llm?.hasApiKey ? t('ui.settings.keepExisting') : t('ui.settings.enterKey')}
                    autoComplete="new-password" spellCheck={false} />
                  <Button type="button" variant="outline" size="icon"
                    aria-label={t(showLlmKey ? 'ui.settings.hideKey' : 'ui.settings.showKey')}
                    onClick={() => setShowLlmKey((current: boolean) => !current)}>
                    {showLlmKey ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                {llm?.hasApiKey && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="size-3.5 text-success" />
                    {t('ui.settings.savedKey')}{llm.maskedApiKey ? ` · ${llm.maskedApiKey}` : ''}
                  </p>
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                  {t(llm?.needsReentry
                    ? 'ui.settings.reentryRequired' : 'ui.settings.keyHint')}
                </p>
              </div>
              {llmError && <p className="text-sm text-destructive" role="alert">{llmError}</p>}
              {llmTestResult && <TestResult result={llmTestResult} />}
              {llmDirty && (
                <p className="text-xs text-muted-foreground">{t('ui.settings.saveBeforeTest')}</p>
              )}
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
                <Button type="button" onClick={handleSaveLlm} disabled={saveLlm.isPending}>
                  {saveLlm.isPending && <LoaderCircle className="animate-spin" />}
                  {t('ui.settings.save')}
                </Button>
                <Button type="button" variant="outline" onClick={() => testLlm.mutate()}
                  disabled={!llm?.available || llmDirty || testLlm.isPending}>
                  {testLlm.isPending ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
                  {t(llm?.engine === 'basic' ? 'integrations.checkBasic' : 'ui.settings.test')}
                </Button>
                {llm?.source === 'user' && (
                  <Button type="button" variant="ghost" className="text-destructive"
                    onClick={() => setDeleteTarget('llm')}>
                    <Trash2 /> {t('ui.settings.remove')}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>}

          {section === 'data' && <Card className="min-w-0">
            <CardHeader className="gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-primary/10 p-2 text-primary"><KeyRound size={19} /></div>
                  <div>
                    <CardTitle className="text-lg leading-snug">{t('ui.settings.financial.title')}</CardTitle>
                    <CardDescription className="mt-1">{t('integrations.financialSubtitle')}</CardDescription>
                  </div>
                </div>
                <Badge variant={financial?.hasApiKey ? 'secondary' : 'outline'}>
                  {t(financial?.needsReentry
                    ? 'ui.settings.source.needsReentry'
                    : financial?.source === 'builtin' ? 'integrations.publicBadge'
                    : `ui.settings.source.${financial?.source ?? 'none'}`)}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <p className="text-sm leading-6 text-muted-foreground">
                {t('integrations.publicScope')}
              </p>
              {financial?.needsReentry && (
                <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm leading-6 text-foreground">
                  {t('ui.settings.reentryWarning')}
                </p>
              )}
              <div className="rounded-lg border border-border bg-secondary/40 p-4 text-sm leading-6">
                <p className="font-medium">{t('ui.settings.financial.currentCoverage')}</p>
                <p className="mt-1 text-muted-foreground">
                  {t('integrations.financialUpgrade')}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="financial-api-key">{t('integrations.finnhubOptional')}</Label>
                <div className="flex gap-2">
                  <Input id="financial-api-key" type={showFinancialKey ? 'text' : 'password'}
                    value={financialKey}
                    onChange={(event) => {
                      setFinancialKey(event.target.value);
                      setFinancialDirty(true);
                      setFinancialError(null);
                      setFinancialTestResult(null);
                    }}
                    placeholder={financial?.hasApiKey
                      ? t('ui.settings.keepExisting') : t('ui.settings.enterKey')}
                    autoComplete="new-password" spellCheck={false} />
                  <Button type="button" variant="outline" size="icon"
                    aria-label={t(showFinancialKey ? 'ui.settings.hideKey' : 'ui.settings.showKey')}
                    onClick={() => setShowFinancialKey((current: boolean) => !current)}>
                    {showFinancialKey ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                {financial?.hasApiKey && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="size-3.5 text-success" />
                    {t('ui.settings.savedKey')}
                    {financial.maskedApiKey ? ` · ${financial.maskedApiKey}` : ''}
                  </p>
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                  {t(financial?.needsReentry
                    ? 'ui.settings.reentryRequired' : 'ui.settings.keyHint')}
                </p>
              </div>
              {financialError && (
                <p className="text-sm text-destructive" role="alert">{financialError}</p>
              )}
              {financialTestResult && <TestResult result={financialTestResult} />}
              {financialDirty && (
                <p className="text-xs text-muted-foreground">{t('ui.settings.saveBeforeTest')}</p>
              )}
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
                <Button type="button" onClick={handleSaveFinancial} disabled={saveFinancial.isPending}>
                  {saveFinancial.isPending && <LoaderCircle className="animate-spin" />}
                  {t('ui.settings.save')}
                </Button>
                <Button type="button" variant="outline" onClick={() => testFinancial.mutate()}
                  disabled={!financial?.available || financialDirty || testFinancial.isPending}>
                  {testFinancial.isPending
                    ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
                  {t(financial?.provider === 'public' ? 'integrations.testPublic' : 'ui.settings.test')}
                </Button>
                {financial?.source === 'user' && (
                  <Button type="button" variant="ghost" className="text-destructive"
                    onClick={() => setDeleteTarget('financial')}>
                    <Trash2 /> {t('ui.settings.remove')}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>}
        </>
      )}

      <div className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-4 text-xs leading-6 text-muted-foreground">
        <LockKeyhole className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <p>{t('ui.settings.privacyNote')}</p>
      </div>

      <AlertDialog open={active && deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ui.settings.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(deleteTarget === 'llm'
                ? 'modelRoute.removeLlm'
                : 'integrations.removeFinancial')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('ui.settings.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => {
                if (deleteTarget === 'llm') deleteLlm.mutate();
                if (deleteTarget === 'financial') deleteFinancial.mutate();
              }}
            >
              {t('ui.settings.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TestResult({ result }: { result: IntegrationTestResult }) {
  const { t } = useTranslation();
  return (
    <div role="status" className={`rounded-lg border px-3 py-2 text-sm leading-6 ${
      result.ok
        ? 'border-success/30 bg-success/10 text-success'
        : 'border-destructive/30 bg-destructive/5 text-destructive'
    }`}>
      <span className="font-medium">{t(result.ok
        ? 'ui.settings.testSucceeded' : 'ui.settings.testFailed')}</span>
      {result.code ? ` · ${t(`integrations.test.${result.code}`)}` : result.message ? ` · ${result.message}` : ''}
    </div>
  );
}
