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
    [{currency:'USD',balance:'5'}]);
  assert.deepEqual(result,[{currency:'HKD',holdingsValue:null,cash:0},{currency:'USD',holdingsValue:20,cash:5}]);
});
