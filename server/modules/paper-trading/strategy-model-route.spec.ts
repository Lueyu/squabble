import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StrategyModelService } from './strategy-model.service';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { LocalAgentStore } from '../local-agents/local-agents.store';
import { providerCatalog } from '../local-agents/local-agents.requests';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { BudgetExceededException } from '../llm-budget/llm-budget.rules';
import { GlobalExceptionFilter } from '../../common/filters/exception.filter';
test('strategy preparation uses a ready local member with its saved model override when no default API exists',async()=>{
  let apiCalls=0,localCalls=0;
  const model=new StrategyModelService({chatSlowJSON:async()=>{apiCalls++;throw Error('No default API');}} as never,
    {execute:async(_owner:string,input:{agentId:string;agentSettings:unknown})=>{localCalls++;assert.equal(input.agentId,'native-opencode');assert.deepEqual(input.agentSettings,{model:'gateway/fixture'});return{text:'{"entries":[]}'};}} as never,
    undefined,{resolve:async()=>({route:{mode:'local',agentId:'native-opencode',agentSettings:{model:'gateway/fixture'}},label:'Local friend'})} as never);
  assert.deepEqual(await model.json('owner',undefined,'task','prepare','untrusted draft',async()=>true,false),{entries:[]});
  assert.equal(apiCalls,0);assert.equal(localCalls,1);
});
test('strategy preparation preserves the selected named API connection',async()=>{
  const model=new StrategyModelService({chatSlowJSON:async(_messages:unknown,_owner:string,options:{connectionId:string})=>{assert.equal(options.connectionId,'named-connection');return{data:{entries:[]}};}} as never,{} as never,
    undefined,{resolve:async()=>({route:{mode:'api'},connectionId:'named-connection',label:'Named model'})} as never);
  assert.deepEqual(await model.json('owner',undefined,'task','prepare','draft',async()=>true,false),{entries:[]});
});
test('a completed local preparation with a short preface and JSON fence is parsed without another dispatch',async()=>{
  let calls=0;
  const model=new StrategyModelService({} as never,{execute:async()=>{calls++;return{text:'Preparation finished.\n```json\n{"entries":[]}\n```'};}} as never);
  const member={id:'local',name:'Local',role:'researcher',instructions:'',model:'slow',executionMode:'local',agentId:'native-codex'};
  assert.deepEqual(await model.json('owner',member as never,'task','prepare','draft',async()=>true,false),{entries:[]});
  assert.equal(calls,1);
});

test('an oversized preparation on the selected local route preserves the budget denial before dispatch without retrying',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'squabble-strategy-budget-'));
  const prior=process.env.SQUABBLE_DESKTOP_ORIGIN;
  process.env.SQUABBLE_DESKTOP_ORIGIN='http://127.0.0.1:43199';
  let nativeCalls=0,apiCalls=0,transactions=0,routeCalls=0;
  const local=new LocalAgentsService({detectNativeAgents:async()=>[{...providerCatalog.codex,state:'ready'}],
    openNativeLogin:async()=>undefined,runNativeAgent:async()=>{nativeCalls++;throw Error('Unexpected native dispatch');}},new LocalAgentStore(directory));
  // Only the settings read is allowed: the default input limit denies before a usage row is written.
  const tx={execute:async()=>undefined,select:()=>({from:()=>({where:async()=>[]})}),
    insert:()=>assert.fail('A denied preparation must not reserve usage')};
  const budgets=new LlmBudgetService({transaction:async(work:(value:typeof tx)=>Promise<unknown>)=>{transactions++;return work(tx);}} as never);
  const model=new StrategyModelService({chatSlowJSON:async()=>{apiCalls++;throw Error('Unexpected API dispatch');}} as never,local,budgets,
    {resolve:async()=>{routeCalls++;return{route:{mode:'local',agentId:'native-codex'},label:'Local friend'};}} as never);
  try{
    await local.connect('owner','native-codex');
    let denied:unknown;
    await assert.rejects(model.json('owner',undefined,'prepare-denied','strategy-preparation','x'.repeat(7000),async()=>true,false),error=>{
      denied=error;return error instanceof BudgetExceededException&&error.reason==='input_tokens'&&error.taskId==='prepare-denied';
    });
    const task=await local.store.findMessage('owner','prepare-denied');
    assert.ok(task,'the request is durably staged before the budget check');
    assert.equal(task.state,'cancelled');
    assert.notEqual(task.commandEmitted,true);
    assert.notEqual(task.runtimeEntered,true);
    assert.equal(nativeCalls,0);assert.equal(apiCalls,0);assert.equal(routeCalls,1);
    assert.equal(transactions,1,'budget denial is neither retried nor settled without a reservation');
    let status=0;
    let payload:{error:{code:string;reason:string;taskId:string}}|undefined;
    const response={headersSent:false,status(value:number){status=value;return this;},json(value:typeof payload){payload=value;}};
    new GlobalExceptionFilter().catch(denied,{switchToHttp:()=>({getResponse:()=>response})} as never);
    assert.equal(status,429);assert.equal(payload?.error.code,'LLM_BUDGET_EXCEEDED');
    assert.equal(payload?.error.reason,'input_tokens');assert.equal(payload?.error.taskId,'prepare-denied');
  }finally{
    await local.onModuleDestroy();
    if(prior===undefined)delete process.env.SQUABBLE_DESKTOP_ORIGIN;else process.env.SQUABBLE_DESKTOP_ORIGIN=prior;
    await rm(directory,{recursive:true,force:true});
  }
});
