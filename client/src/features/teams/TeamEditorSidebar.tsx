import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { LayoutTemplate, Search } from 'lucide-react';
import { TEAM_TEMPLATES } from '@shared/team-templates';
import { agentRosterApi } from '@/api/agent-roster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AgentIdentity } from '@/features/agent-roster/AgentIdentity';
import type { ModelConnection } from '@shared/model-connections.interface';
import { draftWithTemplate } from './team-template-instantiation';
import { assignAgentToRole, staffingFailureMessage } from './team-staffing';
import type { TeamEditorState } from './team-graph';

interface TeamEditorSidebarProps {
  state: TeamEditorState;
  selected: string[];
  select: (ids: string[]) => void;
  edit: (state: TeamEditorState) => void;
  zh: boolean;
  readOnly: boolean;
  notify: (message: string) => void;
  models?: ModelConnection[];
  assignAgent?: (roleId: string, agentId: string) => void;
}

export function TeamEditorSidebar({ state, selected, select, edit, zh, readOnly, notify, models = [], assignAgent }: TeamEditorSidebarProps) {
  const { i18n } = useTranslation();
  const zhText = zh || i18n.language.startsWith('zh');
  const [query, setQuery] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyId, setApplyId] = useState<string | null>(null);
  const [tab, setTab] = useState<'friends' | 'templates'>('friends');
  const [friendId, setFriendId] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const roster = useQuery({ queryKey: ['agent-roster'], queryFn: agentRosterApi.list, retry: false });
  const filter = query.trim().toLocaleLowerCase();
  const friends = useMemo(() => (roster.data?.items ?? []).filter(person => `${person.name} ${person.specialty}`.toLocaleLowerCase().includes(filter)), [roster.data, filter]);
  const selectedTemplate = TEAM_TEMPLATES.find(item => item.id === applyId);
  const selectedRoles = state.config.roles.filter(role => selected.includes(role.id));
  const selectedRole = selectedRoles.length === 1 ? selectedRoles[0] : undefined;
  const chosenFriend = roster.data?.items.find(person => person.id === friendId);
  const friendUnavailable = chosenFriend?.status === 'archived' || chosenFriend?.availability !== 'configured';
  const assign = (): void => {
    if (!chosenFriend || !selectedRole) return;
    try {
      const next = assignAgentToRole(state, selectedRole.id, chosenFriend.id, roster.data?.items ?? [], models, { readOnly });
      if (assignAgent) assignAgent(selectedRole.id, chosenFriend.id);
      else {
        edit(next);
        notify(zhText ? '股友已指派到当前草稿。可撤销；保存和发布需另行确认。' : 'Agent assigned in the current draft. Undoable; saving and publication require separate confirmation.');
      }
      setFailure('');
    } catch (error) {
      const message = staffingFailureMessage(error, zhText);
      setFailure(message);
      notify(message);
    }
  };
  return <aside className="team-editor-sidebar" aria-label={zhText ? '组织编辑侧栏' : 'Organization editing sidebar'}>
    <div className="team-sidebar-tabs" role="tablist" aria-label={zhText ? '侧栏内容' : 'Sidebar content'}>
      {(['friends', 'templates'] as const).map((value, index) => <button type="button" key={value} id={`team-sidebar-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls={`team-sidebar-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = ['friends', 'templates'] as const;
        const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index];
        setTab(next);
        document.getElementById(`team-sidebar-tab-${next}`)?.focus();
      }}>{value === 'friends' ? (zhText ? '股友库' : 'Friends') : (zhText ? '模板' : 'Templates')}</button>)}
    </div>
    <div className="team-sidebar-panel" data-sidebar-tab={tab} id={`team-sidebar-panel-${tab}`} role="tabpanel" aria-labelledby={`team-sidebar-tab-${tab}`}>
    {tab === 'friends' && <section className="team-sidebar-section">
      <div className="team-sidebar-search"><Search size={14} /><Input aria-label={zhText ? '搜索股友' : 'Find friends'} placeholder={zhText ? '按姓名或专长搜索…' : 'By name or specialty…'} value={query} onChange={event => setQuery(event.target.value)} /></div>
      {roster.isPending && <p role="status" className="team-muted team-small">{zhText ? '正在读取股友库…' : 'Loading friends…'}</p>}
      {roster.isError && <div role="alert" className="team-sidebar-assignment"><p>{zhText ? '股友库读取失败，请重试。' : 'Could not load friends. Try again.'}</p><Button variant="outline" size="sm" onClick={() => void roster.refetch()}>{zhText ? '重试' : 'Retry'}</Button></div>}
      <ul className="team-sidebar-friends" aria-label={zhText ? '我的股友列表' : 'My friends list'}>
        {friends.map(person => <li key={person.id}><button type="button" className={`team-sidebar-friend-option${person.id === friendId ? ' is-selected' : ''}`} aria-pressed={person.id === friendId} draggable={!readOnly && person.status === 'active' && person.availability === 'configured'} onClick={() => { setFriendId(person.id); setFailure(''); }} onDragStart={event => { event.dataTransfer.setData('application/x-squabble-agent', person.id); event.dataTransfer.effectAllowed = 'copy'; setFriendId(person.id); }}>
          <AgentIdentity avatar={person.avatar} avatarClassName="size-8" />
          <span className="team-sidebar-friend"><strong>{person.name}</strong><small>{person.specialty}</small><small className="team-sidebar-friend-state">{person.status === 'archived' ? (zhText ? '已归档 · 不可指派' : 'Archived · cannot assign') : person.availability === 'configured' ? (zhText ? '连接已配置' : 'Connection configured') : (zhText ? '连接待配置 · 不可指派' : 'Connection required · cannot assign')}</small></span>
        </button>
        </li>)}
        {!roster.isPending && !roster.isError && !friends.length && <li className="team-muted team-small">{filter ? (zhText ? '没有匹配的股友，请调整搜索。' : 'No matching friends. Adjust your search.') : (zhText ? '股友库为空。先在股友库添加股友，再来指派。' : 'Your friend roster is empty. Add an agent there, then assign it here.')}</li>}
      </ul>
      <div className="team-sidebar-assignment">
        <p className="team-muted team-small">{selectedRole ? (zhText ? `指派岗位：${state.display.roleLabels[selectedRole.id] || '未命名岗位'}` : `Assign to: ${state.display.roleLabels[selectedRole.id] || 'Untitled seat'}`) : (zhText ? '先在画布或目录选择一个岗位，再选择股友。' : 'Select one seat on the canvas or outline, then choose an agent.')}</p>
        {chosenFriend && friendUnavailable && <p className="team-muted team-small">{chosenFriend.status === 'archived' ? (zhText ? '这位股友已归档，不能指派。' : 'This agent is archived and cannot be assigned.') : (zhText ? '请先在股友库配置这位股友的连接。' : 'Configure this agent’s connection in the friend roster first.')}</p>}
        <Button size="sm" disabled={readOnly || !selectedRole || !chosenFriend || friendUnavailable || roster.isPending || roster.isError} onClick={assign}>{zhText ? '指派到所选岗位' : 'Assign to selected seat'}</Button>
        {failure && <p role="alert" className="team-small">{failure}</p>}
        <p className="team-muted team-small">{zhText ? '也可把已连接股友拖到岗位上。指派只改草稿，不增加资料权限；可撤销。' : 'You can also drag a connected agent onto a seat. Assignment changes the draft and is undoable; it grants no source access.'}</p>
      </div>
    </section>}
    {tab === 'templates' && <section className="team-sidebar-section">
      <Button variant="outline" size="sm" disabled={readOnly} onClick={() => { setApplying(true); setApplyId(null); }}><LayoutTemplate size={14} />{zhText ? '应用模板到当前草稿' : 'Apply a template to this draft'}</Button>
      <p className="team-muted team-small">{zhText ? '应用只替换当前草稿结构并可撤销；已发布版本与运行协议不变。' : 'Applying only replaces the current draft structure and is undoable; published versions and run agreements stay untouched.'}</p>
    </section>}
    </div>
    <Dialog open={applying} onOpenChange={setApplying}>
      <DialogContent className="team-dialog">
        <DialogHeader>
          <DialogTitle>{zhText ? '选择组织模板' : 'Choose an organization template'}</DialogTitle>
          <DialogDescription>{zhText ? '模板会替换当前草稿的部门、岗位、关系与默认研究分工。先检查差异再确认；历史版本与研究不被改动。' : 'A template replaces the draft departments, seats, relations and default division of labour. Review the difference before confirming; versions and research stay untouched.'}</DialogDescription>
        </DialogHeader>
        <div className="team-template-grid">
          {TEAM_TEMPLATES.map(item => <button key={item.id} type="button" role="radio" aria-checked={applyId === item.id} className={`team-template-card${applyId === item.id ? ' is-selected' : ''}`} onClick={() => setApplyId(item.id)}>
            <strong>{item.name[zhText ? 'zh-CN' : 'en']}</strong>
            <span>{item.config.roles.length} {zhText ? '岗位' : 'roles'} · {item.config.departments.length} {zhText ? '部门' : 'departments'}</span>
            <p>{item.description[zhText ? 'zh-CN' : 'en']}</p>
          </button>)}
        </div>
        {selectedTemplate && <p className="team-muted team-small">{zhText ? `将移除当前草稿 ${state.config.roles.length} 个岗位、${state.config.departments.length} 个部门与 ${state.config.relations.length} 条关系，替换为模板的 ${selectedTemplate.config.roles.length} 岗 / ${selectedTemplate.config.departments.length} 部门。执行者与资料授权不会自动迁移。` : `This removes ${state.config.roles.length} current seats, ${state.config.departments.length} departments and ${state.config.relations.length} relations, replaced by the template's ${selectedTemplate.config.roles.length} seats / ${selectedTemplate.config.departments.length} departments. Executors and source grants are not migrated automatically.`}</p>}
        <div className="team-dialog-actions">
          <Button variant="outline" onClick={() => setApplying(false)}>{zhText ? '取消' : 'Cancel'}</Button>
          <Button disabled={!applyId} onClick={() => {
            if (!selectedTemplate) return;
            edit(draftWithTemplate(state, selectedTemplate, () => crypto.randomUUID()));
            select([]);
            setApplying(false);
            notify(zhText ? '模板已应用到当前草稿。可撤销；保存并发布才会成为新版本。' : 'Template applied to the current draft. Undoable; it becomes a new version only after saving and publishing.');
          }}>{zhText ? '替换当前草稿结构' : 'Replace the draft structure'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </aside>;
}
