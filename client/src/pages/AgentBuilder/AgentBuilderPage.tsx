/**
 * AgentBuilderPage.tsx — 智能体构建器页面：配置档案管理 + 提案收件箱 + 实盘成交补录。
 *
 * 职责边界：
 *  - 顶部 hero（护栏/模拟盘/手动确认三说明 pill）+ 打开向导入口；
 *  - "你的智能体"区：档案卡片列表（策略摘要、价格规则徽标、激活/暂停/立即运行/编辑）；
 *  - 提案收件箱：pending 提案卡片（跳过/记录实盘成交）与最近历史；
 *  - 实盘成交补录弹窗（与模拟盘记录分离，仅人工补录真实成交）；
 *  - 兼容旧入口：?tab=budget 重定向到新的预算页。
 * 上下游：
 *  - 上游（路由入口/谁引用）：app.tsx 路由 /agent-builder。
 *  - 下游（调用哪些 hooks/api/组件）：useQuery/useMutation/useQueryClient；@/api/builder 七个函数；
 *    errorMessage（本目录公共错误转文案）；BuilderWizard；@/utils/council-state 的 DEFAULT_CADENCE；
 *    toast；Badge/Button/Card/Dialog/Input/Label/Textarea。
 * 关键约定：
 *  - 提案列表 60 秒轮询（refetchInterval）；档案列表不轮询，各 mutation 成功后 invalidate ['builder']。
 *  - 同一时刻至多一个 active 档案（服务端保证）；激活/暂停/运行期间 busy 禁用相关按钮。
 *  - 成交补录校验：数量/价格 > 0、费用 >= 0、执行时间有效且不晚于当前时间 + 5 分钟容差。
 *  - 向导以 key={editing?.id ?? 'new'} 挂载，切换编辑对象时强制重建表单初值。
 */
import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight,
  Bell,
  Bot,
  CirclePause,
  ClipboardCheck,
  FlaskConical,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
} from 'lucide-react';

import {
  activateBuilderProfile,
  fetchBuilderProfiles,
  fetchBuilderProposals,
  fillBuilderProposal,
  pauseBuilderProfile,
  runBuilderProfile,
  skipBuilderProposal,
  type BuilderProfile,
  type BuilderProposal,
  type BuilderRunResult,
} from '@/api/builder';
import type { RecordBuilderFillDto } from '@shared/api.interface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import BuilderWizard from './BuilderWizard';
import { errorMessage } from './errorMessage';
import { DEFAULT_CADENCE } from '@/utils/council-state';

/** 当前本地时间格式化为 datetime-local 输入需要的 "YYYY-MM-DDTHH:mm"（先减去时区偏移再截断）。 */
function localDateTimeNow(): string {
  const now: Date = new Date();
  const local: Date = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

// 实盘成交补录表单：全部以字符串承载输入，提交前统一转数字
interface FillForm {
  executedAt: string;
  quantity: string;
  price: string;
  fees: string;
  notes: string;
}

// 空白补录表单：执行时间默认当前本地时间，费用默认 '0'
const EMPTY_FILL: FillForm = {
  executedAt: localDateTimeNow(),
  quantity: '',
  price: '',
  fees: '0',
  notes: '',
};

export default function AgentBuilderPage() {
  // —— 状态声明区 ——
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  // 向导开关与当前编辑对象（null=新建）；selected=补录弹窗目标提案
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<BuilderProfile | null>(null);
  const [selected, setSelected] = useState<BuilderProposal | null>(null);
  const [fill, setFill] = useState<FillForm>(EMPTY_FILL);
  const [fillError, setFillError] = useState<string | null>(null);

  // —— 数据获取区 ——
  // 档案列表：不轮询；提案列表：60 秒轮询（收件箱保持新鲜）
  const profilesQuery = useQuery<BuilderProfile[]>({
    queryKey: ['builder', 'profiles'],
    queryFn: fetchBuilderProfiles,
  });
  const proposalsQuery = useQuery<BuilderProposal[]>({
    queryKey: ['builder', 'proposals'],
    queryFn: fetchBuilderProposals,
    refetchInterval: 60_000,
  });
  // 统一刷新：任何 mutation 成功后失效整个 ['builder'] 前缀
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['builder'] });

  // 激活档案：成功刷新并提示；同一时刻仅一个 active
  const activateMutation = useMutation<BuilderProfile, Error, string>({
    mutationFn: activateBuilderProfile,
    onSuccess: () => {
      void refresh();
      toast.success(t('ui.builder.activated'));
    },
    onError: (error: Error) => toast.error(errorMessage(error, t('ui.builder.activateFailed'))),
    retry: false,
  });
  // 暂停档案
  const pauseMutation = useMutation<BuilderProfile, Error, string>({
    mutationFn: pauseBuilderProfile,
    onSuccess: () => {
      void refresh();
      toast.success(t('ui.builder.paused'));
    },
    onError: (error: Error) => toast.error(errorMessage(error, t('ui.builder.actionFailed'))),
    retry: false,
  });
  // 立即运行：扫描并按信号下单；placed===0 时用 info 提示（无信号不算失败）
  const runMutation = useMutation<BuilderRunResult, Error, string>({
    mutationFn: runBuilderProfile,
    onSuccess: (result: BuilderRunResult) => {
      void refresh();
      const summary: string = t('ui.builder.runSummary', {
        scanned: result.scanned,
        placed: result.placed,
        rejected: result.rejected,
      });
      if (result.placed === 0) {
        toast.info(summary, { description: t('ui.builder.noSignalsHint') });
      } else {
        toast.success(summary);
      }
    },
    onError: (error: Error) => toast.error(errorMessage(error, t('ui.builder.runFailed'))),
    retry: false,
  });
  // 跳过提案
  const skipMutation = useMutation<BuilderProposal, Error, string>({
    mutationFn: skipBuilderProposal,
    onSuccess: () => {
      void refresh();
      toast.success(t('ui.builder.skipped'));
    },
    onError: (error: Error) => toast.error(errorMessage(error, t('ui.builder.actionFailed'))),
    retry: false,
  });
  // 补录实盘成交：成功关弹窗并刷新
  const fillMutation = useMutation<
    BuilderProposal,
    Error,
    { id: string; fill: RecordBuilderFillDto }
  >({
    mutationFn: ({ id, fill: request }) => fillBuilderProposal(id, request),
    onSuccess: () => {
      setSelected(null);
      void refresh();
      toast.success(t('ui.builder.fillRecorded'));
    },
    onError: (error: Error) => toast.error(errorMessage(error, t('ui.builder.actionFailed'))),
    retry: false,
  });

  // —— 派生计算区 ——
  // 列表兜底：查询未返回时按空数组处理
  const profiles: BuilderProfile[] = profilesQuery.data ?? [];
  const proposals: BuilderProposal[] = proposalsQuery.data ?? [];
  // 当前唯一激活的档案
  const active: BuilderProfile | undefined = profiles.find(
    (profile: BuilderProfile) => profile.status === 'active',
  );
  // pending=待处理提案；history=其余状态（已成交/已跳过/已过期）
  const pending: BuilderProposal[] = proposals.filter(
    (proposal: BuilderProposal) => proposal.status === 'pending',
  );
  const history: BuilderProposal[] = proposals.filter(
    (proposal: BuilderProposal) => proposal.status !== 'pending',
  );
  // 激活/暂停/运行任一进行中即视为忙（互斥操作期间禁用按钮）
  const busy = activateMutation.isPending || pauseMutation.isPending || runMutation.isPending;
  // 日期本地化：英文用 en-US，其余（中文）用 zh-CN
  const locale: string = i18n.language === 'en' ? 'en-US' : 'zh-CN';

  // 日期格式化：无效值原样返回（如服务端缺省字符串）
  const formatDate = (value: string): string => {
    const date: Date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
  };

  // —— 事件处理区 ——
  // 新建：先清掉 URL 上的 tab 等参数，再以 editing=null 打开向导
  const openNew = () => {
    setParams({}, { replace: true });
    setEditing(null);
    setWizardOpen(true);
  };
  // 编辑：同样清参数，以该档案打开向导（向导 key 变化强制重建初值）
  const openEdit = (profile: BuilderProfile) => {
    setParams({}, { replace: true });
    setEditing(profile);
    setWizardOpen(true);
  };
  // 打开补录弹窗：预填建议数量与参考价格，执行时间用当前本地时间
  const openFill = (proposal: BuilderProposal) => {
    setSelected(proposal);
    setFill({
      ...EMPTY_FILL,
      executedAt: localDateTimeNow(),
      quantity: proposal.quantity,
      price: proposal.referencePrice,
    });
    setFillError(null);
  };
  // 提交补录：数字/日期校验（数量价格 > 0、费用 >= 0、执行时间不晚于当前 + 5 分钟容差），
  // 通过后转 ISO 时间戳提交
  const submitFill = () => {
    if (!selected) return;
    const quantity: number = Number(fill.quantity);
    const price: number = Number(fill.price);
    const fees: number = Number(fill.fees);
    const date: Date = new Date(fill.executedAt);
    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(fees) ||
      fees < 0 ||
      Number.isNaN(date.getTime()) ||
      date.getTime() > Date.now() + 300_000
    ) {
      setFillError(t('ui.builder.fillInvalid'));
      return;
    }
    setFillError(null);
    fillMutation.mutate({
      id: selected.id,
      fill: {
        executedAt: date.toISOString(),
        quantity,
        price,
        fees,
        notes: fill.notes.trim(),
      },
    });
  };

  // —— 渲染区 ——
  // 什么时候走到这里：旧入口 /agent-builder?tab=budget——重定向到新预算页
  if (params.get('tab') === 'budget') return <Navigate to="/settings/budget" replace />;
  return (
    <div className="mx-auto max-w-6xl space-y-8 pb-12">
      {/* Hero：标题/简介 + 打开投委会/新建智能体 + 三条说明 pill */}
      <section className="relative overflow-hidden rounded-2xl border border-primary/20 bg-card p-6 md:p-8">
        <div className="absolute -right-12 -top-20 size-56 rounded-full bg-primary/5 blur-3xl" />
        <div className="relative flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary">
              <Bot className="size-4" /> {t('ui.builder.eyebrow')}
            </p>
            <h1 className="mt-3 font-serif text-3xl font-semibold tracking-tight md:text-4xl">
              {t('ui.builder.title')}
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground md:text-base">
              {t('ui.builder.intro')}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/council">
                <Users />
                {t('council.open')}
              </Link>
            </Button>
            {/* 什么时候走到这里：向导未打开才显示新建按钮（打开后由向导内操作收尾） */}
            {!wizardOpen && (
              <Button type="button" onClick={openNew} className="shrink-0">
                <Plus /> {t('ui.builder.createAgent')}
              </Button>
            )}
          </div>
        </div>
        <div className="relative mt-6 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-border bg-background px-3 py-1.5">
            {t('ui.builder.guardrailPill')}
          </span>
          <span className="rounded-full border border-border bg-background px-3 py-1.5">
            {t('ui.builder.paperPill')}
          </span>
          <span className="rounded-full border border-border bg-background px-3 py-1.5">
            {t('ui.builder.manualPill')}
          </span>
        </div>
      </section>

      {/* 什么时候走到这里：向导打开——新建（key='new'）或编辑（key=档案 id）模式 */}
      {wizardOpen && (
        <BuilderWizard
          key={editing?.id ?? 'new'}
          editing={editing}
          onSaved={() => void refresh()}
          onClose={() => setWizardOpen(false)}
        />
      )}

      {/* 档案区 */}
      <section className="space-y-4" aria-labelledby="builder-profiles-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="builder-profiles-title" className="font-serif text-2xl font-semibold">
              {t('ui.builder.yourAgents')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('ui.builder.oneActiveHint')}</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
            <RefreshCw /> {t('ui.builder.refresh')}
          </Button>
        </div>
        {profilesQuery.isLoading && (
          <p className="text-sm text-muted-foreground">{t('ui.builder.loading')}</p>
        )}
        {profilesQuery.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(profilesQuery.error, t('ui.builder.loadFailed'))}
          </p>
        )}
        {/* 什么时候走到这里：档案列表为空——空状态引导新建 */}
        {!profilesQuery.isLoading && !profilesQuery.isError && profiles.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <ShieldCheck className="size-8 text-muted-foreground" />
              <p className="font-medium">{t('ui.builder.noAgents')}</p>
              <p className="text-sm text-muted-foreground">{t('ui.builder.noAgentsHint')}</p>
              <Button type="button" variant="outline" onClick={openNew}>
                <Plus /> {t('ui.builder.createAgent')}
              </Button>
            </CardContent>
          </Card>
        )}
        {/* 档案卡片网格：active 卡片高亮描边 */}
        <div className="grid gap-4 md:grid-cols-2">
          {profiles.map((profile: BuilderProfile) => (
            <Card
              key={profile.id}
              className={profile.status === 'active' ? 'border-primary/50' : ''}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-lg">{profile.config.name}</CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(`ui.builder.template.${profile.config.template}.title`)} · v
                      {profile.version}
                    </p>
                  </div>
                  <Badge variant={profile.status === 'active' ? 'default' : 'secondary'}>
                    {t(`ui.builder.status.${profile.status}`)}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* 策略参数摘要：最低评级/单笔上限/每日笔数/标的池 */}
                <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted/40 p-3 text-xs">
                  <div>
                    <span className="text-muted-foreground">{t('ui.builder.minimumRating')}</span>
                    <p className="mt-1 font-semibold">
                      {t(
                        profile.config.minimumRating === 'Buy'
                          ? 'ui.builder.ratingBuy'
                          : 'ui.builder.ratingStrongBuy',
                      )}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('ui.builder.maxOrderPct')}</span>
                    <p className="mt-1 font-semibold">{profile.config.maxOrderPct}%</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('ui.builder.maxOrdersPerDay')}</span>
                    <p className="mt-1 font-semibold">{profile.config.maxOrdersPerDay}</p>
                  </div>
                  <div className="min-w-0">
                    <span className="text-muted-foreground">{t('ui.builder.tickers')}</span>
                    <p className="mt-1 truncate font-semibold">
                      {profile.config.tickers.length
                        ? profile.config.tickers.join(', ')
                        : t('ui.builder.allTracked')}
                    </p>
                  </div>
                </div>
                {/* 节奏与投委会模式摘要（cadence 缺省时回退默认值） */}
                <div className="rounded-lg border border-border p-3 text-xs leading-5 text-muted-foreground">
                  <p>
                    {t('council.cadence.summary', {
                      days:
                        profile.config.cadence?.reviewEveryTradingDays ??
                        DEFAULT_CADENCE.reviewEveryTradingDays,
                      orders:
                        profile.config.cadence?.maxOrdersPerWeek ??
                        DEFAULT_CADENCE.maxOrdersPerWeek,
                    })}
                  </p>
                  <p className="mt-1">
                    {t(
                      profile.config.council?.enabled
                        ? 'council.team.enabledHint'
                        : 'council.team.rulesOnly',
                    )}
                  </p>
                </div>
                {/* 什么时候走到这里：配置了个股价格规则——最多展示 4 条，其余折叠为计数徽标 */}
                {(profile.config.priceRules?.length ?? 0) > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t('ui.builder.priceRuleSummary')}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {profile.config.priceRules?.slice(0, 4).map((rule) => (
                        <Badge key={rule.ticker} variant="outline" className="font-normal">
                          {rule.ticker}
                          {rule.buyAtOrBelow !== undefined && ` · ≤${rule.buyAtOrBelow}`}
                          {rule.sellAtOrAbove !== undefined && ` · ≥${rule.sellAtOrAbove}`}
                        </Badge>
                      ))}
                      {(profile.config.priceRules?.length ?? 0) > 4 && (
                        <Badge variant="secondary">
                          {t('ui.builder.moreRules', {
                            count: (profile.config.priceRules?.length ?? 0) - 4,
                          })}
                        </Badge>
                      )}
                    </div>
                  </div>
                )}
                {/* 操作区：投委会/编辑 + （激活态：暂停/立即运行；否则：激活） */}
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/council?profileId=${encodeURIComponent(profile.id)}`}>
                      <Users />
                      {t('council.nav')}
                    </Link>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={profile.status === 'active'}
                    onClick={() => openEdit(profile)}
                  >
                    <Pencil /> {t('ui.builder.edit')}
                  </Button>
                  {profile.status === 'active' ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => pauseMutation.mutate(profile.id)}
                      >
                        <CirclePause /> {t('ui.builder.pause')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => runMutation.mutate(profile.id)}
                      >
                        {runMutation.isPending ? <Loader2 className="animate-spin" /> : <Play />}
                        {t('ui.builder.runNow')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => activateMutation.mutate(profile.id)}
                    >
                      <Play /> {t('ui.builder.activate')}
                    </Button>
                  )}
                </div>
                {/* 什么时候走到这里：该卡未激活且已有别的激活档案——提示切换需先暂停对方 */}
                {profile.status !== 'active' && active && (
                  <p className="text-xs text-muted-foreground">
                    {t('ui.builder.switchActiveHint', { name: active.config.name })}
                  </p>
                )}
                {/* 什么时候走到这里：该卡是激活档案——提示编辑前需先暂停 */}
                {profile.status === 'active' && (
                  <p className="text-xs text-muted-foreground">{t('ui.builder.pauseToEdit')}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* 提案收件箱区 */}
      <section className="space-y-4" aria-labelledby="builder-inbox-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              id="builder-inbox-title"
              className="flex items-center gap-2 font-serif text-2xl font-semibold"
            >
              <ClipboardCheck className="size-6 text-primary" /> {t('ui.builder.inbox')}
              {pending.length > 0 && <Badge>{pending.length}</Badge>}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('ui.builder.inboxHint')}</p>
          </div>
          <Link
            to="/paper"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            <FlaskConical className="size-4" /> {t('ui.builder.openPaper')}{' '}
            <ArrowRight className="size-4" />
          </Link>
        </div>
        {proposalsQuery.isLoading && (
          <p className="text-sm text-muted-foreground">{t('ui.builder.loading')}</p>
        )}
        {proposalsQuery.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(proposalsQuery.error, t('ui.builder.loadFailed'))}
          </p>
        )}
        {/* 什么时候走到这里：收件箱为空且无加载错误 */}
        {!proposalsQuery.isLoading && !proposalsQuery.isError && pending.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {t('ui.builder.emptyInbox')}
            </CardContent>
          </Card>
        )}
        {/* 待处理提案卡列表 */}
        <div className="space-y-3">
          {pending.map((proposal: BuilderProposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              profiles={profiles}
              formatDate={formatDate}
              onFill={() => openFill(proposal)}
              onSkip={() => skipMutation.mutate(proposal.id)}
              busy={skipMutation.isPending || fillMutation.isPending}
            />
          ))}
        </div>
        {/* 什么时候走到这里：有非 pending 历史——最近 10 条紧凑列表 */}
        {history.length > 0 && (
          <div className="space-y-2 pt-2">
            <h3 className="text-sm font-semibold">{t('ui.builder.recentHistory')}</h3>
            {history.slice(0, 10).map((proposal: BuilderProposal) => (
              <div
                key={proposal.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"
              >
                <span className="font-medium">
                  {proposal.ticker} · {t(`ui.builder.side.${proposal.side}`)}
                </span>
                <span className="text-muted-foreground">{formatDate(proposal.createdAt)}</span>
                <Badge variant="secondary">
                  {t(`ui.builder.proposalStatus.${proposal.status}`)}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 实盘成交补录弹窗：与模拟盘记录分离；选中提案时打开 */}
      <Dialog
        open={selected !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setSelected(null);
        }}
      >
        {selected && (
          <DialogContent showCloseButton={false} className="max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="font-serif text-xl">
                {t('ui.builder.recordFillTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('ui.builder.recordFillDescription', { ticker: selected.ticker })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <p className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
                {t('ui.builder.fillSeparationNotice')}
              </p>
              {/* 执行时间：datetime-local，默认当前本地时间 */}
              <div className="space-y-2">
                <Label htmlFor="builder-fill-date">{t('ui.builder.executedAt')}</Label>
                <Input
                  id="builder-fill-date"
                  type="datetime-local"
                  value={fill.executedAt}
                  onChange={(event) => setFill({ ...fill, executedAt: event.target.value })}
                />
              </div>
              {/* 数量/价格：默认预填提案建议值 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="builder-fill-quantity">{t('ui.builder.quantity')}</Label>
                  <Input
                    id="builder-fill-quantity"
                    type="number"
                    min="0.000001"
                    step="any"
                    value={fill.quantity}
                    onChange={(event) => setFill({ ...fill, quantity: event.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="builder-fill-price">{t('ui.builder.price')}</Label>
                  <Input
                    id="builder-fill-price"
                    type="number"
                    min="0.000001"
                    step="any"
                    value={fill.price}
                    onChange={(event) => setFill({ ...fill, price: event.target.value })}
                  />
                </div>
              </div>
              {/* 费用：默认 '0' */}
              <div className="space-y-2">
                <Label htmlFor="builder-fill-fees">{t('ui.builder.fees')}</Label>
                <Input
                  id="builder-fill-fees"
                  type="number"
                  min="0"
                  step="any"
                  value={fill.fees}
                  onChange={(event) => setFill({ ...fill, fees: event.target.value })}
                />
              </div>
              {/* 备注：最长 1000 字 */}
              <div className="space-y-2">
                <Label htmlFor="builder-fill-notes">{t('ui.builder.notes')}</Label>
                <Textarea
                  id="builder-fill-notes"
                  value={fill.notes}
                  maxLength={1000}
                  onChange={(event) => setFill({ ...fill, notes: event.target.value })}
                />
              </div>
              {/* 什么时候走到这里：补录校验失败——错误提示 */}
              {fillError && (
                <p role="alert" className="text-sm text-destructive">
                  {fillError}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setSelected(null)}>
                  {t('ui.builder.cancel')}
                </Button>
                <Button type="button" disabled={fillMutation.isPending} onClick={submitFill}>
                  {fillMutation.isPending && <Loader2 className="animate-spin" />}
                  {t('ui.builder.recordFill')}
                </Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

// 提案卡片入参：提案本身 + 档案列表（找来源智能体名）+ 格式化函数 + 跳过/补录回调 + 忙标志
interface ProposalCardProps {
  proposal: BuilderProposal;
  profiles: BuilderProfile[];
  formatDate: (value: string) => string;
  onFill: () => void;
  onSkip: () => void;
  busy: boolean;
}

/** 单条提案卡：来源/到期徽标、理由、建议数量与参考价、模拟盘关联、跳过/补录按钮。 */
function ProposalCard({ proposal, profiles, formatDate, onFill, onSkip, busy }: ProposalCardProps) {
  const { t } = useTranslation();
  // 反查提案来源档案（可能已被删除 → 未知智能体）
  const profile: BuilderProfile | undefined = profiles.find(
    (item: BuilderProfile) => item.id === proposal.profileId,
  );
  // 是否已过有效期（前端即时判定，用于禁用补录按钮）
  const expired: boolean = new Date(proposal.expiresAt).getTime() < Date.now();
  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {/* 标的行：买/卖徽标 + 代码 + 市场·币种 */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={proposal.side === 'buy' ? 'default' : 'secondary'}>
                {t(`ui.builder.side.${proposal.side}`)}
              </Badge>
              <span className="text-lg font-semibold">{proposal.ticker}</span>
              <span className="text-xs text-muted-foreground">
                {proposal.market} · {proposal.currency}
              </span>
            </div>
            {/* 来源行：智能体名（缺失回退"未知"）· 版本 · 创建时间 */}
            <p className="mt-2 break-words text-xs text-muted-foreground">
              {profile?.config.name ?? t('ui.builder.unknownAgent')} · v{proposal.profileVersion}
              {' · '}
              {formatDate(proposal.createdAt)}
            </p>
          </div>
          {/* 什么时候走到这里：提案已过有效期——红色过期徽标 */}
          {expired && <Badge variant="destructive">{t('ui.builder.expired')}</Badge>}
        </div>
        {/* 建议理由 */}
        <p className="break-words text-sm leading-6">{proposal.reason}</p>
        {/* 数值行：建议数量 / 参考价 / 到期时间 */}
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span>
            {t('ui.builder.suggestedQuantity')}:{' '}
            <strong className="text-foreground">{proposal.quantity}</strong>
          </span>
          <span>
            {t('ui.builder.referencePrice')}:{' '}
            <strong className="text-foreground">
              {proposal.referencePrice} {proposal.currency}
            </strong>
          </span>
          <span>
            {t('ui.builder.expires')}: {formatDate(proposal.expiresAt)}
          </span>
        </div>
        {/* 底部：模拟盘关联标识 + 跳过/补录按钮 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            {/* 什么时候走到这里：已关联模拟盘订单 → 烧瓶图标"已挂模拟盘"；否则铃铛"仅提案" */}
            {proposal.paperOrderId ? (
              <FlaskConical className="size-3.5" />
            ) : (
              <Bell className="size-3.5" />
            )}
            {proposal.paperOrderId ? t('ui.builder.paperLinked') : t('ui.builder.proposalOnly')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onSkip}>
              {t('ui.builder.skip')}
            </Button>
            {/* 补录：忙或已过期时禁用 */}
            <Button type="button" size="sm" disabled={busy || expired} onClick={onFill}>
              {t('ui.builder.recordRealFill')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
