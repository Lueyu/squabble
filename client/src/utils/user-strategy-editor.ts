import type { StrategyDraftInput,StrategyEntry,UserInvestmentStrategy } from '@shared/user-investment-strategy.interface';
/** Changing editorial intent invalidates its prior executable interpretation. */
export function editStrategyEntry(entry:StrategyEntry,text:string):StrategyEntry {
  return text===entry.text?entry:{...entry,text,directive:undefined,mandateRule:undefined,mandateReviewedText:undefined};
}
export function strategyEditorContent(content:StrategyDraftInput):StrategyDraftInput {
  const entries=content.entries.filter(e=>e.text.trim()).map(e=>({...e,text:e.text.trim()}));
  return {...content,title:content.title.trim(),entries:entries.length?entries:content.body.trim()?[{id:'manual_body',text:content.body.trim(),sourceKeys:[]}]:[]};
}
/** Period, limits and removal edits retain their reviewed text; new intent requires preparation. */
export function canReuseStrategyInterpretation(content:StrategyDraftInput,previous:UserInvestmentStrategy|null):boolean {
  const value=strategyEditorContent(content);
  if(previous&&previous.content.body!==value.body)return false;
  return value.entries.length>0&&value.entries.every(entry=>{
    if(entry.directive?.reviewedText===entry.text||entry.mandateRule&&entry.mandateReviewedText===entry.text)return true;
    const prior=previous?.content.entries.find(item=>item.id===entry.id);
    return !!previous?.preview&&prior?.text===entry.text;
  });
}
