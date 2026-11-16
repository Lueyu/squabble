/**
 * CouncilPage.tsx — 理事会主页面：会话头部/对话区/报告栏/历史/成员/新建弹窗的装配与编排。
 *
 * 职责边界：
 *  - 装配会话工作台：顶栏（历史/运行暂停/成员/报告/新建）、无模型横幅、
 *    对话区（四态：加载/错误/会话/欢迎空态）、桌面报告侧栏；
 *  - 三个抽屉/弹窗：历史会话 Sheet、报告 Sheet（移动端）、成员快照 Sheet、新建会话 Dialog；
 *  - "沿用该团队新建"入口：把当前会话成员拷贝为 newSeed，重挂 CouncilNewDialog。
 * 上下游：
 *  - 上游（路由入口/谁引用）：app.tsx 路由 /council。
 *  - 下游（调用哪些 hooks/api/组件）：useCouncilSessions/useCouncilSession/useCouncilActions；
 *    四路 useQuery（profiles/integrations/model-connections/local-agents）；
 *    AgentBuilder/errorMessage；CouncilConversation/CouncilNewDialog/CouncilReports/
 *    CouncilMembersSheet；createCouncilPreset。
 * 关键约定：
 *  - 选中会话由 URL 参数 session 决定（缺省取列表第一个）；历史列表当前会话用实时数据替换；
 *  - noModel 横幅：有成员逐个判连接可用（local 恒 false 不算缺模型），无成员则要求
 *    本地智能体、默认 LLM、任一模型连接三者皆不可用才提示；
 *  - newSeed.key 递增作 CouncilNewDialog 的 key，强制重挂以重置表单初始值；
 *  - create：创建成功后写 URL 参数并自动 run（失败仅 toast，不回滚创建）。
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CirclePause,
  FileText,
  History,
  Loader2,
  MessageCircle,
  Play,
  Plus,
  Users,
} from 'lucide-react';
import type { BuilderProfile } from '@shared/api.interface';
import type {
  CouncilConfig,
  CouncilSession,
  CreateCouncilSession,
} from '@shared/council.interface';
import { createCouncilPreset } from '@shared/council-templates';
import { fetchBuilderProfiles } from '@/api/builder';
import { fetchIntegrationSettings } from '@/api/settings';
import { fetchModelConnections } from '@/api/model-connections';
import { fetchLocalAgents } from '@/api/local-agents';
import { useCouncilActions, useCouncilSession, useCouncilSessions } from '@/hooks/use-council';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';
import CouncilConversation from './CouncilConversation';
import CouncilNewDialog from './CouncilNewDialog';
import CouncilReports from './CouncilReports';
import CouncilMembersSheet from './CouncilMembersSheet';

export default function CouncilPage() {
  const { t, i18n } = useTranslation();
  // === 状态声明区 ===
  // URL 参数（session/profileId/ticker）
  const [params, setParams] = useSearchParams();
  // 新建弹窗开闭（URL 带 profileId/ticker 时初始打开）/ 历史/报告/成员三个抽屉
  const [newOpen, setNewOpen] = useState(params.has('profileId') || params.has('ticker'));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  // 新建弹窗种子：key 递增触发重挂；携带预填 ticker 与"沿用团队"
  const [newSeed, setNewSeed] = useState<{ key: number; ticker: string; team?: CouncilConfig }>({
    key: 0,
    ticker: params.get('ticker') ?? '',
  });
  // === 数据获取区 ===
  // Builder 档案 / LLM 集成设置 / 模型连接 / 本地智能体
  const profilesQuery = useQuery({
    queryKey: ['builder', 'profiles'],
    queryFn: fetchBuilderProfiles,
  });
  const integrations = useQuery({
    queryKey: ['settings', 'integrations'],
    queryFn: fetchIntegrationSettings,
  });
  const connections = useQuery({
    queryKey: ['settings', 'model-connections'],
    queryFn: fetchModelConnections,
  });
  const localAgents = useQuery({
    queryKey: ['settings', 'local-agents'],
    queryFn: fetchLocalAgents,
  });
  // 会话列表 / 选中会话（URL 参数优先，缺省取第一个）/ 会话操作集合
  const sessionsQuery = useCouncilSessions();
  const selectedId = params.get('session') ?? sessionsQuery.data?.[0]?.id ?? null;
  const sessionQuery = useCouncilSession(selectedId);
  const actions = useCouncilActions();
  // === 派生计算区 ===
  const session = sessionQuery.data;
  const profiles = profilesQuery.data ?? [];
  const selectedProfile = profiles.find((item: BuilderProfile) => item.id === session?.profileId);
  // 默认 LLM 是否可用（集成可用且引擎非 basic）
  const defaultAvailable =
    integrations.data?.llm.available && integrations.data.llm.engine !== 'basic';
  // 是否"无可用模型"（决定顶部横幅）：有成员逐个判——local 成员不算缺模型，
  // 带连接的成员看连接可用性，不带连接的看默认 LLM；
  // 无成员时：本地智能体、默认 LLM、任一模型连接三者皆不可用才判缺
  const noModel =
    integrations.isSuccess &&
    connections.isSuccess &&
    (session?.members?.length
      ? session.members.every((member) =>
          member.executionMode === 'local'
            ? false
            : member.connectionId
              ? !connections.data.some(
                  (connection) => connection.id === member.connectionId && connection.available,
                )
              : !defaultAvailable,
        )
      : localAgents.isSuccess &&
        !localAgents.data.some((agent) => agent.available) &&
        !defaultAvailable &&
        !connections.data.some((connection) => connection.available));
  // 统一错误 toast
  const showError = (cause: unknown) => toast.error(errorMessage(cause, t('council.actionFailed')));

  // === 事件处理区 ===
  // 创建会话：成功后写 URL 参数、关弹窗并自动启动；启动失败仅 toast
  const create = async (request: CreateCouncilSession) => {
    const created = await actions.create.mutateAsync(request);
    setParams({ session: created.id });
    setNewOpen(false);
    try {
      await actions.run.mutateAsync(created.id);
    } catch (cause) {
      showError(cause);
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* === 渲染区：顶栏 === */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3 sm:px-5">
        {/* 历史会话入口 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label={t('council.sessions')}
              onClick={() => setHistoryOpen(true)}
            >
              <History className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('council.sessions')}</TooltipContent>
        </Tooltip>
        {/* 标题与状态行：运行中转圈，否则红/灰状态点 */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">
            {session?.ticker ?? t('council.title')}
          </h1>
          <p
            className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground"
            role="status"
          >
            {session?.status === 'running' ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
            ) : (
              <span
                className={`size-1.5 shrink-0 rounded-full ${session?.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground/60'}`}
              />
            )}
            <span className="truncate">
              {session ? t(`council.status.${session.status}`) : t('council.chatWelcome')}
              {selectedProfile && (
                <span className="hidden sm:inline"> · {selectedProfile.config.name}</span>
              )}
            </span>
          </p>
        </div>
        {/* 什么时候走到这里：有会话——运行中显示暂停，否则显示继续 */}
        {session && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                aria-label={t(session.status === 'running' ? 'council.pause' : 'council.continue')}
                disabled={actions.run.isPending || actions.pause.isPending}
                onClick={() =>
                  session.status === 'running'
                    ? actions.pause.mutate(session.id, { onError: showError })
                    : actions.run.mutate(session.id, { onError: showError })
                }
              >
                {actions.run.isPending || actions.pause.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : session.status === 'running' ? (
                  <CirclePause className="size-4" />
                ) : (
                  <Play className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t(session.status === 'running' ? 'council.pause' : 'council.continue')}
            </TooltipContent>
          </Tooltip>
        )}
        {/* 什么时候走到这里：有会话——成员快照入口 */}
        {session && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                aria-label={t('council.members.groupTitle', {
                  count: session.members?.length ?? 0,
                })}
                onClick={() => setMembersOpen(true)}
              >
                <Users className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t('council.members.groupTitle', { count: session.members?.length ?? 0 })}
            </TooltipContent>
          </Tooltip>
        )}
        {/* 什么时候走到这里：有会话且桌面以下——报告侧栏折叠为图标按钮 */}
        {session && (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 xl:hidden"
            aria-label={t('council.report.history')}
            onClick={() => setReportsOpen(true)}
          >
            <FileText className="size-4" />
          </Button>
        )}
        {/* 新建会话入口 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              className="shrink-0 gap-1.5"
              aria-label={t('council.newSession')}
              onClick={() => setNewOpen(true)}
            >
              <Plus className="size-4" />
              <span className="hidden sm:inline">{t('council.newSession')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('council.newSession')}</TooltipContent>
        </Tooltip>
      </header>
      {/* 什么时候走到这里：无可用模型——顶部横幅 + 设置入口 */}
      {noModel && (
        <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-2 text-xs leading-5 text-muted-foreground">
          {t('council.noModelShort')}{' '}
          <Link to="/settings" className="font-medium text-primary hover:underline">
            {t('council.apiSettings')}
          </Link>
        </div>
      )}
      {/* === 渲染区：对话区 + 报告侧栏 === */}
      <div className="flex min-h-0 flex-1">
        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          aria-label={t('council.conversation')}
        >
          {/* 四态分流：加载中 / 加载失败（可重试） / 有会话（对话区） / 无会话（欢迎空态） */}
          {sessionQuery.isLoading || sessionsQuery.isLoading ? (
            <div className="m-auto flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('council.loading')}
            </div>
          ) : !session && (sessionQuery.isError || sessionsQuery.isError) ? (
            <div role="alert" className="m-auto space-y-3 p-6 text-center">
              <p className="text-sm text-destructive">
                {errorMessage(sessionQuery.error ?? sessionsQuery.error, t('council.loadFailed'))}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void sessionsQuery.refetch();
                  if (selectedId) void sessionQuery.refetch();
                }}
              >
                {t('council.retry')}
              </Button>
            </div>
          ) : session ? (
            <CouncilConversation
              key={session.id}
              session={session}
              actions={actions}
              profileChanged={Boolean(
                selectedProfile && selectedProfile.version !== session.profileVersion,
              )}
            />
          ) : (
            <div className="m-auto max-w-md space-y-4 px-6 text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <MessageCircle className="size-7" />
              </div>
              <h2 className="text-lg font-semibold">{t('council.chatWelcome')}</h2>
              <p className="text-sm leading-6 text-muted-foreground">
                {t('council.chatWelcomeHint')}
              </p>
              <Button onClick={() => setNewOpen(true)}>
                <Plus className="size-4" />
                {t('council.newSession')}
              </Button>
            </div>
          )}
        </section>
        {/* 什么时候走到这里：有会话且桌面宽屏——右侧报告归档栏 */}
        {session && (
          <aside
            className="hidden min-h-0 w-[300px] shrink-0 border-l border-border bg-muted/20 xl:flex 2xl:w-[340px]"
            aria-label={t('council.report.history')}
          >
            <CouncilReports session={session} profileVersion={selectedProfile?.version} />
          </aside>
        )}
      </div>

      {/* === 渲染区：历史会话抽屉 === */}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="w-[min(360px,90vw)] gap-0 p-0">
          <SheetHeader className="border-b border-border px-5 py-5 pr-12">
            <SheetTitle>{t('council.sessions')}</SheetTitle>
            <SheetDescription>{t('council.historyHint')}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
            {/* 什么时候走到这里：会话列表加载失败——错误 + 重试 */}
            {sessionsQuery.isError && (
              <div role="alert" className="space-y-2 p-2 text-sm">
                <p className="text-destructive">{t('council.loadFailed')}</p>
                <Button variant="outline" size="sm" onClick={() => void sessionsQuery.refetch()}>
                  {t('council.retry')}
                </Button>
              </div>
            )}
            {/* 历史条目：当前选中会话用实时数据替换列表快照 */}
            {(sessionsQuery.data ?? []).map((savedItem: CouncilSession) => {
              const item = savedItem.id === session?.id ? session : savedItem;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={selectedId === item.id}
                  onClick={() => {
                    setParams({ session: item.id });
                    setHistoryOpen(false);
                  }}
                  className={`w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    selectedId === item.id
                      ? 'border-primary/30 bg-primary/10'
                      : 'border-transparent hover:bg-muted'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold">{item.ticker}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {new Date(item.updatedAt).toLocaleDateString(i18n.language)}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {item.status === 'running' && <Loader2 className="size-3 animate-spin" />}
                    {t(`council.status.${item.status}`)}
                    <span className="truncate">
                      ·{' '}
                      {profiles.find((profile: BuilderProfile) => profile.id === item.profileId)
                        ?.config.name ?? t('council.members.standalone')}
                    </span>
                  </span>
                </button>
              );
            })}
            {/* 什么时候走到这里：列表为空——无历史提示 */}
            {sessionsQuery.isSuccess && sessionsQuery.data.length === 0 && (
              <p className="px-2 py-6 text-sm text-muted-foreground">{t('council.noHistory')}</p>
            )}
          </div>
          {/* 抽屉底：构建器与预算入口 */}
          <div className="flex shrink-0 items-center justify-between border-t border-border p-4 text-xs">
            <Link to="/agent-builder" className="text-primary hover:underline">
              {t('council.builder')}
            </Link>
            <Link to="/settings/budget" className="text-muted-foreground hover:underline">
              {t('council.budget.open')}
            </Link>
          </div>
        </SheetContent>
      </Sheet>
      {/* === 渲染区：报告抽屉（移动端替代侧栏） === */}
      <Sheet open={reportsOpen} onOpenChange={setReportsOpen}>
        <SheetContent className="w-[min(420px,94vw)] gap-0 p-0 sm:max-w-[420px]">
          <SheetHeader className="sr-only">
            <SheetTitle>{t('council.report.history')}</SheetTitle>
            <SheetDescription>{t('council.report.detailHint')}</SheetDescription>
          </SheetHeader>
          {session && (
            <CouncilReports session={session} profileVersion={selectedProfile?.version} />
          )}
        </SheetContent>
      </Sheet>
      {/* === 渲染区：成员快照抽屉 === */}
      {membersOpen && session && (
        <CouncilMembersSheet
          session={session}
          onClose={() => setMembersOpen(false)}
          onUseTeam={() => {
            // "沿用该团队新建"：拷贝当前成员（深拷贝研究焦点），无成员则回退均衡预设；
            // key 递增重挂新建弹窗
            setNewSeed((current) => ({
              key: current.key + 1,
              ticker: session.ticker,
              team: {
                enabled: true,
                members: (session.members?.length
                  ? session.members
                  : createCouncilPreset('balanced', i18n.language)
                ).map((member) => ({
                  ...member,
                  researchFocus: member.researchFocus ? [...member.researchFocus] : undefined,
                })),
                webResearch: Boolean(session.webResearch),
              },
            }));
            setMembersOpen(false);
            setNewOpen(true);
          }}
        />
      )}
      {/* === 渲染区：新建会话弹窗（key 变化时整体重挂以重置表单） === */}
      <CouncilNewDialog
        key={newSeed.key}
        open={newOpen}
        onOpenChange={setNewOpen}
        profiles={profiles}
        loading={profilesQuery.isLoading}
        error={profilesQuery.error}
        pending={actions.create.isPending}
        initialProfileId={params.get('profileId') ?? ''}
        initialTicker={newSeed.ticker}
        initialTeam={newSeed.team}
        onCreate={create}
      />
    </div>
  );
}
