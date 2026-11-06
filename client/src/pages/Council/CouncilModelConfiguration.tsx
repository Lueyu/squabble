import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { NativeAgentConfiguration } from '@shared/local-agents.interface';
import type { ResearchExecutionReadiness } from '@shared/research-execution.interface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Saving a configuration never dispatches research; retry remains explicit. */
export default function CouncilModelConfiguration({ connection, memberName, onSave, onRetry, retryAllowed }: {
  connection: ResearchExecutionReadiness; memberName: string;
  onSave: (settings: NativeAgentConfiguration) => Promise<ResearchExecutionReadiness>;
  onRetry: () => void; retryAllowed: boolean;
}) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const settings = connection.configuration ?? (connection.route?.mode === 'local' ? connection.route.agentSettings : undefined);
  const [model, setModel] = useState(settings?.model || '');
  const [effort, setEffort] = useState(settings?.reasoningEffort || '');
  const [pending, setPending] = useState(false); const [error, setError] = useState(false);
  const [saved, setSaved] = useState<ResearchExecutionReadiness | null>(null); const lock = useRef(false);
  const modelId = model.trim() || connection.effectiveModel.id;
  const efforts = connection.models?.find(item => item.id === modelId)?.reasoningEfforts ?? connection.reasoningEfforts ?? [];
  const needsQualifiedModel = connection.provider === 'opencode' && (model.trim() || connection.effectiveModel.id)
    && !/^[^/\s]+\/[^\s]+$/u.test(model.trim() || connection.effectiveModel.id || '');
  const save = async () => {
    if (lock.current || needsQualifiedModel) return;
    lock.current = true; setPending(true); setError(false); setSaved(null);
    try { setSaved(await onSave({ ...(model.trim() ? { model: model.trim() } : {}), ...(effort ? { reasoningEffort: effort } : {}) })); }
    catch { setError(true); } finally { lock.current = false; setPending(false); }
  };
  return <form className="min-w-0 space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
    <p className="text-sm text-muted-foreground">{zh ? `只修改 ${memberName} 的原执行连接。保存不会重新发送研究。` : `Edit ${memberName}’s original connection. Saving does not resend research.`}</p>
    <div className="space-y-2"><label className="text-sm font-medium" htmlFor="research-model-id">{zh ? '模型' : 'Model'}</label><Input id="research-model-id" list="research-available-models" value={model} maxLength={160} disabled={pending || connection.models === undefined} onChange={event => { setModel(event.target.value); setSaved(null); }} placeholder={connection.effectiveModel.id || (zh ? '使用本地默认模型' : 'Use local default model')} />
      <datalist id="research-available-models">{connection.models?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>
      <p className="text-xs leading-5 text-muted-foreground">{zh ? '留空沿用本地默认。下面只列出这份连接已配置的模型，可点击选择。' : 'Leave blank to retain the local default. These options come from this connection’s configured models.'}</p>
      {!!connection.models?.length && <div className="flex flex-wrap gap-2">{connection.models.map(item => <Button key={item.id} type="button" size="sm" variant="outline" className="h-auto max-w-full whitespace-normal text-left [overflow-wrap:anywhere]" disabled={pending} onClick={() => { setModel(item.id); setSaved(null); }}>{item.id}</Button>)}</div>}
      {needsQualifiedModel && <p className="text-xs text-amber-700 dark:text-amber-300">{zh ? 'OpenCode 需要完整的 provider/model 标识，请从已配置模型中明确选择。' : 'OpenCode needs the full provider/model identifier. Choose an existing configured model explicitly.'}</p>}
    </div>
    {(efforts.length > 0 || effort) && <div className="space-y-2"><label htmlFor="research-reasoning-effort" className="text-sm font-medium">{zh ? '推理强度' : 'Reasoning effort'}</label><select id="research-reasoning-effort" className="w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm" value={effort} disabled={pending} onChange={event => { setEffort(event.target.value); setSaved(null); }}><option value="">{zh ? '沿用本地默认' : 'Keep local default'}</option>{effort && !efforts.includes(effort) && <option value={effort}>{effort} · {zh ? '已保存' : 'saved'}</option>}{efforts.map(value => <option key={value} value={value}>{value}</option>)}</select></div>}
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending || Boolean(needsQualifiedModel)}>{pending ? (zh ? '正在保存…' : 'Saving…') : (zh ? '保存配置' : 'Save configuration')}</Button>{saved?.executable && retryAllowed && <Button type="button" variant="outline" onClick={onRetry}>{zh ? '只重试这位股友' : 'Retry this member only'}</Button>}</div>
    {saved && <p role="status" className="text-sm">{saved.executable ? (zh ? '配置已保存。可单独重试这位股友，其他已完成观点继续保留。' : 'Configuration saved. Retry this member separately; accepted views remain available.') : (zh ? '配置已保存，这份连接还需要登录、等待空闲或继续修正配置。' : 'Configuration saved. This connection still needs sign-in, an available slot, or further configuration.')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{zh ? '配置未能确认保存，请重试。已保存的研究继续保留。' : 'The configuration could not be confirmed. Retry; saved research remains available.'}</p>}
    {(connection.models === undefined || connection.state === 'login_required' || (saved && !saved.executable)) && <Link to="/settings/agents" className="inline-block text-sm text-primary underline">{zh ? '打开这份连接的设置' : 'Open connection settings'}</Link>}
  </form>;
}
