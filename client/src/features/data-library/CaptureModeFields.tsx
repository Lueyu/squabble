import { useTranslation } from 'react-i18next';
import type { DataLibraryCaptureMode } from '@shared/data-library.interface';
import { Button } from '@/components/ui/button';

export default function CaptureModeFields({ value, onChange, disabled = false }: {
  value: DataLibraryCaptureMode;
  onChange: (value: DataLibraryCaptureMode) => void;
  disabled?: boolean;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  return <fieldset className="data-capture-config" disabled={disabled}>
    <legend className="text-sm font-medium">{zh ? '采集方式' : 'Collection method'}</legend>
    <div className="data-capture-modes" role="group" aria-label={zh ? '采集方式' : 'Collection method'}>
      <Button type="button" variant={value === 'http' ? 'default' : 'outline'}
        aria-pressed={value === 'http'} onClick={() => onChange('http')}>
        {zh ? 'HTTP 静态采集' : 'HTTP static capture'}
      </Button>
      <Button type="button" variant={value === 'browser' ? 'default' : 'outline'}
        aria-pressed={value === 'browser'} onClick={() => onChange('browser')}>
        {zh ? '浏览器动态采集' : 'Browser dynamic capture'}
      </Button>
    </div>
    <p className="text-xs leading-6 text-muted-foreground">{value === 'browser'
      ? zh ? '使用隔离浏览器读取这个地址的动态正文，不会自动遍历整站文章。' : 'Use an isolated browser to read this page’s rendered content. Other pages are not crawled automatically.'
      : zh ? '直接读取静态 HTML、RSS 或 JSON；认证方式在下方单独设置。' : 'Fetch static HTML, RSS or JSON directly. Set authentication separately below.'}</p>
  </fieldset>;
}
