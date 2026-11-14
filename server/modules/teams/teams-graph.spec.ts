import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateTeamGraph, compileTeamPlan } from './team-graph';
import { canonicalHash } from './team-contract';
import type { TeamSemanticConfig } from '../../../shared/team-workspace.interface';
const a = randomUUID(), b = randomUUID();
const errorCode=(code:string)=>(error:unknown)=>typeof error==='object'&&error!==null&&'getResponse' in error&&(error.getResponse as ()=>{code:string})().code===code;
const config: TeamSemanticConfig = { schemaVersion: 1, departments: [], roles: [a,b].map(id => ({ id, departmentId:null, participation:'enabled', responsibility:'Research', expectedOutput:'Evidence', executor:{executionMode:'model',connectionId:randomUUID(),model:'fixture',settings:{}},allowedToolIds:[],sourceGrantIds:[] })), relations:[], defaults:{leadRoleId:a,parallelism:1} };
test('reports-to graph rejects cycles while review relations can cycle', () => {
  const relations = [{id:randomUUID(),fromRoleId:a,toRoleId:b,kind:'reports_to' as const,responsibilityScope:'One'}, {id:randomUUID(),fromRoleId:b,toRoleId:a,kind:'reports_to' as const,responsibilityScope:'Two'}];
  assert.throws(() => validateTeamGraph({...config,relations}), errorCode('TEAM_GRAPH_INVALID'));
  assert.doesNotThrow(() => validateTeamGraph({...config,relations:relations.map(r=>({...r,kind:'reviews'}))}));
});
test('canonical hash ignores object key order and preserves exact revisions',()=>{
  assert.equal(canonicalHash({a:1,b:2}),canonicalHash({b:2,a:1}));
  assert.notEqual(canonicalHash({source:'v1'}),canonicalHash({source:'v2'}));
});
test('finite plan rejects missing summary and duplicate dispatch identity',()=>{
  const base={schemaVersion:1 as const,leadRoleId:a,participantRoleIds:[a,b],objective:'Analyze',expectedOutput:'Report',dataCutoffAt:'2026-11-12T00:00:00.000Z',deadlineAt:'2026-11-13T00:00:00.000Z',supervisorRoleIds:[],work:[],parallelism:1 as const,conflictResolutions:[],budget:{budgetMode:'cost_and_calls' as const,ceiling:{amount:'1',currency:'USD'},callLimit:3,paidRevisionLimit:0}};
  assert.throws(()=>compileTeamPlan(config,base,{}),errorCode('TEAM_PLAN_INVALID'));
});
test('identical work content with a different reviewer is never merged',()=>{
  const plan={schemaVersion:1 as const,leadRoleId:a,participantRoleIds:[a,b],objective:'Analyze',expectedOutput:'Report',dataCutoffAt:'2026-11-12T00:00:00.000Z',deadlineAt:'2026-11-13T00:00:00.000Z',supervisorRoleIds:[],parallelism:1 as const,conflictResolutions:[],
    budget:{budgetMode:'cost_and_calls' as const,ceiling:{amount:'1',currency:'USD'},callLimit:6,paidRevisionLimit:0},
    work:[
      {workKey:'summary',roleId:a,taskKind:'summary' as const,objective:'Analyze',expectedOutput:'Report',dependencyWorkKeys:[],reviewerRoleId:a,reviewMode:'self_check' as const,requestedByRoleIds:[a],inputRefs:[]},
      {workKey:'financials-a',roleId:a,taskKind:'financials' as const,objective:'Check the cash flow',expectedOutput:'Cash-flow evidence',dependencyWorkKeys:[],reviewerRoleId:b,reviewMode:'independent' as const,requestedByRoleIds:[a],inputRefs:[]},
      {workKey:'financials-b',roleId:b,taskKind:'financials' as const,objective:'Check the cash flow',expectedOutput:'Cash-flow evidence',dependencyWorkKeys:[],reviewerRoleId:a,reviewMode:'independent' as const,requestedByRoleIds:[a],inputRefs:[]},
    ]};
  const compiled=compileTeamPlan(config,plan,{});
  assert.equal(compiled.work.length,3);
  const financialItems=compiled.work.filter(w=>w.taskKind==='financials');
  assert.equal(financialItems.length,2);
  assert.notEqual(financialItems[0].workKey,financialItems[1].workKey);
  assert.deepEqual(financialItems.map(w=>w.reviewerRoleId).sort(),[a,b].sort());
});
