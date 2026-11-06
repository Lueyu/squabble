import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AiInvestmentView } from '@shared/investment-policy.interface';
import type { StrategyDraftInput,StrategyEntry,UserInvestmentStrategy } from '@shared/user-investment-strategy.interface';
import { investmentStrategiesApi } from '@/api/investment-strategies';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle } from '@/components/ui/dialog';
import { editStrategyEntry,strategyEditorContent } from '@/utils/user-strategy-editor';
import { businessTime,resolveZonedInput,strategyPeriodDates,zonedInput } from '@/utils/strategy-dates';

const draftLimits:NonNullable<StrategyDraftInput['limits']>={maxPositionPct:10,maxDailyIncreasePct:5,maxDailyTurnoverPct:20,minCashPct:10,maxGrossExposurePct:90,maxOrderPct:5};
function simulationLimits(limits:AiInvestmentView['limits']):NonNullable<StrategyDraftInput['limits']> {
  return {maxPositionPct:limits.maxPositionPct,maxDailyIncreasePct:limits.maxDailyIncreasePct,maxDailyTurnoverPct:limits.maxDailyTurnoverPct,minCashPct:limits.minCashPct,maxGrossExposurePct:limits.maxGrossExposurePct,maxOrderPct:limits.maxOrderPct};
}
function initialContent(item:UserInvestmentStrategy|null,timezone:string,investment?:AiInvestmentView):StrategyDraftInput {
  if(item)return structuredClone(item.content);
  const limits=investment?.limits;
  return {title:'投资策略 / Investment strategy',body:'',timezone,...strategyPeriodDates('custom',timezone),entries:[{id:'manual_'+crypto.randomUUID(),text:'',sourceKeys:[]}],
    ...(limits?{limits:simulationLimits(limits)}:{})};
}
export default function InvestmentStrategyEditor({item,currentId,timezone,investment,onClose,onChanged}:{item:UserInvestmentStrategy|null;currentId:string|null;timezone:string;investment?:AiInvestmentView;onClose:()=>void;onChanged:()=>void}) {
  const {i18n}=useTranslation(),zh=i18n.language.startsWith('zh');
  const [content,setContent]=useState(()=>initialContent(item,timezone,investment)),[saved,setSaved]=useState<UserInvestmentStrategy|null>(()=>item?.status==='draft'?item:null);
  const [expectedCurrentId]=useState(currentId),[busy,setBusy]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState(''),[elapsed,setElapsed]=useState(0);
  const lock=useRef(false),prepareIntent=useRef<{revision:string;key:string}|null>(null),applyIntent=useRef<{revision:string;key:string}|null>(null);
  const dirty=saved?JSON.stringify(strategyEditorContent(content))!==JSON.stringify(saved.content):item?.status==='confirmed'?JSON.stringify(strategyEditorContent(content))!==JSON.stringify(item.content):true;
  const prepared=saved?.preview;
  const confirmedPreview=item?.status==='confirmed'?item.preview:null;
  const sources=saved?.sources??item?.sources??[];
  useEffect(()=>{if(busy!=='prepare')return;const started=Date.now();setElapsed(0);const timer=window.setInterval(()=>setElapsed(Math.floor((Date.now()-started)/1000)),1000);return()=>window.clearInterval(timer);},[busy]);
  const changeEntry=(id:string,change:(entry:StrategyEntry)=>StrategyEntry)=>setContent(c=>({...c,entries:c.entries.map(e=>e.id===id?change(e):e)}));
  const saveLatest=async()=>{
    const value=strategyEditorContent(content);
    if(!value.title||!value.entries.length)throw Error('EMPTY');
    const result=saved?(JSON.stringify(value)===JSON.stringify(saved.content)?saved:await investmentStrategiesApi.update(saved.id,saved.revision,value))
      :await investmentStrategiesApi.create(value,item?.status==='confirmed'?item.id:undefined);
    setSaved(result);setContent(result.content);onChanged();return result;
  };
  const work=async(kind:'save'|'prepare'|'apply'|'read')=>{
    if(lock.current)return;lock.current=true;setBusy(kind);setError('');setMessage('');
    try{
      if(kind==='read'&&saved){const value=await investmentStrategiesApi.get(saved.id);setSaved(value);setContent(value.content);setMessage(zh?'已读取保存结果。':'Loaded the saved result.');return;}
      if(kind==='apply'){
        if(!saved?.preview||dirty||!saved.preview.canConfirm)throw Error('PREVIEW');
        const revision=`${saved.id}:${saved.revision}:${saved.preview.contentHash}`;
        if(applyIntent.current?.revision!==revision)applyIntent.current={revision,key:crypto.randomUUID()};
        await investmentStrategiesApi.apply({strategyId:saved.id,expectedRevision:saved.revision,previewHash:saved.preview.contentHash,expectedCurrentId,requestKey:applyIntent.current.key});
        onChanged();onClose();return;
      }
      const wasInterpreted=!!saved?.preview&&saved.content.body===content.body&&saved.content.entries.length===content.entries.filter(e=>e.text.trim()).length
        &&saved.content.entries.every(e=>content.entries.find(x=>x.id===e.id)?.text===e.text);
      const value=await saveLatest();
      if(kind==='prepare'){
        const revision=`${value.id}:${value.revision}`;
        if(prepareIntent.current?.revision!==revision)prepareIntent.current={revision,key:crypto.randomUUID()};
        const next=wasInterpreted?await investmentStrategiesApi.preview(value.id,value.revision):await investmentStrategiesApi.prepare(value.id,value.revision,prepareIntent.current.key);
        setSaved(next);setContent(next.content);onChanged();setMessage(zh?'执行说明已整理，请核对下面的条件与金额。':'Execution details are ready. Review the conditions and amounts below.');
      }else setMessage(zh?'草稿已保存。正在执行的策略保持原样。':'Draft saved. The applied strategy keeps running.');
    }catch(cause){
      const code=String((cause as {response?:{data?:{message?:string}}})?.response?.data?.message??(cause instanceof Error?cause.message:''));
      setError(code==='EMPTY'?(zh?'请写一条策略想法并填写标题。':'Add an idea and a title.'):/changed|stale|revision/iu.test(code)?(zh?'草稿、来源或当前策略已变化，请关闭后重新核对。':'The draft, source or applied strategy changed. Close and review it again.')
        :kind==='prepare'?(zh?'草稿已保留，整理结果尚未确认。可读取已保存结果；不会自动重复调用股友。':'The draft is retained; preparation is unconfirmed. Check the saved result; no automatic repeat call is made.')
        :kind==='apply'?(zh?'尚未确认切换。请核对模拟盘、执行说明和风险限制后再试。':'The switch is unconfirmed. Review the account, execution details and limits before retrying.'):(zh?'尚未确认保存，请核对内容后重试。':'Save is unconfirmed. Review the content and retry.'));
    }finally{lock.current=false;setBusy('');}
  };
  const valid=content.title.trim()&&strategyEditorContent(content).entries.length>0;
  return <Dialog open onOpenChange={v=>{if(!v)onClose();}}><DialogContent className="max-h-[90dvh] min-w-0 overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{zh?'写下你的投资策略':'Write your investment strategy'}</DialogTitle><DialogDescription>{currentId?(zh?'编辑期间旧策略继续运行。点击应用才会整体切换。':'The applied strategy keeps running while you edit. Apply explicitly to switch it.'):(zh?'先保存想法，再核对执行说明，最后交给模拟盘。':'Save your intent, review execution details, then apply it to your simulation.')}</DialogDescription></DialogHeader>
    <div className="min-w-0 space-y-4">{confirmedPreview&&<section aria-label={zh?'已确认执行说明':'Confirmed execution details'} className="space-y-3 rounded-2xl border bg-muted/20 p-4"><h3 className="font-semibold">{zh?'已确认执行说明（固定保留）':'Confirmed execution details'}</h3><p className="text-xs leading-6 text-muted-foreground">{zh?'以下是当时确认的执行依据，修改正文不会改变它。另存草稿并重新核对后，才能应用新的说明。':'This is the confirmed execution authority. Editing the text does not change it. Copy to a draft and review new details before applying.'}</p>{item?.confirmedAt&&<p className="text-xs text-muted-foreground">{zh?'确认于：':'Confirmed: '}{businessTime(item.confirmedAt,item.content.timezone)}</p>}{confirmedPreview.entries.map(entry=><div key={entry.id} className="space-y-1 rounded-xl bg-background/60 p-3 text-sm leading-7 [overflow-wrap:anywhere]"><p>{entry.explanation[zh?'zh-CN':'en']}</p><p className="text-xs text-muted-foreground">{businessTime(entry.startsAt,entry.timezone)} — {businessTime(entry.endsAt,entry.timezone)} · {entry.timezone}</p></div>)}</section>}
      <label className="block space-y-2 text-sm"><span>{zh?'策略名称':'Strategy name'}</span><Input value={content.title} maxLength={120} disabled={!!busy} onChange={e=>setContent(c=>({...c,title:e.target.value}))}/></label>
      <label className="block space-y-2 text-sm"><span>{zh?'总体想法（可选）':'Overall intent (optional)'}</span><Textarea className="min-h-20" maxLength={4000} disabled={!!busy} placeholder={zh?'例如：本月控制总仓位，优先检查已有持仓。':'For example: control total exposure this month and review existing positions first.'} value={content.body} onChange={e=>setContent(c=>({...c,body:e.target.value}))}/></label>
      <div className="space-y-3">{content.entries.map((entry,index)=><article key={entry.id} className="space-y-3 rounded-2xl border bg-muted/20 p-3"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{zh?`想法 ${index+1}`:`Idea ${index+1}`}</h3><Button variant="ghost" size="sm" disabled={!!busy} onClick={()=>setContent(c=>({...c,entries:c.entries.filter(e=>e.id!==entry.id)}))}>{zh?'移除':'Remove'}</Button></div><Textarea className="min-h-24" aria-label={zh?`策略条目 ${index+1}`:`Strategy entry ${index+1}`} maxLength={12000} disabled={!!busy} value={entry.text} placeholder={zh?'写清股票、什么情况下行动，以及股数或仓位；只想观察也可以。':'Describe the security, condition and shares or position size. Observation-only ideas are welcome.'} onChange={e=>changeEntry(entry.id,v=>editStrategyEntry(v,e.target.value))}/>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><label className="flex flex-wrap items-center gap-2"><span>{zh?'这条有效至':'This entry ends'}</span><Input className="h-8 w-40" type="date" disabled={!!busy} value={entry.endsAt?zonedInput(entry.endsAt,entry.timezone??content.timezone).slice(0,10):''} onChange={e=>{const date=e.target.value;const end=date?resolveZonedInput(`${date}T23:59`,entry.timezone??content.timezone):null;if(end?.error){setError(zh?'该日期无法在当前时区确定。':'The date cannot be resolved in this timezone.');return;}changeEntry(entry.id,v=>({...v,endsAt:end?.iso?new Date(Date.parse(end.iso)+59999).toISOString():undefined}));}}/><span>{entry.timezone??content.timezone} · {zh?'留空沿用总策略期限':'Blank uses the total strategy period'}</span></label>{!!entry.sourceKeys.length&&<span>{entry.sourceKeys.length} {zh?'处固定来源':'pinned sources'}</span>}</div>
        <p className="text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">{zh?'生效期间：':'Effective period: '}{businessTime(entry.startsAt??content.startsAt,entry.timezone??content.timezone)} — {businessTime(entry.endsAt??content.endsAt,entry.timezone??content.timezone)} · {zh?'到期仅停止新动作，不自动清仓。':'Expiry stops new actions; it does not automatically sell.'}</p>
        {entry.directive?.trigger.kind==='semantic'&&<label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" disabled={!!busy} checked={entry.directive.semanticAuthorized===true} onChange={e=>changeEntry(entry.id,v=>({...v,directive:v.directive?{...v.directive,semanticAuthorized:e.target.checked}:undefined}))}/><span>{zh?'我允许 AI 在这条已明确金额和范围的条件内补充判断。':'Allow AI to assess this qualitative condition within its explicit amount and scope.'}</span></label>}
      </article>)}</div>
      <Button variant="outline" size="sm" disabled={!!busy||content.entries.length>=20} onClick={()=>setContent(c=>({...c,entries:[...c.entries,{id:'manual_'+crypto.randomUUID(),text:'',sourceKeys:[]}]}))}>{zh?'再写一条':'Add another idea'}</Button>
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-primary/5 p-3 text-sm"><span>{zh?'总策略期限':'Total strategy period'} · {content.timezone}</span>{(['day','month','custom'] as const).map(p=><Button type="button" key={p} size="sm" variant="ghost" disabled={!!busy} onClick={()=>setContent(c=>({...c,...strategyPeriodDates(p,c.timezone)}))}>{p==='day'?(zh?'今日':'Today'):p==='month'?(zh?'本月':'This month'):(zh?'未来一周':'Next week')}</Button>)}<Input className="h-8 w-40" aria-label={zh?'总策略到期日期':'Total strategy end date'} type="date" disabled={!!busy} value={zonedInput(content.endsAt,content.timezone).slice(0,10)} onChange={e=>{const end=resolveZonedInput(`${e.target.value}T23:59`,content.timezone);if(end.iso)setContent(c=>({...c,endsAt:new Date(Date.parse(end.iso)+59999).toISOString()}));}}/></div>
      <details className="rounded-xl border p-3"><summary className="cursor-pointer text-sm font-medium">{zh?'仓位和资金边界':'Position and cash limits'}</summary>{content.limits?<><p className="mt-3 text-xs leading-6 text-muted-foreground">{zh?'请核对这些草稿边界；保存不会授权交易，仍需核对执行说明并确认应用。':'Review these draft limits. Saving does not authorize trading; review the execution details and apply explicitly.'}</p><div className="mt-3 grid gap-3 sm:grid-cols-2">{(Object.keys(content.limits) as Array<keyof NonNullable<StrategyDraftInput['limits']>>).map(key=><label key={key} className="space-y-1 text-sm"><span>{({maxPositionPct:zh?'单股仓位上限':'Single-position cap',maxOrderPct:zh?'单笔资金上限':'Single-order cap',maxDailyIncreasePct:zh?'每日新增仓位上限':'Daily increase cap',maxDailyTurnoverPct:zh?'每日交易金额上限':'Daily turnover cap',minCashPct:zh?'最低现金比例':'Minimum cash',maxGrossExposurePct:zh?'总仓位上限':'Gross exposure cap'} as Record<string,string>)[key]} (%)</span><Input type="number" min="0" max={key==='maxDailyTurnoverPct'?200:100} disabled={!!busy} value={content.limits?.[key]??''} onChange={e=>setContent(c=>({...c,limits:c.limits?{...c.limits,[key]:Number(e.target.value)}:undefined}))}/></label>)}</div></>:<div className="mt-3 space-y-3"><p className="text-sm text-muted-foreground">{zh?'保存想法不需要资金边界。执行前请设置并核对，也可以使用模拟盘当前边界作为草稿。':'You can save ideas without funding limits. Set and review them before execution, or use the current simulation limits as a draft.'}</p><div className="flex flex-wrap gap-2">{investment?.account&&<Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={()=>setContent(c=>({...c,limits:simulationLimits(investment.limits)}))}>{zh?'使用模拟盘当前边界':'Use current simulation limits'}</Button>}<Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={()=>setContent(c=>({...c,limits:{...draftLimits}}))}>{zh?'设置并核对边界':'Set and review limits'}</Button></div></div>}</details>
      {!!sources.length&&<section aria-label={zh?'固定研究来源':'Pinned research sources'} className="space-y-2 rounded-xl border p-3"><h3 className="text-sm font-medium">{zh?'固定研究来源':'Pinned research sources'}</h3>{sources.map(source=><div key={source.key} className="text-xs leading-6 [overflow-wrap:anywhere]">{source.kind==='report'&&source.versionId?<Link className="text-primary underline" to={`/analysis/reports/${encodeURIComponent(source.versionId)}`} onClick={onClose}>{source.title}</Link>:source.sessionId?<Link className="text-primary underline" to={`/council?session=${encodeURIComponent(source.sessionId)}`} onClick={onClose}>{source.title}</Link>:<span>{source.title}</span>}<span className="ml-2 text-muted-foreground">{businessTime(source.createdAt,content.timezone)}</span></div>)}</section>}
      {prepared&&<section aria-label={zh?'执行说明':'Execution details'} className={`space-y-3 rounded-2xl border p-4 ${dirty?'opacity-60':''}`}><h3 className="font-semibold">{zh?'股友理解的执行方式':'How your stock friends will execute'}</h3><p className="text-xs leading-6 text-muted-foreground">{zh?'请逐条核对股票、买卖方向、条件与数量。确认应用后，模拟盘以这些说明为依据。':'Review each security, buy/sell direction, condition and quantity. These details become the execution authority after you apply them.'}</p>{dirty&&<p className="text-sm text-amber-600">{zh?'正文已修改，请重新核对说明后再应用。':'Your text changed. Review refreshed details before applying.'}</p>}{prepared.entries.map(entry=><div key={entry.id} className="space-y-1 rounded-xl bg-muted/30 p-3 text-sm leading-7 [overflow-wrap:anywhere]"><p>{entry.explanation[zh?'zh-CN':'en']}</p><p className="text-xs text-muted-foreground">{businessTime(entry.startsAt,entry.timezone)} — {businessTime(entry.endsAt,entry.timezone)} · {entry.timezone}</p></div>)}{prepared.issues.map((issue,index)=><p key={index} role={issue.severity==='error'?'alert':undefined} className="text-sm text-amber-600">{issue.message[zh?'zh-CN':'en']}</p>)}</section>}
      {busy==='prepare'&&<p role="status" className="rounded-xl bg-primary/5 p-3 text-sm">{zh?`股友正在整理执行说明 · ${elapsed} 秒。草稿已保存，可以稍后回来查看。`:`Preparing execution details · ${elapsed}s. Your draft is saved; you can return later.`}</p>}
      {message&&<p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>}{error&&<div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p>{saved&&<Button variant="outline" size="sm" disabled={!!busy} onClick={()=>void work('read')}>{zh?'读取已保存结果':'Check saved result'}</Button>}</div>}
      {!investment?.account&&<p className="text-sm text-muted-foreground">{zh?'应用前先建立模拟盘。':'Create a simulation before applying.'} <Link className="text-primary underline" to="/paper" onClick={onClose}>{zh?'复制当前持仓':'Copy current holdings'}</Link></p>}
      <footer className="flex flex-wrap justify-end gap-2 border-t pt-4"><Button variant="ghost" onClick={onClose}>{zh?'关闭':'Close'}</Button><Button variant="outline" disabled={!!busy||!valid} onClick={()=>void work('save')}>{item?.status==='confirmed'&&!saved?(zh?'另存为草稿':'Copy as draft'):(zh?'仅保存草稿':'Save draft only')}</Button><Button variant="secondary" disabled={!!busy||!valid} onClick={()=>void work('prepare')}>{zh?'整理并核对执行说明':'Prepare execution details'}</Button><Button disabled={!!busy||!saved||dirty||!prepared?.canConfirm||!investment?.account} onClick={()=>void work('apply')}>{busy==='apply'?(zh?'正在应用…':'Applying…'):(zh?'确认说明并应用':'Review and apply to simulation')}</Button></footer>
    </div>
  </DialogContent></Dialog>;
}
