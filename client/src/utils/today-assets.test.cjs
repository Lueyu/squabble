const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');
const view = (summary,updatedAt='2026-11-06T01:00:00Z') => ({topicKey:'portfolio',dateKey:'2026-11-06',documentId:summary,title:summary,content:summary,summary,updatedAt,state:'ready',researchLevel:'ai',taskId:null,error:null,source:null,keyPoints:[]});
const base={date:'2026-11-06',timezone:'Asia/Shanghai',asOf:'2026-11-06T04:00:00Z',overview:{totalValueUsd:null,cashUsd:null,dailyPnlUsd:null,returnPct:null,holdingCount:1},
  holdings:[],analysis:view('Current analysis','2026-11-06T02:00:00Z'),initialAnalysis:view('Original frozen analysis'),discussionAnalysis:view('Latest discussion finding','2026-11-06T03:00:00Z'),
  summary:null,attention:[],gaps:[],aiAvailable:false,marketTimes:[],assetMetrics:{totalValueUsd:null,knownValueUsd:1300,holdingsValueUsd:1300,cashUsd:null,knownCashUsd:0,dailyPnlUsd:null,knownDailyPnlUsd:null,returnPct:null,partial:true,estimated:true,gaps:['CASH_UNCONFIRMED'],marketTimes:[],refreshing:false}};

test('Today shows known assets while cash awaits confirmation, with a concrete confirmation action',()=>{
  const f=fixture();f.state.queries.set('today',{data:base});
  const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
  assert.match(html,/1,300\.00/);
  assert.match(html,/Known assets/);
  assert.match(html,/Confirm cash/);
  assert.doesNotMatch(html,/CASH_UNCONFIRMED/);
});

test('Today shows only the latest complete report with one entry to all history in both languages',()=>{
  for(const language of ['en','zh-CN']){
    const f=fixture();f.state.language=language;f.state.queries.set('today',{data:base});
    const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
    assert.match(html,/Latest discussion finding/);
    assert.doesNotMatch(html,/Original frozen analysis|Current analysis/);
    assert.match(html,language==='en'?/Latest portfolio report/:/最新持仓报告/u);
    assert.equal((html.match(/class="research-analysis /g)||[]).length,1);
    assert.equal((html.match(/href="\/analysis#report-history"/g)||[]).length,1);
    assert.match(html,/referenceVersionId=Latest\+discussion\+finding/);
  }
});

test('a newer standalone report replaces an older discussion without altering saved history',()=>{
  const f=fixture(),history=[base.initialAnalysis,base.discussionAnalysis];
  const data={...base,analysis:view('Newest published analysis','2026-11-06T04:00:00Z'),reportHistory:history};
  f.state.queries.set('today',{data});
  const before=JSON.stringify(data);
  const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
  assert.match(html,/Newest published analysis/);
  assert.doesNotMatch(html,/Original frozen analysis|Latest discussion finding/);
  assert.match(html,/referenceVersionId=Newest\+published\+analysis/);
  assert.equal(JSON.stringify(data),before,'reading the latest report preserves every historical report');
});

test('a new analysis in progress keeps the latest published discussion and its live controls',()=>{
  const f=fixture();f.state.queries.set('today',{data:{...base,analysis:{...base.analysis,state:'generating',progress:{message:'Checking the next result'},taskId:'new-task'},aiAvailable:true}});
  const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
  assert.match(html,/Latest discussion finding/);
  assert.doesNotMatch(html,/Original frozen analysis|Current analysis/);
  assert.match(html,/Checking the next result/);
  assert.match(html,/Stop analysis/);
});

test('unreadable or facts-only results never displace the last complete report',()=>{
  for(const unavailable of [{readingState:'pending',state:'failed'},{researchLevel:'facts_only',state:'empty'},{content:'',summary:null}]){
    const f=fixture();f.state.queries.set('today',{data:{...base,analysis:{...view('Unavailable new report','2026-11-06T05:00:00Z'),...unavailable}}});
    const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
    assert.match(html,/Latest discussion finding/);
    assert.doesNotMatch(html,/Unavailable new report|Original frozen analysis/);
  }
});

test('pending formatting retains the exact latest complete publication from history',()=>{
  const f=fixture(),published={...view('Latest complete standalone','2026-11-06T04:00:00Z'),readingState:'ready',reportRole:'initial'};
  const partial={...view('Newer incomplete council result','2026-11-06T05:00:00Z'),readingState:'ready',reportRole:'discussion'};
  f.state.queries.set('today',{data:{...base,
    analysis:{...published,state:'failed',readingState:'pending',taskId:'newer-formatting-task'},
    reportHistory:[base.initialAnalysis,base.discussionAnalysis,published,partial]}});
  const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
  assert.ok(html.includes('Latest complete standalone'),'formatting a newer result must not replace the retained complete publication with an older report');
  assert.ok(!html.includes('Latest discussion finding'),'the older discussion stays in history');
  assert.ok(!html.includes('Newer incomplete council result'),'unrelated partial council history remains excluded');
  assert.match(html,/referenceVersionId=Latest\+complete\+standalone/);
  assert.match(html,/Reformat saved result/);
  assert.match(html,/Choose other report content/,'the retained ready publication can still be added to a strategy');
});

test('update failure details belong to the active task rather than the displayed publication',()=>{
  const f=fixture(),Panel=f.load('pages/Today/CurrentAnalysisPanel.tsx').default;
  const html=f.render(Panel,{topicKey:'portfolio',view:{...base.discussionAnalysis,error:'Obsolete publication warning'},
    activityView:{...base.analysis,state:'failed',error:'Current analysis connection interrupted'}});
  assert.ok(html.includes('Current analysis connection interrupted'),'the failure explains the current task');
  assert.ok(!html.includes('Obsolete publication warning'),'saved report metadata cannot supply the active failure detail');
  assert.match(html,/Latest discussion finding/);
  assert.match(html,/Retry analysis/);
});

test('cash-only portfolio remains an asset account after a full sale',()=>{
  const f=fixture();f.state.queries.set('today',{data:{...base,overview:{...base.overview,holdingCount:0,totalValueUsd:1500,cashUsd:1500},assetMetrics:{...base.assetMetrics,totalValueUsd:1500,knownValueUsd:1500,cashUsd:1500,partial:false}}});
  const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
  assert.match(html,/1,500\.00/);
  assert.doesNotMatch(html,/Welcome — pick a way to start/);
});

test('empty workspace retains cash confirmation and report-derived strategy access',()=>{
  const f=fixture();f.state.queries.set('today',{data:{...base,overview:{...base.overview,holdingCount:0},assetMetrics:{...base.assetMetrics,knownValueUsd:0,holdingsValueUsd:0}}});
  f.state.queries.set('investment-strategies',{data:{current:null,drafts:[{id:'report-draft',sources:[{key:'report:fixed'}],updatedAt:'2026-11-06T04:00:00Z',content:{title:'Draft from a research report'}}],history:[]}});
  const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
  assert.match(html,/Welcome — pick a way to start/,'the onboarding guide stays visible');
  assert.match(html,/Try with simulated cash/,'a no-holding user can start instantly with simulated cash');
  assert.match(html,/Confirm cash/,'cash can be reconciled before holdings exist');
  assert.match(html,/href="\/paper"[^>]*>Manage simulation strategy/,'strategy management is reachable in the simulation');
});

test('Today leads to the single strategy workspace in the simulation',()=>{
  const f=fixture();f.state.queries.set('today',{data:base});
  f.state.queries.set('investment-strategies',{data:{current:null,drafts:[],history:[]}});
  const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
  assert.match(html,/href="\/paper#investment-strategy"/,'one strategy workspace must be directly reachable from Today');
  assert.match(html,/Manage simulation strategy/);
  assert.doesNotMatch(html,/id="investment-strategy"/,'Today does not duplicate the editor');
});

test('editing a strategy entry preserves sources and clears stale execution interpretation',()=>{
  const f=fixture(),{editStrategyEntry,strategyEditorContent}=f.load('utils/user-strategy-editor.ts');
  const original={id:'one',text:'Buy 10 ACME at 100',sourceKeys:['report:one'],directive:{ticker:'ACME',side:'buy'}};
  const changed=editStrategyEntry(original,'Watch ACME');
  assert.equal(changed.directive,undefined);assert.deepEqual(Array.from(changed.sourceKeys),['report:one']);
  const saved=strategyEditorContent({title:' My plan ',body:'Keep cash',entries:[],timezone:'Asia/Shanghai',startsAt:'x',endsAt:'y'});
  assert.equal(saved.entries[0].text,'Keep cash');assert.equal(saved.title,'My plan');
});

test('asset provenance distinguishes market observation, retrieval and recorded inverse FX',()=>{
  const f=fixture(),AssetOverview=f.load('pages/Today/AssetOverview.tsx').default;
  const data={...base,assetMetrics:{...base.assetMetrics,provenance:{quotes:[{ticker:'FICT',market:'US',source:'yahoo',quoteAt:'2026-11-05T21:00:00Z',retrievedAt:'2026-11-06T04:00:00Z',tradingDate:'2026-11-05',previousCloseDate:'2026-11-04'}],fx:[{currency:'HKD',usdRate:1/7.8,rateDate:'2026-11-05',source:'recorded',direction:'inverse'},{currency:'CNY',usdRate:null,rateDate:null,source:'missing',direction:null}]}}};
  const html=f.render(AssetOverview,{data});
  assert.match(html,/Quote and FX basis/);
  assert.match(html,/Market observation/);
  assert.match(html,/Retrieved/);
  assert.match(html,/Previous close date: 2026-11-04/);
  assert.match(html,/Recorded rate/);
  assert.match(html,/Inverse conversion/);
  assert.match(html,/Rate unavailable/);
  assert.doesNotMatch(html,/Frankfurter/);
});

test('default change summary renders its readable content instead of protocol JSON',()=>{
  const f=fixture(),Panel=f.load('pages/Today/CurrentAnalysisPanel.tsx').default;
  const html=f.render(Panel,{topicKey:'portfolio',view:{...view('Visible summary'),changeSummary:'```json\n{"summary":"Added readable conclusion"}\n```'}});
  assert.match(html,/Added readable conclusion/);
  assert.doesNotMatch(html,/```json/);
  assert.doesNotMatch(html,/&quot;summary&quot;/);
});
