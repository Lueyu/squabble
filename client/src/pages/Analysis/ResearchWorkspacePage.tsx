import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { History, Plus } from 'lucide-react';
import { fetchResearchConversations } from '@/api/research-conversations';
import { agentRosterApi } from '@/api/agent-roster';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { createRequestIntent } from '@/utils/simple-experience';
import ResearchHistoryList from '@/features/research-workspace/ResearchHistoryList';
import { ResearchStrategyLibrary, ResearchSavedStrategy } from '@/features/research-workspace/ResearchStrategyLibrary';
import NewStrategyInterviewPage from '@/features/strategy-interview/NewStrategyInterviewPage';
import { InterviewWorkspace } from '@/features/strategy-interview/StrategyInterviewPage';
import { saveComposer } from '@/features/strategy-interview/interview-state';
import { Input } from '@/components/ui/input';
import type { ResearchWorkspaceRequest } from '@/features/research-workspace/research-workspace-state';
import ArchivedCouncilPage from '@/pages/Council/ArchivedCouncilPage';
import '@/pages/Council/council-chat.css';
import '@/features/research-workspace/research-workspace.css';

export default function ResearchWorkspacePage() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('session') || params.get('sessionId');
  const tab = params.get('tab') === 'strategies' ? 'strategies' : 'chats';
  const interviewId = params.get('interview');
  const strategyId = params.get('strategy');
  const selection = `${tab}:${selectedId ?? interviewId ?? strategyId ?? 'new'}`;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [search, setSearch] = useState('');
  const [skills, setSkills] = useState<Record<string, string | null>>({});
  const draftKey = selectedId || 'new';
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({
    new: (params.get('question') || '').slice(0, 2000),
  }));
  const requests = useRef(new Map<string, ResearchWorkspaceRequest>());
  if (!requests.current.has(draftKey))
    requests.current.set(draftKey, {
      intent: createRequestIntent(() => crypto.randomUUID()),
    });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [agentIds, setAgentIds] = useState<string[] | null>(() => params.get('agent') ? [params.get('agent')!] : null);
  const roster = useQuery({ queryKey: ['agent-roster'], queryFn: agentRosterApi.list });
  const availableAgents = roster.data?.items?.filter(agent => agent.status === 'active') ?? [];
  const recommendedAgents = ['financials', 'bear', 'moderator'].flatMap(templateId => availableAgents.find(agent => agent.currentVersion.config.templateId === templateId) ?? []).slice(0, 3);
  const chosenAgents = agentIds === null ? (recommendedAgents.length ? recommendedAgents : availableAgents.slice(0, 3)) : availableAgents.filter(agent => agentIds.includes(agent.id));
  const agentSelection = chosenAgents.map(agent => ({ agentId: agent.id, agentVersionId: agent.currentVersionId }));
  const moderators = chosenAgents.filter(agent => agent.currentVersion.config.templateId === 'moderator');
  const moderator = moderators[0] ?? chosenAgents[chosenAgents.length - 1];
  const participantProblem = selectedId ? null : roster.isPending
    ? (zh ? '正在读取股友，准备好后再发送问题。' : 'Loading your agents. Wait before sending a question.')
    : roster.isError || !roster.data
      ? (zh ? '暂时无法读取股友，请重新读取后继续。' : 'Your roster is unavailable. Reload it before continuing.')
      : !chosenAgents.length
        ? (zh ? '所选股友已不可用。请明确选择其他股友，或先添加股友。' : 'The selected agent is unavailable. Choose another agent explicitly, or add an agent first.')
        : moderators.length > 1
          ? (zh ? '请只选择一位主持股友，再发送问题。' : 'Choose one moderator before sending your question.')
          : null;
  const sessions = useQuery({
    queryKey: ['research-conversations'],
    queryFn: fetchResearchConversations,
    refetchInterval: 15_000,
  });
  const select = (id: string | null) => {
    setParams(id ? { session: id } : {});
    setHistoryOpen(false);
  };
  const selectStrategy = (kind: 'interview' | 'strategy', id: string) => {
    setParams({ tab: 'strategies', [kind]: id });
    setHistoryOpen(false);
  };
  const startStrategy = (message: string) => {
    if (message.trim()) saveComposer('new', message.slice(0, 1500));
    selectStrategy('interview', 'new');
  };
  const history = (
    <ResearchHistoryList
      sessions={(sessions.data ?? []).filter(item => `${item.title ?? ''} ${item.subject ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))}
      selectedId={selectedId}
      pending={sessions.isPending}
      error={sessions.isError}
      onRetry={() => void sessions.refetch()}
      onSelect={select}
      onDeleted={(id) => {
        if (selectedRef.current === id) select(null);
        requests.current.delete(id);
        setDrafts((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
      }}
    />
  );
  const sidebar = <>
    <div className="research-sidebar-tabs" role="tablist" aria-label={zh ? '研究内容' : 'Research content'}>
      <button type="button" role="tab" aria-selected={tab === 'chats'} onClick={() => { setParams({}); setSearch(''); }}>{zh ? '对话' : 'Chats'}</button>
      <button type="button" role="tab" aria-selected={tab === 'strategies'} onClick={() => { setParams({ tab: 'strategies' }); setSearch(''); }}>{zh ? '策略库' : 'Strategies'}</button>
    </div>
    <Input aria-label={zh ? '搜索研究内容' : 'Search research'} placeholder={tab === 'chats' ? (zh ? '搜索对话' : 'Search chats') : (zh ? '搜索策略库' : 'Search strategies')}
      value={search} onChange={event => setSearch(event.target.value)} className="research-sidebar-search" />
    {tab === 'chats' ? <><h2>{zh ? '历史研究' : 'Research history'}</h2>{history}</>
      : <ResearchStrategyLibrary selected={interviewId ?? strategyId} search={search} onSelect={selectStrategy} />}
    <div className="research-sidebar-footer"><strong>{zh ? '技能' : 'Skills'}</strong><p>{zh ? '输入 / 选择分析方式' : 'Type / to choose a research skill'}</p><span>{zh ? '策略访谈 · 财报 · 估值 · 对比' : 'Strategy · Financials · Valuation · Peers'}</span></div>
  </>;

  return (
    <section
      className="research-workspace-shell"
      aria-label={zh ? '研究室' : 'Research room'}
    >
      <aside
        className="research-workspace-sidebar"
        aria-label={zh ? '研究历史' : 'Research history'}
      >
        <header>
          <h1>{zh ? '研究室' : 'Research room'}</h1>
          <Button
            size="sm"
            variant="outline"
            onClick={() => select(null)}
            aria-label={zh ? '新研究' : 'New research'}
          >
            <Plus size={15} />
            {zh ? '新研究' : 'New research'}
          </Button>
        </header>
        {sidebar}
      </aside>
      <div className="research-workspace-main">
        <div className="research-workspace-mobile-tools">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setHistoryOpen(true)}
          >
            <History size={15} />
            {zh ? '研究历史' : 'Research history'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => select(null)}
            aria-label={zh ? '新研究' : 'New research'}
          >
            <Plus size={15} />
            {zh ? '新研究' : 'New research'}
          </Button>
        </div>
        {tab === 'chats' && !selectedId && availableAgents.length > 0 && <section className="border-b px-4 py-3 space-y-2" aria-label={zh ? '本次研究股友' : 'Research participants'}><p className="text-sm font-medium">{zh ? '这次和谁聊？' : 'Who should join?'}</p><div className="flex flex-wrap gap-2">{availableAgents.map(agent => <Button key={agent.id} size="sm" variant={chosenAgents.some(item => item.id === agent.id) ? 'secondary' : 'outline'} aria-pressed={chosenAgents.some(item => item.id === agent.id)} disabled={Boolean(requests.current.get(draftKey)?.submission)} onClick={() => {
          const selected = chosenAgents.map(item => item.id);
          if (selected.includes(agent.id)) { if (selected.length > 1) setAgentIds(selected.filter(id => id !== agent.id)); }
          else if (selected.length < 6) setAgentIds([...selected, agent.id]);
        }}>{agent.name}</Button>)}</div><p className="text-xs text-muted-foreground">{chosenAgents.length === 1 ? (zh ? '单聊由这位股友直接回答。' : 'This agent answers directly.') : (zh ? `有限讨论，${moderator?.name ?? ''}负责最后收束。` : `Bounded discussion; ${moderator?.name ?? ''} gives the final summary.`)}</p></section>}
        {tab === 'chats' && participantProblem && <section role="alert" className="border-b px-4 py-3 text-sm space-y-2"><p>{participantProblem}</p>{roster.isError && <Button size="sm" variant="outline" onClick={() => void roster.refetch()}>{zh ? '重新读取股友' : 'Reload agents'}</Button>}<Link className="underline" to="/friends">{zh ? '管理我的股友' : 'Manage my agents'}</Link></section>}
        {tab === 'strategies' ? interviewId && interviewId !== 'new'
          ? <InterviewWorkspace key={interviewId} id={interviewId} embedded />
          : strategyId ? <ResearchSavedStrategy key={strategyId} id={strategyId} />
            : <NewStrategyInterviewPage key="new-strategy" embedded onCreated={id => selectStrategy('interview', id)} />
          : <ArchivedCouncilPage
          readOnly={Boolean(participantProblem)}
          workspace={{
            agents: agentSelection.length ? agentSelection : undefined,
            skillId: skills[draftKey],
            onSkillChange: id => setSkills(previous => ({ ...previous, [draftKey]: id })),
            onStrategy: startStrategy,
            draft: drafts[draftKey] ?? '',
            request: requests.current.get(draftKey)!,
            onDraftChange: (value) =>
              setDrafts((previous) => ({ ...previous, [draftKey]: value })),
            onAccepted: (id) => {
              setDrafts((previous) => ({ ...previous, [draftKey]: '' }));
              if (selectionRef.current === selection)
                setParams({ session: id });
            },
          }}
        />}
      </div>
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent
          side="left"
          className="research-workspace-drawer"
          closeLabel={zh ? '关闭研究历史' : 'Close research history'}
        >
          <SheetHeader>
            <SheetTitle>{zh ? '研究历史' : 'Research history'}</SheetTitle>
            <SheetDescription>
              {zh
                ? '在这里选择任务，原始研究会在对话区打开。'
                : 'Choose a task to open its original research in the conversation area.'}
            </SheetDescription>
          </SheetHeader>
          {sidebar}
        </SheetContent>
      </Sheet>
    </section>
  );
}
