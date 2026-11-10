import {useEffect,useRef,useState} from 'react';
import {Link,useNavigate,useSearchParams} from 'react-router-dom';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {ArrowUpRight,BookOpen,FileText,History,LoaderCircle,RefreshCw,Send,X} from 'lucide-react';
import {toast} from 'sonner';
import type {ChannelAction,ChannelBubble,ChannelVibe,DeferredQuestion,ChannelRuntimeSnapshot} from '@shared/channel.interface';
import {fetchChannel,fetchChannelBubble,acknowledgeChannelNotifications,fetchChannelLogs,fetchChannelPending,postChannelAction,postChannelQuestion,setChannelVibe,channelActionRequest} from '@/api/channel';
import {fetchResearchConversations} from '@/api/research-conversations';
import {contextFromSearch} from '@/utils/simple-experience';
import {channelQuestionPayload,createChannelQuestionIntent} from '@/utils/channel-question';
import {Sheet,SheetContent,SheetDescription,SheetHeader,SheetTitle} from '@/components/ui/sheet';
import {ChannelBubbleCard,ChannelWorkbenchView,ChannelResearchLog,channelDate} from '@/pages/Channel/ChannelWorkbench';
import {channelText} from '@/pages/Channel/channel-copy';
import ArchivedCouncilPage from './ArchivedCouncilPage';
import ChannelPersonalNotes from '@/pages/Channel/ChannelPersonalNotes';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';

export default function SimpleCouncilPage(){
 const {i18n}=useTranslation(),language=i18n.language,c=channelText(language);
 const client=useQueryClient(),navigate=useNavigate(),[params,setParams]=useSearchParams();
 const [message,setMessage]=useState(()=>params.get('question')?.slice(0,2000)??''),[pending,setPending]=useState(false),[receipt,setReceipt]=useState(false);
 const importedQuestion=useRef(params.get('question'));
 useEffect(()=>{const incoming=params.get('question');if(incoming===importedQuestion.current)return;importedQuestion.current=incoming;
  if(incoming)setMessage(current=>current.trim()?current:incoming.slice(0,2000));},[params]);
 const [history,setHistory]=useState(Boolean(params.get('session')||params.get('sessionId')));
 const [logs,setLogs]=useState(false),[pendingOpen,setPendingOpen]=useState(false),[priorId,setPriorId]=useState<string|null>(null);
 const [context,setContext]=useState(()=>contextFromSearch(params));
 const lock=useRef(false),requestIntent=useRef(createChannelQuestionIntent(()=>crypto.randomUUID()));
 const actionIntents=useRef(new Map<string,string>());
 const delivered=useRef(new Set<string>());
 const deliveryLock=useRef(false);
 const accountId=params.get('accountId')||undefined;
 const [accountOptions,setAccountOptions]=useState<NonNullable<ChannelRuntimeSnapshot['accounts']>>([]);
 const query=useQuery({queryKey:['channel',accountId],queryFn:()=>fetchChannel(accountId),refetchInterval:5000,retry:false});
 const resolvedAccountId=accountId??query.data?.runtime.accountId??undefined;
 useEffect(()=>{if(query.data?.runtime.accounts)setAccountOptions(query.data.runtime.accounts);},[query.data?.runtime.accounts]);
 const logQuery=useQuery({queryKey:['channel-logs'],queryFn:fetchChannelLogs,enabled:logs,refetchInterval:logs?5000:false,retry:false});
 const pendingQuery=useQuery({queryKey:['channel-pending',resolvedAccountId],queryFn:()=>fetchChannelPending(resolvedAccountId),enabled:pendingOpen,refetchInterval:pendingOpen?5000:false,retry:false});
 const pendingItems=pendingQuery.data?.items.filter(item=>item.id!==query.data?.pinned?.id);
 const archiveQuery=useQuery({queryKey:['research-conversations'],queryFn:fetchResearchConversations,enabled:history,retry:false});
 const priorQuery=useQuery({queryKey:['channel-bubble',priorId],queryFn:()=>fetchChannelBubble(priorId!),enabled:logs&&Boolean(priorId),retry:false});
 const archiveId=params.get('session')||params.get('sessionId');
 useEffect(()=>{if(params.get('session')||params.get('sessionId'))setHistory(true);setContext(contextFromSearch(params));},[params]);

 useEffect(()=>{
  const notifications=query.data?.notifications??[];
  if(!notifications.length||deliveryLock.current)return;
  deliveryLock.current=true;
  let stored:string[]=[];
  try{stored=JSON.parse(localStorage.getItem('sq-channel-delivered')??'[]');if(!Array.isArray(stored))stored=[];}catch{stored=[];}
  stored.forEach(id=>delivered.current.add(id));
  const bubbles=[...(query.data?.pinned?[query.data.pinned]:[]),...(query.data?.episodes.flatMap(group=>group.bubbles)??[])];
  void (async()=>{
   const acknowledged:string[]=[];
   for(const notification of notifications){
    if(delivered.current.has(notification.id)){acknowledged.push(notification.id);continue;}
    try{
     const bubble=bubbles.find(item=>item.id===notification.bubbleId)??await fetchChannelBubble(notification.bubbleId);
     if(bubble.weight!=='poke')continue;
     toast.info(bubble.text,{id:notification.id});
     delivered.current.add(notification.id);acknowledged.push(notification.id);
    }catch{ /* Undelivered notifications remain pending on the server. */ }
   }
   try{localStorage.setItem('sq-channel-delivered',JSON.stringify([...delivered.current].slice(-2000)));}catch{ /* In-memory deduplication remains available. */ }
   if(acknowledged.length)await acknowledgeChannelNotifications(acknowledged);
  })().catch(()=>{}).finally(()=>{deliveryLock.current=false;});
 },[query.data]);
 async function refresh(){
  await Promise.all([client.invalidateQueries({queryKey:['channel']}),client.invalidateQueries({queryKey:['channel-pending']}),client.invalidateQueries({queryKey:['channel-logs']})]);
 }
 async function submit(selected?:DeferredQuestion){
  const text=selected?.text??message.trim();
  if(!text||lock.current)return;lock.current=true;setPending(true);setReceipt(false);
  const payload=channelQuestionPayload(text,resolvedAccountId,context??undefined,selected);
  try{
   await postChannelQuestion(requestIntent.current.request(payload));
   requestIntent.current.complete();
   // Preserve a new draft typed while this request was in flight.
   if(!selected)setMessage(current=>current.trim()===text?'':current);
   setReceipt(true);await refresh();
  }catch(error){toast.error(error instanceof Error&&error.message==='CHANNEL_QUESTION_SCOPE_CHANGED'
   ?language.startsWith('zh')?'此问题仍关联原账户。请切回原账户重试，或修改问题后重新发送。':'This question is still bound to its original account. Switch back to retry, or edit the question to start a new request.'
   :c.sendFailed);}
  finally{lock.current=false;setPending(false);}
 }
 async function act(action:ChannelAction,bubble:ChannelBubble){
  if(lock.current)return;
  if(action.expiresAt&&Date.parse(action.expiresAt)<=Date.now()){toast.error(c.actionExpired);void refresh();return;}
  lock.current=true;setPending(true);
  let selectedQuestion:DeferredQuestion|undefined;
  const intentKey=`${bubble.id}:${action.id}:${action.expectedRevision}`;
  const requestKey=actionIntents.current.get(intentKey)??crypto.randomUUID();actionIntents.current.set(intentKey,requestKey);
  try{
   const result=await postChannelAction(channelActionRequest(action,bubble.id,requestKey));
   actionIntents.current.delete(intentKey);await refresh();
   if(result.questionId)selectedQuestion=query.data?.deferredQuestions.find(item=>item.id===result.questionId);
   if(result.navigation&&result.navigation.startsWith('/')&&!result.navigation.startsWith('//'))navigate(result.navigation);
  }catch{toast.error(c.actionFailed);}
  finally{lock.current=false;setPending(false);}
  if(selectedQuestion)await submit(selectedQuestion);
 }
 async function vibe(value:ChannelVibe){
  if(lock.current)return;lock.current=true;setPending(true);
  try{await setChannelVibe(value);await client.invalidateQueries({queryKey:['channel']});}
  catch{toast.error(c.preferenceFailed);}
  finally{lock.current=false;setPending(false);}
 }
 function showPrior(id:string){
  const element=document.getElementById(`channel-bubble-${id}`);
  if(element){element.scrollIntoView({behavior:'smooth',block:'center'});element.focus();}
  else{setPriorId(id);setLogs(true);}
 }
 const contextLabel=context?.kind==='stock'?`${c.contextStock} · ${context.ticker}`:context?.kind==='report'?c.contextReport:context?.kind==='decision'?c.contextDecision:context?.kind==='portfolio'?c.contextPortfolio:null;
 return <div className="channel-page"><div className="channel-workbench">
  <header className="channel-header"><div><h1>{c.title}<span className="channel-title-dot" aria-hidden="true"/></h1><p>{c.caption}</p></div><nav>
   <Link className="channel-header-link" to={query.data?.report?.href??'/analysis'}><FileText size={14}/><span>{c.today}</span></Link>
   <button type="button" className="channel-header-link" onClick={()=>setHistory(true)}><History size={14}/><span>{c.history}</span></button>
   <button type="button" className="channel-icon-button" aria-label={c.refresh} disabled={query.isFetching} onClick={()=>void refresh()}><RefreshCw size={15}/></button>
  </nav></header>
  {accountOptions.length>0&&<div className="channel-account-selection">
   <span id="channel-account-label">{c.account}</span>
   <Select value={accountId??query.data?.runtime.accountId??''} onValueChange={value=>{const next=new URLSearchParams(params);next.set('accountId',value);setParams(next);}}>
    <SelectTrigger className="w-full sm:w-64" aria-label={c.account} aria-labelledby="channel-account-label"><SelectValue placeholder={c.chooseAccount}/></SelectTrigger>
    <SelectContent>{accountOptions.map(account=><SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>)}</SelectContent>
   </Select>
  </div>}
  {query.data?<ChannelWorkbenchView view={query.data} language={language} pending={pending} onVibe={value=>void vibe(value)} onAction={(action,bubble)=>void act(action,bubble)} onLogs={()=>setLogs(true)} onPending={()=>setPendingOpen(true)} onSelect={item=>void submit(item)} onPrior={showPrior}/>:<div className="channel-load-state" role={query.isError?'alert':'status'}><p>{query.isError?c.error:c.loading}</p>{query.isError&&<button type="button" onClick={()=>void query.refetch()}>{c.retry}</button>}</div>}
  {query.isError&&query.data&&<p className="channel-inline-error" role="status">{c.error}<button type="button" onClick={()=>void query.refetch()}>{c.retry}</button></p>}
  <form className="channel-composer" onSubmit={event=>{event.preventDefault();void submit();}}>
   <p className="channel-muted">{query.data?.runtime.accountName
    ?`${c.questionAccount} · ${query.data.runtime.accountName}`:c.questionReal}</p>
   {contextLabel&&<div className="channel-context"><span>{contextLabel}</span><button type="button" onClick={()=>setContext(undefined)} aria-label={c.removeContext}><X size={12}/></button></div>}
   {query.data?.userMessages?.length?<details className="channel-last-question"><summary>{c.yourQuestion} · {query.data.userMessages.at(-1)?.text}</summary><p>{query.data.userMessages.at(-1)?.text}</p></details>:null}
   <label className="sr-only" htmlFor="channel-question">{c.placeholder}</label><div className="channel-composer-row"><textarea id="channel-question" value={message} maxLength={2000} rows={2} placeholder={c.placeholder} onChange={event=>setMessage(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void submit();}}}/><button type="submit" disabled={pending||!message.trim()} aria-label={pending?c.waiting:c.send}>{pending?<LoaderCircle size={18} className="animate-spin"/>:<Send size={18}/>}<span>{c.send}</span></button></div>
   <p className="channel-composer-hint" role={receipt?'status':undefined}>{receipt?c.sent:c.questionHint}</p>
  </form>
 </div>
 <Sheet open={logs} onOpenChange={open=>{setLogs(open);if(!open)setPriorId(null);}}><SheetContent className="channel-drawer overflow-y-auto" closeLabel={c.close}><SheetHeader><SheetTitle>{c.log}</SheetTitle><SheetDescription>{c.allAccountLogs}</SheetDescription></SheetHeader>
  {priorId&&<section className="channel-drawer-section"><h3>{c.prior}</h3>{priorQuery.isPending?<p role="status">{c.loading}</p>:priorQuery.data?<ChannelBubbleCard bubble={priorQuery.data} language={language}/>:<p className="channel-muted">{c.unreadable}</p>}</section>}
  {logQuery.isPending?<p role="status">{c.loading}</p>:logQuery.isError?<button type="button" onClick={()=>void logQuery.refetch()}>{c.retry}</button>:logQuery.data?.items.length?<ChannelResearchLog items={logQuery.data.items} language={language}/>:<p className="channel-muted">{c.noLog}</p>}
  {query.data?.userMessages?.length?<section className="channel-drawer-section"><h3>{c.yourQuestion}</h3>{query.data.userMessages.map(item=><article className="channel-detail-card" key={item.id}><p>{item.text}</p><time className="channel-muted">{channelDate(item.createdAt,language)}</time></article>)}</section>:null}
  <ChannelPersonalNotes language={language} userMessages={query.data?.userMessages??[]}/>
  {query.data?.visibleTaps.length?<section className="channel-drawer-section"><h3>{c.viewAllTaps}</h3>{query.data.visibleTaps.map(bubble=><ChannelBubbleCard key={bubble.id} bubble={bubble} language={language} onPrior={showPrior}/>)}</section>:null}
 </SheetContent></Sheet>
 <Sheet open={pendingOpen} onOpenChange={setPendingOpen}><SheetContent className="channel-drawer overflow-y-auto" closeLabel={c.close}><SheetHeader><SheetTitle>{c.otherPending}</SheetTitle><SheetDescription>{c.boardDescription}</SheetDescription></SheetHeader>
  {pendingQuery.isPending?<p role="status">{c.loading}</p>:pendingQuery.isError?<button type="button" onClick={()=>void pendingQuery.refetch()}>{c.retry}</button>:pendingItems?.length?pendingItems.map(bubble=><ChannelBubbleCard key={bubble.id} bubble={bubble} language={language} pending={pending} onAction={(action,item)=>void act(action,item)} onPrior={showPrior}/>):<p className="channel-muted">{c.noPending}</p>}
 </SheetContent></Sheet>
 <Sheet open={history} onOpenChange={open=>{setHistory(open);if(!open&&archiveId){const next=new URLSearchParams(params);next.delete('session');next.delete('sessionId');setParams(next);}}}><SheetContent className={`channel-drawer overflow-y-auto ${archiveId?'channel-archive-drawer':''}`} closeLabel={c.close}><SheetHeader><SheetTitle>{c.history}</SheetTitle><SheetDescription>{c.readOnlyHistory}</SheetDescription></SheetHeader>
  <Link to="/analysis#report-history" className="channel-inline-link" onClick={()=>setHistory(false)}><BookOpen size={14}/>{c.reportHistory}<ArrowUpRight size={13}/></Link>
  {archiveId?<div className="channel-archive-view"><ArchivedCouncilPage readOnly/></div>:<section className="channel-drawer-section"><h3>{c.archive}</h3>{archiveQuery.isPending?<p role="status">{c.archiveLoading}</p>:archiveQuery.isError?<button type="button" onClick={()=>void archiveQuery.refetch()}>{c.retry}</button>:archiveQuery.data?.length?archiveQuery.data.map(item=><button type="button" className="channel-archive-item" key={item.id} onClick={()=>{const next=new URLSearchParams(params);next.set('session',item.id);setParams(next);}}><strong>{item.title||item.subject||item.ticker}</strong><time>{channelDate(item.updatedAt,language)}</time></button>):<p className="channel-muted">{c.noArchive}</p>}</section>}
 </SheetContent></Sheet>
 </div>;
}
