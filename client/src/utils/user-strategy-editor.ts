import type { StrategyDraftInput,StrategyEntry } from '@shared/user-investment-strategy.interface';
/** Changing editorial intent invalidates its prior executable interpretation. */
export function editStrategyEntry(entry:StrategyEntry,text:string):StrategyEntry {
  return text===entry.text?entry:{...entry,text,directive:undefined,mandateRule:undefined,mandateReviewedText:undefined};
}
export function strategyEditorContent(content:StrategyDraftInput):StrategyDraftInput {
  const entries=content.entries.filter(e=>e.text.trim()).map(e=>({...e,text:e.text.trim()}));
  return {...content,title:content.title.trim(),entries:entries.length?entries:content.body.trim()?[{id:'manual_body',text:content.body.trim(),sourceKeys:[]}]:[]};
}
