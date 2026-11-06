const {test}=require('node:test');
const assert=require('node:assert/strict');
const fixture=require('./simple-test-loader.cjs');
const React=require('react');
const {createRoot}=require('react-dom/client');
const {MemoryRouter}=require('react-router-dom');
const {JSDOM}=require('jsdom');
function editorFixture(){
 const f=fixture();
 // The portal shell is unrelated to editor behavior; preserve its children for server rendering.
 const dialog=f.load('components/ui/dialog.tsx');
 for(const key of ['Dialog','DialogContent','DialogDescription','DialogHeader','DialogTitle'])dialog[key]=({children})=>React.createElement('div',null,children);
 return f;
}

const content={title:'Frozen strategy',body:'Keep cash',timezone:'Asia/Shanghai',startsAt:'2026-11-05T00:00:00.000Z',endsAt:'2026-11-13T15:59:59.999Z',entries:[{id:'one',text:'Watch FICT',sourceKeys:['report:fixed-report'],timezone:'America/New_York',endsAt:'2026-11-06T02:30:00.000Z'}]};
const confirmed={id:'confirmed',revision:2,parentId:null,status:'confirmed',content,sources:[{key:'report:fixed-report',kind:'report',versionId:'fixed-report',title:'Pinned report',createdAt:'2026-11-05T00:00:00Z'}],confirmedAt:'2026-11-05T00:00:00Z',preview:{canConfirm:true,entries:[{id:'one',explanation:{en:'Frozen execution authority','zh-CN':'已确认执行方式'},startsAt:content.startsAt,endsAt:content.entries[0].endsAt,timezone:'America/New_York'}],issues:[]}};

test('confirmed strategy shows immutable authority and an explicit copy action',()=>{
 const f=editorFixture();const Editor=f.load('pages/Today/InvestmentStrategyEditor.tsx').default;
 const html=f.render(Editor,{item:confirmed,currentId:confirmed.id,timezone:'Asia/Shanghai',onChanged(){},onClose(){}});
 assert.match(html,/Confirmed execution details/);
 assert.match(html,/Copy as draft/);
 assert.match(html,/Frozen execution authority/);
 assert.doesNotMatch(html,/Your text changed/);
});

test('entry date and effective-period help use its own timezone',()=>{
 const f=editorFixture();const Editor=f.load('pages/Today/InvestmentStrategyEditor.tsx').default;
 const html=f.render(Editor,{item:confirmed,currentId:confirmed.id,timezone:'Asia/Shanghai',onChanged(){},onClose(){}});
 assert.match(html,/value="2026-11-05"/);
 assert.match(html,/America\/New_York/);
 assert.match(html,/Effective period/);
});

test('editor exposes the exact pinned report instead of only a source count',()=>{
 const f=editorFixture();const Editor=f.load('pages/Today/InvestmentStrategyEditor.tsx').default;
 const html=f.render(Editor,{item:confirmed,currentId:confirmed.id,timezone:'Asia/Shanghai',onChanged(){},onClose(){}});
 assert.match(html,/href="\/analysis\/reports\/fixed-report"/);
 assert.match(html,/Pinned report/);
});

test('copying confirmed strategy creates a child draft and retains frozen authority',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 const previous={window:global.window,document:global.document,act:global.IS_REACT_ACT_ENVIRONMENT};
 global.window=dom.window;global.document=dom.window.document;global.IS_REACT_ACT_ENVIRONMENT=true;
 const root=createRoot(document.getElementById('root'));
 try{
  const f=editorFixture(),Editor=f.load('pages/Today/InvestmentStrategyEditor.tsx').default;
  f.state.responses=new Map([['/api/investment-strategies',{...structuredClone(confirmed),id:'new-draft',parentId:confirmed.id,status:'draft',revision:1,preview:null}]]);
  await React.act(async()=>root.render(React.createElement(MemoryRouter,null,React.createElement(Editor,{item:confirmed,currentId:confirmed.id,timezone:'Asia/Shanghai',onChanged(){},onClose(){}}))));
  const copy=[...document.querySelectorAll('button')].find(button=>button.textContent==='Copy as draft');assert.ok(copy);
  await React.act(async()=>copy.click());
  assert.equal(f.state.requests.length,1);
  assert.equal(f.state.requests[0].method,'post');
  assert.equal(f.state.requests[0].args[1].parentId,'confirmed');
  assert.equal(f.state.requests[0].args[1].content.entries[0].text,'Watch FICT');
  assert.match(document.body.textContent,/Frozen execution authority/);
  assert.equal(document.querySelectorAll('section[aria-label="Execution details"]').length,0);
  assert.match(document.body.textContent,/Draft saved/);
 }finally{
  await React.act(async()=>root.unmount());dom.window.close();global.window=previous.window;global.document=previous.document;global.IS_REACT_ACT_ENVIRONMENT=previous.act;
 }
});

async function limitsDraftFixture(investment,run){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 const previous={window:global.window,document:global.document,act:global.IS_REACT_ACT_ENVIRONMENT};
 global.window=dom.window;global.document=dom.window.document;global.IS_REACT_ACT_ENVIRONMENT=true;
 const root=createRoot(document.getElementById('root'));
 try{
  const f=editorFixture(),Editor=f.load('pages/Today/InvestmentStrategyEditor.tsx').default;
  const draft={...structuredClone(confirmed),id:'report-draft',status:'draft',revision:1,preview:null,confirmedAt:null};
  f.state.responses=new Map([['/api/investment-strategies/report-draft',{...draft,revision:2}]]);
  await React.act(async()=>root.render(React.createElement(MemoryRouter,null,React.createElement(Editor,{item:draft,currentId:null,timezone:'Asia/Shanghai',investment,onChanged(){},onClose(){}}))));
  await run(f);
 }finally{
  await React.act(async()=>root.unmount());dom.window.close();global.window=previous.window;global.document=previous.document;global.IS_REACT_ACT_ENVIRONMENT=previous.act;
 }
}

test('report draft explicitly adopts and saves the simulation limits without automatically applying',async()=>{
 const limits={maxPositionPct:15,maxOrderPct:4,maxDailyIncreasePct:6,maxDailyTurnoverPct:25,minCashPct:20,maxGrossExposurePct:80,dailyLossLimitPct:3};
 await limitsDraftFixture({account:{id:'paper'},limits},async f=>{
  assert.equal(document.querySelectorAll('input[type="number"]').length,0,'opening a saved draft does not add silent authority');
  const adopt=[...document.querySelectorAll('button')].find(button=>button.textContent==='Use current simulation limits');assert.ok(adopt);
  await React.act(async()=>adopt.click());
  assert.equal(document.querySelectorAll('input[type="number"]').length,6);
  const save=[...document.querySelectorAll('button')].find(button=>button.textContent==='Save draft only');
  await React.act(async()=>save.click());
  assert.equal(f.state.requests.length,1);assert.equal(f.state.requests[0].method,'patch');
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.requests[0].args[1].content.limits)),{maxPositionPct:15,maxDailyIncreasePct:6,maxDailyTurnoverPct:25,minCashPct:20,maxGrossExposurePct:80,maxOrderPct:4});
  assert.doesNotMatch(f.state.requests[0].args[0],/apply|prepare/);
 });
});

test('report draft can explicitly set editable limits before creating a simulation',async()=>{
 await limitsDraftFixture(undefined,async f=>{
  const set=[...document.querySelectorAll('button')].find(button=>button.textContent==='Set and review limits');assert.ok(set);
  await React.act(async()=>set.click());
  const fields=[...document.querySelectorAll('input[type="number"]')];assert.equal(fields.length,6);assert.ok(fields.every(input=>!input.disabled));
  assert.match(document.body.textContent,/Review these draft limits/);
  const save=[...document.querySelectorAll('button')].find(button=>button.textContent==='Save draft only');
  await React.act(async()=>save.click());
  const limits=f.state.requests[0].args[1].content.limits;
  assert.equal(limits.minCashPct,10);assert.equal(limits.maxGrossExposurePct,90);
  assert.equal(f.state.requests.length,1);assert.equal(f.state.requests[0].method,'patch');
  assert.doesNotMatch(f.state.requests[0].args[0],/apply|prepare/);
 });
});

test('a new draft has an actionable review step and applies only after its prepared explanation is confirmed',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 const previous={window:global.window,document:global.document,act:global.IS_REACT_ACT_ENVIRONMENT};
 global.window=dom.window;global.document=dom.window.document;global.IS_REACT_ACT_ENVIRONMENT=true;
 const root=createRoot(document.getElementById('root'));
 try{
  const f=editorFixture(),Editor=f.load('pages/Today/InvestmentStrategyEditor.tsx').default;
  const draft={...structuredClone(confirmed),id:'ready-draft',status:'draft',revision:1,preview:null,confirmedAt:null};
  const prepared={...draft,revision:2,preview:{...structuredClone(confirmed.preview),revision:2,contentHash:'reviewed-hash'}};
  f.state.responses=new Map([['/api/investment-strategies/ready-draft/prepare',prepared]]);
  let closed=0;
  await React.act(async()=>root.render(React.createElement(MemoryRouter,null,React.createElement(Editor,{item:draft,currentId:null,timezone:'Asia/Shanghai',investment:{account:{id:'paper'}},onChanged(){},onClose(){closed++;}}))));
  const button=text=>[...document.querySelectorAll('button')].find(item=>item.textContent===text);
  const review=button('Review execution details');assert.ok(review,'unprepared drafts expose the next step instead of a disabled apply button');assert.equal(review.disabled,false);
  await React.act(async()=>review.click());
  assert.equal(f.state.requests.length,1);assert.equal(f.state.requests[0].args[0],'/api/investment-strategies/ready-draft/prepare');
  assert.equal(closed,0);assert.match(document.body.textContent,/Frozen execution authority/);
  const apply=button('Review and apply to simulation');assert.ok(apply);assert.equal(apply.disabled,false);
  await React.act(async()=>apply.click());
  assert.equal(f.state.requests.length,2);assert.equal(f.state.requests[1].args[0],'/api/ai-investment/apply-strategy');
  assert.equal(f.state.requests[1].args[1].expectedRevision,2);assert.equal(f.state.requests[1].args[1].previewHash,'reviewed-hash');assert.equal(closed,1);
 }finally{
  await React.act(async()=>root.unmount());dom.window.close();global.window=previous.window;global.document=previous.document;global.IS_REACT_ACT_ENVIRONMENT=previous.act;
 }
});
