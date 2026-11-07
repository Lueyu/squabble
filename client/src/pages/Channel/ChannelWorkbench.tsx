import {useState} from 'react';
import {Link} from 'react-router-dom';
import {ArrowUpRight,ChevronDown,FileText,FlaskConical,Info,MessageCircle,Pin,ShieldCheck,Sparkles} from 'lucide-react';
import type {ChannelAction,ChannelBubble,ChannelEvidenceCard,ChannelProjection,ChannelRuntimeSnapshot,ChannelSpeaker,ChannelVibe,DeferredQuestion} from '@shared/channel.interface';
import {Sheet,SheetContent,SheetDescription,SheetHeader,SheetTitle} from '@/components/ui/sheet';
import CouncilMemberAvatar from '../Council/CouncilMemberAvatar';
import {channelText} from './channel-copy';
import './channel.css';

const friendAvatars={laozhou:'value',ajie:'technical',xiaoqi:'macro'} as const;
function ChannelFriendAvatar({speaker,language}:{speaker:ChannelSpeaker;language:string}){
 const c=channelText(language),names={laozhou:c.actorLao,ajie:c.actorJie,xiaoqi:c.actorQi};
 return <span className="channel-avatar" role="img" aria-label={names[speaker]}><CouncilMemberAvatar avatar={friendAvatars[speaker]} role="researcher"/></span>;
}
export function channelDate(value:string|null|undefined,language:string){
 if(!value||!Number.isFinite(Date.parse(value)))return channelText(language).unknownTime;
 return new Intl.DateTimeFormat(language,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
}
function safeSource(uri:string){
 if(uri.startsWith('/')&&!uri.startsWith('//'))return uri;
 try{const parsed=new URL(uri);return parsed.protocol==='http:'||parsed.protocol==='https:'?uri:undefined;}catch{return undefined;}
}
export function RuntimeBoard({snapshot,language}:{snapshot:ChannelRuntimeSnapshot;language:string}){
 const c=channelText(language),[open,setOpen]=useState(false);
 const proposal=snapshot.proposals.find(item=>item.status==='applying')??snapshot.proposals.find(item=>item.status==='proposed')??snapshot.proposals[0];
 const execution=snapshot.executions[0],rule=snapshot.current.rules.find(item=>item.effective);
 const allExpired=snapshot.current.rules.length>0&&snapshot.current.rules.every(item=>item.effectiveReason==='expired');
 const current=!snapshot.current.strategyId?c.observing:snapshot.monitoringStatus==='paused'?c.paused:snapshot.monitoringStatus==='stopped'?(allExpired?c.expiredStrategy:c.stopped):snapshot.monitoringStatus==='observing'?(snapshot.monitoringReason==='OBSERVATION_ONLY'?c.observation_only:c.monitorObserving):snapshot.monitoringStatus==='running'?(rule?`${rule.label} · ${rule.value}`:c.noEffectiveRules):c.monitorUnconfirmed;
 const executionLabel=execution?((execution.symbol?execution.symbol+' · ':'')+c[execution.status]):c.noExecution;
 return <><section className="channel-runtime-board" aria-label={c.boardDescription}>
  <button className="channel-runtime-cell" data-runtime-cell="current" onClick={()=>setOpen(true)}>
   <span className="channel-cell-label"><ShieldCheck size={13}/>{c.current}</span>
   <strong className="channel-cell-main" title={current}>{current}</strong>
   <span className="channel-cell-meta">{snapshot.accountId?channelDate(snapshot.confirmedAt,language):c.noAccountHint}</span>
  </button>
  <button className="channel-runtime-cell channel-runtime-proposal" data-runtime-cell="proposal" onClick={()=>setOpen(true)}>
   <span className="channel-cell-label"><Sparkles size={13}/>{c.proposal}</span>
   <strong className="channel-cell-main">{proposal?`${c[proposal.status]} · ${proposal.after}`:c.noProposal}</strong>
   <span className="channel-cell-meta">{proposal?proposal.status==='active'?c.active:c.unapplied:c.paper}</span>
  </button>
  <button className="channel-runtime-cell" data-runtime-cell="execution" onClick={()=>setOpen(true)}>
   <span className="channel-cell-label"><FlaskConical size={13}/>{c.execution}</span>
   <strong className="channel-cell-main">{executionLabel}</strong>
   <span className="channel-cell-meta">{execution?`${c.filledLabel} ${execution.filledQuantity} · ${c.remaining} ${execution.remainingQuantity}`:c.paper}</span>
  </button>
 </section>
 <Sheet open={open} onOpenChange={setOpen}><SheetContent className="channel-drawer overflow-y-auto" closeLabel={c.close}><SheetHeader><SheetTitle>{c.details}</SheetTitle><SheetDescription>{c.boardDescription}</SheetDescription></SheetHeader>
  <section className="channel-drawer-section"><h3>{c.current}</h3><p>{current}</p><p className="channel-muted">{snapshot.accountId?channelDate(snapshot.confirmedAt,language):c.unknownTime}</p>
   {snapshot.current.rules.map(item=><div className="channel-detail-row" key={item.id}><span>{item.label}</span><strong>{item.value}</strong><span>{item.status==='active'?c.configured:c[item.status]} · {item.effective?c.effective:item.effectiveReason==='expired'?c.ruleExpired:item.effectiveReason?c[item.effectiveReason]:c.monitorUnconfirmed}</span></div>)}
   <Link to="/paper" className="channel-inline-link">{c.continueObserve}<ArrowUpRight size={13}/></Link>
  </section>
  <section className="channel-drawer-section"><h3>{c.proposal}</h3>{snapshot.proposals.length?snapshot.proposals.map(item=><article key={item.id} className="channel-detail-card"><strong>{c[item.status]}</strong><p>{c.changeBefore}: {item.before}</p><p>{c.changeAfter}: {item.after}</p><p className="channel-muted">{item.status==='active'?c.active:c.unapplied}</p><Link to={`/?investmentStrategyId=${encodeURIComponent(item.id)}#investment-strategy`} className="channel-inline-link">{c.details}<ArrowUpRight size={13}/></Link></article>):<p>{c.noProposal}</p>}</section>
  <section className="channel-drawer-section"><h3>{c.execution}</h3>{snapshot.executions.length?snapshot.executions.map(item=><article key={item.id} className="channel-detail-card"><strong>{item.symbol?item.symbol+' · ':''}{c[item.status]}</strong><p>{c.filledLabel} {item.filledQuantity} / {item.requestedQuantity} · {c.remaining} {item.remainingQuantity}</p><p className="channel-muted">{channelDate(item.updatedAt,language)} · {item.strategyRevision>0?(c.strategy+' v'+item.strategyRevision):c.executionSourceUnknown}</p></article>):<p>{c.noExecution}</p>}</section>
 </SheetContent></Sheet></>;
}
export function EvidenceCard({card,language}:{card:ChannelEvidenceCard;language:string}){
 const c=channelText(language);
 return <div className="channel-evidence-card" data-evidence-card={card.id}><p>{card.summary}</p><time className="channel-muted" dateTime={card.asOf}>{channelDate(card.asOf,language)}</time>
  {card.sources.map(source=>{const href=safeSource(source.uri);return <article className="channel-source" key={source.id}>{href?<a href={href} target={href.startsWith('http')?'_blank':undefined} rel="noreferrer">{source.title}<ArrowUpRight size={12}/></a>:<span>{source.title}</span>}<p className="channel-muted">{c[source.verification]} · {channelDate(source.observedAt,language)}</p>{source.locator&&<p className="channel-muted">{source.locator}</p>}</article>;})}
  {card.supports.length>0&&<div className="channel-evidence-gaps"><strong>{c.supports}</strong><ul>{card.supports.map((support,index)=><li key={index}>{support.scope}</li>)}</ul></div>}
  {card.gaps.length>0&&<div className="channel-evidence-gaps"><strong>{c.gaps}</strong><ul>{card.gaps.map((gap,index)=><li key={index}>{gap}</li>)}</ul></div>}
 </div>;
}
export function ChannelBubbleCard({bubble,language,pending=false,onAction,onPrior}:{bubble:ChannelBubble;language:string;pending?:boolean;onAction?:(action:ChannelAction,bubble:ChannelBubble)=>void;onPrior?:(id:string)=>void}){
 const c=channelText(language),[evidenceOpen,setEvidenceOpen]=useState(false);
 const names={laozhou:c.actorLao,ajie:c.actorJie,xiaoqi:c.actorQi};
 return <article className={`channel-bubble channel-bubble-${bubble.weight} channel-speaker-${bubble.speaker}`} id={`channel-bubble-${bubble.id}`} tabIndex={-1} data-channel-bubble={bubble.id} data-weight={bubble.weight} data-stance={bubble.stance}>
  <ChannelFriendAvatar speaker={bubble.speaker} language={language}/><div className="channel-bubble-content">
   <header><strong>{names[bubble.speaker]}</strong><time dateTime={bubble.createdAt}>{channelDate(bubble.createdAt,language)}</time>{bubble.weight==='poke'&&<span className="channel-attention-dot" aria-label={c.pinned}/>}</header>
   <p className="channel-line">{bubble.text}</p>
   {bubble.sourceState&&bubble.sourceState!=='current'&&<span className="channel-source-state" role="note">{bubble.sourceState==='corrected'?c.sourceCorrected:c.sourceSuperseded}</span>}
   {bubble.correctionOf&&<p className="channel-correction">{c.corrected}</p>}
   <div className="channel-bubble-tools"><button type="button" className="channel-evidence-toggle" aria-expanded={evidenceOpen} onClick={()=>setEvidenceOpen(value=>!value)}><Info size={13}/>{c.evidence}<ChevronDown size={12}/></button>
    {bubble.anchors.priorOwnBubbleId&&<button type="button" className="channel-evidence-toggle" onClick={()=>onPrior?.(bubble.anchors.priorOwnBubbleId!)}>{c.prior}</button>}
   </div>
   {evidenceOpen&&<EvidenceCard card={bubble.evidence} language={language}/>}
   {bubble.stance!=='mood'&&bubble.action?.length?<div className="channel-bubble-actions">{bubble.action.map(action=>{const expired=Boolean(action.expiresAt&&Date.parse(action.expiresAt)<=Date.now());return <button type="button" key={action.id} disabled={pending||expired} title={expired?c.expired:undefined} onClick={()=>{if(action.kind==='view_evidence')setEvidenceOpen(true);onAction?.(action,bubble);}}>{action.label}{expired?` · ${c.expired}`:''}</button>;})}</div>:null}
  </div>
 </article>;
}
export function DeferredQuestions({questions,language,pending,onSelect}:{questions:DeferredQuestion[];language:string;pending:boolean;onSelect?:(question:DeferredQuestion)=>void}){
 const c=channelText(language),items=questions.filter(item=>item.status==='pending');if(!items.length)return null;
 return <details className="channel-deferred"><summary>{c.deferred} · {items.length}</summary><div>{items.map(item=><article key={item.id}><p>{item.text}</p><button type="button" disabled={pending} onClick={()=>onSelect?.(item)}>{c.select}</button></article>)}</div></details>;
}
export function ChannelWorkbenchView({view,language,pending=false,onVibe,onAction,onLogs,onPending,onSelect,onPrior}:{view:ChannelProjection;language:string;pending?:boolean;onVibe?:(vibe:ChannelVibe)=>void;onAction?:(action:ChannelAction,bubble:ChannelBubble)=>void;onLogs?:()=>void;onPending?:()=>void;onSelect?:(question:DeferredQuestion)=>void;onPrior?:(id:string)=>void}){
 const c=channelText(language),pinId=view.pinned?.id;
 const episodes=view.episodes.map(group=>({...group,bubbles:group.bubbles.filter(bubble=>bubble.id!==pinId&&bubble.weight!=='tap')})).filter(group=>group.bubbles.length);
 return <>
  <RuntimeBoard snapshot={view.runtime} language={language}/>
  <div className="channel-pinned-slot">{view.pinned&&<section className="channel-pinned" aria-label={c.pinned}><div className="channel-pinned-label"><Pin size={13}/><strong>{c.pinned}</strong>{view.pendingCount>1&&<button type="button" onClick={onPending}>{c.otherPending} · {view.pendingCount-1}</button>}</div><ChannelBubbleCard bubble={view.pinned} language={language} pending={pending} onAction={onAction} onPrior={onPrior}/></section>}</div>
  <section className="channel-episodes" aria-label={c.keyChanges}>
   {episodes.length?episodes.map(group=><section className="channel-episode" key={group.episode.id} data-episode={group.episode.id}><div className="channel-episode-heading"><span>{group.episode.phase==='closed'?c.postureClose:group.episode.phase==='accompany'?c.postureAccompany:c.postureAlarm}</span><span className="channel-muted">{group.bubbles.length}</span></div>{group.bubbles.map(bubble=><ChannelBubbleCard key={bubble.id} bubble={bubble} language={language} pending={pending} onAction={onAction} onPrior={onPrior}/>)}</section>):!view.pinned&&<div className="channel-empty"><div className="channel-empty-friends">{(['laozhou','ajie','xiaoqi'] as const).map(speaker=><ChannelFriendAvatar key={speaker} speaker={speaker} language={language}/>)}</div><h2>{c.emptyTitle}</h2><p>{view.report?c.emptyBody:c.emptyWithoutReport}</p><Link className="channel-inline-link" to={view.report?.href??'/'}><FileText size={14}/>{view.report?c.today:c.reportNotReady}<ArrowUpRight size={13}/></Link></div>}
   <DeferredQuestions questions={view.deferredQuestions} language={language} pending={pending} onSelect={onSelect}/>
  </section>
  <section className="channel-asides" aria-label={c.aside} aria-live="off"><div className="channel-aside-title"><MessageCircle size={13}/><button type="button" onClick={onLogs} title={c.viewAllTaps}>{c.aside}</button><label><span className="sr-only">{c.vibe}</span><select value={view.vibe} onChange={event=>onVibe?.(event.target.value as ChannelVibe)} disabled={pending} aria-label={c.vibe}>{(['quiet','deskmate','chatty'] as const).map(vibe=><option key={vibe} value={vibe}>{c[vibe]}</option>)}</select></label></div><div className="channel-aside-items">{view.visibleTaps.length?view.visibleTaps.map(bubble=><ChannelBubbleCard key={bubble.id} bubble={bubble} language={language} pending={pending} onAction={onAction} onPrior={onPrior}/>):<p className="channel-muted">{c.noTaps}</p>}</div></section>
  <button type="button" className="channel-progress" onClick={onLogs}><span className={view.progress.runningCount?'channel-progress-dot is-running':'channel-progress-dot'}/><span>{view.progress.runningCount} {c.progress} · {view.progress.gapCount} {c.gapCount}</span><span>{c.log}<ArrowUpRight size={12}/></span></button>
 </>;
}
export function ChannelResearchLog({items,language}:{items:Array<{id:string;kind:string;summary:string;createdAt:string;status?:string;toolName?:string;durationMs?:number}>;language:string}){
 const zh=language.startsWith('zh');
 return <ol className="channel-log-list">{items.map(item=><li key={item.id}><details><summary><span>{item.toolName??item.kind}</span><time className="channel-muted">{channelDate(item.createdAt,language)}</time></summary><p>{item.summary}</p>{item.status&&<span className="channel-muted">{zh?'记录状态':'Recorded status'}: {item.status}</span>}{typeof item.durationMs==='number'&&<p className="channel-muted">{zh?'耗时':'Duration'}: {item.durationMs} ms</p>}</details></li>)}</ol>;
}
