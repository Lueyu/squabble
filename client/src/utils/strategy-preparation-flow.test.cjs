const {test}=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const {createRoot}=require('react-dom/client');
const {MemoryRouter}=require('react-router-dom');
const {JSDOM}=require('jsdom');
const fixture=require('./simple-test-loader.cjs');
const content={title:'Watchlist',body:'',timezone:'Asia/Shanghai',startsAt:'2026-11-06T00:00:00Z',endsAt:'2026-11-13T15:59:59Z',entries:[{id:'watch',text:'持续监控FICT，寻找加仓机会',sourceKeys:[]}]};
const draft={id:'watch-draft',revision:1,status:'draft',parentId:null,content,sources:[],preview:null,confirmedAt:null};
const ready={...draft,preview:{canConfirm:true,revision:1,contentHash:'watch-only-hash',entries:[{id:'watch',state:'observation',startsAt:content.startsAt,endsAt:content.endsAt,timezone:content.timezone,explanation:{en:'Observation only; no automatic trades.','zh-CN':'仅观察，不自动买卖。'}}],directives:[],mandateRules:[],issues:[]}};
async function scenario(status,run,{item=draft,setup=()=>{}}={}){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),previous={window:global.window,document:global.document,act:global.IS_REACT_ACT_ENVIRONMENT};
 global.window=dom.window;global.document=dom.window.document;global.IS_REACT_ACT_ENVIRONMENT=true;
 const root=createRoot(document.getElementById('root'));
 try{
  const f=fixture(),dialog=f.load('components/ui/dialog.tsx');
  for(const key of ['Dialog','DialogContent','DialogDescription','DialogHeader','DialogTitle'])dialog[key]=({children})=>React.createElement('div',null,children);
  f.state.responses=new Map([['/api/investment-strategies/watch-draft/preparation',status],['/api/investment-strategies/watch-draft',draft],['/api/investment-strategies/watch-draft/preview',ready],['/api/investment-strategies/watch-draft/prepare',ready]]);
  setup(f);
  const Editor=f.load('pages/Today/InvestmentStrategyEditor.tsx').default;
  await React.act(async()=>root.render(React.createElement(MemoryRouter,null,React.createElement(Editor,{item:structuredClone(item),currentId:null,timezone:content.timezone,investment:{account:{id:'paper'}},onChanged(){},onClose(){}}))));
  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
  await run({f,button,dom});
 }finally{await React.act(async()=>root.unmount());dom.window.close();Object.assign(global,{window:previous.window,document:previous.document,IS_REACT_ACT_ENVIRONMENT:previous.act});}
}

test('known failure shows its cause and an explicit retry uses a fresh key without applying',async()=>{
 await scenario({status:'failed',requestKey:'spent-request',error:{code:'LLM_BUDGET_EXCEEDED_INPUT_TOKENS',message:{en:'Input limit exceeded.','zh-CN':'超过输入上限。'}}},async({f,button})=>{
  assert.match(document.body.textContent,/Input limit exceeded/);
  const retry=button('Retry preparation');assert.ok(retry);assert.equal(retry.disabled,false);
  await React.act(async()=>retry.click());
  const calls=f.state.requests.filter(r=>r.method==='post');assert.equal(calls.length,1);assert.match(calls[0].args[0],/\/prepare$/);assert.notEqual(calls[0].args[1].requestKey,'spent-request');
  assert.equal(button('Review and apply to simulation').disabled,false);
 });
});

for(const status of ['pending','succeeded'])test(`a verified ${status} preparation replaces a transport error without another dispatch`,async()=>{
 let dispatches=0;
 await scenario({status:'none'},async({f,button})=>{
  await React.act(async()=>button('Review execution details').click());
  assert.equal(dispatches,1);
  if(status==='pending')assert.match(document.body.textContent,/still being prepared/i);
  else assert.ok(button('Read prepared details'));
  assert.equal(!!document.querySelector('[role="alert"]'),false,'verified preparation state must replace the transport failure alert');
  await React.act(async()=>button('Check preparation status').click());
  assert.equal(dispatches,1,'reading the verified state must never redispatch preparation');
  assert.equal(f.state.requests.filter(request=>request.method==='post').length,0,'only the overridden preparation endpoint was dispatched');
 },{setup:f=>{
  const api=f.load('api/investment-strategies.ts').investmentStrategiesApi;
  api.prepare=async()=>{
   dispatches++;
   f.state.responses.set('/api/investment-strategies/watch-draft/preparation',{status,requestKey:'received-request',...(status==='succeeded'?{result:ready}:{})});
   throw Error('network');
  };
 }});
});

test('pending preparation offers status reads and never redispatches the model',async()=>{
 await scenario({status:'pending',requestKey:'running-request'},async({f,button})=>{
  assert.match(document.body.textContent,/still being prepared/i);
  const read=button('Check preparation status');assert.ok(read);
  await React.act(async()=>read.click());
  assert.equal(f.state.requests.filter(r=>r.method==='post').length,0);
  assert.ok(f.state.requests.filter(r=>r.args[0].endsWith('/preparation')).length>=2);
 });
});

test('reopening a draft with a pending preparation reads its durable status without dispatching',async()=>{
 for(let opening=0;opening<2;opening++){
  await scenario({status:'pending',requestKey:'persisted-request'},async({f,button})=>{
   assert.equal(button('Preparing details…').disabled,true);
   assert.ok(button('Check preparation status'));
   assert.equal(f.state.requests.filter(request=>request.method==='post'||request.method==='patch').length,0);
   assert.equal(f.state.requests.filter(request=>request.args[0].endsWith('/preparation')).length,1);
  });
 }
});

test('reading a succeeded preparation fetches the latest saved draft instead of its older receipt snapshot',async()=>{
 const receipt={...ready,revision:2,content:{...content,title:'Earlier prepared strategy'}};
 const latest={...draft,revision:3,content:{...content,title:'Latest saved strategy'}};
 await scenario({status:'succeeded',requestKey:'completed-request',result:receipt},async({f,button})=>{
  f.state.responses.set('/api/investment-strategies/watch-draft',latest);
  await React.act(async()=>button('Read prepared details').click());
  assert.equal(document.querySelector('input').value,latest.content.title);
  assert.ok(f.state.requests.some(request=>request.method==='get'&&request.args[0]==='/api/investment-strategies/watch-draft'));
  assert.equal(f.state.requests.filter(request=>request.method==='post').length,0);
 });
});

test('reading preparation status preserves an unsaved period edit',async()=>{
 await scenario({status:'pending',requestKey:'running-request'},async({f,button})=>{
  const date=()=>document.querySelector('input[aria-label="Total strategy end date"]').value;
  await React.act(async()=>button('Today').click());
  const chosen=date();assert.notEqual(chosen,'2026-11-13');
  await React.act(async()=>button('Check preparation status').click());
  assert.equal(date(),chosen,'status reads must retain the unsaved end date');
  assert.equal(f.state.requests.filter(request=>request.method==='post'||request.method==='patch').length,0);
 },{setup:f=>{
  const dates=f.load('utils/strategy-dates.ts'),periodDates=dates.strategyPeriodDates;
  dates.strategyPeriodDates=(period,zone)=>periodDates(period,zone,new Date('2026-11-06T04:00:00Z'));
 }});
});

test('a new draft preparation clears status checking when its result arrives before the status read',async()=>{
 let finishStatus,finishPreparation;
 const confirmed={...ready,status:'confirmed',confirmedAt:'2026-11-06T00:00:00Z'};
 await scenario({status:'none'},async({button})=>{
  try{
   await React.act(async()=>button('Review execution details').click());
   assert.equal(typeof finishStatus,'function','saving the new draft starts its status read');
   assert.equal(typeof finishPreparation,'function','the explicit preparation is waiting for its result');
   await React.act(async()=>finishPreparation(ready));
   const apply=button('Review and apply to simulation');assert.ok(apply);
   assert.equal(apply.disabled,false,'the completed preview must release the obsolete status-checking lock');
  }finally{if(finishStatus)await React.act(async()=>finishStatus({status:'pending',requestKey:'obsolete-read'}));}
 },{item:confirmed,setup:f=>{
  const api=f.load('api/investment-strategies.ts').investmentStrategiesApi;
  api.create=async()=>structuredClone(draft);
  api.preparation=()=>new Promise(resolve=>{finishStatus=resolve;});
  api.prepare=()=>new Promise(resolve=>{finishPreparation=resolve;});
 }});
});

test('explicit observation review preserves text and uses only deterministic preview before separate apply',async()=>{
 await scenario({status:'none'},async({f,button})=>{
  const observe=button('Review as observation only');assert.ok(observe);assert.equal(observe.disabled,false);
  await React.act(async()=>observe.click());
  const posts=f.state.requests.filter(r=>r.method==='post');assert.equal(posts.length,1);assert.match(posts[0].args[0],/\/preview$/);
  assert.match(document.body.textContent,/Observation only; no automatic trades/);
  assert.equal(document.querySelector('textarea[aria-label="Strategy entry 1"]').value,content.entries[0].text);
  await React.act(async()=>button('Review and apply to simulation').click());
  const applied=f.state.requests.filter(r=>r.method==='post');assert.equal(applied.length,2);assert.match(applied[1].args[0],/apply-strategy$/);assert.equal(applied[1].args[1].previewHash,'watch-only-hash');
 });
});

test('an existing stale explanation can be rechecked without another model call',async()=>{
 await scenario({status:'none'},async({f,button})=>{
  const api=f.load('api/investment-strategies.ts').investmentStrategiesApi;
  api.apply=async()=>{throw {response:{data:{error:{message:'Strategy preview is stale'}}}};};
  await React.act(async()=>button('Review and apply to simulation').click());
  const recheck=button('Recheck saved explanation');assert.ok(recheck);
  await React.act(async()=>recheck.click());
  const posts=f.state.requests.filter(r=>r.method==='post');assert.equal(posts.length,1);assert.match(posts[0].args[0],/\/preview$/);
  assert.equal(button('Review and apply to simulation').disabled,false);
 },{item:ready});
});
