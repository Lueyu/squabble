import { memo, useEffect, useRef, useState, type DragEvent } from 'react';
import { BaseEdge, Handle, MiniMap, NodeResizer, Panel, Position, ReactFlow, ReactFlowProvider, SelectionMode, applyNodeChanges, useReactFlow, type Connection, type EdgeProps, type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronRight, Folder, Map as MapIcon, Network, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { agentRosterApi } from '@/api/agent-roster';
import AnimalAvatar from '@/components/AnimalAvatar';
import { absolutePosition, departmentDescendants, moveTeamObjects, type TeamEditorState } from './team-graph';
import { toTeamFlow, type ParallelTeamEdge, type TeamFlowNode } from './team-flow-adapter';
import '@xyflow/react/dist/style.css';

const RoleNode = memo(function RoleNode({ id, data, selected }: NodeProps<TeamFlowNode>) {
  return <div className={`team-role-node${selected ? ' is-selected' : ''}${data.dropState === 'ready' ? ' is-drop-target' : data.dropState === 'blocked' ? ' is-drop-blocked' : ''}`} onDragOver={event => data.onAgentDragOver?.(id, event)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) data.onAgentDragLeave?.(id); }} onDrop={event => data.onAgentDrop?.(id, event)}><Handle id="work-in" type="target" position={Position.Top} />
    <Handle id="report-in" type="target" position={Position.Bottom} isConnectable={false} className="team-report-handle" />
    <Handle id="report-out" type="source" position={Position.Top} isConnectable={false} className="team-report-handle" />
    <Handle id="left-in" type="target" position={Position.Left} isConnectable={false} className="team-report-handle" />
    <Handle id="left-out" type="source" position={Position.Left} isConnectable={false} className="team-report-handle" />
    <Handle id="right-in" type="target" position={Position.Right} isConnectable={false} className="team-report-handle" />
    <Handle id="right-out" type="source" position={Position.Right} isConnectable={false} className="team-report-handle" />
    <div className="team-role-title">
      {data.avatar ? <AnimalAvatar avatar={data.avatar} role="researcher" className="size-10" /> : <span className="team-node-avatar"><UserRound size={19} /></span>}
      <div className="team-role-identity">
        <strong>{data.label}</strong>
        <p>{data.agentName || (data.zh ? '未指派股友' : 'Unassigned')}</p>
      </div>
    </div><div className="team-node-badges">{data.placeholder && <span>○ {data.zh ? '待配置 / 不参与' : 'Placeholder / inactive'}</span>}{data.shared && <span><Network size={11} /> {data.zh ? '共用连接' : 'Shared connection'}</span>}</div><Handle id="work-out" type="source" position={Position.Bottom} /></div>;
});
const DepartmentNode = memo(function DepartmentNode({ id, data, selected }: NodeProps<TeamFlowNode>) {
  return <><NodeResizer isVisible={selected && !data.collapsed && !!data.onResize} minWidth={280} minHeight={180} onResizeEnd={(_, size) => data.onResize?.(id, size.width, size.height)} /><div className={`team-department-node${selected ? ' is-selected' : ''}`}><div className="team-department-title"><Folder size={17} /><strong>{data.label}</strong><Button variant="ghost" size="icon" className="nodrag nopan team-department-toggle" aria-label={`${data.collapsed ? (data.zh ? '展开' : 'Expand') : (data.zh ? '折叠' : 'Collapse')} ${data.label}`} disabled={!data.onToggle} onClick={event => { event.stopPropagation(); data.onToggle?.(id); }}>{data.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</Button></div>{!data.collapsed && <p>{data.subtitle}</p>}</div></>;
});
const nodeTypes = { teamRole: RoleNode, teamDepartment: DepartmentNode };
const edgeTypes = {
  teamParallel: function ParallelRelation({
    id, sourceX, sourceY, targetX, targetY, data, style, markerEnd, interactionWidth, label, labelStyle, labelBgStyle,
  }: EdgeProps<ParallelTeamEdge>) {
    const horizontal = data?.horizontal ?? false;
    const offset = data?.offset ?? 0;
    const source = horizontal ? sourceX : sourceY;
    const target = horizontal ? targetX : targetY;
    const fromCross = horizontal ? sourceY : sourceX;
    const toCross = horizontal ? targetY : targetX;
    const middle = (source + target) / 2;
    const middleCross = (fromCross + toCross) / 2 + offset;
    const control = (target - source) / 5;
    const point = (along: number, across: number) => horizontal ? `${along},${across}` : `${across},${along}`;
    const path = `M ${point(source, fromCross)} C ${point(source + control, fromCross)} ${point(middle - control, middleCross)} ${point(middle, middleCross)} S ${point(target - control, toCross)} ${point(target, toCross)}`;
    return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth}
      label={label} labelStyle={labelStyle} labelBgStyle={labelBgStyle}
      labelX={horizontal ? middle : middleCross} labelY={horizontal ? middleCross : middle} />;
  },
};
export interface CanvasControls { fit: () => void; zoomIn: () => void; zoomOut: () => void; resetZoom: () => void; getZoom: () => number }
interface TeamCanvasProps { state: TeamEditorState; selected: string[]; select: (ids: string[]) => void; edit: (state: TeamEditorState) => void; connect: (from: string, to: string) => void; onSelectRelation: (id: string, trigger?: SVGElement) => void; filter: string; zh: boolean; readOnly: boolean; locateId: string | null; fitInitial: boolean; assignAgent?: (roleId: string, agentId: string) => void; onZoomChange?: (zoom: number) => void; registerControls?: (controls: CanvasControls | null) => void }
function Canvas({ state, selected, select, edit, connect, onSelectRelation, filter, zh, readOnly, locateId, fitInitial, assignAgent, onZoomChange, registerControls }: TeamCanvasProps) {
  const flow = useReactFlow<TeamFlowNode>();
  const viewportIntent = useRef(false);
  useEffect(() => {
    registerControls?.({ fit: () => { viewportIntent.current = true; void flow.fitView({ padding: 0.15, maxZoom: 1, duration: 250 }); }, zoomIn: () => { viewportIntent.current = true; void flow.zoomIn({ duration: 150 }); }, zoomOut: () => { viewportIntent.current = true; void flow.zoomOut({ duration: 150 }); }, resetZoom: () => { viewportIntent.current = true; void flow.zoomTo(1, { duration: 150 }); }, getZoom: () => flow.getZoom() });
    return () => registerControls?.(null);
  }, [flow, registerControls]);
  const roster = useQuery({ queryKey: ['agent-roster'], queryFn: agentRosterApi.list, retry: false });
  const adapted = toTeamFlow(state, selected, filter, zh, roster.data?.items);
  const edges = adapted.edges.map(edge => ({
    ...edge,
    ariaRole: 'button',
    selectable: false,
    focusable: true,
    domAttributes: {
      'aria-haspopup': 'dialog' as const,
      onKeyDown: (event: React.KeyboardEvent<SVGGElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onSelectRelation(edge.id, event.currentTarget);
      },
    },
  }));
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
  useEffect(() => {
    const adapted = toTeamFlow(state, selected, filter, zh, roster.data?.items);
    setNodes(current => {
      const previousNodes = new Map(current.map(node => [node.id, node]));
      return adapted.nodes.map(node => {
        const previous = previousNodes.get(node.id);
        const sameSize = previous?.style?.width === node.style?.width && previous?.style?.height === node.style?.height;
        return {
          ...node,
          measured: sameSize ? previous?.measured : undefined,
          data: {
            ...node.data,
            dropState: node.id === agentDropTarget ? (readOnly || !assignAgent ? 'blocked' : 'ready') : undefined,
            onAgentDragOver: (id: string, event: DragEvent<HTMLDivElement>) => {
              if (!event.dataTransfer.types.includes('application/x-squabble-agent')) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = readOnly || !assignAgent ? 'none' : 'copy';
              setAgentDropTarget(id);
            },
            onAgentDragLeave: () => setAgentDropTarget(null),
            onAgentDrop: agentDrop,
            onResize: readOnly ? undefined : (id: string, width: number, height: number) =>
              edit({ ...state, layout: { ...state.layout, positions: { ...state.layout.positions, [id]: { ...node.position, width, height } } } }),
            onToggle: readOnly ? undefined : (id: string) => {
              const collapsed = state.layout.collapsedDepartmentIds;
              const collapsedDepartmentIds = collapsed.includes(id) ? collapsed.filter(value => value !== id) : [...collapsed, id];
              edit({ ...state, layout: { ...state.layout, collapsedDepartmentIds } });
            },
          },
        };
      });
    });
  }, [state, selected, filter, zh, roster.data, agentDropTarget, readOnly, assignAgent]);
  useEffect(() => { if (!locateId) return; const p = absolutePosition(state, locateId); viewportIntent.current = true; void flow.setCenter(p.x + 105, p.y + 60, { zoom: 1, duration: 250 }); }, [locateId, flow]);
  const candidate = (node: TeamFlowNode): string | null => {
    const current = { ...state, layout: { ...state.layout, positions: Object.fromEntries(nodesRef.current.map(n => [n.id, { ...state.layout.positions[n.id], ...n.position }])) } };
    const p = absolutePosition(current, node.id); const forbidden = new Set([node.id, ...selected, ...selected.flatMap(id => departmentDescendants(state.config, id)), ...departmentDescendants(state.config, node.id)]);
    const departments = state.config.departments.filter(d => !forbidden.has(d.id) && !state.layout.collapsedDepartmentIds.includes(d.id));
    return departments.reverse().find(d => { const dp = absolutePosition(current, d.id); const size = state.layout.positions[d.id]; return p.x + 100 >= dp.x && p.x + 100 <= dp.x + (size?.width ?? 600) && p.y + 45 >= dp.y + 45 && p.y + 45 <= dp.y + (size?.height ?? 400); })?.id ?? null;
  };
  return <div className="team-canvas" aria-label={zh ? '自由组织画布' : 'Free organization canvas'}><ReactFlow<TeamFlowNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} defaultViewport={state.layout.viewport} fitView={fitInitial || Object.keys(state.layout.positions).length === 0} fitViewOptions={{ padding: 0.12, maxZoom: 1 }} minZoom={0.15} maxZoom={2} nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable selectionMode={SelectionMode.Partial} multiSelectionKeyCode="Shift" panOnDrag zoomOnScroll deleteKeyCode={null}
    onNodesChange={changes => { setNodes(current => applyNodeChanges(changes, current)); const selectionChanges = changes.filter(change => change.type === 'select'); if (selectionChanges.length) { const ids = new Set(selected); selectionChanges.forEach(change => { if (change.type === 'select') { if (change.selected) ids.add(change.id); else ids.delete(change.id); } }); select([...ids]); } }}
    onNodeDrag={(_, node) => setTarget(candidate(node))}
    onNodeDragStop={(_, node, moved) => { const positions = { ...state.layout.positions }; moved.forEach(n => { positions[n.id] = { ...positions[n.id], ...n.position }; }); let next = { ...state, layout: { ...state.layout, positions } }; const destination = candidate(node); next = moveTeamObjects(next, moved.map(n => n.id), destination); edit(next); setTarget(null); }}
    onConnect={(connection: Connection) => { if (connection.source && connection.target) connect(connection.source, connection.target); }}
    onNodeClick={(event, node) => select(event.shiftKey ? [...new Set([...selected, node.id])] : [node.id])}
    onEdgeClick={(event, edge) => onSelectRelation(edge.id, event.currentTarget instanceof SVGElement ? event.currentTarget : undefined)} onPaneClick={() => select([])}
    onInit={instance => onZoomChange?.(instance.getZoom())} onMoveStart={event => { if (event) viewportIntent.current = true; }} onMove={(_, viewport) => onZoomChange?.(viewport.zoom)}
    onMoveEnd={(_, viewport) => { onZoomChange?.(viewport.zoom); const persist = viewportIntent.current; viewportIntent.current = false; if (persist && !readOnly && JSON.stringify(viewport) !== JSON.stringify(state.layout.viewport)) edit({ ...state, layout: { ...state.layout, viewport } }); }}
    proOptions={{ hideAttribution: false }}>{minimapOpen && <MiniMap pannable zoomable nodeColor={n => n.type === 'teamDepartment' ? 'var(--muted)' : 'var(--team-accent)'} />}{(agentDropTarget || target) && <Panel position="top-left"><div className="team-canvas-help" role="status">{agentDropTarget ? (readOnly || !assignAgent ? (zh ? '当前画布只读，不能指派股友' : 'This canvas is read-only; assignment is unavailable') : `${zh ? '松手指派到' : 'Drop to assign to'} ${state.display.roleLabels[agentDropTarget]}`) : target ? `${zh ? '松手加入' : 'Drop into'} ${state.display.departmentLabels[target]}` : null}</div></Panel>}<Panel position="bottom-right"><Button className="team-minimap-toggle" size="icon" variant="outline" aria-label={minimapOpen ? (zh ? '收起导航图' : 'Hide minimap') : (zh ? '显示导航图' : 'Show minimap')} aria-expanded={minimapOpen} onClick={() => setMinimapOpen(value => !value)}><MapIcon size={14} /></Button></Panel></ReactFlow></div>;
}
export function TeamCanvas(props: TeamCanvasProps) { return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>; }
