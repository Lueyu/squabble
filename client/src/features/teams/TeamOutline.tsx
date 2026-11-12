import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, LocateFixed, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { objectParent, type TeamEditorState } from './team-graph';
import { useQuery } from '@tanstack/react-query';
import { agentRosterApi } from '@/api/agent-roster';
import { AgentIdentity } from '@/features/agent-roster/AgentIdentity';

export function TeamOutline({ state, selected, select, edit, locate, zh, readOnly }: { state: TeamEditorState; selected: string[]; select: (ids: string[]) => void; edit: (state: TeamEditorState) => void; locate: (id: string) => void; zh: boolean; readOnly: boolean }) {
  const [search, setSearch] = useState('');
  const roster = useQuery({ queryKey: ['agent-roster'], queryFn: agentRosterApi.list, retry: false });
  const query = search.trim().toLocaleLowerCase();
  const matches = (id: string): boolean => `${state.display.roleLabels[id] ?? state.display.departmentLabels[id] ?? ''} ${state.config.roles.find(r => r.id === id)?.responsibility ?? ''}`.toLocaleLowerCase().includes(query);
  const toggle = (id: string): void => { edit({ ...state, layout: { ...state.layout, collapsedDepartmentIds: state.layout.collapsedDepartmentIds.includes(id) ? state.layout.collapsedDepartmentIds.filter(value => value !== id) : [...state.layout.collapsedDepartmentIds, id] } }); };
  const row = (id: string, department: boolean, depth: number): React.ReactNode => {
    const role = state.config.roles.find(r => r.id === id); const agent = roster.data?.items.find(person => person.id === role?.agentId); const collapsed = state.layout.collapsedDepartmentIds.includes(id); const label = (department ? state.display.departmentLabels[id] : state.display.roleLabels[id]) || (zh ? '未命名' : 'Untitled');
    return <div key={id} className="team-outline-branch"><div className={`team-outline-row${selected.includes(id) ? ' is-selected' : ''}`} style={{ paddingLeft: 10 + Math.min(depth, 8) * 16 }}>
      <Checkbox checked={selected.includes(id)} aria-label={`${zh ? '选择' : 'Select'} ${label}`} onCheckedChange={checked => select(checked ? [...new Set([...selected, id])] : selected.filter(value => value !== id))} />
      {department ? <Button variant="ghost" size="icon" aria-label={`${collapsed ? (zh ? '展开' : 'Expand') : (zh ? '折叠' : 'Collapse')} ${label}`} onClick={() => toggle(id)} disabled={readOnly}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</Button> : <span className="team-outline-spacer" />}
      {department ? <Folder size={16} /> : agent ? <AgentIdentity avatar={agent.avatar} avatarClassName="size-8" /> : <UserRound size={16} />}<Button variant="ghost" className="team-outline-label" aria-pressed={selected.includes(id)} onClick={() => select([id])}><span>{agent?.name ?? label}</span>{role && <small>{agent && agent.name !== label ? `${label} · ` : ''}{role.participation === 'placeholder' || !role.executor ? (zh ? '待配置 · 不参与' : 'Placeholder · inactive') : (zh ? '已配置' : 'Configured')}</small>}</Button><Button variant="ghost" size="icon" aria-label={`${zh ? '定位' : 'Locate'} ${label}`} onClick={() => locate(id)}><LocateFixed size={15} /></Button></div>
      {department && !collapsed && !query && renderChildren(id, depth + 1)}
    </div>;
  };
  const renderChildren = (parent: string | null, depth: number): React.ReactNode => <>{state.config.departments.filter(d => d.parentDepartmentId === parent).map(d => row(d.id, true, depth))}{state.config.roles.filter(r => r.departmentId === parent).map(r => row(r.id, false, depth))}</>;
  return <section className="team-outline" aria-label={zh ? '组织列表与键盘编辑' : 'Organization list and keyboard editing'}><Input aria-label={zh ? '搜索岗位或部门' : 'Find roles or departments'} value={search} onChange={event => setSearch(event.target.value)} placeholder={zh ? '搜索岗位、部门或职责…' : 'Find roles, departments, responsibility…'} />
    <p className="team-muted team-small">{zh ? '选择后在属性中移组、配置连接；所有连线均可在关系列表编辑。' : 'Select items to regroup and configure connections. Edit every connection in the relations list.'}</p>
    {query ? [...state.config.departments, ...state.config.roles].filter(item => matches(item.id)).map(item => row(item.id, 'purpose' in item, 0)) : renderChildren(null, 0)}
    {!state.config.roles.length && !state.config.departments.length && <div className="team-empty-inline"><Folder size={28} /><p>{zh ? '从任意部门或岗位开始，组织可以自由嵌套。' : 'Start with any department or role. Nest departments freely.'}</p></div>}
    {!!query && <p className="team-muted team-small">{zh ? '定位会展开上级部门；搜索不会删除或改变组织。' : 'Locate expands ancestors. Search never removes or changes the organization.'}</p>}
  </section>;
}
