import {useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {toast} from 'sonner';
import {fetchChannelMemory,saveChannelPreference,saveChannelReflection} from '@/api/channel';
import {createRequestIntent} from '@/utils/simple-experience';
import {channelDate} from './ChannelWorkbench';

export default function ChannelPersonalNotes({language,userMessages}:{language:string;userMessages:Array<{id:string;text:string;createdAt:string}>}){
 const zh=language.startsWith('zh'),client=useQueryClient();
 const query=useQuery({queryKey:['channel-memory'],queryFn:fetchChannelMemory,retry:false});
 const [pending,setPending]=useState(false),[decisionId,setDecisionId]=useState(''),[kind,setKind]=useState<'reason_at_adoption'|'later_reflection'>('reason_at_adoption'),[text,setText]=useState('');
 const lock=useRef(false),intent=useRef(createRequestIntent(()=>crypto.randomUUID()));
 async function preference(messageId:string){
  if(lock.current)return;lock.current=true;setPending(true);
  try{await saveChannelPreference({sourceMessageId:messageId,requestKey:`channel-preference:${messageId}`});await client.invalidateQueries({queryKey:['channel-memory']});}
  catch{toast.error(zh?'偏好未能确认保存，请重试。':'Preference was not confirmed. Retry.');}
  finally{lock.current=false;setPending(false);}
 }
 async function reflect(){
  if(lock.current||!decisionId||!text.trim())return;lock.current=true;setPending(true);
  const payload={decisionId,kind,text:text.trim()};
  try{
   await saveChannelReflection({...payload,requestKey:intent.current.keyFor(payload)});intent.current.complete();
   setText(current=>current.trim()===payload.text?'':current);
   await client.invalidateQueries({queryKey:['channel-memory']});
  }catch{toast.error(zh?'这段记录尚未保存。重试会保留同一次请求。':'This note was not confirmed. Retry reuses the same request.');}
  finally{lock.current=false;setPending(false);}
 }
 return <section className="channel-drawer-section channel-personal-notes">
  <h3>{zh?'我们之间的记录':'Our shared record'}</h3>
  <p className="channel-muted">{zh?'只记你说过的话。采纳理由和后来的复盘分别留时点。':'Only words you actually provided. Adoption reasons and later reflections keep separate timestamps.'}</p>
  {query.isError&&<button type="button" className="channel-inline-link" onClick={()=>void query.refetch()}>{zh?'重试读取记录':'Retry records'}</button>}
  {userMessages.map(message=>{
   const saved=query.data?.items.some(item=>item.kind==='user_stated_preference'&&item.sourceMessageId===message.id);
   return <article className="channel-detail-card" key={message.id}><p>{message.text}</p><time className="channel-muted">{channelDate(message.createdAt,language)}</time><div><button type="button" className="channel-inline-link" disabled={pending||saved||query.isPending||query.isError} onClick={()=>void preference(message.id)}>{saved?(zh?'已按原话记住':'Saved in your words'):(zh?'记作我的偏好':'Remember as my preference')}</button></div></article>;
  })}
  {query.data?.items.filter(item=>item.kind==='user_stated_preference'&&!userMessages.some(message=>message.id===item.sourceMessageId)).map(item=><article className="channel-detail-card" key={item.id}><p>{item.exactUserQuote??item.content}</p><time className="channel-muted">{channelDate(item.recordedAt,language)}</time></article>)}
  <form className="channel-reflection-form" onSubmit={event=>{event.preventDefault();void reflect();}}>
   <h3>{zh?'补一条自己的判断记录':'Add your decision note'}</h3>
   {query.data?.decisions.length?<><label>{zh?'对应的决定':'Decision'}<select value={decisionId} onChange={event=>setDecisionId(event.target.value)} disabled={pending}><option value="">{zh?'选择已记录的决定':'Choose a recorded decision'}</option>{query.data.decisions.map(decision=><option key={decision.id} value={decision.id}>{decision.label} · {channelDate(decision.createdAt,language)}</option>)}</select></label>
    <label>{zh?'记录类型':'Note type'}<select value={kind} onChange={event=>setKind(event.target.value as typeof kind)} disabled={pending}><option value="reason_at_adoption">{zh?'我当时采纳的理由':'Why I adopted it'}</option><option value="later_reflection">{zh?'我后来的复盘':'My later reflection'}</option></select></label>
    <label>{zh?'用你自己的话写':'In your own words'}<textarea value={text} onChange={event=>setText(event.target.value)} rows={3} maxLength={2000} placeholder={zh?'未填写就保留未记录。':'Leave blank to keep the reason unrecorded.'}/></label>
    <button type="submit" disabled={pending||!decisionId||!text.trim()}>{pending?(zh?'正在保存…':'Saving…'):(zh?'保存我的原话':'Save my words')}</button>
   </>:<p className="channel-muted">{zh?'有已记录的决定后，可以在这里补采纳理由或复盘。':'Once a decision is recorded, you can add your adoption reason or later reflection here.'}</p>}
  </form>
  {query.data?.reflections?.length?<details className="channel-saved-reflections"><summary>{zh?'已保存的采纳记录与复盘':'Saved adoption records and reflections'}</summary>{query.data.reflections.map(item=><article key={item.id} className="channel-detail-card"><strong>{item.kind==='later_reflection'?(zh?'后来的复盘':'Later reflection'):(zh?'采纳记录':'Adoption record')}</strong><p>{item.author==='user'?item.text:item.author==='unrecorded'?(zh?'当时未记录用户理由':'User reason was not recorded'):(zh?'当时的策略与证据快照已保存':'Strategy and evidence context at the time was preserved')}</p><time className="channel-muted">{channelDate(item.recordedAt,language)}</time></article>)}</details>:null}
 </section>;
}
