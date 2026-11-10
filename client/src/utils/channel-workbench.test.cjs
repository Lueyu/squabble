const assert=require('node:assert/strict');
const {test}=require('node:test');
const fixture=require('./simple-test-loader.cjs');
const {load,render}=fixture();
const empty={runtime:{accountId:'paper',accountKind:'paper',revision:2,monitoringStatus:'observing',monitoringReason:null,confirmedAt:'2026-11-06T03:00:00Z',current:{strategyId:null,strategyRevision:null,rules:[],positions:[],cash:[],valuationAsOf:null},proposals:[],executions:[]},vibe:'deskmate',pinned:null,pendingCount:0,episodes:[],visibleTaps:[],progress:{runningCount:2,gapCount:1},report:null,deferredQuestions:[],sourcesAvailable:false};
test('an observing simulation never presents a draft as the active strategy',()=>{
 const view=structuredClone(empty);view.runtime.proposals=[{id:'draft',revision:1,status:'proposed',before:'Current rule',after:'NEW_DRAFT_NOT_ACTIVE',reasonCardId:'card'}];
 const html=render(load('pages/Channel/ChannelWorkbench.tsx').ChannelWorkbenchView,{view,language:'zh-CN'});
 assert.match(html,/尚未应用策略 · 模拟盘仅观察/);
 assert.match(html,/尚未应用到模拟盘/);
 assert.match(html,/2 项进行中/);assert.match(html,/1 项资料缺口/);
});
test('worst legal state distinguishes current strategy applying proposal and partial fill',()=>{
 const view=structuredClone(empty);view.runtime.current.strategyId='S7';view.runtime.current.strategyRevision=7;view.runtime.monitoringStatus='running';
 view.runtime.current.rules=[{id:'rule7',label:'CURRENT_RULE',status:'active',value:'271',effective:true,effectiveReason:null}];
 view.runtime.proposals=[{id:'P8',revision:8,status:'applying',before:'271',after:'274',reasonCardId:'card'}];
 view.runtime.executions=[{id:'O7',symbol:'TEST',strategyId:'S7',strategyRevision:7,status:'partially_filled',requestedQuantity:'100',filledQuantity:'40',remainingQuantity:'60',updatedAt:empty.runtime.confirmedAt}];
 const html=render(load('pages/Channel/ChannelWorkbench.tsx').ChannelWorkbenchView,{view,language:'en'});
 assert.match(html,/CURRENT_RULE/);assert.match(html,/Applying/);assert.match(html,/40/);assert.match(html,/60/);
 assert.doesNotMatch(html,/Applied|Trade completed/);
});
const {worstLegalFixture,noStrategyFixture}=load('pages/Channel/channel-comprehension.fixture.ts');
test('one pinned decision is rendered once while remaining decisions stay accessible',()=>{
 const view=worstLegalFixture();view.episodes.push({episode:{id:view.pinned.episodeId,phase:'alarm'},bubbles:[view.pinned]});
 const html=render(load('pages/Channel/ChannelWorkbench.tsx').ChannelWorkbenchView,{view,language:'en'});
 assert.equal((html.match(/data-channel-bubble="decision"/g)||[]).length,1);
 assert.match(html,/Other pending items/);
});
test('mood stays a light passing remark without action buttons even if untrusted props contain actions',()=>{
 const bubble=worstLegalFixture().visibleTaps[0];bubble.stance='mood';bubble.anchors.relationshipMemoryIds=[];
 bubble.action=[{id:'bad',kind:'apply_proposal',label:'UNSAFE_ACTION',targetId:'draft',expectedRevision:1}];
 const html=render(load('pages/Channel/ChannelWorkbench.tsx').ChannelBubbleCard,{bubble,language:'en'});
 assert.match(html,/data-weight="tap"/);assert.match(html,/A checked process update/);assert.doesNotMatch(html,/UNSAFE_ACTION/);
});
test('evidence stays collapsed and a source URI cannot become a script link',()=>{
 const bubble=worstLegalFixture().episodes[0].bubbles[0];bubble.evidence.sources[0].uri='javascript:alert(1)';
 const html=render(load('pages/Channel/ChannelWorkbench.tsx').ChannelBubbleCard,{bubble,language:'en'});
 assert.match(html,/aria-expanded="false"/);assert.doesNotMatch(html,/javascript:|Fictional filing/);
 const card=render(load('pages/Channel/ChannelWorkbench.tsx').EvidenceCard,{card:bubble.evidence,language:'en'});
 assert.match(card,/Fictional filing/);assert.doesNotMatch(card,/javascript:/);
});
test('expired actions are disabled while retained evidence remains readable',()=>{
 const bubble=worstLegalFixture().pinned;bubble.action[0].expiresAt='2020-01-01T00:00:00Z';
 const html=render(load('pages/Channel/ChannelWorkbench.tsx').ChannelBubbleCard,{bubble,language:'en'});
 assert.match(html,/disabled=""/);assert.match(html,/Expired/);assert.match(html,/Evidence/);
});
test('vibe and aggregate progress are available in both languages without agent progress spam',()=>{
 for(const language of ['en','zh-CN']){
  const html=render(load('pages/Channel/ChannelWorkbench.tsx').ChannelWorkbenchView,{view:worstLegalFixture(),language});
  assert.equal((html.match(/<option/g)||[]).length,3);assert.match(html,language==='en'?/Research log/:/研究留痕/);
  assert.doesNotMatch(html,/unreported|raw_model|chain.of.thought/i);
 }
});
test('deferred question text appears only in the explicit scope list with a selection action',()=>{
 const view=noStrategyFixture();view.deferredQuestions=worstLegalFixture().deferredQuestions;
 const html=render(load('pages/Channel/ChannelWorkbench.tsx').DeferredQuestions,{questions:view.deferredQuestions,language:'en',pending:false});
 assert.match(html,/Which reporting period/);assert.match(html,/Check this one/);
});
test('public research tools stay in expandable retained logs with actual duration',()=>{
 const html=render(load('pages/Channel/ChannelWorkbench.tsx').ChannelResearchLog,{items:[{id:'public-tool',kind:'research.tool',toolName:'filing_lookup',summary:'Read the stated filing section.',createdAt:empty.runtime.confirmedAt,status:'succeeded',durationMs:1250}],language:'en'});
 assert.match(html,/<details>/);assert.match(html,/filing_lookup/);assert.match(html,/1250 ms/);assert.match(html,/Read the stated filing section/);
 assert.doesNotMatch(html,/<details[^>]+open/);
});
test('personal notes only offer the real user words and never prefill an adoption motive',()=>{
 const local=fixture();local.state.queries.set('channel-memory',{data:{items:[],decisions:[{id:'decision-owned',label:'A recorded choice',createdAt:empty.runtime.confirmedAt}],reflections:[]}});
 const html=local.render(local.load('pages/Channel/ChannelPersonalNotes.tsx').default,{language:'en',userMessages:[{id:'real-user',text:'I prefer primary filings over summaries.',createdAt:empty.runtime.confirmedAt}]});
 assert.match(html,/I prefer primary filings over summaries/);assert.match(html,/Remember as my preference/);
 assert.match(html,/value="decision-owned"/);assert.match(html,/Leave blank to keep the reason unrecorded/);
 assert.doesNotMatch(html,/bias|fear|greed/i);assert.match(html,/<textarea[^>]*><\/textarea>/);
});
test('preference API references actual message identity and reflection sends user input only',async()=>{
 const local=fixture(),api=local.load('api/channel.ts');
 await api.saveChannelPreference({sourceMessageId:'real-user',requestKey:'preference-one'});
 await api.saveChannelReflection({decisionId:'owned-decision',kind:'later_reflection',text:'My words at this later time.',requestKey:'reflection-one'});
 assert.equal(local.state.requests[0].args[0],'/api/channel/memory');
 assert.equal(local.state.requests[0].args[1].sourceMessageId,'real-user');
 assert.equal(local.state.requests[0].args[1].text,undefined);
 assert.equal(local.state.requests[1].args[1].text,'My words at this later time.');
 assert.equal(local.state.requests[1].args[1].author,undefined);
});
test('a confirmed strategy does not imply running when monitoring is paused or expired',()=>{
 const Board=load('pages/Channel/ChannelWorkbench.tsx').RuntimeBoard;
 const paused=worstLegalFixture().runtime;paused.monitoringStatus='paused';paused.current.rules[0].effective=false;paused.current.rules[0].effectiveReason='paused';
 const pausedHtml=render(Board,{snapshot:paused,language:'zh-CN'});
 const pausedMain=pausedHtml.match(/data-runtime-cell="current"[\s\S]*?<\/button>/)[0];
 assert.match(pausedMain,/已暂停（含保护性退出）/);assert.doesNotMatch(pausedMain,/Current protection line|271/);
 const stopped=structuredClone(paused);stopped.monitoringStatus='stopped';stopped.current.rules[0].effectiveReason='expired';
 const stoppedMain=render(Board,{snapshot:stopped,language:'zh-CN'}).match(/data-runtime-cell="current"[\s\S]*?<\/button>/)[0];
 assert.match(stoppedMain,/条目已到期 · 策略已停止/);assert.doesNotMatch(stoppedMain,/规则已生效/);
});
test('running board selects an effective entry and preserves the null-strategy observing label',()=>{
 const Board=load('pages/Channel/ChannelWorkbench.tsx').RuntimeBoard;
 const snapshot=worstLegalFixture().runtime;snapshot.current.rules[0].effective=false;snapshot.current.rules[0].effectiveReason='expired';
 snapshot.current.rules.push({id:'effective-rule',label:'VALID_ENTRY',status:'active',value:'8%',effective:true,effectiveReason:null});
 const current=render(Board,{snapshot,language:'en'}).match(/data-runtime-cell="current"[\s\S]*?<\/button>/)[0];
 assert.match(current,/VALID_ENTRY/);assert.doesNotMatch(current,/Current protection line/);
 snapshot.current.strategyId=null;snapshot.monitoringStatus='paused';
 assert.match(render(Board,{snapshot,language:'zh-CN'}),/尚未应用策略 · 模拟盘仅观察/);
});
test('an applied observation plan clearly says it will not trade',()=>{
 const Board=load('pages/Channel/ChannelWorkbench.tsx').RuntimeBoard;
 const snapshot=worstLegalFixture().runtime;snapshot.monitoringStatus='observing';snapshot.monitoringReason='OBSERVATION_ONLY';
 snapshot.current.rules[0].effective=false;snapshot.current.rules[0].effectiveReason='observation_only';
 for(const language of ['zh-CN','en']){
  const current=render(Board,{snapshot,language}).match(/data-runtime-cell="current"[\s\S]*?<\/button>/)[0];
  assert.match(current,language==='en'?/Observation only · No automatic trades/:/仅观察 · 不自动买卖/);
  assert.doesNotMatch(current,/Current protection line|规则已生效/);
 }
});
test('a combination with several confirmed snapshots remains an applied strategy in the channel',()=>{
 const Board=load('pages/Channel/ChannelWorkbench.tsx').RuntimeBoard;
 const snapshot=worstLegalFixture().runtime;
 snapshot.current.strategyId=null;
 snapshot.current.strategies=[{id:'one',revision:2,title:'One',allocationPct:60},{id:'two',revision:3,title:'Two',allocationPct:40}];
 snapshot.current.rules[0].effective=true;
 snapshot.monitoringStatus='running';
 const current=render(Board,{snapshot,language:'en'}).match(/data-runtime-cell="current"[\s\S]*?<\/button>/)[0];
 assert.match(current,/Current protection line/);
 assert.doesNotMatch(current,/No strategy applied/);
});
test('channel runtime asks for account selection instead of claiming no strategy is applied',()=>{
 const snapshot=structuredClone(empty.runtime);
 snapshot.accountId=null;snapshot.selectionRequired=true;snapshot.monitoringReason='ACCOUNT_SELECTION_REQUIRED';
 const html=render(load('pages/Channel/ChannelWorkbench.tsx').RuntimeBoard,{snapshot,language:'en'});
 assert.match(html,/Choose a simulation account/);
 assert.doesNotMatch(html,/No strategy applied/);
});
test('channel API passes explicit account identity in the read request',async()=>{
 const local=fixture();
 await local.load('api/channel.ts').fetchChannel('account-a');
 assert.equal(local.state.requests[0].args[1]?.params?.accountId,'account-a');
});
test('historical bubbles label superseded or corrected sources without removing the original finding',()=>{
 const Card=load('pages/Channel/ChannelWorkbench.tsx').ChannelBubbleCard;
 const bubble=worstLegalFixture().episodes[0].bubbles[0];bubble.evidence.gaps=['UNRESOLVED_GAP'];
 for(const language of ['zh-CN','en']){
  bubble.sourceState='superseded';const superseded=render(Card,{bubble,language});
  assert.match(superseded,language==='en'?/Basis superseded by a newer report/:/依据已由新报告替代/);
  assert.match(superseded,/A verified distinction remains visible/);
  assert.doesNotMatch(superseded,/gap resolved|缺口已解决/);
  bubble.sourceState='corrected';const corrected=render(Card,{bubble,language});
  assert.match(corrected,language==='en'?/Source corrected/:/来源已更正/);
  assert.match(corrected,/A verified distinction remains visible/);
  bubble.sourceState='current';const current=render(Card,{bubble,language});
  assert.doesNotMatch(current,/channel-source-state/);
 }
 assert.equal(bubble.evidence.gaps[0],'UNRESOLVED_GAP');
});
