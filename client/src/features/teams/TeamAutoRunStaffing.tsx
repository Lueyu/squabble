import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AgentProfile } from '@shared/agent-roster.interface';
import type { ModelConnection } from '@shared/model-connections.interface';
import type { TeamDetail } from '@shared/team-workspace.interface';
import { Button } from '@/components/ui/button';
import { teamOnboardingPath } from '@/features/onboarding/onboarding-state';
import type { TeamEditorState } from './team-graph';
import { applySuggestedTeamStaffing, assignAgentToRole, staffingFailureMessage, suggestTeamStaffing } from './team-staffing';

interface Props {
  team: TeamDetail;
  state: TeamEditorState;
  agents: AgentProfile[];
  models: ModelConnection[];
  zh: boolean;
  disabled: boolean;
  loading?: boolean;
  loadError?: boolean;
  dirty: boolean;
  onEdit: (state: TeamEditorState) => void;
  onPublish: () => void;
  onConfigure: () => void;
  onReload?: () => void;
}

/** Prepare seats in the ordinary draft; publication and run authorization remain explicit steps. */
export function TeamAutoRunStaffing({ team, state, agents, models, zh, disabled, loading, loadError, dirty, onEdit, onPublish, onConfigure, onReload }: Props) {
  const [failure, setFailure] = useState('');
  const [params] = useSearchParams();
  const onboarding = params.get('onboarding') === '1';
  const friendsPath = onboarding ? `/friends?${new URLSearchParams({ onboarding: '1', returnTo: teamOnboardingPath(team.id) })}` : '/friends';
  const published = team.publishedVersion?.config;
  const publishedMembers = published?.roles.filter(role => role.participation === 'enabled') ?? [];
  const required = published?.workBlueprint ? new Set([published.defaults.leadRoleId, published.workBlueprint.summary.reviewerRoleId, ...published.workBlueprint.works.flatMap(work => [work.roleId, work.reviewerRoleId])]) : new Set<string | null>();
  const publishedReady = publishedMembers.length > 0 && publishedMembers.every(role => role.agentId && role.agentVersionId && role.executor)
    && [...required].every(id => publishedMembers.some(role => role.id === id));
  const changed = dirty || JSON.stringify(state.config) !== JSON.stringify(published);
  if (team.status === 'archived' || publishedReady && !changed) return null;

  const suggestions = suggestTeamStaffing(state, agents);
  const active = agents.filter(agent => agent.status === 'active' && agent.availability === 'configured');
  const suggestedCount = Object.keys(suggestions.assignments).length;
  const blocked = disabled || loading || loadError;
  const change = (apply: () => TeamEditorState): void => {
    try { onEdit(apply()); setFailure(''); }
    catch (error) { setFailure(staffingFailureMessage(error, zh)); }
  };
  return <section className="rounded-xl border bg-card p-5 sm:p-6 space-y-4" aria-label={zh ? '准备自动运行成员' : 'Prepare automatic run members'}>
    <div>
      <h2 className="text-xl font-semibold">{zh ? '先让岗位有人负责' : 'Staff the team first'}</h2>
      <p className="text-sm text-muted-foreground mt-2">{zh ? '从已有股友为岗位配员，保存并检查发布后，再关联模拟盘、核对预算并启动。应用建议只改草稿，不发布、不发起研究。' : 'Assign saved friends, save and review publication, then link a paper account and review the run budget. Applying suggestions only edits the draft; it does not publish or start research.'}</p>
    </div>
    {loading && <p role="status">{zh ? '正在读取股友和连接…' : 'Loading saved friends and connections…'}</p>}
    {loadError && <p role="alert">{zh ? '股友或连接读取失败，现有配置保留。' : 'Friends or connections could not load. Existing configuration is retained.'}<Button variant="ghost" onClick={onReload}>{zh ? '重试读取' : 'Retry reading'}</Button></p>}
    {onboarding && !loading && !loadError && active.length === 0 && <p className="text-sm text-muted-foreground">
      {agents.some(agent => agent.status === 'active')
        ? (zh ? '已有股友的执行连接待配置。' : 'Your agents need a configured connection.')
        : (zh ? '添加第一位股友后即可为岗位配员。' : 'Add your first agent to staff a seat.')}
    </p>}
    <ul className="space-y-3">
      {state.config.roles.map(role => {
        const current = agents.find(agent => agent.id === role.agentId);
        const proposed = agents.find(agent => agent.id === suggestions.assignments[role.id]);
        const label = state.display.roleLabels[role.id] ?? role.id;
        return <li className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2" key={role.id}>
          <div><strong className="break-words">{label}</strong><p className="text-xs text-muted-foreground mt-1">{role.agentId ? (current?.name ?? (zh ? '已关联股友' : 'Saved friend assigned')) : proposed ? `${zh ? '建议' : 'Suggested'}: ${proposed.name}` : (zh ? '请选择股友，或进入配置调整岗位。' : 'Choose a friend or edit this seat in configuration.')}</p></div>
          <label className="text-sm"><span className="sr-only">{zh ? `为${label}选择股友` : `Choose a friend for ${label}`}</span><select className="w-full rounded-md border bg-background p-2" value={role.agentId ?? ''} disabled={Boolean(blocked)} onChange={event => { const agentId = event.target.value; if (agentId) change(() => assignAgentToRole(state, role.id, agentId, agents, models)); }}>
            <option value="">{zh ? '选择已有股友' : 'Choose a saved friend'}</option>
            {active.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.specialty}</option>)}
            {role.agentId && !active.some(agent => agent.id === role.agentId) && <option value={role.agentId}>{current?.name ?? (zh ? '原股友不可用' : 'Original friend unavailable')}</option>}
          </select></label>
        </li>;
      })}
    </ul>
    {failure && <p role="alert" className="text-sm">{failure}</p>}
    <div className="flex flex-wrap gap-2">
      {suggestedCount > 0 && <Button variant="secondary" disabled={Boolean(blocked)} onClick={() => change(() => applySuggestedTeamStaffing(state, suggestions.assignments, agents, models))}>{zh ? '应用建议股友' : 'Apply suggested friends'}</Button>}
      <Button disabled={Boolean(blocked) || !state.config.roles.some(role => role.participation === 'enabled' && role.agentId && role.executor)} onClick={onPublish}>{zh ? '保存并检查发布' : 'Save and review publication'}</Button>
      <Button variant="outline" onClick={onConfigure}>{zh ? '调整组织与成员' : 'Edit organization and members'}</Button>
      <Button asChild variant="ghost"><Link to={friendsPath}>{onboarding && !active.length ? (zh ? '前往股友库' : 'Go to my agents') : (zh ? '管理我的股友' : 'Manage saved friends')}</Link></Button>
    </div>
  </section>;
}
