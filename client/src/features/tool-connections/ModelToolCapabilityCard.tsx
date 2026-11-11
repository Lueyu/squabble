import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchModelConnections } from '@/api/model-connections';
import { disableModelToolCapability, listModelToolCapabilities, probeModelToolCapability, toolRequestError,
  listResearchRuntimeDrivers, setResearchRuntimeDriver, type ResearchRuntimeDriver, type ModelToolProbeResult } from '@/api/tool-connections';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function ModelToolCapabilityCard({ active }: { active: boolean }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh'), client = useQueryClient();
  const [connection, setConnection] = useState('default'), [tier, setTier] = useState<'fast' | 'slow'>('fast');
  const [result, setResult] = useState<ModelToolProbeResult | null>(null);
  const models = useQuery({ queryKey: ['settings', 'model-connections'], queryFn: fetchModelConnections, enabled: active, retry: false });
  const capabilities = useQuery({ queryKey: ['model-tool-capabilities'], queryFn: listModelToolCapabilities, enabled: active, retry: false, refetchOnWindowFocus: false });
  const drivers = useQuery({ queryKey: ['research-runtime-drivers'], queryFn: listResearchRuntimeDrivers, enabled: active, retry: false });
  const driver = useMutation({ mutationFn: (value: ResearchRuntimeDriver) => setResearchRuntimeDriver(connection === 'default' ? '' : connection, value),
    retry: false, onSuccess: async () => { await client.invalidateQueries({ queryKey: ['research-runtime-drivers'] }); } });
  const probe = useMutation({ mutationFn: async () => {
    const connectionId = connection === 'default' ? '' : connection;
    const key = `sq-model-tool-probe:${connectionId}:${tier}`;
    let requestKey = sessionStorage.getItem(key);
    if (!requestKey) { requestKey = crypto.randomUUID(); sessionStorage.setItem(key, requestKey); }
    const response = await probeModelToolCapability({ requestKey, ...(connectionId ? { connectionId } : {}), tier, enable: true });
    if (!['provider_unknown', 'running', 'queued'].includes(response.status)) sessionStorage.removeItem(key);
    return response;
  }, retry: false, onSuccess: async response => { setResult(response); await client.invalidateQueries({ queryKey: ['model-tool-capabilities'] }); } });
  const disable = useMutation({ mutationFn: () => disableModelToolCapability(connection === 'default' ? '' : connection), retry: false,
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['model-tool-capabilities'] }); } });
  const cached = capabilities.data?.filter(record => record.connection_id === (connection === 'default' ? '' : connection)) ?? [];
  return <section className="space-y-4 rounded-xl border bg-card p-5" aria-label={zh ? '模型工具调用验证' : 'Model tool calling verification'}>
    <div><h2 className="font-semibold">{zh ? '模型工具调用验证' : 'Model tool calling verification'}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{zh ? '验证最多发起 2 次模型请求并消耗模型预算。验证成功且启用后，新研究才使用多步工具调用；模型配置变化后需重新验证。' : 'Verification makes at most 2 model requests and consumes model budget. Successful verification enables tools for new research. Model configuration changes require verification again.'}</p></div>
    <p className="text-sm text-muted-foreground">{zh ? `当前：${connection === 'default' ? '默认模型连接' : models.data?.find(model => model.id === connection)?.name ?? connection} · ${tier === 'fast' ? '快速' : '深入'}` : `Selected: ${connection === 'default' ? 'Default model connection' : models.data?.find(model => model.id === connection)?.name ?? connection} · ${tier}`}</p>
    <details><summary className="cursor-pointer text-sm">{zh ? '选择其他模型或运行器' : 'Choose another model or runtime'}</summary>
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <div className="space-y-2"><Label htmlFor="model-tool-connection">{zh ? '模型连接' : 'Model connection'}</Label>
        <Select value={connection} onValueChange={value => { setConnection(value); setResult(null); }} disabled={probe.isPending}>
          <SelectTrigger id="model-tool-connection"><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="default">{zh ? '默认模型连接' : 'Default model connection'}</SelectItem>
            {models.data?.map(model => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}
          </SelectContent></Select></div>
      <div className="space-y-2"><Label htmlFor="model-tool-tier">{zh ? '模型档位' : 'Model tier'}</Label>
        <Select value={tier} onValueChange={value => { if (value === 'fast' || value === 'slow') setTier(value); setResult(null); }} disabled={probe.isPending}>
          <SelectTrigger id="model-tool-tier"><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="fast">{zh ? '快速' : 'Fast'}</SelectItem><SelectItem value="slow">{zh ? '深入' : 'Slow'}</SelectItem>
          </SelectContent></Select></div>
    </div>
    <div className="mt-4 space-y-2"><Label htmlFor="research-runtime-driver">{zh ? '研究运行器' : 'Research runtime'}</Label>
      <Select value={drivers.data?.find(item => item.connection_id === (connection === 'default' ? '' : connection))?.driver ?? 'controlled'}
        disabled={probe.isPending || driver.isPending} onValueChange={value => { if (value === 'controlled' || value === 'deep_agents') driver.mutate(value); }}>
        <SelectTrigger id="research-runtime-driver"><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="controlled">{zh ? '标准运行器' : 'Standard runtime'}</SelectItem>
          <SelectItem value="deep_agents">Deep Agents {zh ? '只读研究' : 'read-only research'}</SelectItem>
        </SelectContent></Select>
      <p className="text-xs text-muted-foreground">{zh ? '仅影响新运行。Deep Agents 当前支持只读研究；需要确认的外部操作请使用标准运行器。' : 'Applies to new runs. Deep Agents currently supports read-only research; use the standard runtime for external actions requiring approval.'}</p>
      {(driver.isError || drivers.isError) && <p role="alert" className="text-sm text-destructive">{toolRequestError(driver.error ?? drivers.error)}</p>}
    </div>
    </details>
    <div className="flex flex-wrap gap-2"><Button disabled={probe.isPending || disable.isPending} onClick={() => probe.mutate()}>
      {probe.isPending ? (zh ? '正在验证…' : 'Verifying…') : (zh ? '验证并启用（最多 2 次模型请求）' : 'Verify and enable (up to 2 model requests)')}</Button>
      <Button variant="outline" disabled={probe.isPending || disable.isPending} onClick={() => disable.mutate()}>{zh ? '关闭此连接的工具调用' : 'Disable tools for this connection'}</Button></div>
    <p className="text-xs leading-5 text-muted-foreground">{zh ? '网络中断后再次点击将复用同一请求标识，核查已有回执；不会因自动重试重复付费。金额取决于模型价格与实际用量。' : 'After a network interruption, click again to reuse the saved request identity and check its receipt. Automatic retries are disabled. Amount depends on model pricing and actual usage.'}</p>
    {(probe.isError || disable.isError || capabilities.isError || models.isError) && <p role="alert" className="break-words text-sm text-destructive">{toolRequestError(probe.error ?? disable.error ?? capabilities.error ?? models.error)}</p>}
    {result && <p role="status" className="text-sm">{result.status} · {zh ? '支持工具' : 'Tool support'}: {String(result.supported)} · {zh ? '已启用' : 'Enabled'}: {String(result.enabled)}</p>}
    {cached.map(record => <p key={`${record.connection_id}:${record.model}`} className="break-words text-xs text-muted-foreground">
      {record.model} · {record.enabled && record.supported ? (zh ? '已验证并启用' : 'Verified and enabled') : (zh ? '未启用' : 'Disabled')} · {new Date(record.verified_at).toLocaleString()}
    </p>)}
  </section>;
}
