import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { TelemetryIntegration, TelemetryStatus } from '@shared/telemetry.interface';
import { langfuseLink } from './telemetry-state';
import { statusLabel } from './telemetry-copy';

export function TelemetryPanel({ title, description, children, action, className = '' }: {
  title: string; description?: string; children: ReactNode; action?: ReactNode; className?: string;
}) {
  return <Card className={`telemetry-panel ${className}`}>
    <div className="telemetry-panel-heading"><div><h2>{title}</h2>
      {description && <p className="telemetry-muted">{description}</p>}</div>{action}</div>
    {children}
  </Card>;
}

export function TelemetryMetric({ label, value, note }: { label: string; value: ReactNode; note: ReactNode }) {
  return <Card className="telemetry-metric"><dt>{label}</dt><dd>{value}</dd>
    <p className="telemetry-muted">{note}</p></Card>;
}

export function RunStatus({ status }: { status: TelemetryStatus }) {
  const { i18n } = useTranslation();
  return <Badge variant="secondary" className={`telemetry-status telemetry-status-${status}`}>
    {statusLabel(status, i18n.language.startsWith('zh'))}
  </Badge>;
}

export function TelemetryEmpty({ children }: { children?: ReactNode }) {
  const { i18n } = useTranslation();
  const zh: boolean = i18n.language.startsWith('zh');
  return <div className="telemetry-empty"><p>{children ?? (zh ? '当前筛选条件下没有运行记录。' : 'No runs match these filters.')}</p>
    <p className="telemetry-muted">{zh ? '这里只展示已保存的真实记录，浏览不会启动研究。' : 'Only saved records appear here. Browsing does not start research.'}</p></div>;
}

export function TelemetryLoading() {
  const { i18n } = useTranslation();
  return <div role="status" aria-label={i18n.language.startsWith('zh') ? '正在读取运行记录' : 'Loading telemetry'}>
    <div className="telemetry-metrics">{[0, 1, 2, 3].map((id: number) => <Skeleton key={id} className="h-32 rounded-2xl" />)}</div>
    <Skeleton className="mt-4 h-64 rounded-2xl" />
  </div>;
}

export function TelemetryError({ retry, detail }: { retry: () => void; detail?: boolean }) {
  const { i18n } = useTranslation();
  const zh: boolean = i18n.language.startsWith('zh');
  return <Card className="telemetry-panel telemetry-empty" role="alert">
    <h2>{zh ? '暂时无法读取运行记录' : 'Telemetry is unavailable'}</h2>
    <p className="telemetry-muted">{detail
      ? (zh ? '该记录可能已删除、无访问权限，或服务暂时不可用。' : 'This run may have been deleted, be inaccessible, or temporarily unavailable.')
      : (zh ? '请检查连接后重试。当前没有可验证的数据。' : 'Check the connection and retry. No verified data is available.')}</p>
    <Button variant="outline" onClick={retry}><RefreshCw size={14} />{zh ? '重试读取' : 'Retry'}</Button>
  </Card>;
}

export function CoverageNotes({ limitations }: { limitations: string[] }) {
  const { i18n } = useTranslation();
  if (!limitations.length) return null;
  return <details className="telemetry-limitations"><summary>{i18n.language.startsWith('zh') ? '数据范围与已知限制' : 'Data coverage and limitations'} ({limitations.length})</summary>
    <ul>{limitations.map((item: string, index: number) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
  </details>;
}

export function IntegrationStatus({ integration, traceId }: { integration: TelemetryIntegration; traceId?: string | null }) {
  const { i18n } = useTranslation();
  const zh: boolean = i18n.language.startsWith('zh');
  const href: string | null = langfuseLink(integration, traceId);
  const labels: Record<TelemetryIntegration['status'], string> = {
    ready: zh ? '已配置' : 'Configured', disabled: zh ? '未启用' : 'Disabled', unavailable: zh ? '暂时不可用' : 'Unavailable',
  };
  return <div className="telemetry-integration"><div className="telemetry-row-between">
    <h3>Langfuse</h3><Badge variant="secondary">{labels[integration.status]}</Badge></div>
    <p className="telemetry-muted">{zh
      ? '可选自托管集成，仅导出运行元数据；不采集提示词、正文或凭证。'
      : 'Optional self-hosted integration exports run metadata, without prompts, content or credentials.'}</p>
    {href ? <Button asChild variant="outline"><a href={href} target="_blank" rel="noopener noreferrer">
      {traceId ? (zh ? '打开完整 Trace' : 'Open full trace') : (zh ? '打开 Langfuse 项目' : 'Open Langfuse project')}<ExternalLink size={14} />
    </a></Button> : <p className="telemetry-muted">{zh
      ? '在服务端配置 Langfuse 项目、地址与密钥后启用。集成不可用时仍可查看应用记录。'
      : 'Configure the Langfuse project, host and keys on the server to enable it. App records remain available independently.'}</p>}
  </div>;
}
