import { useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FolderTree, Plus, Search, UsersRound } from 'lucide-react';
import type { TeamSummary } from '@shared/team-workspace.interface';
import type { AiInvestmentPreview } from '@shared/investment-policy.interface';
import { teamKeys, teamsApi } from '@/api/teams';
import { fetchHoldings } from '@/api';
import { portfolioWorkspaceApi, portfolioWorkspaceKeys } from '@/api/portfolio-workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { friendlyError } from '@/utils/error-message';
import { TeamLoadError, TeamNotice } from '@/features/teams/TeamPrimitives';
import { TeamRemovalDialog } from '@/features/teams/TeamRemovalDialog';
import { TeamCreateDialog, readTeamCreationDraft, type TeamCreationDraft } from '@/features/teams/TeamCreateDialog';
import { teamCostLabel } from '@/features/teams/team-commission-state';
import { quickStartStepLabel, templateRouteFor, type QuickStartInput } from '@/features/teams/team-quick-start';
import { useTeamQuickStart, type QuickStartRunState } from '@/features/teams/use-team-quick-start';
import { TeamAccountReviewRecovery } from '@/features/teams/TeamAccountReviewRecovery';
import { OnboardingStepper } from '@/features/onboarding/OnboardingStepper';
import { usableAiConnection, IMPORT_ONBOARDING_PATH, teamOnboardingPath } from '@/features/onboarding/onboarding-state';
import { useAiReadiness } from '@/features/onboarding/use-ai-readiness';
import '@/features/teams/teams.css';

function QuickStartPanel({ state, zh, onContinue, onBackToForm, onLater, onReviewSeed, onConfirmSeed }: { state: QuickStartRunState; zh: boolean; onContinue: () => void; onBackToForm: () => void; onLater: () => void; onReviewSeed: () => Promise<AiInvestmentPreview>; onConfirmSeed: (preview: AiInvestmentPreview) => void }) {
  const states = { done: zh ? '已完成' : 'Done', running: zh ? '进行中…' : 'Running…', failed: zh ? '未完成' : 'Failed', pending: zh ? '等待中' : 'Pending' } as const;
  const needsSeedReview = Boolean(state.input?.reviewedSeed && state.failureKind === 'recoverable-preview' && state.progress?.steps.some(step => step.id === 'account' && step.state === 'failed'));
  return <div className="team-quick-progress" aria-live="polite">
    <p className="team-muted team-small">{zh ? '快速开始按你确认的选项执行：创建团队、发布模板配置、准备并关联模拟盘。已完成的步骤不会重复执行，本过程不调用模型。' : 'Quick start follows your reviewed choices: create the team, publish the template configuration, prepare and link the simulation account. Completed steps never rerun and no model is called.'}</p>
    <ol>{(state.progress?.steps ?? []).map(step => <li key={step.id} className={`is-${step.state}`}><span>{quickStartStepLabel(step.id, zh)}</span><span>{states[step.state]}</span></li>)}</ol>
    {state.status === 'running' && <p role="status">{zh ? '正在执行，请保持此窗口打开…' : 'Running; keep this window open…'}</p>}
    {state.status === 'failed' && <TeamNotice error><p>{state.message ?? (zh ? '此处保留了上次确认的建队请求。' : 'Your confirmed creation request is available to resume.')}</p>{needsSeedReview && <TeamAccountReviewRecovery zh={zh} read={onReviewSeed} confirm={onConfirmSeed} />}<div className="team-inline-actions">{state.failureKind === 'rejected' && (!state.input?.reviewedSeed || !state.progress?.teamId)
      ? <Button variant="outline" onClick={onBackToForm}>{zh ? '返回修改选项' : 'Back to the options'}</Button>
      : <>{!needsSeedReview && <Button onClick={onContinue}>{zh ? '继续完成剩余步骤' : 'Continue the remaining steps'}</Button>}<Button variant="ghost" onClick={onLater}>{zh ? '稍后继续' : 'Continue later'}</Button>{state.progress?.teamId && <Button asChild variant="outline"><Link to={`/teams/${encodeURIComponent(state.progress.teamId)}?panel=overview`}>{zh ? '查看已创建的团队' : 'View the created team'}</Link></Button>}</>}</div></TeamNotice>}
  </div>;
}

function TeamCard({ team, accountName, executionStatus, zh, copy, remove, canRemove }: { team: TeamSummary; accountName?: string; executionStatus?: string; zh: boolean; copy: (team: TeamSummary) => void; remove: (team: TeamSummary) => void; canRemove: boolean }) {
  return <article className="team-card"><div className="team-card-heading"><span className="team-avatar">{team.avatar ? team.avatar.slice(0, 4) : <UsersRound size={25} />}</span><div><h2><Link to={`/teams/${encodeURIComponent(team.id)}`}>{team.name}</Link></h2><span className="team-status">{team.status === 'archived' ? (zh ? '已归档 · 只读' : 'Archived · read only') : team.currentVersion ? `v${team.currentVersion} ${zh ? '已发布' : 'published'}` : (zh ? '尚未发布' : 'Not published')}</span></div></div><p className="team-card-description">{team.description || (zh ? '组织、职责与研究记录，在同一工作区。' : 'Organization, responsibilities and research in one workspace.')}</p><dl className="team-card-facts"><div><dt>{zh ? '组织' : 'Organization'}</dt><dd>{team.roleCount} {zh ? '岗位' : 'roles'} · {team.departmentCount} {zh ? '部门' : 'departments'} · {team.connectionCount ?? '—'} {zh ? '连接' : 'connections'}</dd></div><div><dt>{zh ? '账户' : 'Account'}</dt><dd>{team.accountId ? (accountName || team.accountId) : (zh ? '未关联账户' : 'No account linked')}</dd></div><div><dt>{zh ? '研究' : 'Research'}</dt><dd>{team.runningCommissionCount ? `${team.runningCommissionCount} ${zh ? '项进行中' : 'in progress'}` : (zh ? '当前无进行中委托' : 'No active commissions')}</dd></div><div><dt>{zh ? '模拟执行' : 'Simulated execution'}</dt><dd>{executionStatus === 'running' ? (zh ? '运行中' : 'Running') : executionStatus === 'paused' ? (zh ? '已暂停' : 'Paused') : executionStatus === 'archived' ? (zh ? '账户已归档' : 'Account archived') : (zh ? '未记录 / 未关联' : 'Unrecorded / unlinked')}</dd></div></dl><div className="team-card-draft">{zh ? '运行草稿修订' : 'Execution draft revision'} {team.semanticRevision} · {team.hasDraft === true ? (zh ? '有待发布变化' : 'unpublished changes') : team.hasDraft === false ? (zh ? '与发布版本一致' : 'matches published version') : (zh ? '发布差异待核对' : 'publication difference unverified')} · {zh ? '费用' : 'Cost'} {teamCostLabel(team.cost, zh)}</div><div className="team-card-actions"><Button asChild><Link to={`/teams/${encodeURIComponent(team.id)}?panel=overview`}>{zh ? '运行概览' : 'Run overview'}</Link></Button><Button variant="outline" asChild><Link to={`/teams/${encodeURIComponent(team.id)}?panel=organization`}>{zh ? '配置团队' : 'Configure team'}</Link></Button><Button variant="ghost" onClick={() => copy(team)} disabled={!canRemove}>{zh ? '复制' : 'Copy'}</Button><Button variant="ghost" onClick={() => remove(team)} disabled={!canRemove}><span className="team-danger">{zh ? '移除' : 'Remove'}</span></Button></div></article>;
}

export function TeamsPage({ onboarding = false }: { onboarding?: boolean } = {}) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const q = onboarding ? '' : params.get('q') ?? '';
  const filter = !onboarding && ['published', 'draft', 'unbound', 'archived'].includes(params.get('filter') ?? '') ? params.get('filter')! : 'all';
  const filters = { q, filter: filter === 'archived' ? 'all' : filter, status: filter === 'archived' ? 'archived' : 'active', limit: 30 };
  const list = useInfiniteQuery({ queryKey: teamKeys.list(filters), initialPageParam: undefined as string | undefined, queryFn: ({ pageParam }) => teamsApi.list({ ...filters, cursor: pageParam }), getNextPageParam: page => page.nextCursor || undefined, retry: false });
  const [creationRecovery, setCreationRecovery] = useState<TeamCreationDraft | null>(() => readTeamCreationDraft(onboarding));
  const [copySource, setCopySource] = useState<TeamSummary | null>(null);
  const quick = useTeamQuickStart(zh);
  const rejectedInput = quick.state.failureKind === 'name-conflict' ? quick.state.input : null;
  const [creating, setCreating] = useState(() => Boolean(rejectedInput) || params.get('advanced') === '1' && params.get('create') === '1');
  const rejectedDraft = useMemo<TeamCreationDraft | null>(() => rejectedInput && ({
    name: rejectedInput.name, description: rejectedInput.description, avatar: rejectedInput.avatar,
    templateId: rejectedInput.templateId, mode: rejectedInput.creationMode ?? 'template',
    copyVersionId: rejectedInput.copyFromTeamVersionId ?? '',
    virtualCash: rejectedInput.seed.kind === 'holdings' && rejectedInput.seed.virtualCash
      ? Object.fromEntries(rejectedInput.seed.virtualCash.map(row => [row.currency, String(row.amount)])) : undefined,
  }), [rejectedInput]);
  const [removingTeam, setRemovingTeam] = useState<TeamSummary | null>(null);
  const accounts = useQuery({ queryKey: portfolioWorkspaceKeys.accounts, queryFn: portfolioWorkspaceApi.accounts, retry: false });
  const items = list.data?.pages.flatMap(page => page.items) ?? [];
  const knownAccountIds = new Set((accounts.data ?? []).map(account => account.id));
  const openCreate = (source?: TeamSummary): void => { if (quick.resumable && !rejectedInput) { setCreating(true); quick.resume(knownAccountIds); return; } setCopySource(source ?? null); setCreating(true); };
  const resumeQuickStart = (): void => { setCreating(true); quick.resume(knownAccountIds); };
  const quickActive = quick.state.status !== 'idle' && !rejectedInput;
  const needsStartingPoint = onboarding && list.isSuccess && !items.length && !quickActive && !quick.resumable;
  const holdings = useQuery({ queryKey: ['holdings'], queryFn: fetchHoldings, enabled: needsStartingPoint, retry: false });
  const ai = useAiReadiness({ enabled: creating || Boolean(rejectedDraft) || needsStartingPoint && Boolean(holdings.data?.length) });
  const teamConnection = usableAiConnection(ai.locals.filter(local => local.supportsTeamResearch), ai.models);
  const createTeam = (input: QuickStartInput) => quick.run({
    ...input,
    ...(input.creationMode === 'template' ? { templateRoute: templateRouteFor(teamConnection) } : {}),
  }, knownAccountIds);
  const updateFilter = (key: string, value: string): void => { const next = new URLSearchParams(params); if (value && value !== 'all') next.set(key, value); else next.delete(key); setParams(next, { replace: true }); };
  if (onboarding) {
    if (quickActive || quick.resumable && !rejectedInput) return <section className="team-workspace space-y-4">
      <OnboardingStepper step="team" zh={zh} />
      <h1 className="text-2xl font-semibold sm:text-3xl">{zh ? '继续创建团队模拟盘' : 'Resume team simulation setup'}</h1>
      <div className="rounded-xl border bg-card p-5">
        <QuickStartPanel state={quick.state} zh={zh}
          onReviewSeed={quick.refreshSeedReview} onConfirmSeed={preview => quick.resumeWithSeedReview(preview, knownAccountIds)}
          onContinue={() => quick.resume(knownAccountIds)} onBackToForm={quick.reset}
          onLater={() => setParams({}, { replace: true })} />
      </div>
    </section>;
    if (rejectedDraft) return <div className="team-workspace">
      <TeamCreateDialog checkingConnection={ai.pending} open onboarding teams={items} recovery={rejectedDraft} rejectedName={rejectedDraft.name}
        onOpenChange={open => { if (!open) setParams({}, { replace: true }); }}
        onCreate={createTeam} />
    </div>;
    if (items[0]) return <Navigate to={teamOnboardingPath(items[0].id)} replace />;
    const workspaceDisabled = list.data?.pages[0]?.capabilities.workspaceEnabled === false;
    if (workspaceDisabled || list.isPending || list.isError || holdings.isPending || holdings.isError || !holdings.data?.length || !teamConnection) {
      const pending = list.isPending || needsStartingPoint && (holdings.isPending || Boolean(holdings.data?.length) && ai.pending);
      const failed = list.isError || needsStartingPoint && (holdings.isError || ai.error && Boolean(holdings.data?.length));
      return <section className="team-workspace space-y-4">
        <OnboardingStepper step="team" zh={zh} />
        <h1 className="text-2xl font-semibold sm:text-3xl">{zh ? '新建团队模拟盘' : 'Create a team simulation'}</h1>
        {workspaceDisabled ? <TeamNotice>{zh ? '当前实例尚未开启团队配置。' : 'Team configuration is disabled on this instance.'}</TeamNotice>
          : pending ? <p role="status">{zh ? '正在核对创建条件…' : 'Checking setup requirements…'}</p>
            : failed ? <TeamLoadError zh={zh} retry={() => {
              if (list.isError) void list.refetch();
              if (holdings.isError) void holdings.refetch();
              if (ai.error) void ai.reload();
            }} message={zh ? '暂时无法核对创建条件。' : 'Setup requirements could not be checked.'} />
              : !holdings.data?.length ? <Button asChild><Link to={IMPORT_ONBOARDING_PATH}>{zh ? '先导入持仓' : 'Import holdings first'}</Link></Button>
                : <Button asChild><Link to={ai.connectionPath}>{zh ? '核对研究服务连接' : 'Check your research connection'}</Link></Button>}
      </section>;
    }
    return <div className="team-workspace">
      <TeamCreateDialog checkingConnection={ai.pending} open onboarding teams={items} recovery={creationRecovery}
        onOpenChange={open => { if (!open) setParams({}, { replace: true }); }}
        onCreate={createTeam} />
    </div>;
  }

  return <section className="team-workspace team-list-page" aria-label={zh ? '团队模拟盘' : 'Team simulations'}><header className="team-page-header"><div><span className="team-eyebrow">{zh ? '一起研究，各自成章' : 'Research together, keep every decision traceable'}</span><h1>{zh ? '团队模拟盘' : 'Team simulations'}</h1><p>{zh ? '搭建你的研究组织，为每次判断留下职责、证据与版本。' : 'Build a research organization with responsibilities, evidence and versions for every decision.'}</p></div><Button onClick={() => openCreate()} disabled={list.data?.pages[0]?.capabilities.workspaceEnabled === false}><Plus size={16} />{zh ? '新建团队' : 'New team'}</Button></header>
    {list.data?.pages[0]?.capabilities.workspaceEnabled === false && <TeamNotice>{zh ? '当前实例尚未开启团队配置；已有历史仍可读取。' : 'Team configuration is disabled on this instance. Existing history remains readable.'}</TeamNotice>}
    <div className="team-list-toolbar"><div className="team-search"><Search size={16} /><Input aria-label={zh ? '搜索团队名称' : 'Search teams'} placeholder={zh ? '搜索团队名称…' : 'Search team names…'} value={q} onChange={event => updateFilter('q', event.target.value)} /></div><div className="team-filter-tabs" role="group" aria-label={zh ? '团队筛选' : 'Team filters'}>{['all', 'published', 'draft', 'unbound', 'archived'].map(value => <Button key={value} variant={filter === value ? 'secondary' : 'ghost'} aria-pressed={filter === value} size="sm" onClick={() => updateFilter('filter', value)}>{({ all: zh ? '全部' : 'All', published: zh ? '已发布' : 'Published', draft: zh ? '有草稿' : 'With draft', unbound: zh ? '未关联' : 'Unlinked', archived: zh ? '已归档' : 'Archived' })[value]}</Button>)}</div></div>
    {list.isPending && <p role="status">{zh ? '正在读取团队…' : 'Loading teams…'}</p>}{list.isError && <TeamLoadError zh={zh} retry={() => void list.refetch()} message={friendlyError(list.error, zh, { zh: '团队列表读取失败', en: 'Could not load teams' })} />}
    {list.data && !items.length && <div className="team-empty"><span className="team-empty-icon"><FolderTree size={42} /></span><h2>{q || filter !== 'all' ? (zh ? '没有匹配的团队' : 'No matching teams') : (zh ? '你的研究团队，从这里开始' : 'Your research team starts here')}</h2><p>{zh ? '从空白、现有配置或研究启发的模板开始。组织配置不会发起研究或交易。' : 'Start from a blank canvas, a published configuration or a research-inspired template. Configuration never initiates research or trading.'}</p><Button onClick={() => openCreate()} disabled={list.data.pages[0].capabilities.workspaceEnabled === false}><Plus size={16} />{zh ? '创建第一个团队' : 'Create your first team'}</Button></div>}
    {creationRecovery && <TeamNotice><p>{zh ? '此浏览器会话保留了未完成的团队输入。' : 'This browser session retained an unfinished team draft.'}</p><div className="team-inline-actions"><Button variant="outline" onClick={() => openCreate()}>{zh ? '恢复新建输入' : 'Restore creation draft'}</Button><Button variant="ghost" onClick={() => { window.sessionStorage.removeItem('squabble.team-create'); setCreationRecovery(null); }}>{zh ? '放弃输入' : 'Discard input'}</Button></div></TeamNotice>}
    {quick.resumable && !rejectedInput && quick.state.status !== 'running' && !creating && <TeamNotice><p>{zh ? '有一个未完成的团队快速开始，已完成的步骤不会重复执行。' : 'An unfinished team quick start exists; completed steps will not rerun.'}</p><div className="team-inline-actions"><Button variant="outline" onClick={resumeQuickStart}>{zh ? '继续完成' : 'Continue'}</Button>{!quick.resumableInput?.reviewedSeed && <Button variant="ghost" onClick={quick.reset}>{zh ? '放弃快速开始' : 'Discard quick start'}</Button>}</div></TeamNotice>}
    <div className="team-card-grid">{items.map(team => <TeamCard key={team.id} team={team} accountName={accounts.data?.find(account => account.id === team.accountId)?.name} executionStatus={accounts.data?.find(account => account.id === team.accountId)?.status} zh={zh} copy={openCreate} remove={setRemovingTeam} canRemove={list.data?.pages[0]?.capabilities.workspaceEnabled !== false} />)}</div>{list.hasNextPage && <Button variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{zh ? '加载更多团队' : 'Load more teams'}</Button>}
    {removingTeam && <TeamRemovalDialog team={removingTeam} open close={() => setRemovingTeam(null)} committed={() => { setRemovingTeam(null); void list.refetch(); }} zh={zh} online={typeof window === 'undefined' || window.navigator.onLine} />}
    {quickActive ? <Dialog open={creating} onOpenChange={open => { if (quick.state.status !== 'running') setCreating(open); }}><DialogContent className="team-dialog team-create-dialog"><DialogHeader><DialogTitle>{zh ? '继续团队快速开始' : 'Resume the team quick start'}</DialogTitle><DialogDescription>{zh ? '快速开始会复用已确认的选项继续完成剩余步骤。' : 'Quick start reuses the reviewed options and completes the remaining steps.'}</DialogDescription></DialogHeader><QuickStartPanel state={quick.state} zh={zh} onReviewSeed={quick.refreshSeedReview} onConfirmSeed={preview => quick.resumeWithSeedReview(preview, knownAccountIds)} onContinue={() => quick.resume(knownAccountIds)} onBackToForm={() => { quick.reset(); setCreating(false); }} onLater={() => setCreating(false)} /><div className="team-dialog-actions"><Button variant="outline" onClick={() => setCreating(false)}>{zh ? '关闭' : 'Close'}</Button></div></DialogContent></Dialog> : <TeamCreateDialog checkingConnection={ai.pending} open={creating} onOpenChange={open => { setCreating(open); if (!open) setCopySource(null); }} teams={items} recovery={rejectedDraft ?? creationRecovery} rejectedName={rejectedDraft?.name} copyFrom={rejectedDraft ? null : copySource} onCreate={input => { setCreationRecovery(null); setCopySource(null); createTeam(input); }} />}
  </section>;
}
export default TeamsPage;
