import { useEffect,useRef,useState } from 'react';
import { Link,useSearchParams } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Sparkles,NotebookPen,Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { UserInvestmentStrategy } from '@shared/user-investment-strategy.interface';
import { investmentStrategiesApi } from '@/api/investment-strategies';
import { fetchAiInvestment } from '@/api/ai-investment';
import { Button } from '@/components/ui/button';
import { friendlyError } from '@/utils/error-message';
import ResearchMarkdown from '@/components/ResearchMarkdown';
import InvestmentStrategyEditor from './InvestmentStrategyEditor';

export default function InvestmentStrategySection({timezone='Asia/Shanghai'}:{timezone?:string}) {
  const {i18n}=useTranslation(),zh=i18n.language.startsWith('zh'),client=useQueryClient();
  const query=useQuery({queryKey:['investment-strategies'],queryFn:investmentStrategiesApi.workspace,refetchInterval:15000,retry:false});
  const investment=useQuery({queryKey:['ai-investment'],queryFn:fetchAiInvestment,refetchInterval:15000,retry:false});
  const [editing,setEditing]=useState<{item:UserInvestmentStrategy|null}|null>(null);
  const [params,setParams]=useSearchParams(),requestedId=params.get('investmentStrategyId'),opened=useRef<string|null>(null);
  const selected=useQuery({queryKey:['investment-strategy',requestedId],queryFn:()=>investmentStrategiesApi.get(requestedId!),enabled:!!requestedId,retry:false});
  const [olderDrafts,setOlderDrafts]=useState<UserInvestmentStrategy[]>([]),[olderHistory,setOlderHistory]=useState<UserInvestmentStrategy[]>([]);
  const [draftsCursor,setDraftsCursor]=useState<string|null|undefined>(),[historyCursor,setHistoryCursor]=useState<string|null|undefined>(),[paging,setPaging]=useState(''),[pageError,setPageError]=useState(false);
  const current=query.data?.current;
  const drafts=[...new Map([...(query.data?.drafts??[]),...olderDrafts].map(s=>[s.id,s])).values()];
  const history=[...new Map([...(query.data?.history??[]),...olderHistory].filter(s=>s.id!==current?.id).map(s=>[s.id,s])).values()];
  const nextDraft=draftsCursor===undefined?query.data?.draftsCursor:draftsCursor,nextHistory=historyCursor===undefined?query.data?.historyCursor:historyCursor;
  useEffect(()=>{if(!requestedId){opened.current=null;return;}if(selected.data&&opened.current!==requestedId){opened.current=requestedId;setEditing({item:selected.data});}},[requestedId,selected.data]);
  const closeEditor=()=>{setEditing(null);if(requestedId){const next=new URLSearchParams(params);next.delete('investmentStrategyId');setParams(next,{replace:true});}};
  const more=async(kind:'drafts'|'history')=>{const cursor=kind==='drafts'?nextDraft:nextHistory;if(!cursor||paging)return;setPaging(kind);setPageError(false);try{const page=kind==='drafts'?await investmentStrategiesApi.drafts(cursor):await investmentStrategiesApi.history(cursor);if(kind==='drafts'){setOlderDrafts(d=>[...d,...page.items]);setDraftsCursor(page.nextCursor);}else{setOlderHistory(h=>[...h,...page.items]);setHistoryCursor(page.nextCursor);}}catch{setPageError(true);}finally{setPaging('');}};
  const removeDraft=async(draft:UserInvestmentStrategy)=>{
    if(!window.confirm(zh?`确定删除草稿“${draft.content.title}”吗？此操作不可撤销。`:`Delete draft "${draft.content.title}"? This cannot be undone.`))return;
    try{
      await investmentStrategiesApi.remove(draft.id);
      toast.success(zh?'草稿已删除':'Draft deleted');
      void client.invalidateQueries({queryKey:['investment-strategies']});
    }catch(error){
      toast.error(friendlyError(error,zh,{zh:'删除失败，请稍后重试。',en:'Delete failed. Please try again.'}));
    }
  };
  return <section id="investment-strategy" className="min-w-0 scroll-mt-6 space-y-4 rounded-2xl border bg-card p-4 sm:p-6" aria-label={zh?'我的投资策略':'Your investment strategy'}>
    <header className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><span className="rounded-2xl bg-primary/10 p-3 text-primary"><NotebookPen size={21}/></span><div><h2 className="text-lg font-semibold">{zh?'我的投资策略':'Your investment strategy'}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{zh?'一份总策略，写下你的想法，让股友协助核对和执行。':'One total strategy. Write your intent and let your stock friends help review and execute it.'}</p></div></div><Button size="sm" onClick={()=>setEditing({item:current??null})}>{current?(zh?'编辑策略':'Edit strategy'):(zh?'自己写策略':'Write a strategy')}</Button></header>
    {query.isPending&&<p role="status" className="text-sm text-muted-foreground">{zh?'正在读取策略…':'Loading your strategy…'}</p>}
    {query.isError&&<div role="alert" className="space-y-2 text-sm"><p>{zh?'策略暂时无法读取，已保存的内容仍然保留。':'Your strategy is temporarily unavailable. Saved content is retained.'}</p><Button variant="outline" size="sm" onClick={()=>void query.refetch()}>{zh?'重新读取':'Reload'}</Button></div>}
    {requestedId&&selected.isError&&<p role="alert" className="text-sm text-muted-foreground">{zh?'链接中的策略暂时不可读取，可从下方历史重新选择。':'The linked strategy is unavailable. Choose one from history below.'}</p>}
    {current?<div className="space-y-3"><div className="flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-emerald-500/10 px-3 py-1 text-emerald-700 dark:text-emerald-300">{investment.data?.policy?.status==='running'?(zh?'模拟盘正在执行':'Running in simulation'):(zh?'已确认策略':'Confirmed strategy')}</span><span className="rounded-full bg-muted px-3 py-1 text-muted-foreground">{new Date(current.confirmedAt).toLocaleString(i18n.language)}</span></div><h3 className="font-medium">{current.content.title}</h3>{current.content.body&&<ResearchMarkdown>{current.content.body}</ResearchMarkdown>}<ul className="space-y-2">{current.content.entries.slice(0,3).map(entry=><li key={entry.id} className="rounded-xl bg-muted/30 p-3 text-sm leading-6 [overflow-wrap:anywhere]">{entry.text.length>500?`${entry.text.slice(0,500)}…`:entry.text}</li>)}</ul><Button variant="outline" size="sm" onClick={()=>setEditing({item:current})}>{zh?'查看全文与执行说明':'Read strategy and execution details'}</Button></div>
      :!query.isPending&&!query.isError&&<div className="rounded-xl bg-primary/5 p-4"><p className="text-sm leading-7">{zh?'先写一条想法，或把研究结论保存到这里。保存草稿后可以随时修改，应用到模拟盘才会开始执行。':'Start with an idea or bring a finding from your research. Drafts stay editable; execution starts only after applying one to a simulated account.'}</p><Button asChild variant="ghost" size="sm" className="mt-2"><Link to="/council"><Sparkles size={14}/>{zh?'到频道核对事实':'Check a fact in the channel'}</Link></Button></div>}
    {!!drafts.length&&<div className="space-y-2 border-t pt-4"><h3 className="text-sm font-medium">{zh?'草稿，尚未应用':'Drafts, not applied'}</h3>{drafts.slice(0,5).map(draft=><div key={draft.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2"><div className="min-w-0"><p className="break-words text-sm font-medium">{draft.content.title}</p><p className="mt-1 text-xs text-muted-foreground">{draft.sources.length?`${draft.sources.length} ${zh?'处讨论来源':'discussion sources'}`:(zh?'自己写的策略':'Your own strategy')} · {new Date(draft.updatedAt).toLocaleString(i18n.language)}</p></div><div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={()=>setEditing({item:draft})}>{zh?'继续编辑':'Continue editing'}</Button><Button size="sm" variant="ghost" aria-label={zh?'删除草稿':'Delete draft'} onClick={()=>void removeDraft(draft)}><Trash2 className="h-4 w-4 text-muted-foreground"/></Button></div></div>)}{drafts.length>5&&<select aria-label={zh?'选择其他草稿':'Choose another draft'} className="w-full rounded-xl border bg-background p-2 text-sm" defaultValue="" onChange={e=>{const item=drafts.find(d=>d.id===e.target.value);if(item)setEditing({item});}}><option value="">{zh?'查看其他草稿':'Other drafts'}</option>{drafts.slice(5).map(d=><option key={d.id} value={d.id}>{d.content.title}</option>)}</select>}</div>}
    {nextDraft&&<Button size="sm" variant="ghost" disabled={!!paging} onClick={()=>void more('drafts')}>{zh?'加载更早的草稿':'Load earlier drafts'}</Button>}
    {(!!history.length||nextHistory)&&<details className="border-t pt-4"><summary className="cursor-pointer text-sm font-medium">{zh?`已确认历史 · ${history.length}${nextHistory?'+':''}`:`Confirmed history · ${history.length}${nextHistory?'+':''}`}</summary><ul className="mt-3 space-y-2">{history.map(item=><li key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{item.content.title} · {new Date(item.confirmedAt??item.updatedAt).toLocaleString(i18n.language)}</span><Button size="sm" variant="ghost" onClick={()=>setEditing({item})}>{zh?'查看与另存草稿':'Read or copy as draft'}</Button></li>)}</ul>{nextHistory&&<Button size="sm" variant="ghost" disabled={!!paging} onClick={()=>void more('history')}>{zh?'加载更早的策略':'Load earlier strategies'}</Button>}</details>}
    {pageError&&<p role="alert" className="text-sm text-muted-foreground">{zh?'更早记录暂时无法读取，可以重试。':'Earlier records could not be loaded. You can retry.'}</p>}
    {editing&&<InvestmentStrategyEditor key={editing.item?.id??'new'} item={editing.item} currentId={current?.id??null} timezone={timezone} investment={investment.data} onClose={closeEditor} onChanged={()=>{void client.invalidateQueries({queryKey:['investment-strategies']});void client.invalidateQueries({queryKey:['ai-investment']});}}/>}
  </section>;
}
