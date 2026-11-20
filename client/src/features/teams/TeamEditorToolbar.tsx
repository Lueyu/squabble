import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TeamEditorToolbarProps {
  zh: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  zoom: number;
}

export function TeamEditorToolbar({ zh, onZoomIn, onZoomOut, onResetZoom, zoom }: TeamEditorToolbarProps) {
  return <div className="team-zoom-tools" role="group" aria-label={zh ? '画布缩放' : 'Canvas zoom'}>
    <Button variant="outline" size="icon" aria-label={zh ? '缩小' : 'Zoom out'} onClick={onZoomOut}><Minus /></Button>
    <Button variant="outline" size="sm" aria-label={zh ? '恢复100%缩放' : 'Reset zoom to 100%'} onClick={onResetZoom}>{Math.round(zoom * 100)}%</Button>
    <Button variant="outline" size="icon" aria-label={zh ? '放大' : 'Zoom in'} onClick={onZoomIn}><Plus /></Button>
    <span className="team-canvas-gesture">{zh ? '滚动缩放 · 拖动平移' : 'Scroll to zoom · Drag to pan'}</span>
  </div>;
}
