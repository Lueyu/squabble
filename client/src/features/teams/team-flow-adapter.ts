import { MarkerType, type BuiltInEdge, type Edge, type Node } from '@xyflow/react';
import type { DragEvent } from 'react';
import type { TeamEditorState } from './team-graph';
import { objectParent, relationLabel } from './team-graph';
import type { AgentProfile } from '@shared/agent-roster.interface';
export interface TeamNodeData extends Record<string, unknown> { label: string; agentName?: string; avatar?: AgentProfile['avatar']; subtitle: string; department: boolean; placeholder: boolean; shared: boolean; collapsed: boolean; zh: boolean; dropState?: 'ready' | 'blocked'; onAgentDragOver?: (id: string, event: DragEvent<HTMLDivElement>) => void; onAgentDragLeave?: (id: string) => void; onAgentDrop?: (id: string, event: DragEvent<HTMLDivElement>) => void; onResize?: (id: string, width: number, height: number) => void; onToggle?: (id: string) => void }
export type TeamFlowNode = Node<TeamNodeData, 'teamRole' | 'teamDepartment'>;
export function toTeamFlow(state: TeamEditorState, selected: string[], filter: string, zh: boolean, agents: Pick<AgentProfile, 'id' | 'name' | 'avatar'>[] = []): { nodes: TeamFlowNode[]; edges: Edge[] } {
  const hidden = (id: string): boolean => { let parent = objectParent(state.config, id); const seen = new Set<string>(); while (parent && !seen.has(parent)) { if (state.layout.collapsedDepartmentIds.includes(parent)) return true; seen.add(parent); parent = objectParent(state.config, parent); } return false; };
  const departments = [...state.config.departments];
  const depth = (id: string): number => { let n = 0; let parent = objectParent(state.config, id); const seen = new Set<string>(); while (parent && !seen.has(parent)) { seen.add(parent); n++; parent = objectParent(state.config, parent); } return n; };
  departments.sort((a, b) => depth(a.id) - depth(b.id));
  const nodes: TeamFlowNode[] = departments.map(d => { const p = state.layout.positions[d.id] ?? { x: 0, y: 0 }; const collapsed = state.layout.collapsedDepartmentIds.includes(d.id); return { id: d.id, type: 'teamDepartment', parentId: d.parentDepartmentId ?? undefined, position: { x: p.x, y: p.y }, style: { width: p.width ?? 600, height: collapsed ? 64 : p.height ?? 400 }, hidden: hidden(d.id), selected: selected.includes(d.id), data: { label: state.display.departmentLabels[d.id] || (zh ? '未命名部门' : 'Untitled department'), subtitle: d.purpose, department: true, placeholder: false, shared: false, collapsed, zh }, zIndex: 0 }; });
  const executorKey = (role: typeof state.config.roles[number]): string => role.executor ? role.executor.executionMode === 'local' ? `local:${role.executor.localAgentId}` : `model:${role.executor.connectionId}` : '';
  state.config.roles.forEach(r => { const p = state.layout.positions[r.id] ?? { x: 0, y: 0 }; const key = executorKey(r); const agent = agents.find(person => person.id === r.agentId); const shared = Boolean(key && state.config.roles.filter(other => executorKey(other) === key).length > 1); nodes.push({ id: r.id, type: 'teamRole', parentId: r.departmentId ?? undefined, position: { x: p.x, y: p.y }, selected: selected.includes(r.id), hidden: hidden(r.id), ariaLabel: state.display.roleLabels[r.id], data: { label: state.display.roleLabels[r.id] || (zh ? '未命名岗位' : 'Untitled role'), agentName: agent?.name, avatar: agent?.avatar, subtitle: r.responsibility || (zh ? '添加职责与预期交付' : 'Add responsibility and delivery'), department: false, placeholder: r.participation === 'placeholder' || !r.executor, shared, collapsed: false, zh }, zIndex: 5 }); });
  const samePair = (left: typeof state.config.relations[number], right: typeof left): boolean => [left.fromRoleId, left.toRoleId].sort().join(':') === [right.fromRoleId, right.toRoleId].sort().join(':');
  const edges: Edge[] = state.config.relations.filter(r => filter === 'all' || (filter === 'selected' ? selected.includes(r.id) || selected.includes(r.fromRoleId) || selected.includes(r.toRoleId) : r.kind === filter)).map(r => {
    const peers = state.config.relations.filter(other => samePair(r, other)).sort((a, b) => a.id.localeCompare(b.id));
    const lane = peers.findIndex(other => other.id === r.id);
    const label = `${relationLabel(r.kind, zh)}${r.responsibilityScope ? ` · ${r.responsibilityScope}` : ''}`;
    const edge: BuiltInEdge = {
      id: r.id, source: r.fromRoleId, target: r.toRoleId, type: 'smoothstep', selected: selected.includes(r.id), hidden: hidden(r.fromRoleId) || hidden(r.toRoleId),
      label: selected.includes(r.id) ? label : undefined,
      ariaLabel: `${state.display.roleLabels[r.fromRoleId] || r.fromRoleId} → ${state.display.roleLabels[r.toRoleId] || r.toRoleId}: ${label}`,
      pathOptions: { offset: 24 + lane * 22, stepPosition: (lane + 1) / (peers.length + 1), borderRadius: 10 },
      style: { stroke: r.kind === 'reports_to' ? 'var(--muted-foreground)' : 'var(--team-accent)', strokeWidth: selected.includes(r.id) ? 3 : 1.6, strokeDasharray: r.kind === 'reports_to' ? undefined : r.kind === 'reviews' ? '3 5' : '8 5' },
      markerEnd: { type: MarkerType.ArrowClosed }, labelStyle: { fontSize: 12, fill: 'var(--foreground)' }, labelBgStyle: { fill: 'var(--team-panel)' }, interactionWidth: 20,
    };
    return edge;
  });
  return { nodes, edges };
}
