const assert=require('node:assert/strict');
const {test}=require('node:test');
const fixture=require('./simple-test-loader.cjs');
const {load,render,state}=fixture();
const at='2026-11-06T01:00:00Z';
const report=(id,summary,time)=>({id,summary,createdAt:time,revision:1,version:1,publicationOutcome:'succeeded',researchVersionId:`version-${id}`,dissent:[],evidence:[],nextReviewCondition:'Review the next filing.'});
test('each completed round stays in the conversation after the next round starts or fails',()=>{
  const session={id:'room',title:'Research',revision:3,status:'failed',stage:'waiting',mode:'single',messages:[],reports:[report('first','First saved finding.',at),report('second','Second saved finding.','2026-11-06T02:00:00Z')],members:[],actualExecutors:[],memberStates:[]};
  state.queries.set('research-conversation',{data:session});
  const html=render(load('pages/Council/SimpleCouncilPage.tsx').default);
  assert.match(html,/First saved finding/);assert.match(html,/Second saved finding/);
  assert.equal((html.match(/data-round-report=/g)||[]).length,2);
  assert.match(html,/referenceVersionId=version-first/);
  assert.match(html,/Add to investment strategy/);
});
test('ongoing process appears in the conversation and starts expanded',()=>{
  const session={id:'room',title:'Research',revision:1,status:'running',stage:'independent',mode:'single',messages:[],reports:[],members:[],actualExecutors:[],memberStates:[],researchEvents:[{id:'event',sessionId:'room',taskId:'task',revision:1,memberId:'member',memberName:'Stock friend',turn:0,sequence:1,kind:'task',status:'running',at,summary:'Checking public filings.'}]};
  state.queries.set('research-conversation',{data:session});
  const html=render(load('pages/Council/SimpleCouncilPage.tsx').default);
  assert.match(html,/Checking public filings/);assert.match(html,/<details[^>]*open/);
});
test('historical reader formats known JSON and leaves immutable raw source untouched',()=>{
  const raw='Research follows:\n```json\n{"response":{"thesis":"Preserved historical thesis.","evidencePoints":["Real evidence"],"risks":[],"nextChecks":[]}}\n```';
  const version={id:'old',title:'Old report',createdAt:at,content:raw,sections:[{id:'summary',title:'Summary',content:raw}]};
  state.queries.set('research-document',{data:{version}});
  const html=render(load('pages/Analysis/SimpleReportReader.tsx').default,{versionId:'old'});
  assert.match(html,/Preserved historical thesis/);assert.doesNotMatch(html,/&quot;response&quot;|evidencePoints|```/);
  assert.equal(version.content,raw);
});
test('historical reader preserves public evidence and next-evidence sections without raw envelopes',()=>{
  state.queries.set('research-document',{data:{version:{id:'sectioned',title:'Saved report',createdAt:at,content:'Saved raw report',sections:[
    {id:'summary',title:'Summary',content:'Keep researching.'},
    {id:'evidencePoints',title:'Evidence points',content:'["Public supporting fact."]'},
    {id:'nextEvidence',title:'Next evidence',content:'["Check the next filing."]'},
    {id:'evidence',title:'Raw evidence',content:'[{"content":"PRIVATE_RAW_PAYLOAD"}]'},
    {id:'dailyLedgerFacts',title:'Private ledger',content:'{"summary":"PRIVATE_LEDGER_PAYLOAD"}'},
  ]}}});
  const html=render(load('pages/Analysis/SimpleReportReader.tsx').default,{versionId:'sectioned'});
  assert.match(html,/Public supporting fact/u);assert.match(html,/Check the next filing/u);
  assert.doesNotMatch(html,/PRIVATE_RAW_PAYLOAD|PRIVATE_LEDGER_PAYLOAD/u);
});
test('analysis exposes saved report history with date and topic filters',()=>{
  state.queries.set('research-document-index',{data:{items:[],topics:[],total:0}});
  const html=render(load('pages/Analysis/SimpleAnalysisPage.tsx').default);
  assert.match(html,/Report history/);assert.match(html,/Report topic/);assert.match(html,/Report date/);
});
test('Today has distinct initial and discussion panels with exact report references',()=>{
  const Panel=load('pages/Today/CurrentAnalysisPanel.tsx').default;
  const view={documentId:'immutable',topicKey:'portfolio',dateKey:'2026-11-06',content:'Saved finding',summary:'Saved finding',state:'ready',researchLevel:'ai'};
  const initial=render(Panel,{view,topicKey:'portfolio',variant:'initial'}),discussion=render(Panel,{view,topicKey:'portfolio',variant:'discussion'});
  assert.match(initial,/Today’s initial analysis/);assert.match(discussion,/Latest portfolio discussion/);
  assert.doesNotMatch(discussion,/Update analysis/);assert.match(initial,/Report history/);
});
