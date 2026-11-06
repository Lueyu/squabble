import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { StrategyModelService } from './strategy-model.service';
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
