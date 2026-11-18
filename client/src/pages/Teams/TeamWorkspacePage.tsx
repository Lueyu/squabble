import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Archive, ChevronRight, Copy, Save, UsersRound } from 'lucide-react';
import type { PortfolioAccountSummary } from '@shared/portfolio-workspace.interface';
import type { TeamDetail, TeamRelation } from '@shared/team-workspace.interface';
import { teamKeys, teamsApi } from '@/api/teams';
import { portfolioWorkspaceApi, portfolioWorkspaceKeys } from '@/api/portfolio-workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { friendlyError } from '@/utils/error-message';
import { TeamKeyValue, TeamLoadError, TeamNotice, TeamSelect } from '@/features/teams/TeamPrimitives';
import { TeamCanvas, type CanvasControls } from '@/features/teams/TeamCanvas';
import { TeamOutline } from '@/features/teams/TeamOutline';
import { TeamInspector } from '@/features/teams/TeamInspector';
import { TeamEditorSidebar } from '@/features/teams/TeamEditorSidebar';
import { TeamEditorToolbar } from '@/features/teams/TeamEditorToolbar';
import { TeamRelations } from '@/features/teams/TeamRelations';
import { TeamWorkPlanPreview } from '@/features/teams/TeamWorkPlanPreview';
import { TeamArchiveDialog, TeamBindingDialog, TeamPublishDialog } from '@/features/teams/TeamLifecycleDialogs';
import { TeamRemovalDialog } from '@/features/teams/TeamRemovalDialog';
import { TeamCommissionDialog } from '@/features/teams/TeamCommissionDialog';
import { TeamWorkHistory } from '@/features/teams/TeamWorkHistory';
import { TeamSources } from '@/features/teams/TeamSources';
import { TeamRunPanel } from '@/features/teams/TeamRunPanel';
import { TeamAutoRunStaffing } from '@/features/teams/TeamAutoRunStaffing';
import { useTeamDraft } from '@/features/teams/use-team-draft';
import { autoLayout } from '@/features/teams/team-auto-layout';
import { addTeamObject, deleteTeamObjects, dissolveDepartment, duplicateTeamObjects, objectParent, relationLabel, restoreTeamVersion, validateTeamGraph, type TeamEditorState, type TeamGraphIssue } from '@/features/teams/team-graph';
import { opensTeamRelations, teamEditorView, withTeamEditorView, teamIssueDestination, teamIssueMessage, type TeamRelationView } from '@/features/teams/team-editor-navigation';
import { fetchModelConnections } from '@/api/model-connections';
import { assignAgentToRole, staffingFailureMessage } from '@/features/teams/team-staffing';
import { agentRosterApi } from '@/api/agent-roster';
import CreateSimulationAccount from '@/pages/Paper/CreateSimulationAccount';
import '@/features/teams/teams.css';

/** Post quick-start orientation: what already exists, and the next explicit step. It never dispatches research by itself. */
function TeamQuickStartChecklist({ team, state, accountsData, zh, locateRole, onStartResearch, onDismiss }: { team: TeamDetail; state: TeamEditorState; accountsData: PortfolioAccountSummary[] | undefined; zh: boolean; locateRole: (roleId: string) => void; onStartResearch: () => void; onDismiss: () => void }) {
  const account = accountsData?.find(item => item.id === team.accountId);
  const configuredRoles = state.config.roles.filter(role => role.participation === 'enabled' && role.executor);
  const unconfiguredRole = state.config.roles.find(role => role.participation !== 'enabled' || !role.executor);
  const researchReady = !!team.binding && !!team.currentVersionId && configuredRoles.length > 0;
  return <TeamNotice>
    <div className="team-section-title"><h2>{zh ? '开始使用这个团队' : 'Start using this team'}</h2><Button size="sm" variant="ghost" onClick={onDismiss}>{zh ? '知道了' : 'Got it'}</Button></div>
    <ul className="team-quick-checklist">
      <li className={team.currentVersionId ? 'is-done' : ''}><span>{zh ? '模板配置已发布为版本' : 'Template configuration published as version'}</span><span>{team.currentVersionId ? `v${team.currentVersion ?? ''}` : (zh ? '待发布' : 'Pending')}</span></li>
      <li className={team.binding ? 'is-done' : ''}><span>{zh ? '模拟盘已关联' : 'Simulation account linked'}</span><span>{team.binding ? (account?.name ?? team.accountId) : (zh ? '待关联' : 'Pending')}</span></li>
      <li className={unconfiguredRole ? '' : 'is-done'}><span>{zh ? '岗位执行连接' : 'Role executor connections'}</span><span>{configuredRoles.length}/{state.config.roles.length}</span></li>
    </ul>
    {unconfiguredRole && <div className="team-inline-actions"><Button variant="outline" size="sm" onClick={() => locateRole(unconfiguredRole.id)}>{zh ? `配置岗位「${state.display.roleLabels[unconfiguredRole.id] ?? unconfiguredRole.id}」` : `Configure “${state.display.roleLabels[unconfiguredRole.id] ?? unconfiguredRole.id}”`}</Button><Button asChild variant="ghost" size="sm"><Link to="/settings/models">{zh ? '管理模型连接' : 'Manage connections'}</Link></Button></div>}
    <div className="team-inline-actions"><Button disabled={!researchReady || !team.capabilities.researchEnabled} onClick={onStartResearch}>{zh ? '发起第一次研究' : 'Start your first research'}</Button>{team.accountId && <Button asChild variant="outline"><Link to={`/holdings?accountId=${encodeURIComponent(team.accountId)}`}>{zh ? '查看资产' : 'View assets'}</Link></Button>}</div>
    <p className="team-muted team-small">{zh ? '发起研究后，交付、采纳、策略应用与模拟成交仍是分开的确认步骤。' : 'After research starts, delivery, adoption, policy application and simulated fills remain separate confirmation steps.'}</p>
  </TeamNotice>;
}

function TeamEditor({ team, zh }: { team: TeamDetail; zh: boolean }) {
  const client = useQueryClient(); const navigate = useNavigate(); const [params, setParams] = useSearchParams();
  const draft = useTeamDraft(team, zh);
  const state = draft.state;
  const [selected, setSelected] = useState<string[]>(() => {
    const initial = team.draft.config.roles.find(role => role.id === team.draft.config.defaults.leadRoleId) ?? team.draft.config.roles[0];
    return initial ? [initial.id] : [];
  });
  const [locateId, setLocateId] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const requestedPanel = params.get('panel');
  const panel = requestedPanel === 'relations' ? 'organization'
    : requestedPanel && ['organization', 'history', 'sources', 'versions'].includes(requestedPanel) ? requestedPanel : 'overview';
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => { const resized = () => setWidth(window.innerWidth); window.addEventListener('resize', resized); return () => window.removeEventListener('resize', resized); }, []);
  const outline = teamEditorView(params, width) === 'list';
  const selectObjects = setSelected;
  const organizationRef = useRef<HTMLDivElement>(null);
  const relationTrigger = useRef<HTMLElement | SVGElement | null>(null);
  const allRelationsTrigger = useRef<HTMLButtonElement>(null);
  const models = useQuery({ queryKey: ['model-connections'], queryFn: fetchModelConnections, retry: false });
  const roster = useQuery({ queryKey: ['agent-roster'], queryFn: agentRosterApi.list, retry: false });
  const [publish, setPublish] = useState(false); const [publishTeam, setPublishTeam] = useState<TeamDetail>(team); const [binding, setBinding] = useState(params.get('panel') === 'binding'); const [archive, setArchive] = useState(false); const [commission, setCommission] = useState(false);
  const [removalOpen, setRemovalOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false); const [deleteContents, setDeleteContents] = useState(false); const [leaveTo, setLeaveTo] = useState('');
  const [relationView, setRelationView] = useState<TeamRelationView | null>(null);
  const legacyRelations = opensTeamRelations(params);
  useEffect(() => {
    if (params.get('panel') !== 'relations') return;
    const next = new URLSearchParams(params);
    next.set('panel', 'organization');
    next.set('relations', '1');
    setParams(next, { replace: true });
  }, [params, setParams]);
  const networkReady = draft.online && !draft.needsReconcile;
  const readOnly = team.status === 'archived' || !team.capabilities.workspaceEnabled;
  const quickStarted = params.get('quickStarted') === '1';
  const quickAccounts = useQuery({ queryKey: portfolioWorkspaceKeys.accounts, queryFn: portfolioWorkspaceApi.accounts, enabled: quickStarted, retry: false });
  const sources = useQuery({ queryKey: teamKeys.sources(team.id), queryFn: () => teamsApi.sources(team.id), retry: false });
  const versions = useInfiniteQuery({ queryKey: teamKeys.versions(team.id), initialPageParam: undefined as string | undefined, queryFn: ({ pageParam }) => teamsApi.versions(team.id, pageParam), getNextPageParam: page => page.nextCursor || undefined, enabled: panel === 'versions', retry: false });
  const update = (changes: Record<string, string | null>): void => { const next = new URLSearchParams(params); Object.entries(changes).forEach(([key, value]) => { if (value) next.set(key, value); else next.delete(key); }); setParams(next, { replace: true }); };
  const errorMessage = (error: unknown): void => draft.setMessage(friendlyError(error, zh, { zh: '操作未完成，改动已保留。', en: 'Action was not completed. Edits are retained.' }));
  const notify = (message: string): void => draft.setMessage(message);
  const edit = (next: TeamEditorState): void => { if (!readOnly) draft.edit(next); };
  const saveAll = async (): Promise<TeamDetail> => draft.save.mutateAsync('all');
  const committed = (next: TeamDetail): void => { draft.acceptServer(next); client.setQueryData(teamKeys.detail(team.id), next); void client.invalidateQueries({ queryKey: teamKeys.all }); void client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.accounts }); };
  const openPublish = async (): Promise<void> => { try { const saved = await saveAll(); setPublishTeam(saved); setPublish(true); } catch (error) { errorMessage(error); } };
  const [zoom, setZoom] = useState(1);
  const canvasControls = useRef<CanvasControls | null>(null);
  const setViewMode = (view: 'list' | 'canvas'): void => setParams(withTeamEditorView(params, view), { replace: true });
  const applyAutoLayout = (): void => { if (readOnly) return; edit({ ...state, layout: autoLayout(state.config, state.layout) }); notify(zh ? '已按确定性网格自动布局（只改布局，可撤销）。' : 'Auto layout applied deterministically (layout only; undoable).'); };
  const add = (kind: 'role' | 'department'): void => { try { const parent = selected.find(id => state.config.departments.some(d => d.id === id)) ?? null; const next = addTeamObject(state, kind, parent, kind === 'role' ? (zh ? '新岗位' : 'New role') : (zh ? '新部门' : 'New department')); edit(next); const createdId = kind === 'role' ? next.config.roles[next.config.roles.length - 1].id : next.config.departments[next.config.departments.length - 1].id; selectObjects([createdId]); } catch (error) { errorMessage(error); } };
  const duplicate = (): void => { try { edit(duplicateTeamObjects(state, selected, zh ? '副本' : 'copy')); } catch (error) { errorMessage(error); } };
  const locate = (id: string): void => { const parents: string[] = []; let parent = objectParent(state.config, id); while (parent && !parents.includes(parent)) { parents.push(parent); parent = objectParent(state.config, parent); } if (!readOnly) edit({ ...state, layout: { ...state.layout, collapsedDepartmentIds: state.layout.collapsedDepartmentIds.filter(value => !parents.includes(value)) } }); setSelected([id]); setLocateId(id); update({ panel: 'organization', view: 'canvas' }); };
  const remove = (): void => { setDeleteContents(false); setRemoveOpen(true); };
  const confirmRemove = (): void => { let next = state; const departments = selected.filter(id => state.config.departments.some(d => d.id === id)); if (deleteContents) next = deleteTeamObjects(next, selected); else { departments.forEach(id => { next = dissolveDepartment(next, id, false); }); next = deleteTeamObjects(next, selected.filter(id => !departments.includes(id))); } edit(next); setSelected([]); setRemoveOpen(false); };
  const openRelation = (view: TeamRelationView, trigger?: HTMLElement | SVGElement): void => {
    const focused = document.activeElement;
    relationTrigger.current = trigger ?? (focused instanceof HTMLElement || focused instanceof SVGElement ? focused : null);
    setRelationView(view);
  };
  const closeRelation = (): void => {
    setRelationView(null);
    if (legacyRelations) update({ panel: 'organization', relations: null });
  };
  const applyRelation = (id: string, relation: TeamRelation | null): void => {
    if (readOnly) return;
    draft.edit(current => {
      const relations = current.config.relations;
      const exists = relations.some(item => item.id === id);
      const next = !relation ? relations.filter(item => item.id !== id)
        : exists ? relations.map(item => item.id === id ? relation : item) : [...relations, relation];
      return { ...current, config: { ...current.config, relations: next } };
    });
    closeRelation();
  };
  const restoreRelationFocus = (event: Event): void => {
    event.preventDefault();
    const trigger = relationTrigger.current;
    relationTrigger.current = null;
    requestAnimationFrame(() => {
      const edgeId = trigger instanceof SVGElement ? trigger.dataset.id : undefined;
      const target = trigger?.isConnected ? trigger : edgeId
        ? organizationRef.current?.querySelector<SVGElement>(`.react-flow__edge[data-id="${CSS.escape(edgeId)}"]`)
        : null;
      if (target && target !== document.body && !target.matches(':disabled')) {
        target.focus();
        if (document.activeElement === target) return;
      }
      const fallback = allRelationsTrigger.current;
      const containingDetails = fallback?.closest('details');
      if (containingDetails && !containingDetails.open) containingDetails.querySelector('summary')?.focus();
      else fallback?.focus();
    });
  };
  const repairIssue = (issue: TeamGraphIssue, trigger: HTMLButtonElement): void => {
    const relationDestination = teamIssueDestination(issue, state.config.relations);
    if (relationDestination) {
      openRelation(relationDestination, trigger);
      return;
    }
    selectObjects(issue.objectIds);
    requestAnimationFrame(() => {
      const editor = organizationRef.current;
      const details = editor?.querySelector<HTMLDetailsElement>('.team-advanced-properties');
      if (details) details.open = true;
      editor?.querySelector<HTMLElement>('.team-inspector h2')?.focus();
    });
  };

  useEffect(() => {
    const keyboard = (event: KeyboardEvent): void => {
      const text = (event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"],[role="combobox"]');
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!readOnly && !relationView && !legacyRelations && !draft.save.isPending) void saveAll().catch(errorMessage); return; }
      if (text || readOnly || (event.target as HTMLElement)?.closest('[role="dialog"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) draft.redo(); else draft.undo(); }
      if (event.key === 'Escape' && !relationView && !legacyRelations && !event.defaultPrevented) setSelected([]);
      if (panel === 'organization' && selected.length && ['Delete', 'Backspace'].includes(event.key) && organizationRef.current?.contains(event.target as Node)) { event.preventDefault(); remove(); }
      if (panel === 'organization' && selected.length && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && (event.target as HTMLElement)?.closest('.react-flow__node')) { event.preventDefault(); const step = event.shiftKey ? 40 : 8; const positions = { ...state.layout.positions }; selected.forEach(id => { if (positions[id]) positions[id] = { ...positions[id], x: positions[id].x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), y: positions[id].y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) }; }); edit({ ...state, layout: { ...state.layout, positions } }); }
    };
    document.addEventListener('keydown', keyboard); return () => document.removeEventListener('keydown', keyboard);
  }, [state, selected, readOnly, draft.save.isPending, panel, relationView, legacyRelations]);
  useEffect(() => {
    if (!draft.dirty) return;
    const leave = (event: MouseEvent): void => { const anchor = (event.target as HTMLElement)?.closest('a[href]'); if (!anchor || event.ctrlKey || event.metaKey || event.shiftKey || anchor.getAttribute('target') === '_blank') return; const url = new URL(anchor.getAttribute('href')!, window.location.href); if (url.origin === window.location.origin && url.pathname !== window.location.pathname) { event.preventDefault(); event.stopPropagation(); setLeaveTo(`${url.pathname}${url.search}${url.hash}`); } };
    document.addEventListener('click', leave, true); return () => document.removeEventListener('click', leave, true);
  }, [draft.dirty]);
  const issues = validateTeamGraph(state.config);
  const assignAgent = (roleId: string, agentId: string): void => {
    try { const person = roster.data?.items.find(item => item.id === agentId); if (!person) throw new Error(zh ? '请先重读股友目录。' : 'Reload the friend roster first.'); edit(assignAgentToRole(state, roleId, agentId, roster.data?.items ?? [], models.data ?? [], { readOnly })); notify(zh ? '股友已指派到草稿，可撤销。' : 'Friend assigned to the draft. You can undo this.'); } catch (error) { notify(staffingFailureMessage(error, zh)); }
  };
  const selectedRole = state.config.roles.find(role => selected.includes(role.id));
  const selectedRoleCount = selected.filter(id => state.config.roles.some(role => role.id === id)).length;
  const selectedDepartmentCount = selected.filter(id => state.config.departments.some(department => department.id === id)).length;
  const relationImpacts = state.config.relations.filter(item => selected.includes(item.fromRoleId) || selected.includes(item.toRoleId) || selected.includes(item.id));
  return <section className={`team-workspace${panel === 'organization' ? ' team-editor-page' : panel === 'overview' ? ' team-run-page' : ''}`} aria-label={zh ? '团队组织工作区' : 'Team organization workspace'}>{panel === 'overview' ? <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div><h1>{state.display.name}</h1><p className="text-muted-foreground"><Link to="/teams">{zh ? '团队模拟盘' : 'Paper teams'}</Link> / {zh ? '运行概览' : 'Run overview'}</p></div>
      <Button variant="outline" onClick={() => update({ panel: 'organization' })}>{zh ? '配置团队' : 'Configure team'}</Button>
    </header> : panel === 'organization'
      ? <header className="team-organization-heading">
        <h1>{zh ? `配置${state.display.name}` : `Configure ${state.display.name}`}</h1>
        <p className="team-muted">{readOnly ? (zh ? '查看岗位、股友与关系。' : 'View roles, friends and relations.')
          : (zh ? '选择岗位，指派已有股友并编辑职责。' : 'Select a role to assign an existing friend and edit responsibilities.')}</p>
      </header>
      : <header className="team-editor-header"><div><Button asChild variant="ghost" size="sm"><Link to="/teams"><ArrowLeft size={15} />{zh ? '返回团队' : 'Teams'}</Link></Button><div className="team-editor-identity"><span className="team-avatar">{state.display.avatar ? state.display.avatar.slice(0, 4) : <UsersRound size={25} />}</span><div><h1>{state.display.name}</h1><p>{team.status === 'archived' ? (zh ? '已归档 · 只读历史' : 'Archived · read-only history') : team.currentVersion ? `v${team.currentVersion} ${zh ? '已发布' : 'published'}` : (zh ? '尚未发布' : 'Not published')} · {team.accountId ? (zh ? '已关联模拟盘' : 'Simulation linked') : (zh ? '未关联账户' : 'Unlinked')}</p></div></div>{!readOnly && <Button variant="ghost" size="sm" disabled={!networkReady} onClick={() => setRemovalOpen(true)}>{zh ? '移除团队' : 'Remove team'}</Button>}</div><div className={panel === 'overview' ? 'hidden' : 'team-header-actions'}>{team.accountId && <Button asChild variant="outline"><Link to={`/holdings?accountId=${encodeURIComponent(team.accountId)}`}>{zh ? '查看资产' : 'View assets'}</Link></Button>}<Button variant="outline" disabled={readOnly || !networkReady || draft.save.isPending || !!draft.conflict || !!draft.recovery} onClick={() => void saveAll().catch(errorMessage)}><Save size={14} />{draft.save.isPending ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存草稿' : 'Save draft')}</Button><Button disabled={readOnly || !networkReady || draft.save.isPending || !!draft.conflict || !!draft.recovery} onClick={() => void openPublish()}>{zh ? '发布团队版本' : 'Publish team version'}</Button><Button variant="outline" disabled={readOnly || !networkReady || !team.currentVersionId} onClick={() => setBinding(true)}>{team.binding ? (zh ? '账户交接' : 'Account handoff') : (zh ? '关联账户' : 'Link account')}</Button><Button disabled={readOnly || !networkReady || !team.capabilities.researchEnabled || !team.binding || !team.currentVersionId} onClick={() => setCommission(true)}>{zh ? '发起研究' : 'Start research'}</Button></div></header>}

    {panel !== 'overview' && panel !== 'organization' && <div className="team-save-strip" role="status"><span>{draft.dirty ? (zh ? '有未保存更改' : 'Unsaved changes') : (zh ? '草稿已保存' : 'Draft saved')}</span><span>{team.currentVersion ? (zh ? `当前发布 v${team.currentVersion} · 发布前检查草稿差异` : `Published v${team.currentVersion} · Review draft changes before publishing`) : (zh ? '尚未发布' : 'Not published')}</span><details><summary>{zh ? '修订详情' : 'Revision details'}</summary><div><span className={draft.semanticDirty ? 'team-unsaved' : ''}>{zh ? '运行草稿' : 'Execution draft'} r{draft.baseline.semanticRevision} · {draft.semanticDirty ? (zh ? '有未保存改动' : 'unsaved changes') : (zh ? '已保存' : 'saved')}</span><span>{zh ? '布局' : 'Layout'} r{draft.baseline.layoutRevision} · {draft.layoutDirty ? (zh ? '等待保存' : 'pending save') : (zh ? '已保存' : 'saved')}</span><span>{zh ? '展示' : 'Display'} r{draft.baseline.displayRevision} · {draft.displayDirty ? (zh ? '有改动' : 'changed') : (zh ? '已保存' : 'saved')}</span><span>{zh ? '当前发布版本' : 'Published'} {team.currentVersion ? `v${team.currentVersion}` : '—'}</span></div></details></div>}
    {quickStarted && <TeamQuickStartChecklist team={team} state={state} accountsData={quickAccounts.data} zh={zh} locateRole={locate} onStartResearch={() => setCommission(true)} onDismiss={() => update({ quickStarted: null })} />}
    {!draft.online && <TeamNotice>{zh ? '当前离线。编辑只在此浏览器会话暂存；不能发布、关联或发起研究。联网后先核对服务器修订。' : 'Offline. Edits are stored only in this browser session. Publishing, binding and research are unavailable. Reconcile server revisions when online.'}</TeamNotice>}
    {readOnly && <TeamNotice>{team.status === 'archived' ? (zh ? '归档团队保留历史。新工作需要复制配置为新团队。' : 'Archived history remains readable. Copy a configuration into a new team for new work.') : (zh ? '当前实例尚未开启团队编辑。' : 'Team editing is disabled on this instance.')}</TeamNotice>}
    {panel !== 'organization' && !team.capabilities.researchEnabled && <p className="team-muted team-small">{zh ? '当前实例尚未开启新团队研究，历史检查与取消仍可使用。' : 'New team research is disabled on this instance. Historical checks and cancellation remain available.'}</p>}
    {draft.recovery && <TeamNotice><p>{zh ? '发现本团队本地恢复草稿' : 'A local recovery draft exists for this team'} · {draft.recovery.savedAt}</p><div className="team-inline-actions"><Button variant="outline" onClick={draft.restore}>{zh ? '查看并恢复本地改动' : 'Inspect and restore local edits'}</Button><Button variant="ghost" onClick={draft.discardRecovery}>{zh ? '放弃本地恢复草稿' : 'Discard recovery draft'}</Button></div></TeamNotice>}
    {draft.message && <TeamNotice error={draft.save.isError}><p>{draft.message}</p><Button size="sm" variant="outline" disabled={!draft.online} onClick={() => void draft.checkServer().catch(errorMessage)}>{zh ? '核对服务器 / 原保存回执' : 'Check server / original save receipt'}</Button></TeamNotice>}
    {draft.conflict && <TeamNotice error><h2>{zh ? '检测到并发修订，未覆盖服务器' : 'Concurrent revisions detected; server not overwritten'}</h2><p>{zh ? '本地与服务器内容均保留。逐项查看差异后，加载服务器版或明确以服务器最新修订为基准手动合并。' : 'Local and server versions are retained. Compare differences, then load the server version or explicitly use its revisions for a manual merge.'}</p><div className="team-conflict-columns"><details><summary>{zh ? '本地草稿' : 'Local draft'}</summary><pre>{JSON.stringify(state, null, 2)}</pre></details><details><summary>{zh ? '服务器最新内容' : 'Latest server content'}</summary><pre>{JSON.stringify({ config: draft.conflict.draft.config, display: draft.conflict.display, layout: draft.conflict.layout }, null, 2)}</pre></details></div><div className="team-inline-actions"><Button variant="outline" onClick={draft.useServer}>{zh ? '放弃本地并加载服务器' : 'Discard local and load server'}</Button><Button variant="outline" onClick={draft.mergeLocal}>{zh ? '保留本地，基于最新修订手动合并' : 'Keep local and manually merge against latest revision'}</Button></div></TeamNotice>}
    {panel !== 'organization' && panel !== 'overview' && <nav className="team-panel-tabs" aria-label={zh ? '团队工作区页面' : 'Team workspace panels'}>{(['overview', 'organization', 'history', 'sources', 'versions'].map(value => <Button key={value} variant={panel === value ? 'secondary' : 'ghost'} aria-current={panel === value ? 'page' : undefined} onClick={() => update({ panel: value === 'overview' ? null : value })}>{({ overview: zh ? '运行概览' : 'Overview', organization: zh ? '配置团队' : 'Configure team', history: zh ? '研究与交付' : 'Research and delivery', sources: zh ? '资料授权' : 'Source grants', versions: zh ? '发布历史' : 'Version history' })[value]}</Button>))}</nav>}
    {panel === 'overview' && <div className="space-y-5">

      <TeamRunPanel key={team.id} memberSettings={<div className="mt-3 space-y-3">
        <TeamAutoRunStaffing team={team} state={state} agents={roster.data?.items ?? []} models={models.data ?? []} zh={zh} dirty={draft.semanticDirty} disabled={readOnly || !networkReady || draft.save.isPending || !!draft.conflict || !!draft.recovery} loading={roster.isPending || models.isPending} loadError={roster.isError || models.isError} onReload={() => { void roster.refetch(); void models.refetch(); }} onEdit={edit} onPublish={() => void openPublish()} onConfigure={() => update({ panel: 'organization' })} />
        {!readOnly && <Button variant="ghost" size="sm" disabled={!networkReady} onClick={() => setRemovalOpen(true)}>{zh ? '移除团队' : 'Remove team'}</Button>}
      </div>} team={team} zh={zh} setupBlocked={readOnly || !networkReady || draft.save.isPending || !!draft.conflict || !!draft.recovery} onConfigure={() => { update({ panel: 'organization' }); const missing = state.config.roles.find(role => !role.agentId || !role.agentVersionId || !role.executor); if (missing) selectObjects([missing.id]); }} onPublish={() => void openPublish()} onBind={() => setBinding(true)} />
    </div>}
    {panel === 'organization' && <div className="team-organization" ref={organizationRef}>
      <div className="team-organization-grid">
        <section className="team-organization-card">
          <div className="team-section-title">
            <h2>{zh ? '团队组织' : 'Team organization'}</h2>
            <div className="team-view-switch" role="group" aria-label={zh ? '组织视图' : 'Organization view'}>
              <Button variant={!outline ? 'secondary' : 'ghost'} size="sm" aria-pressed={!outline}
                onClick={() => setViewMode('canvas')}>{zh ? '画布' : 'Canvas'}</Button>
              <Button variant={outline ? 'secondary' : 'ghost'} size="sm" aria-pressed={outline}
                onClick={() => setViewMode('list')}>{zh ? '列表' : 'List'}</Button>
            </div>
          </div>
          {outline
            ? <TeamOutline state={state} selected={selected} select={selectObjects} edit={edit} locate={locate} zh={zh} readOnly={readOnly} />
            : <TeamCanvas state={state} selected={selected} select={selectObjects} edit={edit}
              connect={(fromRoleId, toRoleId) => openRelation({ kind: 'add', fromRoleId, toRoleId })}
              onSelectRelation={(id, trigger) => openRelation({ kind: 'edit', id }, trigger)}
              filter={filter} zh={zh} readOnly={readOnly} locateId={locateId}
              fitInitial={draft.baseline.layoutRevision <= 1 || (state.layout.viewport.x === 0 && state.layout.viewport.y === 0)}
              assignAgent={assignAgent}
              onZoomChange={setZoom} registerControls={controls => { canvasControls.current = controls; }} />}
          {!outline && <p className="team-muted team-small">{zh ? '实线表示汇报，虚线表示协作。' : 'Solid lines show reporting. Dashed lines show collaboration.'}</p>}
          <div className="team-inline-actions">
            {!readOnly && <>
              <Button variant="outline" size="sm" disabled={state.config.roles.length >= 30} onClick={() => add('role')}>{zh ? '新增岗位' : 'Add role'}</Button>
              <Button variant="outline" size="sm" disabled={state.config.roles.length < 2}
                onClick={event => openRelation({ kind: 'add', fromRoleId: selectedRole?.id }, event.currentTarget)}>{zh ? '新增关系' : 'Add relation'}</Button>
            </>}
            {draft.history.past.length > 0 && !readOnly && <Button variant="ghost" size="sm" onClick={draft.undo}>{zh ? '撤销' : 'Undo'}</Button>}
            {draft.history.future.length > 0 && !readOnly && <Button variant="ghost" size="sm" onClick={draft.redo}>{zh ? '重做' : 'Redo'}</Button>}
          </div>
          <details className="team-editor-disclosure team-organization-tools">
            <summary>{zh ? '组织工具' : 'Organization tools'}<ChevronRight aria-hidden="true" /></summary>
            <div className="team-inspector-details">
              <div className="team-inline-actions">
                <Button ref={allRelationsTrigger} variant="outline" size="sm" onClick={event => openRelation({ kind: 'all' }, event.currentTarget)}>{zh ? '查看全部关系' : 'View all relations'}</Button>
                {!readOnly && <Button variant="outline" size="sm" onClick={() => add('department')}>{zh ? '新增部门' : 'Add department'}</Button>}
              </div>
              <TeamEditorToolbar view={outline ? 'list' : 'canvas'} readOnly={readOnly} zh={zh}
                onAutoLayout={applyAutoLayout} onFit={() => canvasControls.current?.fit()}
                onZoomIn={() => canvasControls.current?.zoomIn()} onZoomOut={() => canvasControls.current?.zoomOut()}
                onResetZoom={() => canvasControls.current?.resetZoom()} zoom={zoom} />
              {!outline && <TeamSelect label={zh ? '显示关系' : 'Visible relations'} value={filter} onChange={setFilter}
                options={[{ value: 'all', label: zh ? '全部关系' : 'All relations' }, { value: 'selected', label: zh ? '选中岗位的关系' : 'Selected role relations' },
                  ...(['reports_to', 'delegates_to', 'reviews'] as const).map(kind => ({ value: kind, label: relationLabel(kind, zh) }))]} />}
              <TeamEditorSidebar state={state} selected={selected} select={selectObjects} edit={edit}
                zh={zh} readOnly={readOnly} notify={notify} models={models.data ?? []} assignAgent={assignAgent} />
              <p className="team-muted team-small">{zh ? 'Ctrl/⌘ S 保存 · Ctrl/⌘ Z 撤销 · Shift Z 重做 · 画布方向键移动 · Delete 检查删除影响。'
                : 'Ctrl/⌘ S saves · Ctrl/⌘ Z undoes · Shift Z redoes · Arrow keys move canvas items · Delete reviews removal.'}</p>
            </div>
          </details>
        </section>
        <TeamInspector teamId={team.id} semanticRevision={draft.baseline.semanticRevision} state={state}
          selected={selected} edit={edit} remove={remove} duplicate={duplicate} zh={zh} readOnly={readOnly}
          openRelations={(roleId, trigger) => openRelation({ kind: 'related', roleId }, trigger)}
          clearSelection={() => selectObjects([])} sourceGrants={sources.data?.items ?? []} needsSave={draft.semanticDirty}
          workPlan={<TeamWorkPlanPreview teamId={team.id} semanticRevision={draft.baseline.semanticRevision} state={state}
            edit={edit} zh={zh} readOnly={readOnly} online={networkReady} />}
          saveAction={readOnly ? null : <div className="team-inline-actions">
            <Button variant="outline" disabled={readOnly || !networkReady || draft.save.isPending || !!draft.conflict || !!draft.recovery} onClick={() => void saveAll().catch(errorMessage)}>{draft.save.isPending ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存草稿' : 'Save draft')}</Button>
            {draft.dirty && <span role="status" className="team-muted team-small">{zh ? '有未保存更改' : 'Unsaved changes'}</span>}
          </div>}
        />
      </div>
      {!!issues.length && <div className="team-graph-issues">
        <strong>{zh ? `${issues.length} 项待修正` : `${issues.length} issues to resolve`}</strong>
        {issues.map((issue, index) => <Button key={`${issue.code}-${index}`} variant="ghost" size="sm"
          onClick={event => repairIssue(issue, event.currentTarget)}>
          {teamIssueMessage(issue, zh)}{issue.objectIds.map(id => state.display.roleLabels[id] ?? state.display.departmentLabels[id]).filter(Boolean).map(label => ` · ${label}`).join('')}
        </Button>)}
      </div>}
      <div className="team-inline-actions">
        {!readOnly && <Button disabled={readOnly || !networkReady || draft.save.isPending || !!draft.conflict || !!draft.recovery} onClick={() => void openPublish()}>{zh ? '核对并发布版本' : 'Review and publish version'}</Button>}
        <Button asChild variant="ghost" className="team-return-to-run">
          <Link to={`/teams/${encodeURIComponent(team.id)}?panel=overview`}>{zh ? '返回运行概览' : 'Back to run overview'}</Link>
        </Button>
      </div>
      <Button variant="outline" className="team-version-link" onClick={() => update({ panel: 'versions' })}>
        {zh ? '版本历史与变更' : 'Version history and changes'}<ChevronRight aria-hidden="true" />
      </Button>
      <details className="team-editor-disclosure">
        <summary>{zh ? '团队管理' : 'Team management'}<ChevronRight aria-hidden="true" /></summary>
        <div className="team-inspector-details">
          <p>{team.status === 'archived' ? (zh ? '已归档 · 只读历史' : 'Archived · read-only history') : team.currentVersion ? `v${team.currentVersion} ${zh ? '已发布' : 'published'}` : (zh ? '尚未发布' : 'Not published')} · {team.accountId ? (zh ? '已关联模拟盘' : 'Simulation linked') : (zh ? '未关联账户' : 'Unlinked')}</p>
          <div className="team-inline-actions">
            <Button variant="outline" size="sm" onClick={() => update({ panel: 'history' })}>{zh ? '研究与交付' : 'Research and delivery'}</Button>
            <Button variant="outline" size="sm" onClick={() => update({ panel: 'sources' })}>{zh ? '资料授权' : 'Source grants'}</Button>
            {team.accountId && <Button asChild variant="outline" size="sm"><Link to={`/holdings?accountId=${encodeURIComponent(team.accountId)}`}>{zh ? '查看资产' : 'View assets'}</Link></Button>}
            {!readOnly && <>
              <Button size="sm" variant="outline" disabled={!networkReady || !team.currentVersionId} onClick={() => setBinding(true)}>{team.binding ? (zh ? '账户交接' : 'Account handoff') : (zh ? '关联账户' : 'Link account')}</Button>
              <Button size="sm" variant="outline" disabled={!networkReady || !team.capabilities.researchEnabled || !team.binding || !team.currentVersionId} onClick={() => setCommission(true)}>{zh ? '发起研究' : 'Start research'}</Button>
              <Button size="sm" variant="ghost" disabled={!networkReady} onClick={() => setRemovalOpen(true)}>{zh ? '移除团队' : 'Remove team'}</Button>
            </>}
          </div>
        </div>
      </details>
    </div>}
    {panel === 'history' && <TeamWorkHistory team={team} zh={zh} online={networkReady} commissionId={params.get('commissionId') ?? ''} selectCommission={id => update({ commissionId: id })} />}
    {panel === 'sources' && <TeamSources team={team} zh={zh} online={networkReady} readOnly={readOnly} />}
    {panel === 'versions' && <section className="team-version-history"><div className="team-section-title"><h2>{zh ? '不可变发布版本' : 'Immutable published versions'}</h2><Button variant="outline" disabled={readOnly || !networkReady} onClick={() => void saveAll().then(() => setArchive(true)).catch(errorMessage)}><Archive size={15} />{zh ? '归档团队' : 'Archive team'}</Button></div>{versions.isError && <TeamLoadError zh={zh} retry={() => void versions.refetch()} />}{versions.isPending && <p role="status">{zh ? '读取版本…' : 'Loading versions…'}</p>}{versions.data?.pages.flatMap(page => page.items).map(version => <article className="team-version" key={version.id}><div className="team-section-title"><div><h3>v{version.version} · {version.displaySnapshot.name}</h3><p className="team-muted">{version.createdAt} · r{version.semanticRevision}</p></div><Button variant="outline" disabled={readOnly} onClick={() => { draft.edit(restoreTeamVersion(state, version)); draft.setMessage(zh ? `v${version.version} 已复制到本地草稿，需保存并重新检查发布。历史版本未改变。` : `v${version.version} copied into the local draft. Save and review publication. Historical versions are unchanged.`); update({ panel: 'organization' }); }}><Copy size={14} />{zh ? '复制为草稿' : 'Copy into draft'}</Button></div><div className="team-summary-grid"><TeamKeyValue label={zh ? '岗位' : 'Roles'}>{version.config.roles.length}</TeamKeyValue><TeamKeyValue label={zh ? '部门 / 关系' : 'Departments / relations'}>{version.config.departments.length} / {version.config.relations.length}</TeamKeyValue></div><details><summary>{zh ? '查看固定组织与职责' : 'View frozen organization and responsibilities'}</summary><pre>{JSON.stringify({ config: version.config, display: version.displaySnapshot }, null, 2)}</pre></details></article>)}{versions.data && !versions.data.pages.some(page => page.items.length) && <p className="team-muted">{zh ? '尚未发布版本。保存草稿后可检查发布；不要求绑定账户。' : 'No published versions. Save a draft and review publication; an account binding is not required.'}</p>}{versions.hasNextPage && <Button variant="outline" disabled={versions.isFetchingNextPage} onClick={() => void versions.fetchNextPage()}>{zh ? '更早版本' : 'Earlier versions'}</Button>}</section>}
    <TeamPublishDialog team={publishTeam} open={publish} close={() => setPublish(false)} committed={committed} zh={zh} online={networkReady} />
    <TeamBindingDialog AccountCreator={CreateSimulationAccount} team={team} open={binding} close={() => { setBinding(false); if (params.has('bindingAccount') || params.get('panel') === 'binding') update({ bindingAccount: null, panel: null }); }} committed={committed} zh={zh} online={networkReady} initialAccountId={params.get('bindingAccount') ?? ''} />
    <TeamRemovalDialog team={team} open={removalOpen} close={() => setRemovalOpen(false)} committed={next => { committed(next); navigate('/teams?advanced=1'); }} zh={zh} online={networkReady} />
    <TeamArchiveDialog team={team} open={archive} close={() => setArchive(false)} committed={committed} zh={zh} online={networkReady} />
    <TeamCommissionDialog team={team} open={commission} close={() => setCommission(false)} started={id => { update({ panel: 'history', commissionId: id }); void client.invalidateQueries({ queryKey: teamKeys.all }); }} zh={zh} online={networkReady} />
    {panel === 'organization' && <TeamRelations state={state} view={relationView ?? (legacyRelations ? { kind: 'all' } : null)}
      show={setRelationView} close={closeRelation} apply={applyRelation} onRestoreFocus={restoreRelationFocus} zh={zh} readOnly={readOnly} />}
    <Dialog open={removeOpen} onOpenChange={setRemoveOpen}><DialogContent><DialogHeader><DialogTitle>{zh ? '检查删除与解散影响' : 'Review removal and dissolve impact'}</DialogTitle><DialogDescription>{zh ? '只修改当前草稿，已发布版本、研究和账本不删除。解散部门默认保留内容，子节点移到上级。' : 'Only edits the current draft. Published versions, research and ledgers remain. Dissolving a department keeps its contents and moves children to its parent by default.'}</DialogDescription></DialogHeader><p>{selectedRoleCount} {zh ? '岗位' : 'roles'} · {selectedDepartmentCount} {zh ? '部门' : 'departments'} · {relationImpacts.length} {zh ? '条直接关联关系' : 'directly affected relations'}</p><p className="team-muted">{selected.map(id => state.display.roleLabels[id] ?? state.display.departmentLabels[id] ?? id).join(', ')}</p>{selectedDepartmentCount > 0 && <label className="team-check-row"><Checkbox checked={deleteContents} onCheckedChange={value => setDeleteContents(value === true)} />{zh ? '同时删除部门全部内容（岗位、嵌套部门与关联关系）' : 'Also remove all department contents, nested groups and relations'}</label>}<div className="team-dialog-actions"><Button variant="outline" onClick={() => setRemoveOpen(false)}>{zh ? '取消' : 'Cancel'}</Button><Button variant="destructive" onClick={confirmRemove}>{zh ? '确认修改草稿' : 'Confirm draft edit'}</Button></div></DialogContent></Dialog>
    <Dialog open={!!leaveTo} onOpenChange={value => { if (!value) setLeaveTo(''); }}><DialogContent><DialogHeader><DialogTitle>{zh ? '离开前处理未保存改动' : 'Handle unsaved edits before leaving'}</DialogTitle><DialogDescription>{zh ? '保存失败会留在当前页。放弃只丢弃当前本地编辑，不影响服务器已保存的草稿。' : 'A failed save keeps this page open. Discard affects only local edits, not the server draft.'}</DialogDescription></DialogHeader><div className="team-dialog-actions"><Button variant="outline" onClick={() => setLeaveTo('')}>{zh ? '继续编辑' : 'Keep editing'}</Button><Button variant="outline" onClick={() => { draft.reset(); navigate(leaveTo); }}>{zh ? '放弃并离开' : 'Discard and leave'}</Button><Button disabled={!networkReady || draft.save.isPending || !!draft.conflict} onClick={() => void saveAll().then(() => navigate(leaveTo)).catch(errorMessage)}>{zh ? '保存并离开' : 'Save and leave'}</Button></div></DialogContent></Dialog>
  </section>;
}

export function TeamWorkspacePage() {
  const { id = '' } = useParams(); const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const query = useQuery({ queryKey: teamKeys.detail(id), queryFn: () => teamsApi.detail(id), enabled: !!id, retry: false });
  if (query.isPending) return <section className="team-workspace"><p role="status">{zh ? '读取团队…' : 'Loading team…'}</p></section>;
  if (query.isError && !query.data) return <section className="team-workspace"><TeamLoadError zh={zh} retry={() => void query.refetch()} message={friendlyError(query.error, zh, { zh: '此团队暂不可访问。未切换到其他团队。', en: 'This team is unavailable. No other team was substituted.' })} /><Button asChild variant="outline"><Link to="/teams">{zh ? '返回团队列表' : 'Back to teams'}</Link></Button></section>;
  return query.data ? <TeamEditor key={id} team={query.data} zh={zh} /> : null;
}
export default TeamWorkspacePage;
