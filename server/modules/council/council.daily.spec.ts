import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDailyReverseCheck, dailyResearchTurns, renderDailyReverseCheck } from './council.daily';

test('daily research always checks the opposite case even when independent opinions agree', () => {
  const members = [{id:'one',role:'researcher'}, {id:'two',role:'challenger'}] as const;
  assert.deepEqual(dailyResearchTurns([...members]), [{memberId:'two',phase:'challenge'}]);
});
test('absence of counterevidence remains limited evidence, never a safety verdict', () => {
  const check = parseDailyReverseCheck({outcome:'no_counterevidence_found',checked:['Compare cash and accrual growth'],findings:['No discrepancy in the supplied period'],gaps:['Customer mix is unavailable'],affectedPremises:['Cash conversion'],evidenceIds:['e1']}, new Set(['e1']));
  assert.match(renderDailyReverseCheck(check, 'zh-CN'), /不代表判断正确/);
  assert.match(renderDailyReverseCheck(check, 'zh-CN'), /Customer mix/);
  assert.throws(()=>parseDailyReverseCheck({...check,evidenceIds:['invented']},new Set(['e1'])));
});
test('unavailable verification is explicit and unsupported contradiction is rejected', () => {
  assert.throws(()=>parseDailyReverseCheck({outcome:'critical_counterevidence',checked:['a'],findings:['b'],gaps:[],affectedPremises:['c'],evidenceIds:[]},new Set()));
  const check=parseDailyReverseCheck({outcome:'unable_to_verify',checked:['Locate original filing'],findings:[],gaps:['No original source'],affectedPremises:['Growth'],evidenceIds:[]},new Set());
  assert.match(renderDailyReverseCheck(check,'en'),/unconfirmed/i);
});
