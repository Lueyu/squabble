import {useState} from 'react';
import {Link} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import type {ResearchDocumentIndexQuery} from '@shared/research-document.interface';
import {fetchResearchDocuments} from '@/api/research-documents';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {questionPath} from '@/utils/simple-experience';

export default function ReportHistory({topic,date}:{topic?:string;date?:string}){
  const {i18n}=useTranslation(),zh=i18n.language.startsWith('zh');
  const [filters,setFilters]=useState<ResearchDocumentIndexQuery>({history:true,limit:20,offset:0,topic,date});
  const query=useQuery({queryKey:['report-history',filters],queryFn:()=>fetchResearchDocuments(filters)});
  const change=(patch:ResearchDocumentIndexQuery)=>setFilters(current=>({...current,...patch,offset:0}));
  const selectClass='h-9 min-w-0 rounded-md border bg-background px-2 text-sm';
  return <section id="report-history" className="min-w-0 space-y-4 rounded-2xl border bg-card p-4 sm:p-5" aria-label={zh?'报告历史':'Report history'}><h2 className="text-lg font-semibold">{zh?'报告历史':'Report history'}</h2><p className="text-sm text-muted-foreground">{zh?'每次分析与每轮讨论都保留在这里。':'Every analysis and discussion round stays available here.'}</p>
    <div className="grid min-w-0 gap-3 sm:grid-cols-3"><label className="space-y-1 text-xs">{zh?'报告日期':'Report date'}<Input type="date" value={filters.date??''} onChange={event=>change({date:event.target.value||undefined})}/></label><label className="flex min-w-0 flex-col gap-1 text-xs">{zh?'报告主题':'Report topic'}<select className={selectClass} value={filters.topic??''} onChange={event=>change({topic:event.target.value||undefined})}><option value="">{zh?'全部主题':'All topics'}</option>{(query.data?.topics??[]).map(item=><option key={item.key} value={item.key}>{item.key==='portfolio'?(zh?'投资组合':'Portfolio'):item.label}</option>)}</select></label><label className="flex min-w-0 flex-col gap-1 text-xs">{zh?'报告来源':'Report source'}<select className={selectClass} value={filters.source??''} onChange={event=>change({source:(event.target.value||undefined) as ResearchDocumentIndexQuery['source']})}><option value="">{zh?'全部来源':'All sources'}</option><option value="portfolio">{zh?'持仓分析':'Portfolio analysis'}</option><option value="council">{zh?'投研室讨论':'Research discussion'}</option><option value="deep">{zh?'单股研究':'Stock research'}</option><option value="daily">{zh?'历史日报':'Earlier daily research'}</option></select></label></div>
    {query.isPending&&<p role="status">{zh?'正在读取报告…':'Loading reports…'}</p>}{query.isError&&<Button variant="outline" onClick={()=>void query.refetch()}>{zh?'重试读取':'Retry loading'}</Button>}
    <div className="space-y-2">{query.data?.items.map(item=><article key={item.id} className="min-w-0 space-y-2 rounded-xl border p-3"><Link to={`/analysis/reports/${encodeURIComponent(item.id)}`} className="font-medium [overflow-wrap:anywhere] hover:underline">{item.title}</Link><p className="text-xs text-muted-foreground">{new Date(item.generatedAt??item.createdAt).toLocaleString(i18n.language)} · {item.topicKey==='portfolio'?(zh?'投资组合':'Portfolio'):item.ticker} · {item.source?.type==='council'?(zh?'投研室':'Discussion'):(zh?'分析':'Analysis')}</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" asChild><Link to={`/analysis/reports/${encodeURIComponent(item.id)}`}>{zh?'阅读报告':'Read report'}</Link></Button>{item.status==='valid'&&<Button size="sm" variant="ghost" asChild><Link to={questionPath({versionId:item.id})}>{zh?'继续讨论':'Continue discussion'}</Link></Button>}</div></article>)}</div>
    {query.data?.items.length===0&&<p className="text-sm text-muted-foreground">{zh?'这个范围内还没有保存的报告。':'No saved reports in this range.'}</p>}
    <div className="flex flex-wrap justify-between gap-2"><Button size="sm" variant="outline" disabled={!filters.offset} onClick={()=>setFilters(current=>({...current,offset:Math.max(0,(current.offset??0)-20)}))}>{zh?'上一页':'Previous'}</Button><Button size="sm" variant="outline" disabled={(filters.offset??0)+20>=(query.data?.total??0)} onClick={()=>setFilters(current=>({...current,offset:(current.offset??0)+20}))}>{zh?'下一页':'Next'}</Button></div>
    {query.data?.moreLegacySources&&<Button size="sm" variant="outline" onClick={()=>void query.refetch()}>{zh?'继续读取早期报告':'Load earlier reports'}</Button>}
  </section>;
}
