import type { ResearchDocumentSection } from '../../../shared/research-document.interface';
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const prose = (v: unknown): string => typeof v === 'string' && !/^\s*[\[{]/u.test(v) ? v.trim() : '';
const list = (v: unknown): string[] => Array.isArray(v) ? v.map(prose).filter(Boolean) : [];

/** Render accepted research, keeping the immutable evidence envelope out of the reading surface. */
export function researchPresentation(report: unknown, sections: ResearchDocumentSection[]) {
  const data=record(report);
  const section=(name:string)=>sections.find(s=>s.id.toLowerCase()===name.toLowerCase()||s.title.toLowerCase()===name.toLowerCase());
  const summary=prose(data.summary)||prose(section('summary')?.content)||prose(section('analysis')?.content)||null;
  const risks=list(data.allocationRisks??data.dissent),nextChecks=list(data.actions??data.nextEvidence),uncertainties=list(data.uncertainties);
  const chunks:string[]=[];
  if(summary)chunks.push(summary);
  const group=(title:string,items:string[])=>{if(items.length)chunks.push(`## ${title}\n\n${items.map(v=>`- ${v}`).join('\n')}`);};
  group('重点关注',risks);group('接下来看看',nextChecks);group('尚待核实',uncertainties);
  if(Array.isArray(data.holdings))for(const raw of data.holdings){const row=record(raw),ticker=prose(row.ticker),rationale=prose(row.rationale);
    if(ticker&&rationale)chunks.push(`## ${ticker}\n\n${rationale}${list(row.triggers).length?'\n\n'+list(row.triggers).map(v=>`- ${v}`).join('\n'):''}`);}
  if(!chunks.length)chunks.push(...sections.filter(s=>!/ledger|snapshot|evidence|holdings|facts|references/iu.test(s.id)&&prose(s.content)).map(s=>`## ${s.title}\n\n${s.content}`));
  return {summary,keyPoints:[...risks,...nextChecks].slice(0,3),risks,nextChecks,content:chunks.join('\n\n')};
}

export function currencyBreakdown(rows:Array<{currency:string;shares:number;currentPrice:number|null}>,cash:Array<{currency:string;balance:string|number}>){
  return [...new Set([...rows.map(r=>r.currency),...cash.map(r=>r.currency)])].sort().map(currency=>{
    const positions=rows.filter(r=>r.currency===currency),balances=cash.filter(r=>r.currency===currency).map(r=>Number(r.balance));
    return {currency,holdingsValue:positions.some(r=>r.currentPrice===null||!Number.isFinite(r.currentPrice))?null:positions.reduce((sum,r)=>sum+r.shares*r.currentPrice!,0),
      cash:balances.every(Number.isFinite)?balances.reduce((sum,n)=>sum+n,0):null};
  });
}
