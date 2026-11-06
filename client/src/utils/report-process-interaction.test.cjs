const assert=require('node:assert/strict');
const {test}=require('node:test');
const React=require('react');
const {createRoot}=require('react-dom/client');
const {MemoryRouter}=require('react-router-dom');
const {JSDOM}=require('jsdom');
const fixture=require('./simple-test-loader.cjs');

async function mounted(work){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
  const previous={window:global.window,document:global.document,act:global.IS_REACT_ACT_ENVIRONMENT};
  global.window=dom.window;global.document=dom.window.document;global.IS_REACT_ACT_ENVIRONMENT=true;
  const root=createRoot(document.getElementById('root'));
  try{await work({...fixture(),root});}finally{await React.act(async()=>root.unmount());dom.window.close();global.window=previous.window;global.document=previous.document;global.IS_REACT_ACT_ENVIRONMENT=previous.act;}
}
test('research process auto-collapses at completion while a manual expansion stays open',async()=>mounted(async({load,root})=>{
  const Timeline=load('pages/Council/CouncilResearchTimeline.tsx').default;
  const task={status:'running',startedAt:'2026-11-06T01:00:00Z',activities:[],sourceCount:0};
  const show=async(key,status)=>React.act(async()=>root.render(React.createElement(Timeline,{key,task:{...task,status}})));
  await show('automatic','running');assert.equal(document.querySelector('details').open,true);
  await show('automatic','succeeded');assert.equal(document.querySelector('details').open,false);
  await show('manual','running');
  await React.act(async()=>document.querySelector('summary').click());
  await React.act(async()=>document.querySelector('summary').click());
  assert.equal(document.querySelector('details').open,true);
  await show('manual','succeeded');assert.equal(document.querySelector('details').open,true);
}));
test('formatting recovery posts the retained-result action and never starts new research',async()=>mounted(async({load,state,root})=>{
  const Panel=load('pages/Today/CurrentAnalysisPanel.tsx').default;
  state.mutationFactory=options=>({isPending:false,mutate(){return options.mutationFn().then(data=>options.onSuccess?.(data));}});
  state.responses=new Map([['/api/research/current/reformat',{state:'ready',content:'Recovered',readingState:'ready'}]]);
  await React.act(async()=>root.render(React.createElement(MemoryRouter,null,React.createElement(Panel,{topicKey:'portfolio',date:'2026-11-06',view:{state:'failed',readingState:'pending',taskId:'retained-paid-result',content:'Previous complete analysis',researchLevel:'ai'}}))));
  assert.match(document.body.textContent,/Previous complete analysis/);
  const button=[...document.querySelectorAll('button')].find(item=>item.textContent==='Reformat saved result');assert.ok(button);
  await React.act(async()=>button.click());assert.equal(state.requests.length,1);
  assert.equal(state.requests[0].args[0],'/api/research/current/reformat');
  assert.equal(state.requests[0].args[1].topicKey,'portfolio');
}));
