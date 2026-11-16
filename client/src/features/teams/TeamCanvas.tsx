import { memo, useEffect, useRef, useState, type DragEvent } from 'react';
import { Background, BackgroundVariant, Handle, MiniMap, NodeResizer, Panel, Position, ReactFlow, ReactFlowProvider, SelectionMode, applyNodeChanges, useReactFlow, type Connection, type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronRight, Folder, Map, Network, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { agentRosterApi } from '@/api/agent-roster';
import { AgentIdentity } from '@/features/agent-roster/AgentIdentity';
import { absolutePosition, departmentDescendants, moveTeamObjects, type TeamEditorState } from './team-graph';
import { toTeamFlow, type TeamFlowNode } from './team-flow-adapter';
import '@xyflow/react/dist/style.css';

const RoleNode = memo(function RoleNode({ id, data, selected }: NodeProps<TeamFlowNode>) {
  return <div className={`team-role-node${selected ? ' is-selected' : ''}${data.dropState === 'ready' ? ' is-drop-target' : data.dropState === 'blocked' ? ' is-drop-blocked' : ''}`} onDragOver={event => data.onAgentDragOver?.(id, event)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) data.onAgentDragLeave?.(id); }} onDrop={event => data.onAgentDrop?.(id, event)}><Handle type="target" position={Position.Top} /><div className="team-role-title">{data.agentName ? <AgentIdentity avatar={data.avatar} name={data.agentName} avatarClassName="size-9" /> : <><span className="team-node-avatar"><UserRound size={19} /></span><strong>{data.label}</strong></>}</div>{data.agentName && data.agentName !== data.label && <p className="text-xs">{data.label}</p>}<p>{data.subtitle}</p><div className="team-node-badges">{data.placeholder && <span>○ {data.zh ? '待配置 / 不参与' : 'Placeholder / inactive'}</span>}{data.shared && <span><Network size={11} /> {data.zh ? '共用连接' : 'Shared connection'}</span>}</div><Handle type="source" position={Position.Bottom} /></div>;
});
const DepartmentNode = memo(function DepartmentNode({ id, data, selected }: NodeProps<TeamFlowNode>) {
  return <><NodeResizer isVisible={selected && !data.collapsed && !!data.onResize} minWidth={280} minHeight={180} onResizeEnd={(_, size) => data.onResize?.(id, size.width, size.height)} /><div className={`team-department-node${selected ? ' is-selected' : ''}`}><div className="team-department-title"><Folder size={17} /><strong>{data.label}</strong><Button variant="ghost" size="icon" className="nodrag nopan team-department-toggle" aria-label={`${data.collapsed ? (data.zh ? '展开' : 'Expand') : (data.zh ? '折叠' : 'Collapse')} ${data.label}`} disabled={!data.onToggle} onClick={event => { event.stopPropagation(); data.onToggle?.(id); }}>{data.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</Button></div>{!data.collapsed && <p>{data.subtitle}</p>}</div></>;
});
const nodeTypes = { teamRole: RoleNode, teamDepartment: DepartmentNode };
export interface CanvasControls { fit: () => void; zoomIn: () => void; zoomOut: () => void; resetZoom: () => void; getZoom: () => number }
interface TeamCanvasProps { state: TeamEditorState; selected: string[]; select: (ids: string[]) => void; edit: (state: TeamEditorState) => void; connect: (from: string, to: string) => void; filter: string; zh: boolean; readOnly: boolean; locateId: string | null; fitInitial: boolean; assignAgent?: (roleId: string, agentId: string) => void; onZoomChange?: (zoom: number) => void; registerControls?: (controls: CanvasControls | null) => void }
function Canvas({ state, selected, select, edit, connect, filter, zh, readOnly, locateId, fitInitial, assignAgent, onZoomChange, registerControls }: TeamCanvasProps) {
  const flow = useReactFlow<TeamFlowNode>();
  const viewportIntent = useRef(false);
  useEffect(() => {
    registerControls?.({ fit: () => { viewportIntent.current = true; void flow.fitView({ padding: 0.15, duration: 250 }); }, zoomIn: () => { viewportIntent.current = true; void flow.zoomIn({ duration: 150 }); }, zoomOut: () => { viewportIntent.current = true; void flow.zoomOut({ duration: 150 }); }, resetZoom: () => { viewportIntent.current = true; void flow.zoomTo(1, { duration: 150 }); }, getZoom: () => flow.getZoom() });
    return () => registerControls?.(null);
  }, [flow, registerControls]);
  const roster = useQuery({ queryKey: ['agent-roster'], queryFn: agentRosterApi.list, retry: false });
  const adapted = toTeamFlow(state, selected, filter, zh, roster.data?.items);
  const [nodes, setNodes] = useState(adapted.nodes);
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const [target, setTarget] = useState<string | null>(null);
  const [agentDropTarget, setAgentDropTarget] = useState<string | null>(null);
  const [minimapOpen, setMinimapOpen] = useState(false);
  const agentDrop = (id: string, event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('application/x-squabble-agent')) return;
    event.preventDefault();
    event.stopPropagation();
    setAgentDropTarget(null);
    if (readOnly || !assignAgent) return;
    const agentId = event.dataTransfer.getData('application/x-squabble-agent');
    if (agentId) { select([id]); assignAgent(id, agentId); }
  };
  useEffect(() => { setNodes(toTeamFlow(state, selected, filter, zh, roster.data?.items).nodes.map(node => ({ ...node, data: { ...node.data, dropState: node.id === agentDropTarget ? (readOnly || !assignAgent ? 'blocked' : 'ready') : undefined, onAgentDragOver: (id: string, event: DragEvent<HTMLDivElement>) => { if (!event.dataTransfer.types.includes('application/x-squabble-agent')) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = readOnly || !assignAgent ? 'none' : 'copy'; setAgentDropTarget(id); }, onAgentDragLeave: () => setAgentDropTarget(null), onAgentDrop: agentDrop, onResize: readOnly ? undefined : (id: string, width: number, height: number) => edit({ ...state, layout: { ...state.layout, positions: { ...state.layout.positions, [id]: { ...state.layout.positions[id], width, height } } } }), onToggle: readOnly ? undefined : (id: string) => edit({ ...state, layout: { ...state.layout, collapsedDepartmentIds: state.layout.collapsedDepartmentIds.includes(id) ? state.layout.collapsedDepartmentIds.filter(value => value !== id) : [...state.layout.collapsedDepartmentIds, id] } }) } }))); }, [state, selected, filter, zh, roster.data, agentDropTarget, readOnly, assignAgent]);
  useEffect(() => { if (!locateId) return; const p = absolutePosition(state, locateId); viewportIntent.current = true; void flow.setCenter(p.x + 105, p.y + 60, { zoom: 1, duration: 250 }); }, [locateId, flow]);
  const candidate = (node: TeamFlowNode): string | null => {
    const current = { ...state, layout: { ...state.layout, positions: Object.fromEntries(nodesRef.current.map(n => [n.id, { ...state.layout.positions[n.id], ...n.position }])) } };
    const p = absolutePosition(current, node.id); const forbidden = new Set([node.id, ...selected, ...selected.flatMap(id => departmentDescendants(state.config, id)), ...departmentDescendants(state.config, node.id)]);
    const departments = state.config.departments.filter(d => !forbidden.has(d.id) && !state.layout.collapsedDepartmentIds.includes(d.id));
    return departments.reverse().find(d => { const dp = absolutePosition(current, d.id); const size = state.layout.positions[d.id]; return p.x + 100 >= dp.x && p.x + 100 <= dp.x + (size?.width ?? 600) && p.y + 45 >= dp.y + 45 && p.y + 45 <= dp.y + (size?.height ?? 400); })?.id ?? null;
  };
  return <div className="team-canvas" aria-label={zh ? '自由组织画布' : 'Free organization canvas'}><ReactFlow<TeamFlowNode> nodes={nodes} edges={adapted.edges} nodeTypes={nodeTypes} defaultViewport={state.layout.viewport} fitView={fitInitial || Object.keys(state.layout.positions).length === 0} fitViewOptions={{ padding: 0.15, minZoom: 0.93, maxZoom: 1 }} minZoom={0.15} maxZoom={2} nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable selectionOnDrag selectionMode={SelectionMode.Partial} multiSelectionKeyCode="Shift" panOnDrag={[1, 2]} deleteKeyCode={null}
    onNodesChange={changes => { setNodes(current => applyNodeChanges(changes, current)); const selectionChanges = changes.filter(change => change.type === 'select'); if (selectionChanges.length) { const ids = new Set(selected); selectionChanges.forEach(change => { if (change.type === 'select') { if (change.selected) ids.add(change.id); else ids.delete(change.id); } }); select([...ids]); } }}
    onNodeDrag={(_, node) => setTarget(candidate(node))}
    onNodeDragStop={(_, node, moved) => { const positions = { ...state.layout.positions }; moved.forEach(n => { positions[n.id] = { ...positions[n.id], ...n.position }; }); let next = { ...state, layout: { ...state.layout, positions } }; const destination = candidate(node); next = moveTeamObjects(next, moved.map(n => n.id), destination); edit(next); setTarget(null); }}
    onConnect={(connection: Connection) => { if (connection.source && connection.target) connect(connection.source, connection.target); }}
    onNodeClick={(event, node) => select(event.shiftKey ? [...new Set([...selected, node.id])] : [node.id])}
    onEdgeClick={(_, edge) => select([edge.id])} onPaneClick={() => select([])}
    onInit={instance => onZoomChange?.(instance.getZoom())} onMoveStart={event => { if (event) viewportIntent.current = true; }} onMove={(_, viewport) => onZoomChange?.(viewport.zoom)}
    onMoveEnd={(_, viewport) => { onZoomChange?.(viewport.zoom); const persist = viewportIntent.current; viewportIntent.current = false; if (persist && !readOnly && JSON.stringify(viewport) !== JSON.stringify(state.layout.viewport)) edit({ ...state, layout: { ...state.layout, viewport } }); }}
    proOptions={{ hideAttribution: false }}><Background variant={BackgroundVariant.Dots} gap={22} size={1} />{minimapOpen && <MiniMap pannable zoomable nodeColor={n => n.type === 'teamDepartment' ? 'var(--muted)' : 'var(--team-accent)'} />}<Panel position="top-left"><div className="team-canvas-help" role="status">{agentDropTarget ? (readOnly || !assignAgent ? (zh ? '当前画布只读，不能指派股友' : 'This canvas is read-only; assignment is unavailable') : `${zh ? '松手指派到' : 'Drop to assign to'} ${state.display.roleLabels[agentDropTarget]}`) : target ? `${zh ? '松手加入' : 'Drop into'} ${state.display.departmentLabels[target]}` : (zh ? '拖动排布 · Shift 多选 · 从端点拖出关系' : 'Drag to arrange · Shift to select · Connect from handles')}</div></Panel><Panel position="bottom-right"><Button className="team-minimap-toggle" size="sm" variant="outline" aria-expanded={minimapOpen} onClick={() => setMinimapOpen(value => !value)}><Map size={14} />{minimapOpen ? (zh ? '收起导航图' : 'Hide overview') : (zh ? '导航图' : 'Overview')}</Button></Panel></ReactFlow></div>;
}
export function TeamCanvas(props: TeamCanvasProps) { return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>; }
