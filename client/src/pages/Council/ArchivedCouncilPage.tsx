import { useEffect, useRef, useState } from 'react';
import { ResearchToolActivity } from '@/features/research-workspace/ResearchToolActivity';
import { Link,useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Ellipsis, Plus } from 'lucide-react';
import type { CouncilMessage } from '@shared/council.interface';
import type { ResearchContext, ResearchConversationClarification } from '@shared/simple-conversation.interface';
import { configureResearchExecution, createResearchConversation, fetchOriginalResearchResult, fetchResearchConversation, fetchResearchConversations, fetchResearchExecutionReadiness, postResearchConversationMessage, recoverResearchConversation, renameResearchConversation, stopResearchConversation } from '@/api/research-conversations';
import type { RecoveryAction } from '@shared/research-execution.interface';
import { proposeInvestmentConstraint, type ConstraintProposal } from '@/api/ai-investment';
import { contextFromSearch, createRequestIntent } from '@/utils/simple-experience';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { isReadingLatest, researchModelLabel } from '@/utils/research-experience';
import { researchTimeline, researchConversation } from '@/utils/research-events';
import CouncilRoundReport from './CouncilRoundReport';
import InvestmentStrategySourceDialog from '@/features/investment-strategies/InvestmentStrategySourceDialog';
import type {StrategySourceInput} from '@shared/user-investment-strategy.interface';
import CouncilChatMessage from './CouncilChatMessage';
import QuickQuestion from './QuickQuestion';
import { fetchResearchSkills } from '@/api/research-conversations';
import DebateSummary from './DebateSummary';
import ConstraintProposalCard from './ConstraintProposalCard';
import CouncilMemberActivity from './CouncilMemberActivity';
import CouncilRecoveryCard from './CouncilRecoveryCard';
import CouncilResearchTimeline from './CouncilResearchTimeline';
import CouncilMemberAvatar from './CouncilMemberAvatar';
import CouncilModelConfiguration from './CouncilModelConfiguration';
import type { ResearchWorkspaceComposer } from '@/features/research-workspace/research-workspace-state';

export default function ArchivedCouncilPage({readOnly=false,embeddedSessionId,workspace}:{readOnly?:boolean;embeddedSessionId?:string;workspace?:ResearchWorkspaceComposer}) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams(); const client = useQueryClient();
  const id = embeddedSessionId || params.get('session') || params.get('sessionId');
  const [context, setContext] = useState<ResearchContext | undefined>(() => contextFromSearch(params) ?? (workspace ? { kind: 'portfolio' } : undefined));
  const [reply, setReply] = useState<CouncilMessage | null>(null); const [pending, setPending] = useState(false);
  const [search, setSearch] = useState(''); const [history, setHistory] = useState(false);
  const [details, setDetails] = useState(false); const [newMessages, setNewMessages] = useState(false);
  const [receipt, setReceipt] = useState<'sending' | 'accepted' | null>(null);
  const [original, setOriginal] = useState<{ memberId: string; text: string } | null>(null);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [configurationMember, setConfigurationMember] = useState<string | null>(null);
  const [clarification, setClarification] = useState<ResearchConversationClarification | null>(null);
  const [originalQuestion, setOriginalQuestion] = useState('');
  const [rename, setRename] = useState(false); const [title, setTitle] = useState('');
  const [proposal, setProposal] = useState<ConstraintProposal | null>(null);
  const [strategySource,setStrategySource]=useState<StrategySourceInput|null>(null);
  const auxiliaryIntent = useRef(createRequestIntent(() => crypto.randomUUID())); const auxiliaryLock = useRef(false);
  const intent = useRef(createRequestIntent(() => crypto.randomUUID())); const scroll = useRef<HTMLDivElement>(null);
  const recoveryIntent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const sendLock = useRef(false); const recoveryLock = useRef(false); const followLatest = useRef(true);
  const originalRequest = useRef(0);
  const sessions = useQuery({ queryKey: ['research-conversations'], queryFn: fetchResearchConversations, refetchInterval: 15_000 });
  const query = useQuery({ queryKey: ['research-conversation', id], queryFn: () => fetchResearchConversation(id!), enabled: Boolean(id), refetchInterval: q => q.state.data?.status === 'running' || q.state.data?.initializing ? 2000 : 10_000 });
  const session = query.data;
  const skillCatalog = useQuery({ queryKey: ['research-skills'], queryFn: fetchResearchSkills, enabled: Boolean(workspace), staleTime: 300_000 });
  const selectedSkillId = workspace?.skillId === undefined ? session?.skills?.at(-1)?.id : workspace.skillId;
  const selectedSkill = skillCatalog.data?.find(skill => skill.id === selectedSkillId);
  const readiness = useQuery({ queryKey: ['research-execution', 'readiness'], queryFn: fetchResearchExecutionReadiness, enabled: Boolean(configurationMember), staleTime: 0 });
  const configurationExecutor = session?.actualExecutors?.find(item => item.memberId === configurationMember);
  const configurationId = configurationExecutor?.connectionId ?? configurationExecutor?.connection;
  const configuration = readiness.data?.find(item => item.connectionId === configurationId);
  const timeline = session ? researchTimeline(session) : undefined;
  const conversation = session ? researchConversation(session) : undefined;
  const workspaceMode = Boolean(workspace);
  useEffect(() => { setContext(contextFromSearch(params) ?? (workspaceMode ? { kind: 'portfolio' } : undefined)); setReply(null); setClarification(null); }, [params, workspaceMode]);
  useEffect(() => { followLatest.current = true; setNewMessages(false); setOriginal(null); originalRequest.current++; setRename(false); setProposal(null); setConfigurationMember(null); }, [id]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (followLatest.current) { element.scrollTop = element.scrollHeight; setNewMessages(false); }
    else setNewMessages(true);
  }, [session?.messages.length, session?.reports.length, timeline?.cursor]);
  const submit = async (message: string, override?: ResearchContext) => {
    if (readOnly || pending || sendLock.current) return false;
    const command = workspace ? message.trim().match(/^\/(\S+)(?:\s|$)/u)?.[1] : undefined;
    const commandedSkill = command ? skillCatalog.data?.find(skill => skill.command === `/${command}`) : undefined;
    if (command === 'strategy') { workspace!.onStrategy(message.replace(/^\s*\/strategy\s*/u, '')); return true; }
    if (command && !commandedSkill) { toast.error(zh ? '未找到这个技能，请输入 / 选择已安装的技能。' : 'Unknown skill. Type / to choose an installed skill.'); return false; }
    sendLock.current = true; setPending(true); setReceipt('sending');
    try {
      const skillSelection = commandedSkill ? { skillId: commandedSkill.id }
        : workspace?.skillId !== undefined ? { skillId: workspace.skillId } : {};
      const payload = id ? { message, ...skillSelection, ...(reply ? { replyTo: reply.id } : {}) }
        : { message, ...skillSelection, ...(workspace?.agents?.length ? { agents: workspace.agents } : {}), ...((override || context) ? { context: override || context } : {}) };
      const requestIntent = workspace?.request.intent ?? intent.current;
      const submission = workspace?.request.submission ?? { ...payload, requestKey: requestIntent.keyFor({ id, ...payload }) };
      if (workspace) workspace.request.submission = submission;
      const saved = id ? await postResearchConversationMessage(id, submission) : await createResearchConversation(submission);
      if ('needsInput' in saved) { if (workspace) workspace.request.submission = undefined; setClarification(saved); setOriginalQuestion(message); setReceipt(null); return false; }
      requestIntent.complete();
      if (workspace) workspace.request.submission = undefined;
      setClarification(null); setReply(null);
      setReceipt('accepted'); followLatest.current = true;
      client.setQueryData(['research-conversation', saved.id], saved);
      void client.invalidateQueries({ queryKey: ['research-conversations'] });
      void client.invalidateQueries({ queryKey: ['today'] });
      if (workspace) workspace.onAccepted(saved.id);
      else if (!embeddedSessionId) setParams({ session: saved.id });
      return true;
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (workspace && status && status >= 400 && status < 500 && status !== 408 && status !== 429) workspace.request.submission = undefined;
      setReceipt(null); toast.error(zh ? '问题未能确认送达，请重试。重试会保留同一次请求。' : 'The question could not be confirmed. Retry will reuse the same request.'); return false;
    }
    finally { sendLock.current = false; setPending(false); }
  };
  const contextLabel = session?.contextLabel || (context?.kind === 'stock' ? `${zh ? '正在讨论：' : 'Discussing: '}${context.ticker}`
    : context?.kind === 'library' ? (zh ? '已附加资料库固定版本' : 'Pinned library source version')
    : context?.kind === 'report' ? (zh ? '基于这份持仓分析' : 'Based on this portfolio analysis')
    : context?.kind === 'decision' ? (zh ? '正在讨论：当时的操作及依据' : 'Discussing: action and evidence at the time')
    : context?.kind === 'portfolio' ? `${zh ? '正在讨论：持仓 ' : 'Discussing: portfolio '}${context.date || ''}` : undefined);
  const stageLabel = { independent: zh ? '本轮独立研究' : 'Independent research this round', discussion: zh ? '相互质疑' : 'Discussing the evidence', supplement: zh ? '针对性补查' : 'Checking disputed evidence', completed: zh ? '研究已完成' : 'Research complete', waiting: zh ? '等待资料或可用成员' : 'Waiting for evidence or an available member' };
  const updateAuxiliary = async (kind: 'rename' | 'constraint', text: string) => {
    if (readOnly || !id || auxiliaryLock.current) return; auxiliaryLock.current = true; setPending(true);
    try {
      const requestKey = auxiliaryIntent.current.keyFor({ kind, id, text });
      if (kind === 'rename') { const saved = await renameResearchConversation(id, { title: text, requestKey }); client.setQueryData(['research-conversation', id], saved); setRename(false); void sessions.refetch(); }
      else setProposal(await proposeInvestmentConstraint({ text, sessionId: id, requestKey }));
      auxiliaryIntent.current.complete();
    } catch { toast.error(kind === 'constraint' ? (zh ? '无法提出限制，请先开启 AI 账户并明确股票、额度或期限。' : 'Cannot propose a restriction. Enable the AI account first and specify the security, limit or expiry.') : (zh ? '标题未能保存，请重试。' : 'The title could not be saved. Retry.')); }
    finally { auxiliaryLock.current = false; setPending(false); }
  };
  const recover = async (memberId: string, action: RecoveryAction) => {
    if (readOnly) return; if (action === 'fix_configuration') { setConfigurationMember(memberId); return; }
    if (!id || !session || recoveryLock.current) return;
    recoveryLock.current = true; setPending(true);
    const payload = { memberId, action, expectedRevision: session.revision };
    try {
      const saved = await recoverResearchConversation(id, { ...payload, requestKey: recoveryIntent.current.keyFor(payload) });
      recoveryIntent.current.complete(); client.setQueryData(['research-conversation', id], saved);
      void client.invalidateQueries({ queryKey: ['research-conversations'] });
    } catch { toast.error(zh ? '恢复操作尚未确认。请重试，已有研究会继续保留。' : 'Recovery was not confirmed. Retry; saved research remains available.'); }
    finally { recoveryLock.current = false; setPending(false); }
  };
  const showOriginal = async (memberId: string) => {
    if (!id || originalLoading) return;
    const request = ++originalRequest.current;
    setOriginal({ memberId, text: '' }); setOriginalLoading(true);
    try { const saved = await fetchOriginalResearchResult(id, memberId); if (request === originalRequest.current) setOriginal({ memberId, text: saved.text }); }
    catch { if (request === originalRequest.current) { toast.error(zh ? '原始研究文本暂时无法读取。' : 'The original research text could not be loaded.'); setOriginal(null); } }
    finally { setOriginalLoading(false); }
  };
  const stop = async () => {
    if (readOnly || !id || recoveryLock.current) return;
    recoveryLock.current = true; setPending(true);
    try { const saved = await stopResearchConversation(id); client.setQueryData(['research-conversation', id], saved); setReceipt(null); void client.invalidateQueries({ queryKey: ['research-conversations'] }); }
    catch { toast.error(zh ? '停止操作尚未确认，请查询原任务状态。' : 'Stopping is not confirmed. Check the original task status.'); }
    finally { recoveryLock.current = false; setPending(false); }
  };
  return <div data-archive-readonly={readOnly || undefined} className="research-room flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border bg-card">
    <header className="research-room-header flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-3 border-b p-3 sm:px-5"><div className="min-w-0 flex-1"><h1 className="line-clamp-2 font-semibold [overflow-wrap:anywhere]">{session?.title || (zh ? '投研室' : 'Research room')}</h1><p className="mt-1 text-xs text-muted-foreground">{session?.initializing ? (zh ? '问题已收到，正在安排股友。' : 'Question received. Arranging your stock friends.') : session ? stageLabel[session.stage] : (zh ? '一点好奇，几位股友，一起想明白。' : 'A little curiosity. A few friends. A clearer view.')}</p></div>
      <div className="research-room-actions flex min-w-0 flex-wrap gap-2">{session && <Button size="sm" variant="ghost" className="hidden sm:inline-flex" onClick={() => setDetails(true)}>{zh ? '研究详情' : 'Research details'}</Button>}{!embeddedSessionId && !workspace && <Button size="sm" variant="outline" onClick={() => setHistory(true)}>{zh ? '最近讨论' : 'Recent discussions'}</Button>}{(session?.status === 'running' || Boolean(session?.runtimePending?.length)) && <Button size="sm" variant="outline" disabled={pending} onClick={() => void stop()}>{zh ? '停止本轮' : 'Stop round'}</Button>}{!embeddedSessionId && !workspace && <Button size="sm" aria-label={zh ? '新讨论' : 'New discussion'} onClick={() => { setParams({}); setContext(undefined); setReceipt(null); }}><Plus size={14} className="sm:hidden" /><span className="hidden sm:inline">{zh ? '新讨论' : 'New discussion'}</span></Button>}</div></header>
    {rename && <form className="flex shrink-0 gap-2 border-b p-3" onSubmit={event => { event.preventDefault(); void updateAuxiliary('rename', title.trim()); }}><Input aria-label={zh ? '讨论标题' : 'Discussion title'} maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /><Button type="submit" size="sm" disabled={pending || !title.trim()}>{zh ? '保存' : 'Save'}</Button></form>}
    <Sheet open={!embeddedSessionId && !workspace && history} onOpenChange={setHistory}><SheetContent className="min-w-0 overflow-y-auto" closeLabel={zh ? '关闭最近讨论' : 'Close recent discussions'}><SheetHeader className="p-0 pr-6"><SheetTitle>{zh ? '最近讨论' : 'Recent discussions'}</SheetTitle><SheetDescription>{zh ? '回到原来的问题与研究。' : 'Return to the original question and findings.'}</SheetDescription></SheetHeader><section className="min-w-0 space-y-2"><label className="sr-only" htmlFor="discussion-search">{zh ? '搜索最近讨论' : 'Search recent discussions'}</label><Input id="discussion-search" value={search} onChange={event => setSearch(event.target.value)} placeholder={zh ? '搜索标题或问题' : 'Search title or question'} />
      {(sessions.data || []).filter(item => `${item.title} ${item.subject || ''} ${item.messages?.map(message => message.content).join(' ') || ''}`.toLowerCase().includes(search.toLowerCase())).map(item => <button type="button" key={item.id} className="block w-full min-w-0 rounded-lg p-2 text-left text-sm [overflow-wrap:anywhere] hover:bg-muted" onClick={() => { setParams({ session: item.id }); setHistory(false); }}>{item.title || item.subject || item.ticker}<span className="ml-2 text-xs text-muted-foreground">{new Date(item.updatedAt).toLocaleDateString(i18n.language)}</span></button>)}
      {sessions.isError && <Button size="sm" variant="outline" onClick={() => void sessions.refetch()}>{zh ? '重试读取讨论' : 'Retry discussions'}</Button>}</section></SheetContent></Sheet>
    <Sheet open={Boolean(configurationMember)} onOpenChange={open => { if (!open) setConfigurationMember(null); }}><SheetContent className="min-w-0 overflow-y-auto sm:max-w-lg" closeLabel={zh ? '关闭模型配置' : 'Close model configuration'}><SheetHeader className="p-0 pr-6"><SheetTitle>{zh ? '修复模型配置' : 'Fix model configuration'}</SheetTitle><SheetDescription>{zh ? '保留原讨论和已完成观点，只修改这位股友的连接。' : 'Keep the original discussion and accepted views while fixing this member’s connection.'}</SheetDescription></SheetHeader>
      {readiness.isPending || readiness.isFetching ? <p role="status">{zh ? '正在读取原连接的配置…' : 'Loading the original connection…'}</p> : configuration ? <CouncilModelConfiguration key={configurationMember} connection={configuration} memberName={session?.members?.find(item => item.id === configurationMember)?.name || configuration.name}
        retryAllowed={Boolean(session?.memberStates?.some(item => item.memberId === configurationMember && ['failed', 'cancelled'].includes(item.status)))} onSave={async settings => {
          const items = await configureResearchExecution(configuration.connectionId, settings); client.setQueryData(['research-execution', 'readiness'], items);
          void client.invalidateQueries({ queryKey: ['settings', 'local-agents'] });
          const updated = items.find(item => item.connectionId === configuration.connectionId); if (!updated) throw new Error('Connection unavailable'); return updated;
        }} onRetry={() => { if (configurationMember) void recover(configurationMember, 'retry_member'); setConfigurationMember(null); }} /> : <div className="space-y-3"><p role="alert" className="text-sm">{zh ? '这位股友的原连接暂时无法读取，未修改任何设置。' : 'The original connection is unavailable. No settings have been changed.'}</p><Button variant="outline" size="sm" onClick={() => void readiness.refetch()}>{zh ? '重新读取连接' : 'Reload connection'}</Button></div>}
    </SheetContent></Sheet>
    <Sheet open={details} onOpenChange={setDetails}><SheetContent className="min-w-0 overflow-y-auto sm:max-w-lg" closeLabel={zh ? '关闭研究详情' : 'Close research details'}><SheetHeader className="p-0 pr-6"><SheetTitle>{zh ? '研究详情' : 'Research details'}</SheetTitle><SheetDescription>{zh ? '实际执行来源与已记录的公开活动。' : 'Actual execution sources and recorded public activity.'}</SheetDescription></SheetHeader>
      {session && <Button size="sm" variant="outline" onClick={() => { setTitle(session.title || ''); setRename(true); setDetails(false); }}>{zh ? '修改讨论标题' : 'Rename discussion'}</Button>}
      {session?.actualExecutors?.map(executor => <div key={executor.memberId} className="space-y-1 rounded-xl border p-3 text-sm [overflow-wrap:anywhere]"><strong>{session.members?.find(member => member.id === executor.memberId)?.name || executor.memberId}</strong><p className="text-xs text-muted-foreground">{executor.connection} · {executor.provider} · {researchModelLabel(executor.model, zh)}</p>{!executor.modelVerified && <p className="text-xs text-muted-foreground">{zh ? '连接使用本地配置；未确认具体型号时不会推测模型名称。' : 'This connection uses local configuration; a model name is shown only when reported.'}</p>}{session.actualExecutors.filter(item => item.identity === executor.identity).length > 1 && <p className="text-xs text-amber-600">{zh ? '共享同一执行来源' : 'Shares one execution source'}</p>}</div>)}
      {timeline?.tasks.map(task => <div key={task.key} className="min-w-0 rounded-xl border p-3"><h3 className="mb-2 text-sm font-medium">{task.memberName}</h3><CouncilResearchTimeline task={task} /></div>)}
      {!timeline?.tasks.length && <p className="text-sm text-muted-foreground">{zh ? '这场讨论尚无详细活动记录。只展示已确认的成员状态。' : 'No detailed activity was recorded for this discussion. Member cards show only confirmed status.'}</p>}
    </SheetContent></Sheet>
    <Sheet open={Boolean(original)} onOpenChange={open => { if (!open) { originalRequest.current++; setOriginal(null); } }}><SheetContent className="min-w-0 overflow-y-auto sm:max-w-xl" closeLabel={zh ? '关闭原始研究' : 'Close original research'}><SheetHeader className="p-0 pr-6"><SheetTitle>{zh ? '原始研究文本' : 'Original research text'}</SheetTitle><SheetDescription>{zh ? '内容尚未通过应用校验，不能视为已确认结论或交易依据。' : 'This content has not passed validation. It is not a verified finding or a basis for trading.'}</SheetDescription></SheetHeader><p className="whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{originalLoading ? (zh ? '正在读取…' : 'Loading…') : original?.text}</p></SheetContent></Sheet>
    {session && <CouncilMemberActivity session={session} onDetails={() => setDetails(true)} />}
    <div ref={scroll} onScroll={event => { followLatest.current = isReadingLatest(event.currentTarget); if (followLatest.current) setNewMessages(false); }} className="research-room-messages min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto p-3 sm:p-5" role="log" aria-live="polite" aria-relevant="additions" aria-label={zh ? '研究对话' : 'Research conversation'}>
      {!id && !session && <div className="mx-auto max-w-lg space-y-4 py-6 text-center sm:py-10"><div className="mb-2 flex items-end justify-center gap-3" aria-hidden><CouncilMemberAvatar avatar="value" role="researcher" className="size-16 -rotate-6" /><CouncilMemberAvatar avatar="technical" role="researcher" className="size-20" /><CouncilMemberAvatar avatar="macro" role="researcher" className="size-16 rotate-6" /></div><h2 className="text-xl font-semibold">{zh ? '和 AI 股友一起把问题想清楚' : 'Think it through with your AI stock friends'}</h2><p className="text-sm leading-7 text-muted-foreground">{zh ? '直接输入问题。股友先独立研究，再围绕不同观点一起追问。' : 'Ask what’s on your mind. Each friend researches independently before comparing the evidence.'}</p>
        <div className="flex flex-wrap justify-center gap-2">{[zh ? '我的持仓里最值得担心的是什么？' : 'What should I worry about most in my portfolio?', zh ? '如何检查一家公司的现金流质量？' : 'How can I assess cash flow quality?'].map((text, index) => <Button key={text} variant="outline" className="h-auto whitespace-normal text-left" disabled={pending || Boolean(workspace?.request.submission)} onClick={() => workspace ? workspace.onDraftChange(text) : void submit(text, index === 0 ? { kind: 'portfolio' } : undefined)}>{text}</Button>)}</div></div>}
      {id && query.isPending && <p role="status">{zh ? '正在读取讨论…' : 'Loading discussion…'}</p>}
      {id && query.isError && <div role="alert" className="space-y-3"><p>{zh ? '讨论暂时不可用，原始消息未被替代。' : 'The discussion is unavailable. Original messages have not been replaced.'}</p><Button onClick={() => void query.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>}
      {session&&conversation?.entries.map(entry => entry.report ? <CouncilRoundReport key={entry.key} report={entry.report} onAddToStrategy={versionId=>setStrategySource({kind:'report',versionId})}/> : <div key={entry.key}><CouncilChatMessage message={entry.message} task={entry.task} session={session} simple
        executor={session.actualExecutors?.find(item => item.memberId === (entry.message?.memberId??entry.task?.memberId))} onQuestion={text => void submit(text)} onReply={setReply} />
        {entry.message&&!['user','system'].includes(entry.message.role)&&(session.stage!=='independent'||entry.message.revision<session.revision)&&<Button size="sm" variant="ghost" className="ml-12 mt-1" onClick={()=>setStrategySource({kind:'message',messageId:entry.message!.id})}>{zh?'加入投资策略':'Add to investment strategy'}</Button>}
        {entry.message?.role === 'user' && <div className="mt-1 flex justify-end"><DropdownMenu><DropdownMenuTrigger asChild><Button className="size-7 text-muted-foreground" size="icon" variant="ghost" aria-label={zh ? '这条消息的更多操作' : 'More actions for this message'}><Ellipsis size={16} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={pending} onSelect={() => void updateAuxiliary('constraint', entry.message!.content)}>{zh ? '提议为 AI 账户限制' : 'Propose as an AI account restriction'}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>}</div>)}
      {session && <ResearchToolActivity session={session} readOnly={readOnly} />}
      {proposal && <ConstraintProposalCard proposal={proposal} onClose={() => setProposal(null)} />}
      {session?.stage === 'independent' && session.memberStates?.some(item => item.resultAcceptance === 'accepted') && session.memberStates.some(item => ['queued', 'running', 'unknown'].includes(item.status)) && <p className="rounded-xl bg-primary/5 p-3 text-xs text-muted-foreground">{zh ? '初步观点，其他股友尚未完成；大家仍在独立研究。' : 'Preliminary views: other members have not finished their independent research.'}</p>}
      {!readOnly && session && <CouncilRecoveryCard session={session} onRecover={(memberId, action) => void recover(memberId, action)} onOriginal={memberId => void showOriginal(memberId)} pending={pending} />}
      {session?.memberStates && session.memberStates.filter(item => item.resultAcceptance === 'accepted').length === 1 && session.memberStates.length > 1 && session.memberStates.every(item => !['running', 'queued', 'unknown'].includes(item.status)) && <p className="rounded-xl bg-primary/5 p-3 text-xs text-muted-foreground">{zh ? '仅一位完成，尚未经其他股友交叉检查。' : 'Only one member completed. Other members have not cross-checked this view.'}</p>}
      {session?.outcome&&!session.reports.length && <DebateSummary outcome={session.outcome} members={session.members || []} mode={session.mode} />}
      {clarification && <section className="space-y-3 rounded-xl border p-4" role="status"><p>{clarification.needsInput.message}</p><div className="flex flex-wrap gap-2">{clarification.needsInput.options.map(option => <Button key={option.ticker} size="sm" variant="outline" disabled={pending} onClick={() => { setContext({ kind: 'stock', ticker: option.ticker }); void submit(originalQuestion, { kind: 'stock', ticker: option.ticker }); }}>{option.label}</Button>)}</div></section>}
    </div>
    {newMessages && <div className="flex shrink-0 justify-center py-1"><Button size="sm" variant="secondary" onClick={() => { const element = scroll.current; if (element) element.scrollTop = element.scrollHeight; followLatest.current = true; setNewMessages(false); }}>{zh ? '有新消息 · 回到底部' : 'New messages · Jump to latest'}</Button></div>}
    {receipt && <p role="status" className="min-w-0 shrink-0 px-4 py-1 text-xs text-muted-foreground">{receipt === 'sending' ? (zh ? '正在发送问题…' : 'Sending your question…') : session?.status === 'running' ? (zh ? '问题已收到，股友正在研究。' : 'Question received. Your stock friends are researching.') : (zh ? '问题已收到，正在安排股友。' : 'Question received. Arranging your stock friends.')}</p>}
    {workspace?.request.submission && !pending && <p role="alert" className="px-4 py-2 text-sm text-muted-foreground">{zh ? '上一条问题尚未确认送达。再次发送会核对同一条问题，不会新建重复任务。' : 'Delivery of this question is unconfirmed. Send again to check the same request without creating a duplicate task.'}</p>}
    {!readOnly && !embeddedSessionId && <QuickQuestion key={id || 'new'} pending={pending} onSubmit={submit} contextLabel={contextLabel} onRemoveContext={!id && !workspace?.request.submission ? () => setContext(undefined) : undefined}
      skills={workspace ? skillCatalog.data : undefined} selectedSkill={selectedSkill}
      onSkillSelect={workspace ? skill => skill?.mode === 'interview' ? workspace.onStrategy('') : workspace.onSkillChange(skill?.id ?? null) : undefined}
      value={workspace?.draft} onValueChange={workspace?.onDraftChange} readOnlyText={Boolean(workspace?.request.submission)}
      replyLabel={reply ? `${reply.memberName}: ${reply.content.slice(0, 140)}` : undefined} onRemoveReply={() => setReply(null)} />}
    <InvestmentStrategySourceDialog source={strategySource} onClose={()=>setStrategySource(null)}/>
    <Link className="shrink-0 border-t px-4 py-2 text-center text-xs text-primary underline" to="/analysis#report-history">{zh?'查看报告历史':'View report history'}</Link>
  </div>;
}
