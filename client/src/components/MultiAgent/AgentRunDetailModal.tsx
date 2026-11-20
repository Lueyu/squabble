/**
 * AgentRunDetailModal - 全屏弹窗，检视一次 multi-agent 分析 run 的完整细节。
 *
 * 打开时加载 run 详情（getAgentRun），提供五个标签页：
 *   overview - 流水线时间线 + 评级摘要 + 失败信息
 *   evidence - 按角色（fundamental/news/technical/macro）分组的证据
 *   debate   - 多空论点与批评者质询记录
 *   risk     - 风控闸门规则结果表
 *   rating   - 最终评级、催化剂、风险与不确定性
 *
 * 当 run 处于 'awaiting_human' 时，底部显示 human-in-the-loop（HITL）操作条，
 * 可批准、修改或驳回评级；批准/修改会经 submitHumanDecision 把评级
 * 同步回持仓与分析日志。上游数据来自 `@/api`；下游复用本目录的
 * RatingBadge / ConfidenceBadge / RunProgressBar / RiskAlertBadge 与
 * getPipelineStepState。
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Check,
  Clock,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  ShieldAlert,
  FileText,
  Newspaper,
  BarChart3,
  Globe,
  Target,
  Zap,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { getAgentRun, submitHumanDecision, logger } from '@/api';
import { displayCompanyName } from '@/utils/company-name';
import { getPipelineStepState } from './pipeline-step-state';
import RatingBadge from './RatingBadge';
import ConfidenceBadge from './ConfidenceBadge';
import RunProgressBar from './RunProgressBar';
import RiskAlertBadge from './RiskAlertBadge';
import type {
  AgentRunDetail,
  AgentRunStatus,
  EvidenceRole,
  AgentRating,
  AgentConfidence,
  BullBearArgument,
  DebateRecord,
  RiskGateResult,
} from '@shared/api.interface';

interface AgentRunDetailModalProps {
  /** 弹窗是否打开 */
  open: boolean;
  /** Dialog 回调：请求开/关状态变化 */
  onOpenChange: (open: boolean) => void;
  /** 要检视的 run id；关闭/加载中为 null */
  runId: string | null;
}

/** 各 AgentRunStatus 对应的 i18n 文案 key。 */
const statusLabelKeys: Record<AgentRunStatus, string> = {
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

/** 各证据角色对应的 i18n 文案 key。 */
const roleLabelKeys: Record<EvidenceRole, string> = {
  fundamental: 'ui.agent.evidenceRoleFundamental',
  news: 'ui.agent.evidenceRoleNews',
  technical: 'ui.agent.evidenceRoleTechnical',
  macro: 'ui.agent.evidenceRoleMacro',
};

/** 每个证据类别的 Lucide 图标，用作区块标题图标 */
const roleIcons: Record<EvidenceRole, typeof FileText> = {
  fundamental: FileText,
  news: Newspaper,
  technical: BarChart3,
  macro: Globe,
};

/** overview 时间线中按序展示的流水线阶段（含各自图标） */
const pipelineSteps = [
  { key: 'fetching', labelKey: 'ui.agent.stepEvidence', icon: FileText },
  { key: 'debating', labelKey: 'ui.agent.debate', icon: TrendingUp },
  { key: 'critiquing', labelKey: 'ui.agent.criticChallenge', icon: AlertCircle },
  { key: 'risk_check', labelKey: 'ui.agent.riskCheck', icon: ShieldAlert },
  { key: 'completed', labelKey: 'ui.agent.finalRating', icon: Target },
] as const;

/**
 * Dialog 主体：加载 run 详情、渲染标签页视图，并承载人工决策（HITL）流程。
 * 渲染内容按 loading/error/数据三种状态分支。
 */
function AgentRunDetailModal({ open, onOpenChange, runId }: AgentRunDetailModalProps) {
  const { t, i18n } = useTranslation();
  const [run, setRun] = useState<AgentRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('overview');
  // 当前展示的 HITL 控制面板：none | 修改表单打开
  const [decisionMode, setDecisionMode] = useState<'none' | 'approve' | 'modify' | 'reject'>(
    'none',
  );
  const [submitting, setSubmitting] = useState(false);

  // 修改表单的状态
  const [modifyRating, setModifyRating] = useState<AgentRating>('Hold');
  const [modifyConfidence, setModifyConfidence] = useState<AgentConfidence>('medium');
  const [modifyTargetPrice, setModifyTargetPrice] = useState('');
  const [modifyAction, setModifyAction] = useState('');
  const [modifyNote, setModifyNote] = useState('');

  /** 加载 run 详情，并按已有评级预填修改表单字段 */
  const loadRun = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        const data: AgentRunDetail = await getAgentRun(id);
        setRun(data);
        if (data.rating) {
          setModifyRating(data.rating.rating);
          setModifyConfidence(data.rating.confidence);
          setModifyTargetPrice(data.rating.targetPrice || '');
          setModifyAction(data.rating.action);
        }
      } catch (err) {
        logger.error('加载 run 详情失败', err);
        setError(t('ui.agent.loadFailed'));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  // 弹窗带着 runId 打开时（重新）加载；关闭时重置标签页/决策状态并清空数据。
  // 注意：本弹窗每次打开只加载一次；进行中 run 的实时更新由父级 run 列表驱动。
  useEffect(() => {
    if (open && runId) {
      loadRun(runId);
      setActiveTab('overview');
      setDecisionMode('none');
    } else {
      setRun(null);
      setError(null);
    }
  }, [open, runId, loadRun]);

  /**
   * 提交 awaiting_human run 的人工决策。'modified' 携带编辑后的评级字段；
   * 'approved'/'modified' 同时置位 applyToHoldings + syncToAnalysis，
   * 使评级同步传播到持仓组合。
   */
  const handleSubmitDecision = async (decision: 'approved' | 'modified' | 'rejected') => {
    if (!runId || !run) return;
    setSubmitting(true);
    // 组装决策载荷：决策类型 + 可选备注；"修改"时附带编辑后的评级字段。
    try {
      const payload: {
        decision: string;
        note?: string;
        modifiedRating?: Record<string, unknown>;
        applyToHoldings?: boolean;
        syncToAnalysis?: boolean;
      } = {
        decision,
        note: modifyNote || undefined,
      };

      if (decision === 'modified') {
        payload.modifiedRating = {
          rating: modifyRating,
          confidence: modifyConfidence,
          targetPrice: modifyTargetPrice ? Number(modifyTargetPrice) : undefined,
          action: modifyAction,
        };
      }

      // 批准/修改都要把评级落到持仓与分析日志。
      if (decision === 'approved' || decision === 'modified') {
        payload.applyToHoldings = true;
        payload.syncToAnalysis = true;
      }

      await submitHumanDecision(runId, payload);

      if (decision === 'approved') {
        toast.success(t('ui.agent.ratingSynced'));
      } else if (decision === 'modified') {
        toast.success(t('ui.agent.modifiedRatingSynced'));
      } else {
        toast.info(t('ui.agent.ratingRejected'));
      }

      // 成功后收起操作面板、重载详情，使本地状态与后端一致。
      setDecisionMode('none');
      await loadRun(runId);
    } catch (err) {
      logger.error('提交决策失败', err);
      toast.error(t('ui.agent.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // 按角色给证据条目分组，供 Evidence 标签页的手风琴展示
  const evidenceByRole = run
    ? run.evidence.reduce<Record<EvidenceRole, typeof run.evidence>>(
        (acc, item) => {
          if (!acc[item.role]) acc[item.role] = [];
          acc[item.role].push(item);
          return acc;
        },
        {} as Record<EvidenceRole, typeof run.evidence>,
      )
    : ({} as Record<EvidenceRole, typeof run.evidence>);

  // 把辩论拆成多/空两侧，并单独抽出批评者质询记录
  const bullArguments = run?.arguments.filter((a: BullBearArgument) => a.side === 'bull') || [];
  const bearArguments = run?.arguments.filter((a: BullBearArgument) => a.side === 'bear') || [];
  const criticRecords = run?.debate.filter((d: DebateRecord) => d.speaker === 'critic') || [];
  const companyName = run ? displayCompanyName(run.tickerName, run.ticker, i18n.language) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="flex items-center gap-3">
            {loading ? (
              <Skeleton className="h-7 w-48" />
            ) : run ? (
              <>
                <span className="text-xl font-bold">{run.ticker}</span>
                {companyName && (
                  <span className="text-base font-normal text-muted-foreground">{companyName}</span>
                )}
                <Badge
                  variant="outline"
                  className={
                    run.status === 'failed'
                      ? 'border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-400'
                      : run.status === 'awaiting_human'
                        ? 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400'
                        : run.status === 'completed'
                          ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                          : 'border-primary/40 bg-primary/15 text-primary'
                  }
                >
                  {t(statusLabelKeys[run.status])}
                </Badge>
              </>
            ) : null}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="p-8 flex flex-col items-center justify-center text-center">
              <AlertCircle className="h-10 w-10 text-rose-500 mb-3" />
              <p className="text-rose-600 dark:text-rose-400 font-medium">{error}</p>
              <Button variant="outline" className="mt-4" onClick={() => runId && loadRun(runId)}>
                {t('ui.analysis.retry')}
              </Button>
            </div>
          )}

          {loading && !run && <DetailSkeleton />}

          {run && !error && (
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <div className="px-6 pt-4 border-b">
                <TabsList className="mb-0">
                  <TabsTrigger value="overview">{t('ui.agent.overview')}</TabsTrigger>
                  <TabsTrigger value="evidence">{t('ui.agent.evidenceChain')}</TabsTrigger>
                  <TabsTrigger value="debate">{t('ui.agent.debate')}</TabsTrigger>
                  <TabsTrigger value="risk">{t('ui.agent.riskCheck')}</TabsTrigger>
                  <TabsTrigger value="rating">{t('ui.agent.finalRating')}</TabsTrigger>
                </TabsList>
              </div>

              <div className="p-6">
                {/* Overview 标签页 */}
                <TabsContent value="overview" className="mt-0 space-y-6">
                  {/* 摘要条 */}
                  {run.rating && (
                    <div className="flex flex-wrap items-center gap-3">
                      <RatingBadge rating={run.rating.rating} />
                      <ConfidenceBadge confidence={run.rating.confidence} />
                      <Badge variant="secondary">{run.rating.action}</Badge>
                      {run.rating.targetPrice && (
                        <Badge variant="outline">
                          {t('ui.agent.targetPrice')} ${run.rating.targetPrice}
                        </Badge>
                      )}
                      {run.riskGate.length > 0 && <RiskAlertBadge results={run.riskGate} />}
                    </div>
                  )}

                  {/* 流水线时间线 */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base font-semibold">
                        {t('ui.agent.pipelineProgress')}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="relative pl-2">
                        {pipelineSteps.map((step, idx) => {
                          const state = getPipelineStepState(step.key, run);
                          const StepIcon = step.icon;
                          return (
                            <div key={step.key} className="relative flex gap-4 pb-6 last:pb-0">
                              {/* 纵向连接线 */}
                              {idx < pipelineSteps.length - 1 && (
                                <div
                                  className={[
                                    'absolute left-[15px] top-8 bottom-0 w-0.5',
                                    state === 'done'
                                      ? 'bg-emerald-500'
                                      : 'bg-slate-200 dark:bg-slate-700',
                                  ].join(' ')}
                                />
                              )}
                              {/* 圆点 / 图标 */}
                              <div
                                className={[
                                  'relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2',
                                  state === 'done'
                                    ? 'border-emerald-500 bg-emerald-500 text-white'
                                    : state === 'active'
                                      ? 'border-primary bg-primary text-primary-foreground animate-pulse'
                                      : 'border-slate-300 bg-white text-slate-400 dark:border-slate-600 dark:bg-slate-800',
                                ].join(' ')}
                              >
                                {state === 'done' ? (
                                  <Check size={14} strokeWidth={3} />
                                ) : (
                                  <StepIcon size={14} />
                                )}
                              </div>
                              <div className="pt-1">
                                <div className="font-medium text-sm">{t(step.labelKey)}</div>
                                <div className="text-xs text-muted-foreground">
                                  {state === 'done'
                                    ? t('ui.agent.stepDone')
                                    : state === 'active'
                                      ? t('ui.agent.stepInProgress')
                                      : state === 'skipped' || state === 'partial'
                                        ? t(`analysisFlow.stepStatus.${state}`)
                                        : t('ui.agent.stepPending')}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>

                  {/* 评级摘要卡片 */}
                  {run.rating && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base font-semibold">
                          {t('ui.agent.ratingSummary')}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="flex items-center gap-3 flex-wrap">
                          <RatingBadge rating={run.rating.rating} />
                          <ConfidenceBadge confidence={run.rating.confidence} />
                        </div>
                        {run.rating.bullSummary && (
                          <div className="flex items-start gap-2 text-sm">
                            <TrendingUp size={16} className="mt-0.5 shrink-0 text-emerald-500" />
                            <span className="text-emerald-700 dark:text-emerald-400">
                              {run.rating.bullSummary}
                            </span>
                          </div>
                        )}
                        {run.rating.bearSummary && (
                          <div className="flex items-start gap-2 text-sm">
                            <TrendingDown size={16} className="mt-0.5 shrink-0 text-rose-500" />
                            <span className="text-rose-700 dark:text-rose-400">
                              {run.rating.bearSummary}
                            </span>
                          </div>
                        )}
                        {run.rating.aggregationLogic && (
                          <div className="text-sm text-muted-foreground">
                            <span className="font-medium text-foreground">
                              {t('ui.agent.aggregationLabel')}
                            </span>
                            {run.rating.aggregationLogic}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {/* 失败错误信息 */}
                  {run.status === 'failed' && run.errorMessage && (
                    <Card className="border-rose-500/50 bg-rose-500/5">
                      <CardHeader>
                        <CardTitle className="text-base font-semibold text-rose-700 dark:text-rose-400 flex items-center gap-2">
                          <XCircle size={16} />
                          {t('ui.agent.runFailedLabel')}
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-rose-600 dark:text-rose-400">
                          {run.errorMessage}
                        </p>
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>

                {/* Evidence 标签页 */}
                <TabsContent value="evidence" className="mt-0 space-y-4">
                  {(Object.keys(evidenceByRole) as EvidenceRole[]).length === 0 && (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      {t('ui.agent.noEvidence')}
                    </div>
                  )}
                  {(Object.keys(evidenceByRole) as EvidenceRole[]).map((role) => {
                    const RoleIcon = roleIcons[role];
                    const items = evidenceByRole[role];
                    return (
                      <Card key={role}>
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm font-semibold flex items-center gap-2">
                            <RoleIcon size={16} />
                            {t(roleLabelKeys[role])}
                            <Badge variant="outline" className="ml-auto text-xs">
                              {t('ui.agent.itemCount', { count: items.length })}
                            </Badge>
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="pt-0">
                          <Accordion type="multiple" className="w-full">
                            {items.map((item) => (
                              <AccordionItem key={item.id} value={item.id}>
                                <AccordionTrigger className="py-3">
                                  <div className="flex-1 pr-4">
                                    <div className="font-medium text-sm">{item.title}</div>
                                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                                      {item.sourceName && <span>{item.sourceName}</span>}
                                      <span>
                                        {new Date(item.fetchedAt).toLocaleString(i18n.language, {
                                          month: 'short',
                                          day: 'numeric',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </span>
                                      {item.relevanceScore !== null &&
                                        item.relevanceScore !== undefined && (
                                          <span className="text-primary">
                                            {t('ui.agent.relevance')}{' '}
                                            {Number(item.relevanceScore).toFixed(2)}
                                          </span>
                                        )}
                                    </div>
                                  </div>
                                </AccordionTrigger>
                                <AccordionContent>
                                  <div className="text-sm text-muted-foreground whitespace-pre-wrap bg-muted/50 rounded-md p-3 border">
                                    {item.content}
                                  </div>
                                </AccordionContent>
                              </AccordionItem>
                            ))}
                          </Accordion>
                        </CardContent>
                      </Card>
                    );
                  })}
                </TabsContent>

                {/* Debate 标签页 */}
                <TabsContent value="debate" className="mt-0 space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    {/* 多头栏 */}
                    <Card className="border-emerald-500/30 bg-emerald-500/[0.03]">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                          <TrendingUp size={16} />
                          {t('ui.agent.bullArguments')}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {bullArguments.length === 0 && (
                          <p className="text-sm text-muted-foreground">
                            {t('ui.agent.noBullArguments')}
                          </p>
                        )}
                        {bullArguments.map((arg: BullBearArgument, idx: number) => (
                          <div
                            key={arg.id}
                            className="rounded-md border border-emerald-500/20 bg-white dark:bg-slate-900 p-3 text-sm"
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                                {t('ui.agent.roundArgument', { round: arg.round, index: idx + 1 })}
                              </span>
                              {arg.evidenceIds.length > 0 && (
                                <span className="text-xs text-muted-foreground">
                                  {t('ui.agent.referencedEvidence', {
                                    count: arg.evidenceIds.length,
                                  })}
                                </span>
                              )}
                            </div>
                            <p className="text-foreground/90">{arg.argument}</p>
                          </div>
                        ))}
                      </CardContent>
                    </Card>

                    {/* 空头栏 */}
                    <Card className="border-rose-500/30 bg-rose-500/[0.03]">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-semibold text-rose-700 dark:text-rose-400 flex items-center gap-2">
                          <TrendingDown size={16} />
                          {t('ui.agent.bearArguments')}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {bearArguments.length === 0 && (
                          <p className="text-sm text-muted-foreground">
                            {t('ui.agent.noBearArguments')}
                          </p>
                        )}
                        {bearArguments.map((arg: BullBearArgument, idx: number) => (
                          <div
                            key={arg.id}
                            className="rounded-md border border-rose-500/20 bg-white dark:bg-slate-900 p-3 text-sm"
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-xs font-medium text-rose-600 dark:text-rose-400">
                                {t('ui.agent.roundArgument', { round: arg.round, index: idx + 1 })}
                              </span>
                              {arg.evidenceIds.length > 0 && (
                                <span className="text-xs text-muted-foreground">
                                  {t('ui.agent.referencedEvidence', {
                                    count: arg.evidenceIds.length,
                                  })}
                                </span>
                              )}
                            </div>
                            <p className="text-foreground/90">{arg.argument}</p>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  </div>

                  {/* 批评者质询区 */}
                  {criticRecords.length > 0 && (
                    <Card className="border-amber-500/30 bg-amber-500/[0.03]">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-2">
                          <AlertCircle size={16} />
                          {t('ui.agent.criticChallenge')}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {criticRecords.map((record: DebateRecord) => (
                          <div
                            key={record.id}
                            className="rounded-md border border-amber-500/20 bg-white dark:bg-slate-900 p-3 text-sm"
                          >
                            <div className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-1.5">
                              {t('ui.agent.round', { round: record.round })}
                            </div>
                            <p className="text-foreground/90 whitespace-pre-wrap">
                              {record.content}
                            </p>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>

                {/* Risk 标签页 */}
                <TabsContent value="risk" className="mt-0">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base font-semibold flex items-center gap-2">
                        <ShieldAlert size={16} />
                        {t('ui.agent.riskResults')}
                        {run.riskGate.length > 0 && <RiskAlertBadge results={run.riskGate} />}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0">
                      {run.riskGate.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground text-sm">
                          {t('ui.agent.noRiskData')}
                        </div>
                      ) : (
                        <div className="rounded-md border overflow-hidden">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-[180px]">
                                  {t('ui.agent.ruleName')}
                                </TableHead>
                                <TableHead className="w-[80px]">{t('ui.agent.type')}</TableHead>
                                <TableHead className="w-[100px]">
                                  {t('ui.agent.currentValue')}
                                </TableHead>
                                <TableHead className="w-[100px]">
                                  {t('ui.agent.threshold')}
                                </TableHead>
                                <TableHead className="w-[80px]">{t('ui.agent.status')}</TableHead>
                                <TableHead>{t('ui.agent.suggestedAction')}</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {run.riskGate.map((result: RiskGateResult) => (
                                <TableRow key={result.id}>
                                  <TableCell className="font-medium text-sm">
                                    {result.ruleName}
                                  </TableCell>
                                  <TableCell>
                                    <Badge
                                      variant="outline"
                                      className={
                                        result.ruleType === 'hard'
                                          ? 'border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs'
                                          : 'border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs'
                                      }
                                    >
                                      {result.ruleType === 'hard'
                                        ? t('ui.agent.hardRule')
                                        : t('ui.agent.softRule')}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="text-sm">
                                    {result.currentValue ?? '-'}
                                  </TableCell>
                                  <TableCell className="text-sm">
                                    {result.thresholdValue ?? '-'}
                                  </TableCell>
                                  <TableCell>
                                    {result.passed ? (
                                      <Badge
                                        variant="outline"
                                        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 gap-1 text-xs"
                                      >
                                        <CheckCircle2 size={12} />
                                        {t('ui.agent.passed')}
                                      </Badge>
                                    ) : (
                                      <Badge
                                        variant="outline"
                                        className="border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400 gap-1 text-xs"
                                      >
                                        <XCircle size={12} />
                                        {t('ui.agent.failedStatus')}
                                      </Badge>
                                    )}
                                  </TableCell>
                                  <TableCell className="text-sm text-muted-foreground">
                                    {result.suggestedAction ?? '-'}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                {/* Rating 标签页 */}
                <TabsContent value="rating" className="mt-0 space-y-4">
                  {run.rating ? (
                    <>
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base font-semibold">
                            {t('ui.agent.ratingResult')}
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="flex flex-wrap items-center gap-3">
                            <RatingBadge rating={run.rating.rating} />
                            <ConfidenceBadge confidence={run.rating.confidence} />
                            <Badge variant="secondary">
                              {t('ui.agent.actionLabel', { action: run.rating.action })}
                            </Badge>
                            {run.rating.targetPrice && (
                              <Badge variant="outline">
                                {t('ui.agent.targetPrice')} ${run.rating.targetPrice}
                              </Badge>
                            )}
                          </div>

                          {run.rating.aggregationLogic && (
                            <div className="space-y-1">
                              <div className="text-sm font-medium">
                                {t('ui.agent.aggregationLogic')}
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {run.rating.aggregationLogic}
                              </p>
                            </div>
                          )}

                          {run.rating.keyUncertainty && (
                            <div className="space-y-1">
                              <div className="text-sm font-medium flex items-center gap-1.5">
                                <AlertTriangle size={14} className="text-amber-500" />
                                {t('ui.agent.mainUncertainty')}
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {run.rating.keyUncertainty}
                              </p>
                            </div>
                          )}
                        </CardContent>
                      </Card>

                      {run.rating.catalysts && (
                        <Card className="border-emerald-500/30">
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                              <Zap size={16} />
                              {t('ui.agent.catalysts')}
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            <p className="text-sm whitespace-pre-wrap">{run.rating.catalysts}</p>
                          </CardContent>
                        </Card>
                      )}

                      {run.rating.risks && (
                        <Card className="border-rose-500/30">
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-semibold text-rose-700 dark:text-rose-400 flex items-center gap-2">
                              <AlertTriangle size={16} />
                              {t('ui.agent.risks')}
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            <p className="text-sm whitespace-pre-wrap">{run.rating.risks}</p>
                          </CardContent>
                        </Card>
                      )}
                    </>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      {t('ui.agent.noRating')}
                    </div>
                  )}
                </TabsContent>
              </div>
            </Tabs>
          )}
        </div>

        {/* HITL 操作条 */}
        {run && run.status === 'awaiting_human' && (
          <div className="border-t bg-amber-500/5 px-6 py-4">
            {decisionMode === 'none' && (
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2 text-sm">
                  <Clock size={16} className="text-amber-500" />
                  <span className="font-medium text-amber-700 dark:text-amber-400">
                    {t('ui.agent.awaitingDecision')}
                  </span>
                  <span className="text-muted-foreground">{t('analysisFlow.reviewPrompt')}</span>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="border-rose-500/40 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
                    onClick={() => handleSubmitDecision('rejected')}
                    disabled={submitting}
                  >
                    <XCircle className="mr-1.5 h-4 w-4" />
                    {t('ui.agent.reject')}
                  </Button>
                  <Button
                    variant="outline"
                    className="border-amber-500/40 text-amber-600 hover:bg-amber-500/10 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-400"
                    onClick={() => setDecisionMode('modify')}
                    disabled={submitting}
                  >
                    <AlertTriangle className="mr-1.5 h-4 w-4" />
                    {t('ui.agent.modify')}
                  </Button>
                  <Button
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => handleSubmitDecision('approved')}
                    disabled={submitting}
                  >
                    <CheckCircle2 className="mr-1.5 h-4 w-4" />
                    {t('ui.agent.approve')}
                  </Button>
                </div>
              </div>
            )}

            {decisionMode === 'modify' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm">
                  <AlertTriangle size={16} className="text-amber-500" />
                  <span className="font-medium text-amber-700 dark:text-amber-400">
                    {t('ui.agent.modifyRating')}
                  </span>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>{t('ui.agent.rating')}</Label>
                    <Select
                      value={modifyRating}
                      onValueChange={(v) => setModifyRating(v as AgentRating)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Strong Buy">Strong Buy</SelectItem>
                        <SelectItem value="Buy">Buy</SelectItem>
                        <SelectItem value="Hold">Hold</SelectItem>
                        <SelectItem value="Sell">Sell</SelectItem>
                        <SelectItem value="Strong Sell">Strong Sell</SelectItem>
                        <SelectItem value="Watch">Watch</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('ui.agent.confidence')}</Label>
                    <Select
                      value={modifyConfidence}
                      onValueChange={(v) => setModifyConfidence(v as AgentConfidence)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="high">{t('ui.agent.confidenceHigh')}</SelectItem>
                        <SelectItem value="medium">{t('ui.agent.confidenceMedium')}</SelectItem>
                        <SelectItem value="low">{t('ui.agent.confidenceLow')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('ui.agent.targetPrice')}</Label>
                    <Input
                      type="number"
                      value={modifyTargetPrice}
                      onChange={(e) => setModifyTargetPrice(e.target.value)}
                      placeholder={t('ui.agent.targetPricePlaceholder')}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('ui.analysis.actionAdvice')}</Label>
                    <Input
                      value={modifyAction}
                      onChange={(e) => setModifyAction(e.target.value)}
                      placeholder={t('ui.agent.actionPlaceholder')}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>{t('ui.agent.note')}</Label>
                  <Textarea
                    value={modifyNote}
                    onChange={(e) => setModifyNote(e.target.value)}
                    placeholder={t('ui.agent.notePlaceholder')}
                    rows={3}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setDecisionMode('none')}
                    disabled={submitting}
                  >
                    {t('ui.agent.cancel')}
                  </Button>
                  <Button onClick={() => handleSubmitDecision('modified')} disabled={submitting}>
                    {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('ui.agent.submitModification')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 加载占位骨架：布局镜像弹窗的流水线时间线 */
function DetailSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex gap-3">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-16" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
        </CardHeader>
        <CardContent className="space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex gap-4">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="space-y-2 flex-1">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export default AgentRunDetailModal;
