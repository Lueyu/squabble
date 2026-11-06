/** Bounded protocol extraction shared by live output and historical reading. Raw output stays archived. */
export function extractResearchObject(text: string): { value?: unknown; protocol: boolean } {
  const input = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/iu.exec(input);
  const candidates = [input, ...(fence ? [fence[1].trim()] : [])];
  // A model may introduce its JSON with a sentence. Scan one balanced object, respecting strings.
  const start = input.indexOf('{');
  if (start >= 0) {
    let depth=0, quoted=false, escaped=false;
    for(let i=start;i<input.length;i++) {
      const char=input[i];
      if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
      if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&--depth===0){candidates.push(input.slice(start,i+1));break;}
    }
  }
  for(const candidate of candidates)try {
    const value:unknown=JSON.parse(candidate);
    if(value&&typeof value==='object')return {value,protocol:true};
  }catch{/* Normal Markdown remains prose. */}
  return {protocol:/^\s*[\[{]|```json|```\s*[\[{]|\{\s*"[^"\n]+"\s*:/iu.test(input)};
}

const record=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
export function researchSectionsRecord(sections:Array<{id:string;content:string}>):Record<string,unknown>{
  return Object.fromEntries(sections.map(section=>{let content:unknown=section.content;try{content=JSON.parse(section.content);}catch{/* Prose stays unchanged. */}return [section.id,content];}));
}
/** Read sections independently so an archived JSON section cannot swallow adjacent prose. */
export function readableResearchSection(section:{id:string;content:string}):string {
  const publicEvidence=['evidencepoints','nextevidence'].includes(section.id.toLowerCase());
  if(!publicEvidence&&/ledger|snapshot|evidence|facts|references|sources|fingerprint|researchStance|thesisCandidates|(?:^id$|Id$)/iu.test(section.id))return '';
  const data=researchSectionsRecord([section]);
  return readableResearch(data)||readableResearch(section.content);
}
export function readableResearchSections(sections:Array<{id:string;title:string;content:string}>):string {
  const text=sections.map(section=>{const body=readableResearchSection(section);return body?`## ${section.title}\n\n${body}`:'';}).filter(Boolean);
  const references=researchReferences(researchSectionsRecord(sections));
  if(references)text.push(references);
  return text.join('\n\n');
}
export function researchReferences(data:Record<string,unknown>):string{
  const links:string[]=[];
  for(const key of ['sources','references','evidence'])if(Array.isArray(data[key]))for(const raw of data[key]){
    const row=record(raw);if(!row)continue;
    const address=row.sourceUrl??row.url;
    if(typeof address!=='string'||typeof row.title!=='string')continue;
    try{const url=new URL(address);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)continue;
      const label=row.title.replace(/[\[\]\r\n]/gu,' ').slice(0,200),link=`- [${label}](${url.href.replace(/\(/gu,'%28').replace(/\)/gu,'%29')})`;
      if(!links.includes(link))links.push(link);
    }catch{/* Only valid public web references enter the reading surface. */}
  }
  return links.length?`## 参考资料\n\n${links.join('\n')}`:'';
}
/** Only unwrap known response containers; candidate/evidence validation still runs afterwards. */
export function unwrapResearchEnvelope(value: unknown): unknown {
  let data=record(value);
  for(let depth=0;data&&depth<4;depth++) {
    if(typeof data.response==='string') {
      const parsed=extractResearchObject(data.response);
      if(record(parsed.value))data={...data,response:parsed.value};
    }
    const inner=record(data.response);
    if(!inner||typeof inner.thesis==='string')break;
    if(!['response','content','summary','thesis'].some(key=>key in inner))break;
    data={...data,...inner};
  }
  return data??value;
}

/** Known reading fields only. Never stringify arbitrary objects or expose evidence/ledger envelopes. */
export function readableResearch(value: unknown, depth=0): string {
  if(depth>6)return '';
  if(typeof value==='string') {
    const text=value.trim(); if(!text)return '';
    const parsed=extractResearchObject(text);
    return parsed.protocol?parsed.value?readableResearch(parsed.value,depth+1):'':text;
  }
  const data=record(value); if(!data)return '';
  const chunks:string[]=[];
  const append=(text:string)=>{if(text&&!chunks.includes(text))chunks.push(text);};
  for(const field of ['response','thesis','summary','analysis','content'])if(data[field]!==undefined)append(readableResearch(data[field],depth+1));
  for(const [field,title] of [['evidencePoints','支持依据'],['allocationRisks','重要风险'],['risks','重要风险'],['dissent','分歧'],['uncertainties','待核实'],['dataGaps','待核实'],['nextEvidence','后续关注'],['nextChecks','后续关注'],['actions','后续关注'],['nextReviewCondition','后续关注']] as const){
    const raw=data[field],items=Array.isArray(raw)?raw.map(item=>readableResearch(item,depth+1)).filter(Boolean):raw?[readableResearch(raw,depth+1)].filter(Boolean):[];
    if(items.length)append(`## ${title}\n\n${items.map(item=>`- ${item}`).join('\n')}`);
  }
  const details=record(data.details);
  if(details)for(const [title,body] of Object.entries(details)) {const text=readableResearch(body,depth+1);if(text)append(`### ${title}\n\n${text}`);}
  else if(data.details)append(readableResearch(data.details,depth+1));
  if(Array.isArray(data.holdings))for(const raw of data.holdings){const row=record(raw);if(!row)continue;const ticker=readableResearch(row.ticker,depth+1),text=readableResearch(row.rationale,depth+1);if(ticker&&text)append(`## ${ticker}\n\n${text}${Array.isArray(row.triggers)?'\n\n'+row.triggers.map(item=>readableResearch(item,depth+1)).filter(Boolean).map(item=>`- ${item}`).join('\n'):''}`);}
  append(researchReferences(data));
  return chunks.join('\n\n');
}
