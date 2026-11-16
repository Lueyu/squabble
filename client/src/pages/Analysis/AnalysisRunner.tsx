/**
 * AnalysisRunner.tsx — 分析页顶部的"运行 AI 分析"操作卡。
 *
 * 职责边界：
 *  - 发起组合级分析（runPortfolioAnalysis）或单股分析（runStockAnalysis，弹窗输入代码）；
 *  - 展示最近运行列表：状态徽标、运行中转圈 + 取消按钮、待人工复核入口、报告链接；
 *  - 显示集成设置状态（LLM 引擎徽标、缺配置 / 密钥需重入提示）；
 *  - 检测到运行状态串变化时通过 onFinished 通知父组件刷新。
 * 上下游：
 *  - 上游：AnalysisPage（<AnalysisRunner onFinished={handleRunFinished} />）；
 *  - 下游：@/api/settings（fetchIntegrationSettings）、@/api/analysis-runner
 *    （runPortfolioAnalysis / runStockAnalysis / cancelAnalysisRun / fetchRecentAnalysisRuns）、
 *    AgentRunDetailModal（待人工复核详情弹窗）。
 * 关键约定：
 *  - runs 查询在存在活跃运行时每 2.5s 轮询，否则停止轮询；
 *  - "活跃"状态集合见 ACTIVE（pending/fetching/debating/critiquing/risk_check）；
 *  - completed 串 = 各运行 "id:status" 用 | 连接，与上次不同即视为有运行状态变化。
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bot, ArrowRight, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type { AgentRunStatus } from '@shared/api.interface';
import { fetchIntegrationSettings } from '@/api/settings';
import {
  cancelAnalysisRun,
  fetchRecentAnalysisRuns,
  runPortfolioAnalysis,
  runStockAnalysis,
} from '@/api/analysis-runner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { displayCompanyName } from '@/utils/company-name';
import AgentRunDetailModal from '@/components/MultiAgent/AgentRunDetailModal';

/** 视为"运行中"的状态集合（行内转圈 + 显示取消按钮）。 */
const ACTIVE: AgentRunStatus[] = ['pending', 'fetching', 'debating', 'critiquing', 'risk_check'];
/** 运行状态 → i18n key 映射。 */
const STATUS_KEYS: Record<AgentRunStatus, string> = {
  pending: 'agent.pending',
  fetching: 'agent.fetching',
  debating: 'agent.debating',
  critiquing: 'agent.critiquing',
  risk_check: 'agent.riskCheck',
  awaiting_human: 'agent.awaitingHuman',
  completed: 'agent.completed',
  failed: 'agent.failed',
  cancelled: 'agent.cancelled',
};

/** 从 Axios 错误响应体里提取 message 字段；取不到时返回 fallback 文案。 */
function requestError(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    const data: unknown = error.response?.data;
    if (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string')
      return data.message;
  }
  return fallback;
}

export default function AnalysisRunner({ onFinished }: { onFinished: () => void }) {
  // ===== 状态声明区 =====
  const { t, i18n } = useTranslation();
  // 深度报告按语言生成：英文环境用 en，其余一律 zh-CN。
  const language = i18n.language.startsWith('en') ? 'en' : 'zh-CN';
  const queryClient = useQueryClient();
  // 单股分析弹窗开关 + 表单状态。
  const [singleOpen, setSingleOpen] = useState(false);
  const [ticker, setTicker] = useState('');
  const [tickerError, setTickerError] = useState('');
  const [submitError, setSubmitError] = useState('');
  // 当前打开"待人工复核"详情的运行 id。
  const [reviewRunId, setReviewRunId] = useState<string | null>(null);
  // 上一次 completed 串的快照，用于检测"运行状态发生变化"。
  const previousCompleted = useRef<string | null>(null);

  // ===== 数据获取区 =====
  // 集成设置（判断是否已配置 LLM 引擎）。
  const settings = useQuery({
    queryKey: ['settings', 'integrations'],
    queryFn: fetchIntegrationSettings,
  });
  // 最近运行列表：有活跃运行时每 2.5s 轮询，空闲时停止。
  const runs = useQuery({
    queryKey: ['analysis', 'recent-runs'],
    queryFn: fetchRecentAnalysisRuns,
    refetchInterval: (query) => ((query.state.data?.activeTotal ?? 0) > 0 ? 2500 : false),
  });
  // 把运行列表压成 "id:status|id:status" 串，便于整体比较。
  const completed = (runs.data?.items ?? []).map((run) => `${run.id}:${run.status}`).join('|');
  // completed 串与上次不同（排除首次渲染）→ 有运行启动 / 结束，通知父组件刷新。
  useEffect(() => {
    if (previousCompleted.current !== null && previousCompleted.current !== completed) onFinished();
    previousCompleted.current = completed;
  }, [completed, onFinished]);

  // ===== 派生计算区 =====
  const llm = settings.data?.llm;
  // 是否使用 LLM 引擎（否则走基础规则分析）。
  const usesAi = llm?.engine === 'llm';
  // 是否存在活跃运行（按钮转圈 / 文案切换的依据）。
  const busy = (runs.data?.activeTotal ?? 0) > 0;

  // ===== 事件处理区 =====
  // 发起分析：带 symbol = 单股分析，不带 = 全组合分析。
  const start = useMutation({
    mutationFn: async (symbol?: string) => {
      const result = symbol
        ? await runStockAnalysis({ scope: 'custom', tiered: false, tickers: [symbol], language })
        : await runPortfolioAnalysis(language);
      return {
        count: 'totalCreated' in result ? result.totalCreated : result.created,
        errors: result.errors,
      };
    },
    onMutate: () => setSubmitError(''),
    onSuccess: (result) => {
      setSingleOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['analysis', 'recent-runs'] });
      // 有创建成功的运行 → 成功 toast；一个都没创建且无错误 → 提示无可用标的。
      if (result.count > 0) toast.success(t('analysisFlow.submitted', { count: result.count }));
      else if (!result.errors.length) setSubmitError(t('analysisFlow.noTickers'));
      // 部分标的失败 → 汇总每个标的的错误信息展示。
      if (result.errors.length)
        setSubmitError(
          `${t('analysisFlow.partial')}: ${result.errors.map((item) => `${item.ticker}: ${item.error}`).join('; ')}`,
        );
      onFinished();
    },
    onError: (error) => setSubmitError(requestError(error, t('analysisFlow.failed'))),
  });
  // 取消单个运行。
  const cancel = useMutation({
    mutationFn: cancelAnalysisRun,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['analysis', 'recent-runs'] });
    },
    onError: () => toast.error(t('analysisFlow.failed')),
  });
  // 提交类按钮的禁用条件：任一请求挂起 / 出错 / 已有活跃运行 / LLM 密钥需重入。
  const disabled =
    start.isPending ||
    busy ||
    runs.isPending ||
    runs.isError ||
    settings.isPending ||
    settings.isError ||
    llm?.needsReentry;
  // 单股表单提交：先校验代码格式（字母数字 . ^ -，最长 20 位），再发起分析。
  const submitStock = (event: React.FormEvent) => {
    event.preventDefault();
    const symbol = ticker.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.^-]{0,19}$/u.test(symbol)) {
      setTickerError(t('analysisFlow.invalidTicker'));
      return;
    }
    setTickerError('');
    start.mutate(symbol);
  };

  return (
    // ===== 渲染区 =====
    <Card className="min-w-0">
      <CardContent className="space-y-4 p-4 sm:p-5">
        {/* 主操作行：组合分析 / 单股分析按钮 + 右侧引擎徽标 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => start.mutate(undefined)}
              disabled={disabled}
              className="h-auto min-h-9 whitespace-normal text-left"
            >
              {/* 什么时候走到这里：本地提交中或后台已有活跃运行——显示转圈与"运行中"文案 */}
              {start.isPending || busy ? (
                <LoaderCircle className="mr-2 size-4 shrink-0 animate-spin" />
              ) : (
                <Bot className="mr-2 size-4 shrink-0" />
              )}
              {t(busy ? 'analysisFlow.running' : 'analysisFlow.runPortfolio')}
            </Button>
            <Button variant="outline" onClick={() => setSingleOpen(true)} disabled={disabled}>
              <Search className="mr-2 size-4" />
              {t('analysisFlow.runStock')}
            </Button>
          </div>
          {llm && (
            <Badge variant="secondary">
              {t(usesAi ? 'analysisFlow.ai' : 'analysisFlow.basic')}
            </Badge>
          )}
        </div>
        {/* 提示区：当前引擎的说明 + 报告语言 + 设置页入口 */}
        <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          <p>{t(usesAi ? 'analysisFlow.aiHint' : 'analysisFlow.basicHint')}</p>
          <p>
            {t('analysisFlow.language', {
              language: t(language === 'en' ? 'analysisFlow.english' : 'analysisFlow.chinese'),
            })}{' '}
            <Link to="/settings" className="underline underline-offset-4">
              {t('analysisFlow.settings')}
            </Link>
          </p>
        </div>
        {/* 三类错误提示：集成设置缺失 / LLM 密钥需重入 / 提交失败 */}
        {settings.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('analysisFlow.missingSettings')}
          </p>
        )}
        {llm?.needsReentry && (
          <p role="alert" className="text-sm text-destructive">
            {t('analysisFlow.keyUnavailable')}
          </p>
        )}
        {submitError && (
          <p role="alert" className="break-words text-sm text-destructive">
            {submitError}
          </p>
        )}
        {/* 最近运行列表：手动刷新 + 各运行的即时状态 */}
        <div className="border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('analysisFlow.recent')}</h2>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('analysisFlow.refresh')}
              onClick={() => {
                void runs.refetch();
                void settings.refetch();
              }}
            >
              <RefreshCw className={`size-3.5 ${runs.isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          {runs.isError && (
            <p role="alert" className="text-xs text-destructive">
              {t('analysisFlow.loadError')}
            </p>
          )}
          {/* 运行行：代码 / 公司名 + 状态文案 + 按状态附加的操作按钮 */}
          <div className="max-h-72 space-y-2 overflow-y-auto" aria-live="polite">
            {(runs.data?.items ?? []).map((run) => (
              <div
                key={run.id}
                className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-2"
              >
                <div className="min-w-0 flex-1 basis-36">
                  <p className="truncate text-sm font-semibold">
                    {run.ticker}{' '}
                    <span className="font-normal text-muted-foreground">
                      {displayCompanyName(run.tickerName, run.ticker, language)}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">{t(STATUS_KEYS[run.status])}</p>
                  {run.errorMessage && (
                    <p className="mt-1 break-words text-xs text-destructive">{run.errorMessage}</p>
                  )}
                </div>
                {/* 什么时候走到这里：运行仍在活跃阶段——转圈 + 取消按钮 */}
                {ACTIVE.includes(run.status) && (
                  <>
                    <LoaderCircle className="size-4 animate-spin text-primary" />
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`${t('analysisFlow.cancel')} ${run.ticker}`}
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(run.id)}
                    >
                      <X className="size-4" />
                    </Button>
                  </>
                )}
                {/* 什么时候走到这里：运行停在风险检查，等待人工决策——打开复核弹窗 */}
                {run.status === 'awaiting_human' && (
                  <Button variant="outline" size="sm" onClick={() => setReviewRunId(run.id)}>
                    {t('analysisFlow.reviewDecision')}
                  </Button>
                )}
                {/* 有报告 → 跳转深度报告页 */}
                {run.hasReport && (
                  <Button asChild variant="ghost" size="sm">
                    <Link to={`/analysis/deep-report/${run.id}`}>
                      {t('analysisFlow.openReport')}
                      <ArrowRight className="ml-1 size-3.5" />
                    </Link>
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      </CardContent>
      {/* 单股分析弹窗：代码输入 + 校验 + 提交 */}
      <Dialog open={singleOpen} onOpenChange={setSingleOpen}>
        <DialogContent>
          <form onSubmit={submitStock} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t('analysisFlow.stockTitle')}</DialogTitle>
              <DialogDescription>{t('analysisFlow.stockDescription')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="analysis-ticker">{t('analysisFlow.ticker')}</Label>
              <Input
                id="analysis-ticker"
                value={ticker}
                onChange={(event) => setTicker(event.target.value)}
                autoComplete="off"
                maxLength={20}
                placeholder="AAPL"
              />
              <p className="text-xs text-muted-foreground">{t('analysisFlow.tickerHint')}</p>
            </div>
            {tickerError && (
              <p role="alert" className="text-sm text-destructive">
                {tickerError}
              </p>
            )}
            {submitError && (
              <p role="alert" className="text-sm text-destructive">
                {submitError}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSingleOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={disabled}>
                {start.isPending && <LoaderCircle className="mr-2 size-4 animate-spin" />}
                {t('analysisFlow.start')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {/* 待人工复核详情弹窗：关闭时刷新列表并通知父组件 */}
      <AgentRunDetailModal
        open={reviewRunId !== null}
        runId={reviewRunId}
        onOpenChange={(open) => {
          if (!open) {
            setReviewRunId(null);
            void queryClient.invalidateQueries({ queryKey: ['analysis', 'recent-runs'] });
            onFinished();
          }
        }}
      />
    </Card>
  );
}
