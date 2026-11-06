import type { ResearchDocumentSection } from '../../../shared/research-document.interface';
import { readableResearch,readableResearchSection,researchSectionsRecord,researchReferences } from '../../../shared/research-reading';
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const prose = (v: unknown): string => readableResearch(v);
const list = (v: unknown): string[] => Array.isArray(v) ? v.map(prose).filter(Boolean) : [];

/** Render accepted research, keeping the immutable evidence envelope out of the reading surface. */
export function researchPresentation(report: unknown, sections: ResearchDocumentSection[]) {
  const data=report?record(report):researchSectionsRecord(sections);
  const section=(name:string)=>sections.find(s=>s.id.toLowerCase()===name.toLowerCase()||s.title.toLowerCase()===name.toLowerCase());
  const summary=prose(data.summary)||prose(section('summary')?.content)||prose(section('analysis')?.content)||null;
  const risks=list(data.allocationRisks??data.dissent),nextChecks=[...list(data.actions??data.nextEvidence),...list(data.nextChecks),...(prose(data.nextReviewCondition)?[prose(data.nextReviewCondition)]:[])],uncertainties=[...list(data.uncertainties),...list(data.dataGaps)];
  const chunks:string[]=[];
  if(summary)chunks.push(summary);
  const group=(title:string,items:string[])=>{if(items.length)chunks.push(`## ${title}\n\n${items.map(v=>`- ${v}`).join('\n')}`);};
  group('重点关注',risks);group('接下来看看',nextChecks);group('尚待核实',uncertainties);
  let hasHoldingJudgment=false;
  if(Array.isArray(data.holdings))for(const raw of data.holdings){const row=record(raw),ticker=prose(row.ticker),rationale=prose(row.rationale);
    if(ticker&&rationale)hasHoldingJudgment=true;
    if(ticker&&rationale)chunks.push(`## ${ticker}\n\n${rationale}${list(row.triggers).length?'\n\n'+list(row.triggers).map(v=>`- ${v}`).join('\n'):''}`);}
  const handled=new Set(['summary','analysis','allocationRisks','dissent','actions','nextEvidence','nextChecks','nextReviewCondition','uncertainties','dataGaps','holdings']);
  const additional=sections.filter(s=>!handled.has(s.id)).map(s=>({section:s,content:readableResearchSection(s)})).filter(s=>s.content).map(s=>`## ${s.section.title}\n\n${s.content}`);
  chunks.push(...additional);
  const readable=Boolean(summary)||hasHoldingJudgment||additional.length>0;
  const references=researchReferences(data);if(references)chunks.push(references);
  const content=chunks.join('\n\n');
  return {summary,keyPoints:[...risks,...nextChecks].slice(0,3),risks,nextChecks,content,readingState:readable?'ready' as const:'pending' as const};
}

export function currencyBreakdown(rows:Array<{currency:string;shares:number;currentPrice:number|null}>,cash:Array<{currency:string;balance:string|number;reconciliationStatus?:string}>){
  return [...new Set([...rows.map(r=>r.currency),...cash.map(r=>r.currency)])].sort().map(currency=>{
    const positions=rows.filter(r=>r.currency===currency),balances=cash.filter(r=>r.currency===currency);
    return {currency,holdingsValue:positions.some(r=>r.currentPrice===null||!Number.isFinite(r.currentPrice))?null:positions.reduce((sum,r)=>sum+r.shares*r.currentPrice!,0),
      cash:balances.length===1&&balances[0].reconciliationStatus==='confirmed'&&Number.isFinite(Number(balances[0].balance))&&Number(balances[0].balance)>=0?Number(balances[0].balance):null};
  });
}
