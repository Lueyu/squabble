import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import type { AgentProfile } from '@shared/agent-roster.interface';
import { agentRosterApi } from '@/api/agent-roster';
import { fetchModelConnections } from '@/api/model-connections';
import { fetchLocalAgents } from '@/api/local-agents';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { createRequestIntent } from '@/utils/simple-experience';
import { AgentConnectionSetup } from './AgentConnectionSetup';
import { defaultAgentExecutor } from './agent-roster-state';
import { ExternalAgentDialog } from './ExternalAgentDialog';
import { AgentEditorDialog } from './AgentEditorDialog';
import { AgentRosterCard } from './AgentRosterCard';

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
  const [failure, setFailure] = useState('');
  const [memoryAgent, setMemoryAgent] = useState<string | null>(null);
  const recommendedIntent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const editorIntent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const refresh = () => client.invalidateQueries({ queryKey: ['agent-roster'] });
  const recommended = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!executor) throw new Error('AI connection required');
      const existing = new Set(roster.data?.items.filter(agent => agent.status === 'active').map(agent => agent.currentVersion.config.templateId));
      const templateIds = templates.data?.filter(template => !existing.has(template.id)).map(template => template.id);
      if (templateIds?.length === 0) return;
      const payload = { executor, templateIds, language: zh ? 'zh-CN' as const : 'en' as const };
      await agentRosterApi.recommended({ ...payload, requestKey: recommendedIntent.current.keyFor(payload) });
    },
    onSuccess: refresh,
    onError: () => setFailure(zh
      ? '添加结果尚未确认。请刷新名单，再用相同选择重试。'
      : 'Addition is not confirmed. Refresh the roster, then retry the same choices.'),
  });
  const archive = useMutation({
    retry: false,
    mutationFn: (agent: AgentProfile) => agentRosterApi.archive(agent.id, {
      requestKey: `archive:${agent.id}:${agent.revision}`, expectedRevision: agent.revision,
    }),
    onSuccess: refresh,
    onError: () => setFailure(zh ? '归档未确认，请刷新后核对。' : 'Archive is not confirmed. Refresh to check.'),
  });
  function edit(agent: AgentProfile | null) {
    setEditing(agent);
    setFailure('');
    setOpen(true);
  }
  const active = roster.data?.items.filter(agent => agent.status === 'active') ?? [];
  const loading = roster.isPending || models.isPending || locals.isPending;

  return <section className="max-w-6xl mx-auto space-y-6 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{zh ? '我的股友' : 'My agents'}</h1>
        <p className="text-muted-foreground mt-2">{zh ? '认识他们的专长，邀请合适的股友加入你的团队。' : 'Meet their specialties and invite the right agents to your team.'}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => setExternalOpen(true)}>{zh ? '连接外部助手' : 'Connect external agent'}</Button>
        <Button variant="outline" disabled={!executor || !templates.data} onClick={() => edit(null)}>
          <Plus size={16} />{zh ? '添加股友' : 'Add agent'}
        </Button>
      </div>
    </header>
    {loading && <p role="status">{zh ? '正在读取股友和 AI 连接…' : 'Loading agents and AI connections…'}</p>}
    {(roster.isError || models.isError || locals.isError) && <div role="alert" className="rounded-xl border p-4 space-y-3">
      <p>{zh ? '部分信息暂时读不到，已有配置不会丢失。请重新读取后继续。' : 'Some information could not be loaded. Your saved setup is retained. Reload to continue.'}</p>
      <Button variant="outline" onClick={() => { void roster.refetch(); void models.refetch(); void locals.refetch(); }}>
        {zh ? '重新读取' : 'Reload'}
      </Button>
    </div>}
    {!loading && !executor && <AgentConnectionSetup zh={zh} locals={locals.data ?? []} />}
    {failure && <p role="alert" className="text-destructive text-sm">{failure}</p>}
    {!loading && executor && active.length < 5 && <section className="rounded-xl border border-primary/20 bg-primary/5 p-5 space-y-3">
      <h2 className="font-semibold">{zh ? '从推荐股友开始' : 'Start with recommended agents'}</h2>
      <p className="text-sm text-muted-foreground">{zh
        ? '财报、估值、反方、风控和主持各有所长。一次添加，再按需要选择成员；这一步不会调用模型。'
        : 'Financials, valuation, challenge, risk and moderation offer different strengths. Add them together, then choose members. Adding does not call a model.'}</p>
      <Button disabled={recommended.isPending || !templates.data} onClick={() => { setFailure(''); recommended.mutate(); }}>
        {recommended.isPending ? (zh ? '正在添加…' : 'Adding…') : (zh ? '添加推荐股友' : 'Add recommended agents')}
      </Button>
    </section>}
    <div className={cn(
      'grid sm:grid-cols-2 lg:grid-cols-3 gap-4 has-[details[open]]:items-start',
      memoryAgent !== null && 'items-start',
    )}>
      {active.map(agent => <AgentRosterCard key={agent.id} agent={agent} zh={zh}
        memoryOpen={memoryAgent === agent.id} archiving={archive.isPending}
        onEdit={() => edit(agent)} onMemory={() => setMemoryAgent(memoryAgent === agent.id ? null : agent.id)}
        onArchive={() => archive.mutate(agent)} />)}
    </div>
    {active.length > 0 && <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-5">
      <p>{zh ? '股友已经准备好，下一步组成你的团队。' : 'Your agents are ready. Next, create your team.'}</p>
      <Button asChild><Link to="/teams?guided=1">{zh ? '下一步：创建团队' : 'Next: create a team'}</Link></Button>
    </div>}
    <ExternalAgentDialog zh={zh} open={externalOpen} onOpenChange={setExternalOpen} />
    {open && templates.data && <AgentEditorDialog key={editing ? `${editing.id}:${editing.revision}` : 'new'}
      editing={editing} templates={templates.data} models={models.data ?? []} locals={locals.data ?? []}
      defaultExecutor={executor} zh={zh} onClose={() => setOpen(false)} onSaved={refresh}
      requestIntent={editorIntent.current} />}
  </section>;
}
