import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BookOpen, Plus } from 'lucide-react';
import type { AgentExecutor, AgentProfile, AgentTemplateId } from '@shared/agent-roster.interface';
import { agentRosterApi } from '@/api/agent-roster';
import { fetchModelConnections } from '@/api/model-connections';
import { fetchLocalAgents } from '@/api/local-agents';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { createRequestIntent } from '@/utils/simple-experience';
import { missingSpecialtyIds } from '@/features/teams/team-staffing';
import { AgentConnectionSetup } from './AgentConnectionSetup';
import { defaultAgentExecutor } from './agent-roster-state';
import { ExternalAgentDialog } from './ExternalAgentDialog';
import { AgentEditorDialog } from './AgentEditorDialog';
import { AgentRosterCard } from './AgentRosterCard';
import { safeReturnPath } from '@/features/navigation/workspace-navigation';
import { useAiReadiness } from '@/features/onboarding/use-ai-readiness';
import { TEAM_ONBOARDING_PATH } from '@/features/onboarding/onboarding-state';

export default function AgentRosterWorkspace() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const [params] = useSearchParams();
  const onboarding = params.get('onboarding') === '1';
  const requestedReturn = safeReturnPath(params.get('returnTo'));
  const returnTo = requestedReturn?.startsWith('/teams/') ? requestedReturn : TEAM_ONBOARDING_PATH;
  const readiness = useAiReadiness({ enabled: onboarding });
  const roster = useQuery({ queryKey: ['agent-roster'], queryFn: agentRosterApi.list });
  const templates = useQuery({ queryKey: ['agent-templates'], queryFn: agentRosterApi.templates });
  const models = useQuery({ queryKey: ['settings', 'model-connections'], queryFn: fetchModelConnections });
  const locals = useQuery({ queryKey: ['settings', 'local-agents'], queryFn: fetchLocalAgents });
  const verified = readiness.connection;
  const onboardingExecutor: AgentExecutor | null = verified?.kind === 'local'
    ? { executionMode: 'local', localAgentId: verified.connection.connectionId, settings: verified.connection.configuration }
    : verified?.kind === 'model' ? { executionMode: 'model', connectionId: verified.connection.id, model: 'fast' } : null;
  const executor = onboarding ? onboardingExecutor : defaultAgentExecutor(models.data ?? [], locals.data ?? []);
  const [open, setOpen] = useState(false);
  const [externalOpen, setExternalOpen] = useState(false);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [initialTemplateId, setInitialTemplateId] = useState<AgentTemplateId | undefined>(undefined);
  const [failure, setFailure] = useState('');
  const [memoryAgent, setMemoryAgent] = useState<string | null>(null);
  const recommendedIntent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const editorIntent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const refresh = () => client.invalidateQueries({ queryKey: ['agent-roster'] });
  const recommended = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!executor) throw new Error('AI connection required');
      const templateIds = missingSpecialtyIds(roster.data?.items ?? [], (templates.data ?? []).map(item => item.id));
      if (templateIds.length === 0) return;
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
    setInitialTemplateId(undefined);
    setFailure('');
    setOpen(true);
  }
  function addSpecialty(id: AgentTemplateId) {
    setEditing(null);
    setInitialTemplateId(id);
    setFailure('');
    setOpen(true);
  }
  const active = roster.data?.items.filter(agent => agent.status === 'active') ?? [];
  const rosterComplete = !roster.isPending && !roster.isError && !roster.data?.nextCursor;
  const missing = missingSpecialtyIds(active, (templates.data ?? []).map(item => item.id));
  const loading = roster.isPending || (onboarding ? readiness.pending : models.isPending || locals.isPending);
  const byId = new Map((templates.data ?? []).map(item => [item.id, item]));

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
    {!loading && !executor && (onboarding
      ? <Button asChild><Link to={readiness.connectionPath}>{zh ? '核对研究服务连接' : 'Check your research connection'}</Link></Button>
      : <AgentConnectionSetup zh={zh} locals={locals.data ?? []} />)}
    {failure && <p role="alert" className="text-destructive text-sm">{failure}</p>}
    {!onboarding && !loading && executor && rosterComplete && missing.length > 0 && <section className="rounded-xl border border-primary/20 bg-primary/5 p-5 space-y-3">
      <h2 className="font-semibold">{zh ? `还缺 ${missing.length} 种专业股友` : `${missing.length} specialties are still missing`}</h2>
      <p className="text-sm text-muted-foreground">{zh
        ? '按专业分工检查缺口，不按人数判断：同一专业多位股友不会补齐其他专业。一次添加只保存身份，不调用模型，也不会授予资料或工具。'
        : 'Gaps are checked per specialty, not by headcount: several agents in one specialty do not cover the others. Adding saves identities only; it does not call a model or grant data or tools.'}</p>
      <Button disabled={recommended.isPending || !templates.data} onClick={() => { setFailure(''); recommended.mutate(); }}>
        {recommended.isPending ? (zh ? '正在添加…' : 'Adding…') : (zh ? '添加缺失专业股友' : 'Add missing specialties')}
      </Button>
    </section>}
    {!loading && templates.data && <details className="rounded-xl border p-5">
      <summary className="flex cursor-pointer items-center gap-2 py-1 font-semibold"><BookOpen size={16} />{zh ? '查看专业目录（12 种）' : 'Browse all 12 specialties'}</summary>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {templates.data.map(template => {
          const guide = zh ? template.guide : template.guideEn;
          const ownedCount = active.filter(agent => agent.currentVersion.config.templateId === template.id).length;
          return <div key={template.id} className="min-w-0 space-y-2 rounded-lg border p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">{zh ? template.name : template.nameEn}</p>
              <span className="text-xs text-muted-foreground">{rosterComplete
                ? (ownedCount > 0 ? (zh ? `已有 ${ownedCount} 位` : `${ownedCount} owned`) : (zh ? '尚无' : 'None yet'))
                : (zh ? '名单读取中' : 'Roster loading')}</span>
            </div>
            <p className="text-sm text-muted-foreground">{zh ? template.specialty : template.specialtyEn}</p>
            <p className="break-words text-xs">{zh ? '标准交付' : 'Delivery'}：{zh ? template.delivery : template.deliveryEn}</p>
            {guide && <ul className="list-disc space-y-1 ps-4 text-xs text-muted-foreground">
              {guide.workflow.slice(0, 3).map((step, index) => <li key={index}>{step}</li>)}
            </ul>}
            <Button size="sm" variant="outline" onClick={() => addSpecialty(template.id)}>{zh ? '添加此专业' : 'Add this specialty'}</Button>
          </div>;
        })}
      </div>
    </details>}
    <div className={cn(
      'grid sm:grid-cols-2 lg:grid-cols-3 gap-4 has-[details[open]]:items-start',
      memoryAgent !== null && 'items-start',
    )}>
      {active.map(agent => <AgentRosterCard key={agent.id} agent={agent} zh={zh}
        template={byId.get(agent.currentVersion.config.templateId)}
        memoryOpen={memoryAgent === agent.id} archiving={archive.isPending}
        onEdit={() => edit(agent)} onMemory={() => setMemoryAgent(memoryAgent === agent.id ? null : agent.id)}
        onArchive={() => archive.mutate(agent)} />)}
    </div>
    {onboarding && !loading && roster.isSuccess && active.length === 0 && executor && <div className="rounded-xl border p-5">
      <p>{zh ? '还没有股友。先添加一位，再将其指派给团队岗位。' : 'Add your first agent so you can assign them to a team seat.'}</p>
      <Button className="mt-3" disabled={!templates.data} onClick={() => edit(null)}>{zh ? '添加第一位股友' : 'Add your first agent'}</Button>
    </div>}
    {active.length > 0 && <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-5">
      <p>{zh ? '股友已经准备好，下一步组成你的团队。' : 'Your agents are ready. Next, create your team.'}</p>
      <Button asChild><Link to={returnTo}>{onboarding
        ? (zh ? '继续团队设置' : 'Continue team setup')
        : (zh ? '下一步：创建团队' : 'Next: create a team')}</Link></Button>
    </div>}
    <ExternalAgentDialog zh={zh} open={externalOpen} onOpenChange={setExternalOpen} />
    {open && templates.data && <AgentEditorDialog key={editing ? `${editing.id}:${editing.revision}` : `new:${initialTemplateId ?? 'default'}`}
      editing={editing} templates={templates.data} models={models.data ?? []} locals={locals.data ?? []}
      defaultExecutor={executor} zh={zh} initialTemplateId={initialTemplateId}
      onClose={() => setOpen(false)} onSaved={refresh}
      requestIntent={editorIntent.current} />}
  </section>;
}
