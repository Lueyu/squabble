const {test}=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const {createRoot}=require('react-dom/client');
const {MemoryRouter}=require('react-router-dom');
const {JSDOM}=require('jsdom');
const fixture=require('./simple-test-loader.cjs');
const draft={id:'draft-id',revision:3,status:'draft',content:{title:'Fictional draft',body:'',entries:[],startsAt:'2020-01-01T00:00:00Z',endsAt:'2020-01-02T00:00:00Z'},sources:[],updatedAt:'2020-01-01T00:00:00Z'};
const current={...draft,id:'current-id',status:'confirmed',confirmedAt:'2020-01-01T00:00:00Z'};
async function scenario(run){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/paper'}),previous={window:global.window,document:global.document,act:global.IS_REACT_ACT_ENVIRONMENT};
 Object.assign(global,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const root=createRoot(document.getElementById('root'));
 try{
  const f=fixture(),dialog=f.load('components/ui/dialog.tsx');
  for(const key of ['Dialog','DialogContent','DialogDescription','DialogHeader','DialogTitle'])dialog[key]=({children})=>React.createElement('div',null,children);
  f.state.queries.set('investment-strategies',{data:{current,drafts:[draft],history:[],draftsCursor:null,historyCursor:null}});
  f.state.queries.set('ai-investment',{data:{account:{id:'paper'},policy:{id:'policy',revision:7,status:'running'},currentStrategy:current}});
  await React.act(async()=>root.render(React.createElement(MemoryRouter,null,React.createElement(f.load('pages/Today/InvestmentStrategySection.tsx').default))));
  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
  await run({f,button});
 }finally{await React.act(async()=>root.unmount());dom.window.close();Object.assign(global,{window:previous.window,document:previous.document,IS_REACT_ACT_ENVIRONMENT:previous.act});}
}
test('draft removal confirms the exact revision without changing the applied strategy',async()=>{
 await scenario(async({f,button})=>{
  assert.ok(button('Delete draft'));
  await React.act(async()=>button('Delete draft').click());
  assert.equal(f.state.requests.length,0);
  await React.act(async()=>button('Confirm deletion').click());
  assert.equal(f.state.requests.length,1);assert.equal(f.state.requests[0].method,'delete');
  assert.equal(f.state.requests[0].args[0],'/api/investment-strategies/draft-id');
  assert.equal(f.state.requests[0].args[1].data.expectedRevision,3);
 });
});
test('current removal explains the stop and preserves historical records',async()=>{
 await scenario(async({f,button})=>{
  assert.match(document.body.textContent,/Expired/);
  assert.doesNotMatch(document.body.textContent,/Running in simulation/);
  await React.act(async()=>button('Stop and remove').click());
  assert.match(document.body.textContent,/including stop-loss/);
  assert.match(document.body.textContent,/history.*retained/i);
  await React.act(async()=>button('Confirm stop and remove').click());
  const call=f.state.requests[0];assert.equal(call.args[0],'/api/ai-investment/remove-strategy');
  assert.deepEqual(JSON.parse(JSON.stringify(call.args[1])),{strategyId:'current-id',expectedRevision:3,expectedPolicyRevision:7,requestKey:'request-key'});
 });
});

test('a linked draft waits for the current-strategy workspace before opening its editor',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/paper'}),previous={window:global.window,document:global.document,act:global.IS_REACT_ACT_ENVIRONMENT};
 Object.assign(global,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const root=createRoot(document.getElementById('root'));
 try{
  const f=fixture();
  f.load('pages/Today/InvestmentStrategyEditor.tsx').default=({currentId})=>React.createElement('p',{'data-editor-current':currentId??'none'},'Opened linked draft');
  const Section=f.load('pages/Today/InvestmentStrategySection.tsx').default;
  f.state.queries.set('investment-strategies',{isPending:true});
  f.state.queries.set('investment-strategy',{data:draft});
  const render=()=>root.render(React.createElement(MemoryRouter,{initialEntries:['/paper?investmentStrategyId=draft-id']},React.createElement(Section)));
  await React.act(async()=>render());
  assert.equal(Boolean(document.querySelector('[data-editor-current]')),false,'selected draft can arrive before the replacement target');
  f.state.queries.set('investment-strategies',{data:{current,drafts:[draft],history:[]},isPending:false});
  await React.act(async()=>render());
  assert.equal(document.querySelector('[data-editor-current]').getAttribute('data-editor-current'),current.id);
 }finally{await React.act(async()=>root.unmount());dom.window.close();Object.assign(global,{window:previous.window,document:previous.document,IS_REACT_ACT_ENVIRONMENT:previous.act});}
});
