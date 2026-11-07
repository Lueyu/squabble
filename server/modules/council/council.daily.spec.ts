import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDailyReverseCheck, dailyResearchTurns, renderDailyReverseCheck, dailyResearchPrompt, reportExecutionEvidence } from './council.daily';
import type { CouncilEvidence } from './council.rules';

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
test('daily reverse check and report cover every frozen constituent and recorded currency', () => {
  for (const phase of ['challenge', 'summary']) {
    const prompt = dailyResearchPrompt(phase);
    assert.match(prompt, /every frozen holding/iu);
    assert.match(prompt, /cash by currency/iu);
    assert.match(prompt, /confirmed investor limits/iu);
    assert.match(prompt, /snapshot capture time/iu);
    assert.match(prompt, /next verification/iu);
  }
});
test('retaining later research sources never evicts the mandatory owner snapshot', () => {
  const fact = (id: string, sourceName: string): CouncilEvidence => ({ id, sourceName, title: id, content: id, role: 'fundamental', evidenceType: 'other',
    sourceUrl: null, fetchedAt: new Date().toISOString(), relevanceScore: 1 });
  const owner = fact('owner', 'Frozen owner context');
  const retained = reportExecutionEvidence([owner, ...Array.from({ length: 65 }, (_, i) => fact(`source-${i}`, 'Native agent'))]);
  assert.equal(retained.length, 60); assert.ok(retained.some(item => item.id === owner.id));
});
test('summary reuses retained research and checks arithmetic against limits without inventing market timestamps', () => {
  const prompt = dailyResearchPrompt('summary');
  assert.match(prompt, /Synthesize retained independent findings and the supplied reverse-check/iu);
  assert.match(prompt, /only seek new public evidence for a material unresolved gap/iu);
  assert.match(prompt, /exceeding a confirmed maximum is a breach/iu);
  assert.match(prompt, /do not infer an exchange-close timestamp from a stored mark/iu);
});

test('reverse checks preserve all valid citations through the complete report evidence capacity', () => {
  for (const count of [21, 60]) {
    const evidenceIds: string[] = Array.from({ length: count }, (_, i) => `fictional-evidence-${i}`);
    const check = parseDailyReverseCheck({ outcome: 'partially_weakened', checked: ['Compare fictional source periods'],
      findings: ['A fictional premise weakens'], gaps: [], affectedPremises: ['Fictional cash conversion'], evidenceIds }, new Set(evidenceIds));
    assert.deepEqual(check.evidenceIds, evidenceIds, 'valid citations must survive without truncation or reordering');
  }
});

test('reverse-check citation capacity remains bounded and unknown references remain invalid', () => {
  const evidenceIds: string[] = Array.from({ length: 61 }, (_, i) => `fictional-evidence-${i}`);
  const base = { outcome: 'partially_weakened', checked: ['Check fictional evidence'], findings: ['A fictional premise weakens'],
    gaps: [], affectedPremises: ['Fictional premise'] };
  assert.throws(() => parseDailyReverseCheck({ ...base, evidenceIds }, new Set(evidenceIds)), /DAILY_REVERSE_CHECK_INVALID/);
  assert.throws(() => parseDailyReverseCheck({ ...base, evidenceIds: [...evidenceIds.slice(0, 20), 'unknown-evidence'] },
    new Set(evidenceIds)), /DAILY_REVERSE_CHECK_INVALID/);
  assert.throws(() => parseDailyReverseCheck({ ...base, checked: Array.from({ length: 13 }, (_, i) => `Check ${i}`),
    evidenceIds: evidenceIds.slice(0, 21) }, new Set(evidenceIds)), /DAILY_REVERSE_CHECK_INVALID/);
});

test('reverse-check prompt declares the citation inventory and explanatory-list bounds', () => {
  const prompt: string = dailyResearchPrompt('challenge');
  assert.match(prompt, /reverseCheck\.evidenceIds[^.]*at most 60/iu);
  assert.match(prompt, /checked, findings, gaps and affectedPremises[^.]*at most 12/iu);
});
