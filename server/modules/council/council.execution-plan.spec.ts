import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContribution } from './council.dialogue';
import { dailyResearchPrompt } from './council.daily';

const turn={memberId:'summary',phase:'summary' as const};
function input(){
 const text='AI proposal: Sell FICT 1 share when price is at least 110 USD.';
 return {response:{thesis:'The portfolio merits a conditional reduction proposal.',evidencePoints:['Known source'],risks:['Price may not reach the condition'],nextChecks:['Recheck the next filing']},evidenceIds:['source-1'],
  executionPlan:{schemaVersion:1,parameterOrigin:'ai_proposed',strategy:{title:'Conditional proposal',body:'Parameters are suggestions for investor review.',timezone:'Asia/Shanghai',startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),
   limits:{maxPositionPct:20,maxDailyIncreasePct:5,maxDailyTurnoverPct:20,minCashPct:10,maxGrossExposurePct:90,maxOrderPct:5},
   entries:[{id:'trim',text,sourceKeys:[],directive:{ticker:'FICT',side:'sell',quantity:1,trigger:{kind:'price_gte',price:110},reviewedText:text,numericEvidence:[{field:'quantity',value:1,quote:'1 share'},{field:'trigger.price',value:110,quote:'110 USD'}]}}]},evidenceIds:['source-1'],gaps:[]}};
}
test('summary retains a checked executable proposal independently of research prose',()=>{
 const parsed=parseContribution(input(),new Set(['source-1']),turn,null);
 assert.equal(parsed.opinion?.executionPlan?.readiness,'ready');
 assert.equal(parsed.opinion?.executionPlan?.preview.directives[0].quantity,1);
 assert.equal(parsed.executionPlan?.parameterOrigin,'ai_proposed');
 assert.doesNotMatch(parsed.opinion!.summary,/"executionPlan"/);
});
test('invalid proposal cannot discard the report or become executable authority',()=>{
 const value=input();value.executionPlan.evidenceIds=['foreign-source'];
 const parsed=parseContribution(value,new Set(['source-1']),turn,null);
 assert.equal(parsed.opinion?.executionPlan,undefined);
 assert.equal(parsed.opinion?.executionPlanError,'invalid');
 assert.match(parsed.opinion!.summary,/conditional reduction/);
});
test('daily summary explicitly requests proposed parameters and a no-trade alternative',()=>{
 const prompt=dailyResearchPrompt('summary');
 assert.match(prompt,/executionPlan/);assert.match(prompt,/numericEvidence/);assert.match(prompt,/noTradeReason/);assert.match(prompt,/semanticAuthorized/);
});
