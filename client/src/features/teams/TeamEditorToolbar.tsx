import { GitBranch, LayoutGrid, List, LocateFixed, Minus, Plus, Redo2, SlidersHorizontal, Undo2, UsersRound, Wand2 } from 'lucide-react';
import type { TeamRelation } from '@shared/team-workspace.interface';
import { Button } from '@/components/ui/button';

export type RelationKind = TeamRelation['kind'];
interface TeamEditorToolbarProps {
  view: 'list' | 'canvas'; setView: (view: 'list' | 'canvas') => void;
  canUndo: boolean; canRedo: boolean; readOnly: boolean; zh: boolean;
  onUndo: () => void; onRedo: () => void; onAutoLayout: () => void;
  onFit: () => void; onZoomIn: () => void; onZoomOut: () => void;
  onResetZoom: () => void; zoom: number;
  onAddRelation: (kind: RelationKind) => void; onProperties: () => void;
}
/** Explicit edit actions share the same draft; navigation controls also work in read-only views. */
export function TeamEditorToolbar(p: TeamEditorToolbarProps) {
  const { zh, readOnly, view } = p;
  return <div className="team-editor-toolbar" role="toolbar" aria-label={zh ? '画布工具' : 'Canvas tools'}>
    <div className="team-toolbar-modes" role="group" aria-label={zh ? '新增关系' : 'Add relation'}>
      <Button variant="outline" size="sm" disabled={readOnly} onClick={() => p.onAddRelation('reports_to')}><GitBranch size={14} />{zh ? '新增汇报' : 'Add reporting'}</Button>
      <Button variant="outline" size="sm" disabled={readOnly} onClick={() => p.onAddRelation('delegates_to')}><UsersRound size={14} />{zh ? '新增协作' : 'Add collaboration'}</Button>
      <Button variant="ghost" size="sm" onClick={p.onProperties}><SlidersHorizontal size={14} />{zh ? '属性' : 'Properties'}</Button>
    </div>
    <div className="team-inline-actions">
      <Button variant="ghost" size="icon" title={zh ? '自动布局（可撤销）' : 'Auto layout (undoable)'} aria-label={zh ? '自动布局' : 'Auto layout'} disabled={readOnly} onClick={p.onAutoLayout}><Wand2 size={16} /></Button>
      <Button variant="ghost" size="icon" aria-label={zh ? '撤销' : 'Undo'} disabled={readOnly || !p.canUndo} onClick={p.onUndo}><Undo2 size={16} /></Button>
      <Button variant="ghost" size="icon" aria-label={zh ? '重做' : 'Redo'} disabled={readOnly || !p.canRedo} onClick={p.onRedo}><Redo2 size={16} /></Button>
      {view === 'canvas' && <><Button variant="ghost" size="icon" aria-label={zh ? '适应全部' : 'Fit all'} onClick={p.onFit}><LocateFixed size={16} /></Button><Button variant="ghost" size="icon" aria-label={zh ? '缩小' : 'Zoom out'} onClick={p.onZoomOut}><Minus size={15} /></Button><Button variant="ghost" size="sm" aria-label={zh ? '恢复100%缩放' : 'Reset zoom to 100%'} onClick={p.onResetZoom}>{Math.round(p.zoom * 100)}%</Button><Button variant="ghost" size="icon" aria-label={zh ? '放大' : 'Zoom in'} onClick={p.onZoomIn}><Plus size={15} /></Button></>}
      <Button variant={view === 'list' ? 'secondary' : 'ghost'} size="icon" aria-label={zh ? '组织列表视图' : 'Organization list view'} aria-pressed={view === 'list'} onClick={() => p.setView('list')}><List size={16} /></Button>
      <Button variant={view === 'canvas' ? 'secondary' : 'ghost'} size="icon" aria-label={zh ? '自由画布视图' : 'Free canvas view'} aria-pressed={view === 'canvas'} onClick={() => p.setView('canvas')}><LayoutGrid size={16} /></Button>
    </div>
  </div>;
}
