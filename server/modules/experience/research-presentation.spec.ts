import test from 'node:test';
import assert from 'node:assert/strict';
import { researchPresentation, currencyBreakdown } from './research-presentation';

test('portfolio presentation reads the research summary and preserves complete holding rationales', () => {
  const result = researchPresentation({summary:'关注现金流与集中度。', allocationRisks:['行业较集中'], actions:['核实财报'],
    uncertainties:['行情尚未更新'], holdings:[{ticker:'ACME',stance:'watch',rationale:'需要更多资料。',triggers:['新财报']}],
    dailyLedgerFacts:{secret:'INTERNAL_LEDGER'}}, []);
  assert.equal(result.summary,'关注现金流与集中度。');
  assert.deepEqual(result.risks,['行业较集中']);
  assert.match(result.content,/ACME/u);
  assert.doesNotMatch(result.content,/dailyLedgerFacts|INTERNAL_LEDGER|allocationRisks/u);
});

test('legacy section presentation never promotes raw objects into a reading summary', () => {
  const result = researchPresentation(null,[{id:'dailyLedgerFacts',title:'dailyLedgerFacts',content:'{"gaps":["PRIVATE"]}'},
    {id:'summary',title:'summary',content:'这是实际研究结论。'}]);
  assert.equal(result.summary,'这是实际研究结论。');
  assert.doesNotMatch(result.content,/PRIVATE|dailyLedgerFacts/u);
});

test('native currency totals do not invent missing prices or merge unlike currencies', () => {
  const result=currencyBreakdown([{currency:'USD',shares:2,currentPrice:10},{currency:'HKD',shares:3,currentPrice:null}],
    [{currency:'USD',balance:'5',reconciliationStatus:'confirmed'}]);
  assert.deepEqual(result,[{currency:'HKD',holdingsValue:null,cash:null},{currency:'USD',holdingsValue:20,cash:5}]);
});
test('native currency cash distinguishes confirmed zero from missing or ambiguous balances',()=>{
  const position=[{currency:'USD',shares:2,currentPrice:10}];
  for(const cash of [[],[{currency:'USD',balance:'0'}],[{currency:'USD',balance:'100',reconciliationStatus:'review'}],
    [{currency:'USD',balance:'100',reconciliationStatus:'confirmed'},{currency:'USD',balance:'200',reconciliationStatus:'confirmed'}]])assert.equal(currencyBreakdown(position,cash)[0].cash,null);
  assert.equal(currencyBreakdown(position,[{currency:'USD',balance:'0',reconciliationStatus:'confirmed'}])[0].cash,0);
});
test('immutable archived sections retain holdings and risk fields without consulting mutable source rows',()=>{
  const result=researchPresentation(null,[{id:'summary',title:'summary',content:'Original saved finding'},{id:'holdings',title:'holdings',content:'[{"ticker":"ACME","rationale":"Original full holding judgment","triggers":["Next filing"]}]'},{id:'allocationRisks',title:'allocationRisks',content:'["Original concentration risk"]'}]);
  assert.match(result.content,/Original full holding judgment/u);assert.match(result.content,/Original concentration risk/u);
  assert.doesNotMatch(result.content,/"ticker"|allocationRisks/u);
});
test('public supporting evidence is retained alongside the summary without exposing the raw evidence envelope',()=>{
  const result=researchPresentation(null,[{id:'summary',title:'Summary',content:'Keep researching.'},
    {id:'evidencePoints',title:'Supporting evidence',content:'["The filing records lower cash."]'},
    {id:'evidence',title:'Raw evidence',content:'[{"content":"PRIVATE_PAYLOAD"}]'}]);
  assert.match(result.content,/The filing records lower cash/u);assert.doesNotMatch(result.content,/PRIVATE_PAYLOAD/u);
});
