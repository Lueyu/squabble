import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Users, MessageSquare, Archive } from 'lucide-react';
import { agentRosterApi } from '@/api/agent-roster';
import { fetchModelConnections } from '@/api/model-connections';
import { fetchLocalAgents } from '@/api/local-agents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createRequestIntent } from '@/utils/simple-experience';
import type { AgentExecutor, AgentProfile, AgentTemplateId, CreateAgentInput } from '@shared/agent-roster.interface';
import { AgentConnectionSetup } from './AgentConnectionSetup';
import { defaultAgentExecutor } from './agent-roster-state';
import { AgentMemoryPanel } from './AgentMemoryPanel';
import { ExternalAgentDialog } from './ExternalAgentDialog';
import { AgentCapabilityEditor } from './AgentCapabilityEditor';
import { ExternalAgentStatus } from './ExternalAgentStatus';
import type { ResearchSourceRef } from '@shared/team-workspace.interface';

export default function AgentRosterWorkspace() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const roster = useQuery({ queryKey: ['agent-roster'], queryFn: agentRosterApi.list });
  const templates = useQuery({ queryKey: ['agent-templates'], queryFn: agentRosterApi.templates });
  const models = useQuery({ queryKey: ['settings', 'model-connections'], queryFn: fetchModelConnections });
  const locals = useQuery({ queryKey: ['settings', 'local-agents'], queryFn: fetchLocalAgents });
  const executor = defaultAgentExecutor(models.data ?? [], locals.data ?? []);
  const [open, setOpen] = useState(false);
  const [externalOpen, setExternalOpen] = useState(false);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [templateId, setTemplateId] = useState<AgentTemplateId>('financials');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [sourceCeiling, setSourceCeiling] = useState<ResearchSourceRef[]>([]);
  const [toolCeiling, setToolCeiling] = useState<string[] | null>(null);
  const [failure, setFailure] = useState('');
  const [selectedExecutor, setSelectedExecutor] = useState<AgentExecutor | null>(null);
  const [preferences, setPreferences] = useState('');
  const [memoryAgent, setMemoryAgent] = useState<string | null>(null);
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const recommendedIntent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const refresh = () => client.invalidateQueries({ queryKey: ['agent-roster'] });
  const recommended = useMutation({ retry: false, mutationFn: async () => {
    if (!executor) throw new Error('AI connection required');
    const existing = new Set(roster.data?.items.filter(a => a.status === 'active').map(a => a.currentVersion.config.templateId));
    const templateIds = templates.data?.filter(t => !existing.has(t.id)).map(t => t.id);
    if (templateIds?.length === 0) return;
    const payload = { executor, templateIds };
    await agentRosterApi.recommended({ ...payload, requestKey: recommendedIntent.current.keyFor(payload) });
  }, onSuccess: refresh, onError: () => setFailure(zh ? '添加结果尚未确认。请刷新名单，再用相同选择重试。' : 'Addition is not confirmed. Refresh the roster, then retry the same choices.') });
  const save = useMutation({ retry: false, mutationFn: async () => {
    if (!executor && !editing) throw new Error('AI connection required');
    const template = templates.data?.find(item => item.id === templateId);
    const payload: Omit<CreateAgentInput, 'requestKey'> = { templateId, executor: selectedExecutor ?? executor!, preferences: { language: zh ? 'zh-CN' : 'en', userPreferences: preferences }, name: name.trim() || undefined, description, instructions: instructions.trim() || undefined, allowedSources: sourceCeiling, ...(toolCeiling !== null ? { allowedToolIds: toolCeiling } : {}), ...(editing && editing.currentVersion.config.templateId !== templateId ? { specialty: zh ? template?.specialty : template?.specialtyEn } : {}) };
    const requestKey = intent.current.keyFor({ editing: editing?.id, revision: editing?.revision, ...payload });
    return editing ? agentRosterApi.update(editing.id, { ...payload, requestKey, expectedRevision: editing.revision }) : agentRosterApi.create({ ...payload, requestKey });
  }, onSuccess: async () => { setOpen(false); await refresh(); }, onError: () => setFailure(zh ? '保存结果未确认，输入已保留。请核对名单后重试；版本冲突时重新打开股友。' : 'Save is not confirmed. Your input is retained. Check the roster before retrying; reopen the agent after a revision conflict.') });
  const archive = useMutation({ retry: false, mutationFn: (row: AgentProfile) => agentRosterApi.archive(row.id, { requestKey: `archive:${row.id}:${row.revision}`, expectedRevision: row.revision }), onSuccess: refresh, onError: () => setFailure(zh ? '归档未确认，请刷新后核对。' : 'Archive is not confirmed. Refresh to check.') });
  function edit(row: AgentProfile | null) {
    setEditing(row); setSelectedExecutor(row?.currentVersion.config.executor ?? executor); setPreferences(row?.currentVersion.config.preferences.userPreferences ?? ''); setName(row?.name ?? ''); setDescription(row?.description ?? ''); setInstructions(row?.currentVersion.config.instructions ?? ''); setSourceCeiling(row?.currentVersion.config.allowedSources ?? []); setToolCeiling(row?.currentVersion.config.allowedToolIds ?? null); setTemplateId(row?.currentVersion.config.templateId ?? 'financials'); setFailure(''); setOpen(true);
  }
  const active = roster.data?.items.filter(row => row.status === 'active') ?? [];
  const loading = roster.isPending || models.isPending || locals.isPending;
  return <section className="max-w-6xl mx-auto space-y-6 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">{zh ? '我的股友' : 'My agents'}</h1><p className="text-muted-foreground mt-2">{zh ? '认识他们的专长，邀请合适的股友加入你的团队。' : 'Meet their specialties and invite the right agents to your team.'}</p></div><div className="flex gap-2"><Button variant="ghost" onClick={() => setExternalOpen(true)}>{zh ? '连接外部助手' : 'Connect external agent'}</Button><Button variant="outline" disabled={!executor} onClick={() => edit(null)}><Plus size={16} />{zh ? '添加股友' : 'Add agent'}</Button></div></header>
    {loading && <p role="status">{zh ? '正在读取股友和 AI 连接…' : 'Loading agents and AI connections…'}</p>}
    {(roster.isError || models.isError || locals.isError) && <div role="alert" className="rounded-xl border p-4 space-y-3"><p>{zh ? '部分信息暂时读不到，已有配置不会丢失。请重新读取后继续。' : 'Some information could not be loaded. Your saved setup is retained. Reload to continue.'}</p><Button variant="outline" onClick={() => { void roster.refetch(); void models.refetch(); void locals.refetch(); }}>{zh ? '重新读取' : 'Reload'}</Button></div>}
    {!loading && !executor && <AgentConnectionSetup zh={zh} locals={locals.data ?? []} />}
    {failure && <p role="alert" className="text-destructive text-sm">{failure}</p>}
    {!loading && executor && active.length < 5 && <section className="rounded-xl border border-primary/20 bg-primary/5 p-5 space-y-3"><h2 className="font-semibold">{zh ? '从推荐股友开始' : 'Start with recommended agents'}</h2><p className="text-sm text-muted-foreground">{zh ? '财报、估值、反方、风控和主持各有所长。一次添加，再按需要选择成员；这一步不会调用模型。' : 'Financials, valuation, challenge, risk and moderation offer different strengths. Add them together, then choose members. Adding does not call a model.'}</p><Button disabled={recommended.isPending || !templates.data} onClick={() => { setFailure(''); recommended.mutate(); }}>{recommended.isPending ? (zh ? '正在添加…' : 'Adding…') : (zh ? '添加推荐股友' : 'Add recommended agents')}</Button></section>}
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{active.map(row => <article key={row.id} className="rounded-xl border bg-card p-5 space-y-3">
      <div className="flex items-center justify-between"><Users className="text-primary" size={22} /><span className="text-xs rounded-full bg-muted px-2 py-1">{row.availability === 'configured' ? (zh ? '已配置' : 'Configured') : (zh ? '需要连接' : 'Connection needed')}</span></div>
      <h2 className="font-semibold text-lg">{row.name}</h2><p className="text-sm font-medium">{row.specialty}</p><p className="text-sm text-muted-foreground">{row.description}</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" asChild><Link to={`/research?agent=${encodeURIComponent(row.id)}`}><MessageSquare size={14} />{zh ? '聊一聊' : 'Chat'}</Link></Button><Button size="sm" variant="ghost" onClick={() => edit(row)}>{zh ? '了解与调整' : 'Details and edit'}</Button><Button size="sm" variant="ghost" onClick={() => setMemoryAgent(memoryAgent === row.id ? null : row.id)}>{zh ? '记忆' : 'Memory'}</Button></div>
      {memoryAgent === row.id && <AgentMemoryPanel agent={row} zh={zh} />}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{zh ? '能力版本与资料范围' : 'Version and data scope'}</summary><p className="mt-2">{zh ? '能力版本' : 'Version'} {row.currentVersion.version} · {row.currentVersion.config.executor.executionMode === 'model' ? (zh ? '共用模型连接' : 'Shared model connection') : row.currentVersion.config.executor.executionMode === 'a2a' ? (zh ? '外部助手' : 'External agent') : (zh ? '本地助手' : 'Local assistant')}</p><p>{zh ? '团队内部记忆各自隔离；只使用明确授权的资料和工具。' : 'Team memories are isolated; only explicitly allowed data and tools are used.'}</p>{row.currentVersion.config.executor.executionMode === 'a2a' && <ExternalAgentStatus connectionId={row.currentVersion.config.executor.connectionId} zh={zh} />}<p className="mt-2">{zh ? '归档后不能开始新工作，已派发任务按原权限结算。' : 'Archiving stops new work; dispatched tasks settle under existing permissions.'}</p><Button className="mt-2" size="sm" variant="ghost" disabled={archive.isPending} onClick={() => archive.mutate(row)}><Archive size={12} />{zh ? '归档股友' : 'Archive agent'}</Button></details>
    </article>)}</div>
    {active.length > 0 && <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-5"><p>{zh ? '股友已经准备好，下一步组成你的团队。' : 'Your agents are ready. Next, create your team.'}</p><Button asChild><Link to="/teams?guided=1">{zh ? '下一步：创建团队' : 'Next: create a team'}</Link></Button></div>}
    <ExternalAgentDialog zh={zh} open={externalOpen} onOpenChange={setExternalOpen} />
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{editing ? (zh ? '了解与调整股友' : 'Edit agent') : (zh ? '添加自己的股友' : 'Add your agent')}</DialogTitle><DialogDescription>{zh ? '选择专长、起个名字，或描述你希望他怎么帮忙。保存只更新能力版本。' : 'Choose a specialty, a name, and describe how this agent should help. Saving creates a capability version.'}</DialogDescription></DialogHeader>
      <div className="space-y-4"><div className="space-y-2"><Label htmlFor="agent-template">{zh ? '专长' : 'Specialty'}</Label><select id="agent-template" className="w-full rounded-md border bg-background p-2" value={templateId} onChange={e => { const id = e.target.value as AgentTemplateId; setTemplateId(id); setInstructions(templates.data?.find(t => t.id === id)?.instructions ?? ''); }}>{templates.data?.map(t => <option key={t.id} value={t.id}>{zh ? t.name : t.nameEn}</option>)}</select></div><div className="space-y-2"><Label htmlFor="agent-name">{zh ? '名字（可选）' : 'Name (optional)'}</Label><Input id="agent-name" maxLength={80} value={name} onChange={e => setName(e.target.value)} /></div><div className="space-y-2"><Label htmlFor="agent-description">{zh ? '希望他如何帮忙（可选）' : 'How should this agent help? (optional)'}</Label><Textarea id="agent-description" value={description} maxLength={2000} onChange={e => setDescription(e.target.value)} placeholder={zh ? '例如：关注现金流，主动说明数据缺口，回答简短一些。' : 'For example: focus on cash flow, explain missing data, and keep answers concise.'} /></div><details><summary className="cursor-pointer text-sm">{zh ? '高级：详细指令' : 'Advanced: instructions'}</summary><label className="block mt-3 text-sm">{zh ? '个人偏好' : 'Personal preferences'}<Textarea maxLength={4000} value={preferences} onChange={e => setPreferences(e.target.value)} /></label><label className="block my-3 text-sm">{zh ? '复用已保存的连接' : 'Reuse a saved connection'}<select className="w-full rounded border bg-background p-2" value={selectedExecutor?.executionMode === 'local' ? `local:${selectedExecutor.localAgentId}` : selectedExecutor ? `${selectedExecutor.executionMode}:${selectedExecutor.connectionId}` : ''} onChange={e => { const [mode, id] = e.target.value.split(':'); if (mode === 'model') setSelectedExecutor({ executionMode: 'model', connectionId: id, model: 'fast' }); else if (mode === 'local') setSelectedExecutor({ executionMode: 'local', localAgentId: id, settings: {} }); }}><option value="" disabled>{zh ? '请选择连接' : 'Choose a connection'}</option>{models.data?.map(c => <option key={c.id} value={`model:${c.id}`} disabled={!c.available}>{c.name}</option>)}{locals.data?.map(c => <option key={c.id} value={`local:${c.id}`} disabled={!c.connected || !c.available}>{c.name}</option>)}{selectedExecutor?.executionMode === 'a2a' && <option value={`a2a:${selectedExecutor.connectionId}`}>{zh ? '当前外部连接' : 'Current external connection'}</option>}</select></label><Textarea className="mt-2" aria-label={zh ? '详细指令' : 'Instructions'} value={instructions} onChange={e => setInstructions(e.target.value)} maxLength={12000} /></details><details><summary className="cursor-pointer text-sm">{zh ? '高级：资料和工具范围' : 'Advanced: data and tool scopes'}</summary><AgentCapabilityEditor zh={zh} sources={sourceCeiling} tools={toolCeiling ?? templates.data?.find(t => t.id === templateId)?.allowedToolIds ?? []} availableTools={templates.data?.flatMap(t => [...t.allowedToolIds]) ?? []} onSources={setSourceCeiling} onTools={setToolCeiling} /></details>{failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}<Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? (zh ? '正在保存…' : 'Saving…') : (zh ? '保存股友' : 'Save agent')}</Button></div>
    </DialogContent></Dialog>
  </section>;
}
