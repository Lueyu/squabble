import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { a2aAgentsApi } from '@/api/a2a-agents';
import { agentRosterApi } from '@/api/agent-roster';
import type { A2aConnection } from '@shared/a2a-agents.interface';
import type { AnimalAvatarId } from '@shared/animal-avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createRequestIntent } from '@/utils/simple-experience';
import { friendlyError } from '@/utils/error-message';
import { AnimalAvatarPicker } from './AnimalAvatarPicker';

export function ExternalAgentDialog({ zh, open, onOpenChange }: { zh: boolean; open: boolean; onOpenChange: (value: boolean) => void }) {
  const [avatar, setAvatar] = useState<AnimalAvatarId>('technical');
  const query = useQueryClient(); const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [credential, setCredential] = useState(''); const [trustLocal, setTrustLocal] = useState(false); const [error, setError] = useState('');
  const intent = useRef(createRequestIntent(() => crypto.randomUUID())); const connected = useRef<A2aConnection | null>(null);
  const save = useMutation({ retry: false, mutationFn: async () => {
    const payload = { name: name.trim() || 'External agent', cardUrl: url.trim(), ...(credential ? { credential } : {}), trustLocalEndpoint: trustLocal };
    const requestKey = intent.current.keyFor({ ...payload, avatar });
    if (!connected.current) connected.current = await a2aAgentsApi.create({ ...payload, requestKey });
    const external = connected.current;
    await agentRosterApi.create({
      requestKey: `${requestKey}:roster`, avatar,
      name: (name.trim() || external.cardName).slice(0, 80), templateId: 'financials',
      specialty: (external.skills[0]?.name || 'External research').slice(0, 160),
      description: external.skills.map(skill => skill.description).join('\n').slice(0, 2000),
      executor: { executionMode: 'a2a', connectionId: external.id },
      preferences: { language: zh ? 'zh-CN' : 'en' }, allowedToolIds: [], allowedSources: [],
    });
  }, onSuccess: async () => { setCredential(''); intent.current.complete(); connected.current = null; await query.invalidateQueries({ queryKey: ['agent-roster'] }); await query.invalidateQueries({ queryKey: ['a2a-agents'] }); onOpenChange(false); }, onError: failure => setError(friendlyError(failure, zh, { zh: '连接尚未完成。请核对 Agent Card 地址、鉴权和本地服务授权，再用相同输入继续。', en: 'Connection is incomplete. Check the Agent Card URL, authentication and local-service authorization, then continue with the same input.' })) });
  return <Dialog open={open} onOpenChange={value => { if (!save.isPending) onOpenChange(value); }}><DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{zh ? '连接已有的外部助手' : 'Connect an external agent'}</DialogTitle><DialogDescription>{zh ? '读取 A2A 能力卡并登记为股友。这一步不向对方发送研究任务。' : 'Read the A2A capability card and register an agent. This step does not send a research task.'}</DialogDescription></DialogHeader><div className="space-y-4">
    <AnimalAvatarPicker value={avatar} onChange={setAvatar} zh={zh} disabled={Boolean(connected.current)} />
    <div className="space-y-2"><Label htmlFor="external-name">{zh ? '名字（可选）' : 'Name (optional)'}</Label><Input id="external-name" value={name} onChange={e => setName(e.target.value)} maxLength={80} disabled={Boolean(connected.current)} /></div>
    <div className="space-y-2"><Label htmlFor="external-card">{zh ? 'Agent Card 地址' : 'Agent Card URL'}</Label><Input id="external-card" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://agent.example/.well-known/agent-card.json" disabled={Boolean(connected.current)} /></div>
    <details><summary className="cursor-pointer text-sm">{zh ? '鉴权与本地服务（高级）' : 'Authentication and local service (advanced)'}</summary><div className="space-y-3 mt-3"><Label htmlFor="external-credential">{zh ? '访问凭据（可选，加密保存）' : 'Access credential (optional, encrypted)'}</Label><Input id="external-credential" type="password" autoComplete="off" value={credential} onChange={e => setCredential(e.target.value)} disabled={Boolean(connected.current)} /><label className="flex items-start gap-3 text-sm"><Checkbox checked={trustLocal} onCheckedChange={value => setTrustLocal(value === true)} disabled={Boolean(connected.current)} /><span>{zh ? '我允许连接这个已登记的本地端点。' : 'I allow this registered local endpoint.'}</span></label><p className="text-xs text-muted-foreground">{zh ? '本地服务还需由部署配置登记允许的地址；普通公网地址无需此项。服务端会限制地址、跳转和响应大小。' : 'A local service also needs its allowed address registered in deployment settings. Public endpoints do not need this option.'}</p></div></details>
    <p className="text-sm text-muted-foreground">{zh ? '外部助手的内部记忆、模型步骤和费用可能不可见。能力卡不等于交付已经验证，加入团队时会检查岗位要求。' : 'Internal memory, model steps and fees may be unavailable. A capability card does not prove delivery quality; team roles check their requirements.'}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button disabled={!url.trim() || save.isPending} onClick={() => { setError(''); save.mutate(); }}>{save.isPending ? (zh ? '正在读取能力并登记…' : 'Reading capabilities…') : (zh ? '检查连接并添加股友' : 'Check connection and add agent')}</Button>
  </div></DialogContent></Dialog>;
}
