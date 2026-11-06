const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');
const view = summary => ({topicKey:'portfolio',dateKey:'2026-11-06',documentId:summary,title:summary,content:summary,summary,state:'ready',researchLevel:'ai',taskId:null,error:null,source:null,keyPoints:[]});
const base={date:'2026-11-06',timezone:'Asia/Shanghai',asOf:'2026-11-06T04:00:00Z',overview:{totalValueUsd:null,cashUsd:null,dailyPnlUsd:null,returnPct:null,holdingCount:1},
  holdings:[],analysis:view('Current analysis'),initialAnalysis:view('Original frozen analysis'),discussionAnalysis:view('Latest discussion finding'),
  summary:null,attention:[],gaps:[],aiAvailable:false,marketTimes:[],assetMetrics:{totalValueUsd:null,knownValueUsd:1300,holdingsValueUsd:1300,cashUsd:null,knownCashUsd:0,dailyPnlUsd:null,knownDailyPnlUsd:null,returnPct:null,partial:true,estimated:true,gaps:['CASH_UNCONFIRMED'],marketTimes:[],refreshing:false}};

test('Today shows known assets while cash awaits confirmation, with a concrete confirmation action',()=>{
  const f=fixture();f.state.queries.set('today',{data:base});
  const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
  assert.match(html,/1,300\.00/);
  assert.match(html,/Known assets/);
  assert.match(html,/Confirm cash/);
  assert.doesNotMatch(html,/CASH_UNCONFIRMED/);
});

test('Today keeps initial and discussion summaries visible together and exposes report history',()=>{
  const f=fixture();f.state.queries.set('today',{data:base});
  const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
  assert.match(html,/Original frozen analysis/);
  assert.match(html,/Latest discussion finding/);
  assert.match(html,/Report history/);
});

test('cash-only portfolio remains an asset account after a full sale',()=>{
  const f=fixture();f.state.queries.set('today',{data:{...base,overview:{...base.overview,holdingCount:0,totalValueUsd:1500,cashUsd:1500},assetMetrics:{...base.assetMetrics,totalValueUsd:1500,knownValueUsd:1500,cashUsd:1500,partial:false}}});
  const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
  assert.match(html,/1,500\.00/);
  assert.doesNotMatch(html,/Bring in your holdings/);
});

test('empty workspace retains cash confirmation and report-derived strategy access',()=>{
  const f=fixture();f.state.queries.set('today',{data:{...base,overview:{...base.overview,holdingCount:0},assetMetrics:{...base.assetMetrics,knownValueUsd:0,holdingsValueUsd:0}}});
  f.state.queries.set('investment-strategies',{data:{current:null,drafts:[{id:'report-draft',sources:[{key:'report:fixed'}],updatedAt:'2026-11-06T04:00:00Z',content:{title:'Draft from a research report'}}],history:[]}});
  const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
  assert.match(html,/Bring in your holdings/,'the onboarding guide stays visible');
  assert.match(html,/Confirm cash/,'cash can be reconciled before holdings exist');
  assert.match(html,/Your investment strategy/);
  assert.match(html,/Write a strategy/);
  assert.match(html,/Draft from a research report/);
  assert.match(html,/Continue editing/,'a draft saved from a report remains editable on Today');
});

test('Today exposes one strategy workspace with manual and discussion entries',()=>{
  const f=fixture();f.state.queries.set('today',{data:base});
  f.state.queries.set('investment-strategies',{data:{current:null,drafts:[],history:[]}});
  const html=f.render(f.load('pages/Today/TodayPage.tsx').default);
  assert.ok(html.includes('Your investment strategy'),'one strategy workspace must be directly reachable from Today');
  assert.ok(html.includes('Write a strategy'));
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
