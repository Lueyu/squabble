/**
 * IntegrationSettingsPanel.tsx — 集成配置分区面板：按 section 渲染 LLM API（models）或金融数据源（data）配置卡。
 *
 * 职责边界：
 *  - section='models'：LLM 连接配置（baseUrl / 快慢模型 / apiKey）的保存、连通性测试、移除，
 *    以及 basic 引擎就绪横幅；
 *  - section='data'：Finnhub 金融数据源 apiKey 的保存、测试、移除；
 *  - 共用：删除确认弹层、隐私说明、加载/错误分支。
 * 上下游：
 *  - 上游（路由入口/谁引用）：SettingsPage（models 与 data 两个分区各挂一个实例；
 *    active=false 表示其他分区激活，删除确认弹层会被强制关闭）。
 *  - 下游（调用哪些 hooks/api/组件）：useQuery/useMutation/useQueryClient；@/api/settings 的
 *    fetchIntegrationSettings / saveLlmIntegration / saveFinancialIntegration / removeLlmIntegration /
 *    removeFinancialIntegration / testLlmIntegration / testFinancialIntegration；本文件本地
 *    getErrorMessage（解析 axios 错误体，与 AgentBuilder/errorMessage.ts 不同实现）；Card/Input/
 *    Label/Badge/AlertDialog；toast。
 * 关键约定：
 *  - apiKey 永不回显：草稿/输入框始终以空串起步，placeholder 提示"留空沿用已有"；
 *    请求体仅在填了 apiKey 时才带 apiKey 字段（条件展开）。
 *  - 草稿脏标记（llmDirty / financialDirty）：脏的分区不会被服务端数据覆盖（useEffect 跳过）；
 *    保存/移除成功后清脏并重置草稿；脏状态期间"测试"按钮禁用（先保存再测）。
 *  - LLM 保存前置校验：三必填 → 未填 key 时按 needsReentry/source 判定必填性 →
 *    source=user 且未填 key 时 baseUrl 不得更换 provider（去尾斜杠比较，换商须重填 key）。
 *  - 测试结果（IntegrationTestResult）：有 code 时走译文 integrations.test.<code>，否则显示原始 message。
 *  - 保存失败时，服务端 "API base URL must use HTTPS" 前缀映射为本地化 invalidUrl 文案。
 */
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  testFinancialIntegration,
  testLlmIntegration,
  type IntegrationSettings,
  type IntegrationTestResult,
  type UpdateLlmIntegrationRequest,
} from '@/api/settings';

// LLM 配置草稿：baseUrl + 快/慢模型 + apiKey（apiKey 永不回显，始终空串起步）
interface LlmDraft {
  baseUrl: string;
  fastModel: string;
  slowModel: string;
  apiKey: string;
}

// 新建 LLM 配置时的空白草稿
const EMPTY_LLM: LlmDraft = {
  baseUrl: '',
  fastModel: '',
  slowModel: '',
  apiKey: '',
};

/**
 * 从错误对象提取人类可读信息：
 * 1. axios 错误 → 响应体顶层 { message } 字段；
 * 2. 响应体为嵌套 { error: { message } } 时取内层 message；
 * 3. 都没有 → Error.message；仍为空 → 调用方给的回退文案。
 */
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

export default function IntegrationSettingsPanel({
  section,
  active = true,
}: {
  section: 'models' | 'data';
  active?: boolean;
}) {
  // —— 状态声明区 ——
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  // LLM 表单草稿与脏标记（用户改过即脏，脏时不被服务端数据覆盖）
  const [llmDraft, setLlmDraft] = useState<LlmDraft>(EMPTY_LLM);
  const [llmDirty, setLlmDirty] = useState(false);
  // 金融数据源 apiKey 输入与脏标记（同样永不回显，空串起步）
  const [financialKey, setFinancialKey] = useState('');
  const [financialDirty, setFinancialDirty] = useState(false);
  // 两组 apiKey 的明文显隐开关
  const [showLlmKey, setShowLlmKey] = useState(false);
  const [showFinancialKey, setShowFinancialKey] = useState(false);
  // 两张卡各自的错误文案与最近一次测试结果
  const [llmError, setLlmError] = useState<string | null>(null);
  const [financialError, setFinancialError] = useState<string | null>(null);
  const [llmTestResult, setLlmTestResult] = useState<IntegrationTestResult | null>(null);
  const [financialTestResult, setFinancialTestResult] = useState<IntegrationTestResult | null>(
    null,
  );
  // 删除确认弹层目标：'llm' | 'financial'，null 表示关闭
  const [deleteTarget, setDeleteTarget] = useState<'llm' | 'financial' | null>(null);

  // —— 数据获取区 ——
  // 集成配置查询：失败不重试（retry:false），由渲染分支给重试按钮
  const settingsQuery = useQuery<IntegrationSettings>({
    queryKey: ['settings', 'integrations'],
    queryFn: fetchIntegrationSettings,
    retry: false,
  });

  // 服务端数据到达时同步草稿：脏的分区跳过（保留用户输入）；apiKey 一律置空不回显
  useEffect(() => {
    if (!settingsQuery.data) return;
    if (!llmDirty) {
      setLlmDraft({
        baseUrl: settingsQuery.data.llm.baseUrl ?? '',
        fastModel: settingsQuery.data.llm.fastModel ?? '',
        slowModel: settingsQuery.data.llm.slowModel ?? '',
        apiKey: '',
      });
    }
    if (!financialDirty) setFinancialKey('');
  }, [settingsQuery.data, llmDirty, financialDirty]);

  // —— 事件处理区 ——
  // 保存/移除成功后的缓存同步：先写入新数据再失效，触发依赖方刷新
  function syncSettings(saved: IntegrationSettings): void {
    queryClient.setQueryData(['settings', 'integrations'], saved);
    void queryClient.invalidateQueries({ queryKey: ['settings', 'integrations'] });
  }

  // 保存 LLM 配置：成功后清脏、重置草稿（apiKey 置空）、关明文开关、清错误与测试结果
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
      setLlmError(
        message.startsWith('API base URL must use HTTPS')
          ? t('ui.settings.llm.invalidUrl')
          : message,
      );
    },
  });
  // 保存金融数据源：成功后清空输入与脏标记，提示已保存；失败写脱敏错误
  const saveFinancial = useMutation<
    IntegrationSettings,
    Error,
    { provider: 'finnhub'; apiKey?: string }
  >({
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
    onError: (error: Error) =>
      setFinancialError(getErrorMessage(error, t('ui.settings.saveFailed'))),
  });
  // 测试 LLM 连通性：按当前语言请求；失败也写入测试结果（着色展示）
  const testLlm = useMutation<IntegrationTestResult, Error, void>({
    mutationFn: () => testLlmIntegration(i18n.language.startsWith('zh') ? 'zh-CN' : 'en'),
    retry: false,
    onSuccess: setLlmTestResult,
    onError: (error: Error) =>
      setLlmTestResult({
        ok: false,
        message: getErrorMessage(error, t('ui.settings.testFailed')),
      }),
  });
  // 测试金融数据源连通性：失败同样写入测试结果
  const testFinancial = useMutation<IntegrationTestResult, Error, void>({
    mutationFn: testFinancialIntegration,
    retry: false,
    onSuccess: setFinancialTestResult,
    onError: (error: Error) =>
      setFinancialTestResult({
        ok: false,
        message: getErrorMessage(error, t('ui.settings.testFailed')),
      }),
  });
  // 移除 LLM 配置：成功回到服务端状态（通常降级为 basic 引擎），失败清弹层并提示
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
  // 移除金融数据源配置：成功清输入，失败清弹层并提示
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

  // —— 派生计算区 ——
  // 当前服务端的两份配置（可能为 undefined：查询未返回时走加载/错误分支）
  const llm = settingsQuery.data?.llm;
  const financial = settingsQuery.data?.financial;

  // 更新 LLM 草稿字段：置脏并清掉旧错误/测试结果
  function updateLlm(field: keyof LlmDraft, value: string): void {
    setLlmDraft((current: LlmDraft) => ({ ...current, [field]: value }));
    setLlmDirty(true);
    setLlmError(null);
    setLlmTestResult(null);
  }

  // 保存 LLM：三步前置校验（必填 → key 必填性 → 换商校验），通过后组装请求提交
  function handleSaveLlm(): void {
    // 步骤 1：去空格并校验三必填
    const baseUrl = llmDraft.baseUrl.trim();
    const fastModel = llmDraft.fastModel.trim();
    const slowModel = llmDraft.slowModel.trim();
    const apiKey = llmDraft.apiKey.trim();
    if (!baseUrl || !fastModel || !slowModel) {
      setLlmError(t('ui.settings.llm.completeFields'));
      return;
    }
    // 步骤 2：未填 key 时——已有用户 key 且无需重录才允许留空（沿用旧 key）
    if (!apiKey && (llm?.source !== 'user' || llm.needsReentry)) {
      setLlmError(
        t(llm?.needsReentry ? 'ui.settings.reentryRequired' : 'ui.settings.llm.keyRequired'),
      );
      return;
    }
    // 步骤 3：source=user 且未填 key 时，baseUrl 不得更换 provider（去尾斜杠比较）
    if (
      !apiKey &&
      llm?.source === 'user' &&
      baseUrl.replace(/\/+$/u, '') !== llm.baseUrl.replace(/\/+$/u, '')
    ) {
      setLlmError(t('integrations.providerChanged'));
      return;
    }
    // 步骤 4：组装请求——仅填了 apiKey 才带该字段（留空即沿用服务端旧值）
    const request: UpdateLlmIntegrationRequest = {
      baseUrl,
      fastModel,
      slowModel,
      ...(apiKey ? { apiKey } : {}),
    };
    saveLlm.mutate(request);
  }

  // 保存金融数据源：未填 key 时按 needsReentry/source 判定必填性；请求同样条件带 apiKey
  function handleSaveFinancial(): void {
    const apiKey = financialKey.trim();
    if (!apiKey && (financial?.source !== 'user' || financial.needsReentry)) {
      setFinancialError(
        t(
          financial?.needsReentry
            ? 'ui.settings.reentryRequired'
            : 'ui.settings.financial.keyRequired',
        ),
      );
      return;
    }
    saveFinancial.mutate({ provider: 'finnhub', ...(apiKey ? { apiKey } : {}) });
  }

  // —— 渲染区 ——
  return (
    <div className="space-y-5">
      {/* 什么时候走到这里：models 分区且 LLM 引擎为 basic（内置公共额度）——顶部就绪横幅 */}
      {section === 'models' && llm?.engine === 'basic' && (
        <Card className="border-success/30 bg-success/5">
          <CardContent className="flex flex-col items-start gap-4 pt-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 flex-1 space-y-1">
              <h2 className="font-semibold">{t('integrations.readyTitle')}</h2>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                {t('integrations.readyBody')}
              </p>
            </div>
            <Button asChild>
              <Link to="/analysis">{t('integrations.runAnalysis')}</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* 三分支互斥：加载中 / 加载失败 / 已加载（两张配置卡） */}
      {settingsQuery.isLoading ? (
        // 什么时候走到这里：集成配置首次加载中
        <div
          className="flex min-h-56 items-center justify-center gap-2 text-muted-foreground"
          role="status"
        >
          <LoaderCircle className="size-4 animate-spin" /> {t('ui.settings.loading')}
        </div>
      ) : settingsQuery.isError || !settingsQuery.data ? (
        // 什么时候走到这里：配置查询失败——错误提示 + 重试
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
          {/* —— LLM 配置卡（仅 models 分区渲染）—— */}
          {section === 'models' && (
            <Card className="min-w-0">
              <CardHeader className="gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-primary/10 p-2 text-primary">
                      <Sparkles size={19} />
                    </div>
                    <div>
                      <CardTitle className="text-lg leading-snug">
                        {t('ui.settings.llm.title')}
                      </CardTitle>
                      <CardDescription className="mt-1">
                        {t('ui.settings.llm.subtitle')}
                      </CardDescription>
                    </div>
                  </div>
                  {/* 来源徽标：需重录 / 内置 basic / user / none */}
                  <Badge variant={llm?.hasApiKey ? 'secondary' : 'outline'}>
                    {t(
                      llm?.needsReentry
                        ? 'ui.settings.source.needsReentry'
                        : llm?.source === 'builtin'
                          ? 'integrations.basicBadge'
                          : `ui.settings.source.${llm?.source ?? 'none'}`,
                    )}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                {/* 适用范围说明：basic 引擎与自配 key 各不同 */}
                <p className="text-sm leading-6 text-muted-foreground">
                  {t(llm?.engine === 'basic' ? 'integrations.basicScope' : 'integrations.llmScope')}
                </p>
                {/* 什么时候走到这里：服务端标记已有 key 需要重新录入——警告横幅 */}
                {llm?.needsReentry && (
                  <p
                    role="alert"
                    className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm leading-6 text-foreground"
                  >
                    {t('ui.settings.reentryWarning')}
                  </p>
                )}
                {/* baseUrl 输入 + 四个厂商预填按钮 */}
                <div className="space-y-2">
                  <Label htmlFor="llm-base-url">{t('ui.settings.llm.baseUrl')}</Label>
                  <Input
                    id="llm-base-url"
                    type="url"
                    value={llmDraft.baseUrl}
                    onChange={(event) => updateLlm('baseUrl', event.target.value)}
                    placeholder="https://api.openai.com/v1"
                    autoComplete="url"
                  />
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t('ui.settings.llm.baseHint')}
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {/* OpenRouter 预填：完整覆盖草稿（含默认模型名，key 清空） */}
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
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
                      }}
                    >
                      {t('integrations.openRouterPreset')}
                    </Button>
                    {/* OpenAI 预填：只改 baseUrl，其余字段保留 */}
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      onClick={() => updateLlm('baseUrl', 'https://api.openai.com/v1')}
                    >
                      OpenAI
                    </Button>
                    {/* DeepSeek 预填：改 baseUrl 与快慢模型；仅当当前地址已是 DeepSeek
                        （正则判定）才保留已输入的 apiKey，否则清空避免误带到别家 */}
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      onClick={() => {
                        setLlmDraft((current: LlmDraft) => ({
                          ...current,
                          baseUrl: 'https://api.deepseek.com',
                          fastModel: 'deepseek-flash',
                          slowModel: 'deepseek-flash',
                          apiKey: /^https:\/\/api\.deepseek\.com(?:\/|$)/iu.test(
                            current.baseUrl.trim(),
                          )
                            ? current.apiKey
                            : '',
                        }));
                        setLlmDirty(true);
                        setLlmError(null);
                        setLlmTestResult(null);
                      }}
                    >
                      DeepSeek
                    </Button>
                    {/* 豆包（火山引擎方舟）预填：只改 baseUrl */}
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      onClick={() =>
                        updateLlm('baseUrl', 'https://ark.cn-beijing.volces.com/api/v3')
                      }
                    >
                      {t('ui.settings.llm.doubao')}
                    </Button>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t('integrations.presetHint')}
                  </p>
                </div>
                {/* 快/慢模型两个输入（快：轻量高频任务；慢：深度任务） */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="llm-fast-model">{t('ui.settings.llm.fastModel')}</Label>
                    <Input
                      id="llm-fast-model"
                      value={llmDraft.fastModel}
                      onChange={(event) => updateLlm('fastModel', event.target.value)}
                      placeholder={t('ui.settings.llm.modelPlaceholder')}
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="llm-slow-model">{t('ui.settings.llm.slowModel')}</Label>
                    <Input
                      id="llm-slow-model"
                      value={llmDraft.slowModel}
                      onChange={(event) => updateLlm('slowModel', event.target.value)}
                      placeholder={t('ui.settings.llm.modelPlaceholder')}
                      autoComplete="off"
                    />
                  </div>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('ui.settings.llm.modelHint')}
                </p>
                {/* 什么时候走到这里：baseUrl 是 DeepSeek——追加该厂商的模型/模式提示块 */}
                {/^https:\/\/api\.deepseek\.com(?:\/|$)/iu.test(llmDraft.baseUrl.trim()) && (
                  <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">
                    <p>{t('integrations.deepSeekModelHint')}</p>
                    <p className="mt-1">{t('integrations.deepSeekModeHint')}</p>
                  </div>
                )}
                {/* apiKey 输入：密码框 + 明文显隐切换；已有 key 时 placeholder 提示可留空沿用 */}
                <div className="space-y-2">
                  <Label htmlFor="llm-api-key">{t('ui.settings.apiKey')}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="llm-api-key"
                      type={showLlmKey ? 'text' : 'password'}
                      value={llmDraft.apiKey}
                      onChange={(event) => updateLlm('apiKey', event.target.value)}
                      placeholder={
                        llm?.hasApiKey ? t('ui.settings.keepExisting') : t('ui.settings.enterKey')
                      }
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={t(showLlmKey ? 'ui.settings.hideKey' : 'ui.settings.showKey')}
                      onClick={() => setShowLlmKey((current: boolean) => !current)}
                    >
                      {showLlmKey ? <EyeOff /> : <Eye />}
                    </Button>
                  </div>
                  {/* 什么时候走到这里：服务端已存有 key——显示"已保存"与打码摘要 */}
                  {llm?.hasApiKey && (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CheckCircle2 className="size-3.5 text-success" />
                      {t('ui.settings.savedKey')}
                      {llm.maskedApiKey ? ` · ${llm.maskedApiKey}` : ''}
                    </p>
                  )}
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t(llm?.needsReentry ? 'ui.settings.reentryRequired' : 'ui.settings.keyHint')}
                  </p>
                </div>
                {/* 什么时候走到这里：LLM 保存校验或请求失败——错误提示 */}
                {llmError && (
                  <p className="text-sm text-destructive" role="alert">
                    {llmError}
                  </p>
                )}
                {/* 什么时候走到这里：有连通性测试结果——成败着色展示 */}
                {llmTestResult && <TestResult result={llmTestResult} />}
                {/* 什么时候走到这里：草稿有未保存修改——提示先保存再测（测试按钮同时被禁用） */}
                {llmDirty && (
                  <p className="text-xs text-muted-foreground">{t('ui.settings.saveBeforeTest')}</p>
                )}
                {/* 操作区：保存 / 测试 / 移除（仅用户配置的 key 可移除） */}
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
                  <Button type="button" onClick={handleSaveLlm} disabled={saveLlm.isPending}>
                    {saveLlm.isPending && <LoaderCircle className="animate-spin" />}
                    {t('ui.settings.save')}
                  </Button>
                  {/* 测试：配置不可用、草稿脏或测试进行中时禁用 */}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => testLlm.mutate()}
                    disabled={!llm?.available || llmDirty || testLlm.isPending}
                  >
                    {testLlm.isPending ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
                    {t(llm?.engine === 'basic' ? 'integrations.checkBasic' : 'ui.settings.test')}
                  </Button>
                  {/* 什么时候走到这里：来源为 user——提供移除入口（打开确认弹层） */}
                  {llm?.source === 'user' && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => setDeleteTarget('llm')}
                    >
                      <Trash2 /> {t('ui.settings.remove')}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* —— 金融数据源卡（仅 data 分区渲染）—— */}
          {section === 'data' && (
            <Card className="min-w-0">
              <CardHeader className="gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-primary/10 p-2 text-primary">
                      <KeyRound size={19} />
                    </div>
                    <div>
                      <CardTitle className="text-lg leading-snug">
                        {t('ui.settings.financial.title')}
                      </CardTitle>
                      <CardDescription className="mt-1">
                        {t('integrations.financialSubtitle')}
                      </CardDescription>
                    </div>
                  </div>
                  {/* 来源徽标：需重录 / 内置公共数据源 / user / none */}
                  <Badge variant={financial?.hasApiKey ? 'secondary' : 'outline'}>
                    {t(
                      financial?.needsReentry
                        ? 'ui.settings.source.needsReentry'
                        : financial?.source === 'builtin'
                          ? 'integrations.publicBadge'
                          : `ui.settings.source.${financial?.source ?? 'none'}`,
                    )}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <p className="text-sm leading-6 text-muted-foreground">
                  {t('integrations.publicScope')}
                </p>
                {/* 什么时候走到这里：已有 Finnhub key 需要重新录入——警告横幅 */}
                {financial?.needsReentry && (
                  <p
                    role="alert"
                    className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm leading-6 text-foreground"
                  >
                    {t('ui.settings.reentryWarning')}
                  </p>
                )}
                {/* 当前数据覆盖范围说明（无 key 也可用公共数据源） */}
                <div className="rounded-lg border border-border bg-secondary/40 p-4 text-sm leading-6">
                  <p className="font-medium">{t('ui.settings.financial.currentCoverage')}</p>
                  <p className="mt-1 text-muted-foreground">{t('integrations.financialUpgrade')}</p>
                </div>
                {/* Finnhub apiKey 输入：可选（不填用公共数据源），密码框 + 显隐切换 */}
                <div className="space-y-2">
                  <Label htmlFor="financial-api-key">{t('integrations.finnhubOptional')}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="financial-api-key"
                      type={showFinancialKey ? 'text' : 'password'}
                      value={financialKey}
                      onChange={(event) => {
                        setFinancialKey(event.target.value);
                        setFinancialDirty(true);
                        setFinancialError(null);
                        setFinancialTestResult(null);
                      }}
                      placeholder={
                        financial?.hasApiKey
                          ? t('ui.settings.keepExisting')
                          : t('ui.settings.enterKey')
                      }
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={t(
                        showFinancialKey ? 'ui.settings.hideKey' : 'ui.settings.showKey',
                      )}
                      onClick={() => setShowFinancialKey((current: boolean) => !current)}
                    >
                      {showFinancialKey ? <EyeOff /> : <Eye />}
                    </Button>
                  </div>
                  {/* 什么时候走到这里：服务端已存有 Finnhub key——显示"已保存"与打码摘要 */}
                  {financial?.hasApiKey && (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <CheckCircle2 className="size-3.5 text-success" />
                      {t('ui.settings.savedKey')}
                      {financial.maskedApiKey ? ` · ${financial.maskedApiKey}` : ''}
                    </p>
                  )}
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t(
                      financial?.needsReentry
                        ? 'ui.settings.reentryRequired'
                        : 'ui.settings.keyHint',
                    )}
                  </p>
                </div>
                {/* 什么时候走到这里：金融数据源保存或请求失败——错误提示 */}
                {financialError && (
                  <p className="text-sm text-destructive" role="alert">
                    {financialError}
                  </p>
                )}
                {/* 什么时候走到这里：有连通性测试结果——成败着色展示 */}
                {financialTestResult && <TestResult result={financialTestResult} />}
                {/* 什么时候走到这里：输入有未保存修改——提示先保存再测 */}
                {financialDirty && (
                  <p className="text-xs text-muted-foreground">{t('ui.settings.saveBeforeTest')}</p>
                )}
                {/* 操作区：保存 / 测试（公共数据源文案不同）/ 移除（仅用户 key） */}
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
                  <Button
                    type="button"
                    onClick={handleSaveFinancial}
                    disabled={saveFinancial.isPending}
                  >
                    {saveFinancial.isPending && <LoaderCircle className="animate-spin" />}
                    {t('ui.settings.save')}
                  </Button>
                  {/* 测试：不可用、脏或进行中时禁用；provider=public 时按钮文案为"测公共源" */}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => testFinancial.mutate()}
                    disabled={!financial?.available || financialDirty || testFinancial.isPending}
                  >
                    {testFinancial.isPending ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <RotateCw />
                    )}
                    {t(
                      financial?.provider === 'public'
                        ? 'integrations.testPublic'
                        : 'ui.settings.test',
                    )}
                  </Button>
                  {/* 什么时候走到这里：来源为 user——提供移除入口（打开确认弹层） */}
                  {financial?.source === 'user' && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => setDeleteTarget('financial')}
                    >
                      <Trash2 /> {t('ui.settings.remove')}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* 底部隐私说明（两分区共用） */}
      <div className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-4 text-xs leading-6 text-muted-foreground">
        <LockKeyhole className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <p>{t('ui.settings.privacyNote')}</p>
      </div>

      {/* 删除确认弹层：active=false（其他分区激活）时强制关闭；
          确认按钮按 deleteTarget 分派到对应移除请求，成功由 mutation 关弹层 */}
      <AlertDialog
        open={active && deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ui.settings.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                deleteTarget === 'llm' ? 'integrations.removeLlm' : 'integrations.removeFinancial',
              )}
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

/** 连通性测试结果条：成功绿色/失败红色；有 code 时走译文，否则显示原始 message */
function TestResult({ result }: { result: IntegrationTestResult }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className={`rounded-lg border px-3 py-2 text-sm leading-6 ${
        result.ok
          ? 'border-success/30 bg-success/10 text-success'
          : 'border-destructive/30 bg-destructive/5 text-destructive'
      }`}
    >
      <span className="font-medium">
        {t(result.ok ? 'ui.settings.testSucceeded' : 'ui.settings.testFailed')}
      </span>
      {result.code
        ? ` · ${t(`integrations.test.${result.code}`)}`
        : result.message
          ? ` · ${result.message}`
          : ''}
    </div>
  );
}
