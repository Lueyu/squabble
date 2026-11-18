import { LocateFixed, Minus, Plus, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TeamEditorToolbarProps {
  view: 'list' | 'canvas';
  readOnly: boolean;
  zh: boolean;
  onAutoLayout: () => void;
  onFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  zoom: number;
}

export function TeamEditorToolbar({ view, readOnly, zh, onAutoLayout, onFit, onZoomIn, onZoomOut, onResetZoom, zoom }: TeamEditorToolbarProps) {
  return <div className="team-inline-actions" role="group" aria-label={zh ? '布局工具' : 'Layout tools'}>
    {!readOnly && <Button variant="outline" size="sm" onClick={onAutoLayout}><Wand2 />{zh ? '自动布局' : 'Auto layout'}</Button>}
    {view === 'canvas' && <>
      <Button variant="ghost" size="icon" aria-label={zh ? '适应全部' : 'Fit all'} onClick={onFit}><LocateFixed /></Button>
      <Button variant="ghost" size="icon" aria-label={zh ? '缩小' : 'Zoom out'} onClick={onZoomOut}><Minus /></Button>
      <Button variant="ghost" size="sm" aria-label={zh ? '恢复100%缩放' : 'Reset zoom to 100%'} onClick={onResetZoom}>{Math.round(zoom * 100)}%</Button>
      <Button variant="ghost" size="icon" aria-label={zh ? '放大' : 'Zoom in'} onClick={onZoomIn}><Plus /></Button>
    </>}
  </div>;
}
