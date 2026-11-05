import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { CouncilMessage } from '@shared/council.interface';
import type { ResearchContext, ResearchConversationClarification } from '@shared/simple-conversation.interface';
import { createResearchConversation, fetchResearchConversation, fetchResearchConversations, postResearchConversationMessage, renameResearchConversation } from '@/api/research-conversations';
import { proposeInvestmentConstraint, type ConstraintProposal } from '@/api/ai-investment';
import { contextFromSearch, createRequestIntent } from '@/utils/simple-experience';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import CouncilChatMessage from './CouncilChatMessage';
import QuickQuestion from './QuickQuestion';
import DebateSummary from './DebateSummary';
import ConstraintProposalCard from './ConstraintProposalCard';

export default function SimpleCouncilPage() {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams(); const client = useQueryClient();
  const id = params.get('session') || params.get('sessionId');
  const [context, setContext] = useState<ResearchContext | undefined>(() => contextFromSearch(params));
  const [reply, setReply] = useState<CouncilMessage | null>(null); const [pending, setPending] = useState(false);
  const [search, setSearch] = useState(''); const [history, setHistory] = useState(false);
  const [clarification, setClarification] = useState<ResearchConversationClarification | null>(null);
  const [originalQuestion, setOriginalQuestion] = useState('');
  const [rename, setRename] = useState(false); const [title, setTitle] = useState('');
  const [proposal, setProposal] = useState<ConstraintProposal | null>(null);
  const auxiliaryIntent = useRef(createRequestIntent(() => crypto.randomUUID())); const auxiliaryLock = useRef(false);
  const intent = useRef(createRequestIntent(() => crypto.randomUUID())); const scroll = useRef<HTMLDivElement>(null);
  const sessions = useQuery({ queryKey: ['research-conversations'], queryFn: fetchResearchConversations, refetchInterval: 15_000 });
  const query = useQuery({ queryKey: ['research-conversation', id], queryFn: () => fetchResearchConversation(id!), enabled: Boolean(id), refetchInterval: q => q.state.data?.status === 'running' ? 2000 : 10_000 });
  const session = query.data;
  useEffect(() => { setContext(contextFromSearch(params)); setReply(null); setClarification(null); }, [params]);
  useEffect(() => { const element = scroll.current; if (element) element.scrollTop = element.scrollHeight; }, [session?.messages.length, session?.stage]);
  const submit = async (message: string, override?: ResearchContext) => {
    if (pending) return false;
    setPending(true);
    try {
      const payload = id ? { message, ...(reply ? { replyTo: reply.id } : {}) }
        : { message, ...((override || context) ? { context: override || context } : {}) };
      const requestKey = intent.current.keyFor({ id, ...payload });
      const saved = id ? await postResearchConversationMessage(id, { ...payload, requestKey }) : await createResearchConversation({ ...payload, requestKey });
      if ('needsInput' in saved) { setClarification(saved); setOriginalQuestion(message); return false; }
      intent.current.complete(); setClarification(null); setReply(null);
      client.setQueryData(['research-conversation', saved.id], saved);
      void client.invalidateQueries({ queryKey: ['research-conversations'] });
      void client.invalidateQueries({ queryKey: ['today'] });
      setParams({ session: saved.id }); return true;
    } catch { toast.error(zh ? '问题未能确认送达，请重试。重试会保留同一次请求。' : 'The question could not be confirmed. Retry will reuse the same request.'); return false; }
    finally { setPending(false); }
  };
  const contextLabel = session?.contextLabel || (context?.kind === 'stock' ? `${zh ? '正在讨论：' : 'Discussing: '}${context.ticker}`
    : context?.kind === 'report' ? (zh ? '正在讨论：当时的研究材料' : 'Discussing: original research material')
    : context?.kind === 'decision' ? (zh ? '正在讨论：当时的操作及依据' : 'Discussing: action and evidence at the time')
    : context?.kind === 'portfolio' ? `${zh ? '正在讨论：持仓 ' : 'Discussing: portfolio '}${context.date || ''}` : undefined);
  const stageLabel = { independent: zh ? '本轮独立研究' : 'Independent research this round', discussion: zh ? '相互质疑' : 'Discussing the evidence', supplement: zh ? '针对性补查' : 'Checking disputed evidence', completed: zh ? '研究已完成' : 'Research complete', waiting: zh ? '等待资料或可用成员' : 'Waiting for evidence or an available member' };
  const updateAuxiliary = async (kind: 'rename' | 'constraint', text: string) => {
    if (!id || auxiliaryLock.current) return; auxiliaryLock.current = true; setPending(true);
    try {
      const requestKey = auxiliaryIntent.current.keyFor({ kind, id, text });
      if (kind === 'rename') { const saved = await renameResearchConversation(id, { title: text, requestKey }); client.setQueryData(['research-conversation', id], saved); setRename(false); void sessions.refetch(); }
      else setProposal(await proposeInvestmentConstraint({ text, sessionId: id, requestKey }));
      auxiliaryIntent.current.complete();
    } catch { toast.error(kind === 'constraint' ? (zh ? '无法提出限制，请先开启 AI 账户并明确股票、额度或期限。' : 'Cannot propose a restriction. Enable the AI account first and specify the security, limit or expiry.') : (zh ? '标题未能保存，请重试。' : 'The title could not be saved. Retry.')); }
    finally { auxiliaryLock.current = false; setPending(false); }
  };
  return <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b p-3 sm:px-5"><div className="min-w-0"><h1 className="truncate font-semibold">{session?.title || (zh ? '投研室' : 'Research room')}</h1>{session && <p role="status" className="mt-1 text-xs text-muted-foreground">{stageLabel[session.stage]}{session.mode === 'single' && (zh ? ' · 单人分析' : ' · Single-source analysis')}</p>}</div>
      <div className="flex flex-wrap gap-2">{session && <Button size="sm" variant="ghost" onClick={() => { setTitle(session.title || ''); setRename(!rename); }}>{zh ? '改名' : 'Rename'}</Button>}<Button size="sm" variant="outline" onClick={() => setHistory(!history)}>{zh ? '最近讨论' : 'Recent discussions'}</Button><Button size="sm" onClick={() => { setParams({}); setContext(undefined); }}>{zh ? '新讨论' : 'New discussion'}</Button></div></header>
    {rename && <form className="flex shrink-0 gap-2 border-b p-3" onSubmit={event => { event.preventDefault(); void updateAuxiliary('rename', title.trim()); }}><Input aria-label={zh ? '讨论标题' : 'Discussion title'} maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /><Button type="submit" size="sm" disabled={pending || !title.trim()}>{zh ? '保存' : 'Save'}</Button></form>}
    {history && <section className="max-h-64 shrink-0 space-y-2 overflow-y-auto border-b p-3"><label className="sr-only" htmlFor="discussion-search">{zh ? '搜索最近讨论' : 'Search recent discussions'}</label><Input id="discussion-search" value={search} onChange={event => setSearch(event.target.value)} placeholder={zh ? '搜索标题或问题' : 'Search title or question'} />
      {(sessions.data || []).filter(item => `${item.title} ${item.subject || ''} ${item.messages?.map(message => message.content).join(' ') || ''}`.toLowerCase().includes(search.toLowerCase())).map(item => <button type="button" key={item.id} className="block w-full rounded-lg p-2 text-left text-sm hover:bg-muted" onClick={() => { setParams({ session: item.id }); setHistory(false); }}>{item.title || item.subject || item.ticker}<span className="ml-2 text-xs text-muted-foreground">{new Date(item.updatedAt).toLocaleDateString(i18n.language)}</span></button>)}
      {sessions.isError && <Button size="sm" variant="outline" onClick={() => void sessions.refetch()}>{zh ? '重试读取讨论' : 'Retry discussions'}</Button>}</section>}
    {!!session?.actualExecutors?.length && <div className="flex shrink-0 flex-wrap gap-3 border-b px-4 py-3 text-xs">{session.actualExecutors.map(executor => <div className="min-w-0 max-w-full" key={executor.memberId}><strong>{session.members?.find(member => member.id === executor.memberId)?.name || executor.memberId}</strong><p className="break-words text-muted-foreground">{executor.connection} · {executor.provider} · {executor.model}</p>{session.actualExecutors.filter(item => item.identity === executor.identity).length > 1 && <p className="text-amber-600">{zh ? '共享同一执行来源' : 'Shares one execution source'}</p>}</div>)}</div>}
    <div ref={scroll} className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3 sm:p-5" role="log" aria-live="polite" aria-label={zh ? '研究对话' : 'Research conversation'}>
      {!id && <div className="mx-auto max-w-lg space-y-4 py-10 text-center"><h2 className="text-xl font-semibold">{zh ? '和 AI 股友一起把问题想清楚' : 'Think through an investment question together'}</h2><p className="text-sm leading-7 text-muted-foreground">{zh ? '直接输入问题。成员会根据可用连接参与，股票、日报和操作依据会自动带入。' : 'Just ask. Available connections join automatically; stock, daily report and action context travel with your question.'}</p>
        <div className="flex flex-wrap justify-center gap-2">{[zh ? '我的持仓里最值得担心的是什么？' : 'What should I worry about most in my portfolio?', zh ? '如何检查一家公司的现金流质量？' : 'How can I assess cash flow quality?'].map((text, index) => <Button key={text} variant="outline" className="h-auto whitespace-normal text-left" disabled={pending} onClick={() => void submit(text, index === 0 ? { kind: 'portfolio' } : undefined)}>{text}</Button>)}</div></div>}
      {id && query.isPending && <p role="status">{zh ? '正在读取讨论…' : 'Loading discussion…'}</p>}
      {id && query.isError && <div role="alert" className="space-y-3"><p>{zh ? '讨论暂时不可用，原始消息未被替代。' : 'The discussion is unavailable. Original messages have not been replaced.'}</p><Button onClick={() => void query.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>}
      {session?.messages.map(message => <div key={message.id}><CouncilChatMessage message={message} session={session} simple
        executor={session.actualExecutors?.find(item => item.memberId === message.memberId)} onQuestion={text => void submit(text)} onReply={setReply} />
        {message.role === 'user' && <Button className="mt-1" size="sm" variant="ghost" disabled={pending} onClick={() => void updateAuxiliary('constraint', message.content)}>{zh ? '提议为 AI 账户限制' : 'Propose as an AI account restriction'}</Button>}</div>)}
      {proposal && <ConstraintProposalCard proposal={proposal} onClose={() => setProposal(null)} />}
      {!!session?.unavailableMembers?.length && <div className="rounded-lg border p-3 text-xs text-muted-foreground">{session.unavailableMembers.map(item => <p key={item.memberId}>{session.members?.find(member => member.id === item.memberId)?.name || item.memberId}: {item.reason}</p>)}</div>}
      {session?.mode === 'unavailable' && <p className="text-sm text-muted-foreground">{zh ? '目前没有可用 AI。' : 'No AI connection is available.'} <Link to="/settings/agents" className="text-primary underline">{zh ? '连接 AI' : 'Connect AI'}</Link></p>}
      {session?.outcome && <DebateSummary outcome={session.outcome} members={session.members || []} mode={session.mode} />}
      {session?.error && <p role="alert" className="rounded-lg border border-destructive/20 p-3 text-sm text-destructive">{session.error}</p>}
      {clarification && <section className="space-y-3 rounded-xl border p-4" role="status"><p>{clarification.needsInput.message}</p><div className="flex flex-wrap gap-2">{clarification.needsInput.options.map(option => <Button key={option.ticker} size="sm" variant="outline" disabled={pending} onClick={() => { setContext({ kind: 'stock', ticker: option.ticker }); void submit(originalQuestion, { kind: 'stock', ticker: option.ticker }); }}>{option.label}</Button>)}</div></section>}
    </div>
    <QuickQuestion key={id || 'new'} pending={pending} onSubmit={submit} contextLabel={contextLabel} onRemoveContext={!id ? () => setContext(undefined) : undefined}
      replyLabel={reply ? `${reply.memberName}: ${reply.content.slice(0, 140)}` : undefined} onRemoveReply={() => setReply(null)} />
  </div>;
}
