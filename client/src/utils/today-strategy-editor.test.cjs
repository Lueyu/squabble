const {test}=require('node:test');
const assert=require('node:assert/strict');
const fixture=require('./simple-test-loader.cjs');
const React=require('react');
const {createRoot}=require('react-dom/client');
const {MemoryRouter}=require('react-router-dom');
const {JSDOM}=require('jsdom');
const writes=f=>f.state.requests.filter(request=>request.method!=='get');
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
 const f=editorFixture();const Editor=f.load('features/investment-strategies/InvestmentStrategyEditor.tsx').default;
 const html=f.render(Editor,{item:confirmed,currentId:confirmed.id,timezone:'Asia/Shanghai',onChanged(){},onClose(){}});
 assert.match(html,/Confirmed execution details/);
 assert.match(html,/Copy as draft/);
 assert.match(html,/Frozen execution authority/);
 assert.doesNotMatch(html,/Your text changed/);
});

test('a legacy account without an investment policy cannot apply a prepared strategy',()=>{
 const f=editorFixture(),Editor=f.load('features/investment-strategies/InvestmentStrategyEditor.tsx').default;
 const html=f.render(Editor,{item:{...confirmed,status:'draft'},currentId:null,timezone:'Asia/Shanghai',investment:{account:{id:'legacy'}},onChanged(){},onClose(){}});
 assert.match(html,/Set up your simulation before applying/);
 assert.match(html,/<button[^>]*disabled=""[^>]*>Review and apply to simulation<\/button>/);
 assert.match(html,/\/paper\?investmentStrategyId=confirmed/);
});

test('an imported ready draft opens in review mode with visible limits and a persistent action footer',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),previous={window:global.window,document:global.document,act:global.IS_REACT_ACT_ENVIRONMENT};
 Object.assign(global,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const root=createRoot(document.getElementById('root'));
 try{
  const f=editorFixture(),Editor=f.load('features/investment-strategies/InvestmentStrategyEditor.tsx').default;
  const item={...structuredClone(confirmed),status:'draft',content:{...content,limits:{maxPositionPct:10,maxOrderPct:5,minCashPct:20,maxGrossExposurePct:80}}};
  await React.act(async()=>root.render(React.createElement(MemoryRouter,null,React.createElement(Editor,{item,currentId:null,timezone:'Asia/Shanghai',investment:{account:{id:'paper'},policy:{id:'policy'}},onChanged(){},onClose(){}}))));
  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
  assert.match(document.body.textContent,/Review and enable strategy/);
  assert.equal(document.querySelectorAll('textarea').length,0,'ready report plans should not open with an editing form');
  const limits=document.querySelector('[aria-label="Risk limits for review"]');
  assert.ok(limits);assert.match(limits.textContent,/Single-position cap.*10%/);
  const explanation=document.querySelector('section[aria-label="Execution details"]');assert.ok(explanation);
  const scroller=document.querySelector('[data-strategy-scroll]'),footer=document.querySelector('footer');
  assert.ok(scroller);assert.equal(scroller.contains(footer),false,'the apply button must remain outside the scrolling content');
  assert.equal(footer.contains(button('Review and apply to simulation')),true);
  await React.act(async()=>button('Edit strategy content').click());
  assert.equal(document.querySelectorAll('textarea').length,2);
  assert.equal(button('Collapse editing').getAttribute('aria-expanded'),'true');
  assert.equal(writes(f).length,0,'opening editing does not save, re-extract or apply anything');
 }finally{await React.act(async()=>root.unmount());dom.window.close();Object.assign(global,{window:previous.window,document:previous.document,IS_REACT_ACT_ENVIRONMENT:previous.act});}
});

test('editing only a confirmed strategy period rechecks without a model request',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),previous={window:global.window,document:global.document,act:global.IS_REACT_ACT_ENVIRONMENT};
 Object.assign(global,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const root=createRoot(document.getElementById('root'));
 try{
  const f=editorFixture(),Editor=f.load('features/investment-strategies/InvestmentStrategyEditor.tsx').default;
  const draft={...structuredClone(confirmed),id:'new-draft',parentId:confirmed.id,status:'draft',revision:1,preview:null};
  f.state.responses=new Map([['/api/investment-strategies',draft],['/api/investment-strategies/new-draft/preview',{...draft,preview:confirmed.preview}],['/api/investment-strategies/new-draft/prepare',{...draft,preview:confirmed.preview}]]);
  await React.act(async()=>root.render(React.createElement(MemoryRouter,null,React.createElement(Editor,{item:confirmed,currentId:confirmed.id,timezone:'Asia/Shanghai',investment:{account:{id:'paper'},policy:{id:'policy'}},onChanged(){},onClose(){}}))));
  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
  await React.act(async()=>button('Next week').click());
  await React.act(async()=>button('Review execution details').click());
  assert.deepEqual(writes(f).map(r=>r.args[0]),['/api/investment-strategies','/api/investment-strategies/new-draft/preview']);
 }finally{await React.act(async()=>root.unmount());dom.window.close();Object.assign(global,{window:previous.window,document:previous.document,IS_REACT_ACT_ENVIRONMENT:previous.act});}
});

test('changed strategy text cannot reuse its previous executable interpretation',()=>{
 const {load}=fixture(),{canReuseStrategyInterpretation,editStrategyEntry}=load('utils/user-strategy-editor.ts');
 const text='Buy 1 FICT below 100';
 const entry={id:'typed',text,sourceKeys:[],directive:{ticker:'FICT',side:'buy',trigger:{kind:'price_lte',price:100},quantity:1,reviewedText:text,numericEvidence:[]}};
 const original={...confirmed,content:{...content,entries:[entry]}};
 assert.equal(canReuseStrategyInterpretation({...original.content,endsAt:'2026-11-14T00:00:00Z'},original),true);
 const changed=editStrategyEntry(entry,'Buy 10 FICT below 100');
 assert.equal(changed.directive,undefined);
 assert.equal(canReuseStrategyInterpretation({...original.content,entries:[changed]},original),false);
 assert.equal(canReuseStrategyInterpretation({...original.content,body:'Completely different investment intent'},original),false);
});

test('entry date and effective-period help use its own timezone',()=>{
 const f=editorFixture();const Editor=f.load('features/investment-strategies/InvestmentStrategyEditor.tsx').default;
 const html=f.render(Editor,{item:confirmed,currentId:confirmed.id,timezone:'Asia/Shanghai',onChanged(){},onClose(){}});
 assert.match(html,/value="2026-11-05"/);
 assert.match(html,/America\/New_York/);
 assert.match(html,/Effective period/);
});

test('editor exposes the exact pinned report instead of only a source count',()=>{
 const f=editorFixture();const Editor=f.load('features/investment-strategies/InvestmentStrategyEditor.tsx').default;
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
  const f=editorFixture(),Editor=f.load('features/investment-strategies/InvestmentStrategyEditor.tsx').default;
  f.state.responses=new Map([['/api/investment-strategies',{...structuredClone(confirmed),id:'new-draft',parentId:confirmed.id,status:'draft',revision:1,preview:null}]]);
  await React.act(async()=>root.render(React.createElement(MemoryRouter,null,React.createElement(Editor,{item:confirmed,currentId:confirmed.id,timezone:'Asia/Shanghai',onChanged(){},onClose(){}}))));
  const copy=[...document.querySelectorAll('button')].find(button=>button.textContent==='Copy as draft');assert.ok(copy);
  await React.act(async()=>copy.click());
  assert.equal(writes(f).length,1);
  assert.equal(writes(f)[0].method,'post');
  assert.equal(writes(f)[0].args[1].parentId,'confirmed');
  assert.equal(writes(f)[0].args[1].content.entries[0].text,'Watch FICT');
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
  const f=editorFixture(),Editor=f.load('features/investment-strategies/InvestmentStrategyEditor.tsx').default;
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
  assert.equal(writes(f).length,1);assert.equal(writes(f)[0].method,'patch');
  assert.deepEqual(JSON.parse(JSON.stringify(writes(f)[0].args[1].content.limits)),{maxPositionPct:15,maxDailyIncreasePct:6,maxDailyTurnoverPct:25,minCashPct:20,maxGrossExposurePct:80,maxOrderPct:4});
  assert.doesNotMatch(writes(f)[0].args[0],/apply|prepare/);
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
  const limits=writes(f)[0].args[1].content.limits;
  assert.equal(limits.minCashPct,10);assert.equal(limits.maxGrossExposurePct,90);
  assert.equal(writes(f).length,1);assert.equal(writes(f)[0].method,'patch');
  assert.doesNotMatch(writes(f)[0].args[0],/apply|prepare/);
 });
});

test('a new draft has an actionable review step and applies only after its prepared explanation is confirmed',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 const previous={window:global.window,document:global.document,act:global.IS_REACT_ACT_ENVIRONMENT};
 global.window=dom.window;global.document=dom.window.document;global.IS_REACT_ACT_ENVIRONMENT=true;
 const root=createRoot(document.getElementById('root'));
 try{
  const f=editorFixture(),Editor=f.load('features/investment-strategies/InvestmentStrategyEditor.tsx').default;
  const draft={...structuredClone(confirmed),id:'ready-draft',status:'draft',revision:1,preview:null,confirmedAt:null};
  const prepared={...draft,revision:2,preview:{...structuredClone(confirmed.preview),revision:2,contentHash:'reviewed-hash'}};
  f.state.responses=new Map([['/api/investment-strategies/ready-draft/prepare',prepared]]);
  let closed=0;
  await React.act(async()=>root.render(React.createElement(MemoryRouter,null,React.createElement(Editor,{item:draft,currentId:null,timezone:'Asia/Shanghai',investment:{account:{id:'paper'},policy:{id:'policy'}},onChanged(){},onClose(){closed++;}}))));
  const button=text=>[...document.querySelectorAll('button')].find(item=>item.textContent===text);
  const review=button('Review execution details');assert.ok(review,'unprepared drafts expose the next step instead of a disabled apply button');assert.equal(review.disabled,false);
  await React.act(async()=>review.click());
  assert.equal(writes(f).length,1);assert.equal(writes(f)[0].args[0],'/api/investment-strategies/ready-draft/prepare');
  assert.equal(closed,0);assert.match(document.body.textContent,/Frozen execution authority/);
  const apply=button('Review and apply to simulation');assert.ok(apply);assert.equal(apply.disabled,false);
  await React.act(async()=>apply.click());
  assert.equal(writes(f).length,2);assert.equal(writes(f)[1].args[0],'/api/ai-investment/apply-strategy');
  assert.equal(writes(f)[1].args[1].expectedRevision,2);assert.equal(writes(f)[1].args[1].previewHash,'reviewed-hash');assert.equal(closed,1);
 }finally{
  await React.act(async()=>root.unmount());dom.window.close();global.window=previous.window;global.document=previous.document;global.IS_REACT_ACT_ENVIRONMENT=previous.act;
 }
});

test('apply retries retain the opening strategy and reviewed request identity after a workspace refresh', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = {
    window: global.window,
    document: global.document,
    act: global.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById('root'));
  try {
    const f = editorFixture();
    let generated = 0;
    f.state.randomUUID = () => `intent-${++generated}`;
    const Editor = f.load('features/investment-strategies/InvestmentStrategyEditor.tsx').default;
    const api = f.load('api/investment-strategies.ts').investmentStrategiesApi;
    const item = {
      ...structuredClone(confirmed),
      id: 'reviewed-draft',
      status: 'draft',
      preview: { ...confirmed.preview, contentHash: 'reviewed-hash' },
    };
    const attempts = [];
    let rejectFirst;
    let closed = 0;
    api.apply = input => {
      attempts.push(input);
      return attempts.length === 1
        ? new Promise((resolve, reject) => { rejectFirst = reject; })
        : Promise.resolve({});
    };
    const render = currentId => root.render(React.createElement(MemoryRouter, null,
      React.createElement(Editor, {
        item, currentId, timezone: 'Asia/Shanghai',
        investment: { account: { id: 'paper' }, policy: { id: 'policy' } },
        onChanged() {}, onClose() { closed++; },
      })));
    const applyButton = () => [...document.querySelectorAll('button')]
      .find(button => button.textContent === 'Review and apply to simulation');

    await React.act(async () => render('current-at-opening'));
    await React.act(async () => {
      const button = applyButton();
      button.click();
      button.click();
    });
    assert.equal(attempts.length, 1, 'same-turn double clicks must share one in-flight operation');

    await React.act(async () => render('current-after-refresh'));
    await React.act(async () => rejectFirst(new Error('Transport interrupted')));
    await React.act(async () => applyButton().click());

    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(attempts[1].expectedCurrentId, 'current-at-opening');
    assert.equal(attempts[1].strategyId, 'reviewed-draft');
    assert.equal(attempts[1].expectedRevision, item.revision);
    assert.equal(attempts[1].previewHash, 'reviewed-hash');
    assert.equal(generated, 1, 'an uncertain response must not generate another apply identity');
    assert.equal(closed, 1);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    Object.assign(global, {
      window: previous.window,
      document: previous.document,
      IS_REACT_ACT_ENVIRONMENT: previous.act,
    });
  }
});
