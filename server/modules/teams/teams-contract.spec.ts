import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TeamRuntimeAdapter } from './team-runtime-adapter';
import { compareDecimal,parseTeam,moneySchema } from './team-contract';
import { teamCapabilities } from './team-config';
import type { LocalAgentsService } from '../local-agents/local-agents.service';
import type { CouncilService } from '../council/council.service';
import type { TeamDatabase } from '../../database/team-context';
test('decimal comparisons preserve sub-cent differences and reject non-decimal and unknown fields',()=>{
  assert.equal(compareDecimal('9007199254740993.00001','9007199254740993.00000'),1);
  assert.equal(compareDecimal('1.00','1'),0);
  assert.equal(moneySchema.safeParse({amount:'1e3',currency:'USD'}).success,false);
  assert.equal(moneySchema.safeParse({amount:'1',currency:'USD',free:true}).success,false);
  assert.throws(()=>parseTeam(moneySchema,{amount:'1',currency:'USD',extra:{deep:{deep:{deep:{deep:{deep:{deep:{deep:{deep:{deep:{deep:{deep:{deep:{deep:{}}}}}}}}}}}}}}}));
});
test('rollout flags accept only explicit boolean strings',()=>{
  const value=process.env.TEAM_WORKSPACE_ENABLED;
  try{process.env.TEAM_WORKSPACE_ENABLED='yes';assert.throws(()=>teamCapabilities(),/must be true or false/);}
  finally{if(value===undefined)delete process.env.TEAM_WORKSPACE_ENABLED;else process.env.TEAM_WORKSPACE_ENABLED=value;}
});
test('connected native executors without verified isolated tools are unsupported for private team tasks',async()=>{
  const runtime=new TeamRuntimeAdapter({} as CouncilService,{status:async()=>({mode:'native',companion:{connected:false},items:[{id:'native-codex',provider:'codex',name:'Fixture native',state:'ready',available:true,connected:true,busy:false,source:'native',defaultModel:'fixture',loginCommand:'fixture',installUrl:'https://fixture.invalid'}]})} as unknown as LocalAgentsService);
  const checks=await runtime.check({} as TeamDatabase,'owner-fixture',[{id:randomUUID(),departmentId:null,participation:'enabled',responsibility:'Fixture',expectedOutput:'Report',executor:{executionMode:'local',localAgentId:'native-codex',settings:{}},allowedToolIds:[],sourceGrantIds:[]}]);
  assert.equal(checks[0].status,'unsupported');
  assert.equal(checks[0].capabilities.includes('team_scope'),false);
});
