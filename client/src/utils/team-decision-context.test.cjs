const {test}=require('node:test');
const assert=require('node:assert/strict');
const fixture=require('./simple-test-loader.cjs');
const context=()=>fixture().load('features/investment-strategies/team-decision-context.ts');

test('team adoption links require an exact proposal revision and all source identifiers',()=>{
 const {teamDecisionContextFromSearch,matchTeamDecision}=context();
 const valid=teamDecisionContextFromSearch(new URLSearchParams('teamId=t&teamDecisionId=d&proposalId=p&proposalRevision=3'));
 assert.equal(valid.invalid,false); assert.equal(valid.ref.decisionId,'d'); assert.equal(valid.ref.proposalRevision,3);
 for(const query of ['teamDecisionId=d','teamId=t&teamDecisionId=d&proposalId=p&proposalRevision=0','teamId=t&teamDecisionId=d&proposalId=p&proposalRevision=3.2'])assert.equal(teamDecisionContextFromSearch(new URLSearchParams(query)).invalid,true);
 const decision={id:'d',teamId:'t',accountId:'a',event:'adopt',proposalId:'p',proposalRevision:3};
 assert.equal(matchTeamDecision([decision],valid,'a')?.id,'d');
 assert.equal(matchTeamDecision([{...decision,proposalRevision:4}],valid,'a'),null);
 assert.equal(matchTeamDecision([decision],valid,'foreign'),null);
 assert.equal(matchTeamDecision([{...decision,event:'propose'}],valid,'a'),null);
});

test('team decision identities invalidate an old combination review when the adopted revision changes',()=>{
 const {combinationIdentity,canApplyCombination}=fixture().load('utils/portfolio-workspace.ts');
 const refs=[{decisionId:'d',proposalId:'p',proposalRevision:3}];
 const changed=[{...refs[0],proposalRevision:4}];
 const identity=combinationIdentity('a',1,[],refs);
 assert.notEqual(identity,combinationIdentity('a',1,[],changed));
 const preview={accountId:'a',expectedPolicyRevision:1,canApply:true,expiresAt:'2030-01-01T00:00:00Z',teamDecisionRefs:refs};
 assert.equal(canApplyCombination('a',1,[],preview,identity,Date.now(),refs),true);
 assert.equal(canApplyCombination('a',1,[],preview,identity,Date.now(),changed),false);
 assert.equal(canApplyCombination('a',1,[],{...preview,teamDecisionRefs:[]},identity,Date.now(),refs),false);
});

const {JSDOM}=require('jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','Element','Node','Event'])Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react');
const {createRoot}=require('react-dom/client');
const {MemoryRouter}=require('react-router-dom');
const {QueryClient,QueryClientProvider}=require('@tanstack/react-query');
const flush=()=>React.act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
async function waitFor(predicate){const end=Date.now()+2000;while(!predicate()&&Date.now()<end)await flush();assert.ok(predicate(),'state did not settle');}

async function adoptionScenario(accountId,run,options={}){
 const f=fixture({realQuery:true}); const writes=[];const ref={decisionId:'d',proposalId:'p',proposalRevision:3};
 const api=f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi;
 f.load('api/teams.ts').teamsApi.decisions=async()=>({items:[{...ref,id:'d',teamId:'t',accountId,event:'adopt'}],nextCursor:null});
 const strategyApi=f.load('api/investment-strategies.ts').investmentStrategiesApi;
 strategyApi.workspace=async()=>({current:null,history:[],drafts:[]});
 api.saveDraft=async(id,input)=>{writes.push({action:'save',id,input});return{...input,updatedAt:new Date().toISOString()};};
 api.preview=async(id,input)=>{writes.push({action:'preview',id,input});return{...input,accountId:id,canApply:true,expiresAt:new Date(Date.now()+60000).toISOString(),previewHash:'verified',issues:[],allocatedPct:0,cashFloorPct:10};};
 api.apply=async(id,input)=>{writes.push({action:'apply',id,input});return{};};
 const account={id:'a',status:'paused',combination:{policyRevision:1,allocations:[],draft:options.refs?{allocations:[],teamDecisionRefs:options.refs,expectedPolicyRevision:1}:null}};
 const {useAccountStrategyCombination}=f.load('features/investment-strategies/use-account-strategy-combination.ts');
 function Harness(){const editor=useAccountStrategyCombination(account);return React.createElement('section',null,
   React.createElement('output',null,JSON.stringify(editor.teamDecisionRefs)),
   ...['save','preview','apply'].map(action=>React.createElement('button',{key:action,disabled:editor.locked||(action==='apply'&&!editor.canApply),onClick:()=>editor.mutation.mutate(action)},action)));}
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{retry:false,gcTime:Infinity}}});
 const root=createRoot(document.getElementById('root'));
 try{
  await React.act(async()=>root.render(React.createElement(QueryClientProvider,{client},React.createElement(MemoryRouter,{initialEntries:[options.entry??'/paper/a/strategies?teamId=t&teamDecisionId=d&proposalId=p&proposalRevision=3']},React.createElement(Harness)))));
  await flush();await run({writes,ref,button:action=>[...document.querySelectorAll('button')].find(button=>button.textContent===action)});
 }finally{await React.act(async()=>root.unmount());client.clear();}
}

test('explicit save, preview and apply retain the same adopted decision revision in every request',()=>adoptionScenario('a',async({writes,ref,button})=>{
 await waitFor(()=>!button('save').disabled);
 assert.equal(writes.length,0,'opening an adopted source never applies or saves it');
 for(const action of ['save','preview','apply']){
  if(action==='apply')await waitFor(()=>!button('apply').disabled);
  await React.act(async()=>button(action).click()); await flush();
 }
 assert.deepEqual(writes.map(write=>write.action),['save','preview','apply']);
 for(const write of writes)assert.deepEqual(JSON.parse(JSON.stringify(write.input.teamDecisionRefs)),[ref]);
}));

test('a team decision from another account remains read only and cannot authorize combination writes',()=>adoptionScenario('other',async({writes,button})=>{
 await flush();
 assert.equal(button('save').disabled,true);
 assert.equal(button('preview').disabled,true);
 assert.equal(button('apply').disabled,true);
 assert.equal(writes.length,0);
}));

test('the combination review displays exact adopted proposal and decision identities without calling it applied',()=>{
 const f=fixture(); const {TeamDecisionSourcePanel}=f.load('features/investment-strategies/TeamDecisionSourcePanel.tsx');
 const ref={decisionId:'decision-exact',proposalId:'proposal-exact',proposalRevision:3};
 const html=f.render(TeamDecisionSourcePanel,{editor:{zh:false,teamDecisionRefs:[ref],decisionContext:{teamId:'team-exact',ref,invalid:false},teamSourceBlocked:false,decisionSource:{isPending:false,isError:false,data:{id:'decision-exact',teamId:'team-exact',accountId:'a',proposalId:'proposal-exact',proposalRevision:3,event:'adopt',reason:'Read the documented limits',basis:{teamVersionId:'version-exact',reportVersionId:'report-exact',commissionId:'commission-exact'}}}}});
 assert.match(html,/proposal-exact/); assert.match(html,/decision-exact/);assert.match(html,/version-exact/);assert.match(html,/report-exact/);
 assert.match(html,/still require an explicit review and apply/);
});


test('reopening a saved combination draft retains its pinned team sources without reconstructing them from the URL',()=>adoptionScenario('a',async({writes,ref,button})=>{
 await waitFor(()=>!button('save').disabled);
 await React.act(async()=>button('save').click());await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(writes[0].input.teamDecisionRefs)),[ref]);
},{entry:'/paper/a/strategies',refs:[{decisionId:'d',proposalId:'p',proposalRevision:3}]}));

test('a new explicit adoption replaces only that proposal in the candidate, preserving unrelated frozen sources',()=>{
 const {withRequestedTeamDecision}=context();
 const old=[{proposalId:'p',proposalRevision:3,decisionId:'old-d'},{proposalId:'other',proposalRevision:1,decisionId:'other-d'}];
 const next=withRequestedTeamDecision(old,{proposalId:'p',proposalRevision:4,decisionId:'new-d'});
 assert.equal(next.length,2);assert.equal(next.find(ref=>ref.proposalId==='p').decisionId,'new-d');
 assert.equal(next.find(ref=>ref.proposalId==='other').decisionId,'other-d');
 assert.equal(old[0].decisionId,'old-d','the applied snapshot is immutable');
});
