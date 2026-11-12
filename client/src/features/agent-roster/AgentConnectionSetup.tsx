import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { createModelConnection, testModelConnection } from '@/api/model-connections';
import { connectLocalAgent } from '@/api/local-agents';
import type { LocalAgentConnection } from '@shared/local-agents.interface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const providers = [
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  { id: 'custom', name: '其他 / Other', url: '', model: '' },
];

/** Save credentials through the existing encrypted connection service, once. Never generate on page load. */
export function AgentConnectionSetup({ zh, locals }: { zh: boolean; locals: LocalAgentConnection[] }) {
  const query = useQueryClient();
  const [providerId, setProviderId] = useState('deepseek');
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(providers[0].url);
  const [model, setModel] = useState(providers[0].model);
  const [failure, setFailure] = useState('');
  const savedId = useRef<string | null>(null);
  const [saveUnknown, setSaveUnknown] = useState(false);
  const save = useMutation({ retry: false, mutationFn: async () => {
    if (!savedId.current) {
      try {
        const connection = await createModelConnection({ name: providers.find(p => p.id === providerId)?.name ?? 'AI', baseUrl: url, fastModel: model, slowModel: model, apiKey: key });
        savedId.current = connection.id; setKey('');
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        if (!status || status >= 500) setSaveUnknown(true);
        throw error;
      }
    }
    // An explicit click authorizes exactly one short, budgeted request; never retry it automatically.
    const result = await testModelConnection(savedId.current, zh ? 'zh-CN' : 'en');
    if (!result.ok) throw new Error(result.message);
  }, onSuccess: async () => { await query.invalidateQueries({ queryKey: ['settings', 'model-connections'] }); },
  onError: () => setFailure(savedId.current ? (zh ? '连接已保存，检查未成功或结果未确认。请核对服务商状态；再次检查会发起一次新的短请求。' : 'The connection is saved. The check failed or its outcome is unknown. Check the provider; another check sends a new short request.') : (zh ? '保存尚未确认。请核对服务地址和密钥；网络中断时先到连接管理查看已有记录。' : 'Saving is not confirmed. Check the address and key; after a network interruption, inspect saved connections first.')) });
  const connect = useMutation({ retry: false, mutationFn: connectLocalAgent, onSuccess: () => query.invalidateQueries({ queryKey: ['settings', 'local-agents'] }), onError: () => setFailure(zh ? '助手尚未连接，请完成本地登录后继续。' : 'Finish signing in to the local assistant, then continue.') });
  return <section className="rounded-xl border bg-card p-5 space-y-4">
    <div><h2 className="font-semibold text-lg">{zh ? '先接上 AI，只需设置一次' : 'Connect AI once'}</h2><p className="text-sm text-muted-foreground">{zh ? '所有股友都可以复用这个连接。保存后检查会发送一次很短的模型请求，按服务商规则计费。' : 'Your agents can reuse this connection. Saving and checking sends one short model request, billed by your provider.'}</p></div>
    {locals.filter(row => row.state === 'ready' && !row.connected).map(row => <Button key={row.id} variant="outline" disabled={connect.isPending} onClick={() => connect.mutate(row.id)}>{zh ? `使用本地 ${row.name}` : `Use local ${row.name}`}</Button>)}
    <div className="space-y-2"><Label htmlFor="agent-provider">{zh ? '模型服务' : 'Provider'}</Label><select id="agent-provider" disabled={Boolean(savedId.current) || saveUnknown || save.isPending} className="w-full rounded-md border bg-background p-2" value={providerId} onChange={e => { const provider = providers.find(p => p.id === e.target.value)!; setProviderId(provider.id); setUrl(provider.url); setModel(provider.model); }}>
      {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
    <div className="space-y-2"><Label htmlFor="agent-api-key">API Key</Label><Input id="agent-api-key" type="password" disabled={Boolean(savedId.current) || saveUnknown || save.isPending} autoComplete="off" value={key} onChange={e => setKey(e.target.value)} /></div>
    <details open={providerId === 'custom'}><summary className="cursor-pointer text-sm">{zh ? '高级设置：服务地址与模型' : 'Advanced: address and model'}</summary><div className="space-y-3 mt-3"><Input disabled={Boolean(savedId.current) || saveUnknown || save.isPending} aria-label={zh ? '服务地址' : 'Service address'} value={url} onChange={e => setUrl(e.target.value)} /><Input disabled={Boolean(savedId.current) || saveUnknown || save.isPending} aria-label={zh ? '模型名称' : 'Model name'} value={model} onChange={e => setModel(e.target.value)} /></div></details>
    {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
    <Button disabled={saveUnknown || save.isPending || (!savedId.current && !key.trim()) || !url.trim() || !model.trim()} onClick={() => { setFailure(''); save.mutate(); }}>{save.isPending ? (zh ? '正在保存并检查…' : 'Saving and checking…') : savedId.current ? (zh ? '再次检查（可能计费）' : 'Check again (may incur fees)') : (zh ? '保存并检查连接' : 'Save and check connection')}</Button>
    {(saveUnknown || savedId.current) && <Link className="block text-sm underline" to="/settings/models">{zh ? '查看已保存的连接' : 'Inspect saved connections'}</Link>}
    <Link className="block text-sm underline" to="/settings/agents">{zh ? '安装或管理本地助手' : 'Set up a local assistant'}</Link>
  </section>;
}
