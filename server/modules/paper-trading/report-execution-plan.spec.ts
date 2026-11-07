import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportObservationPlan, parseReportExecutionPlan, renderReportExecutionPlan, REPORT_EXECUTION_SECTION_ID } from './report-execution-plan';
import { previewStrategy, sourceAddition } from './user-investment-strategy.rules';
import type { ReportExecutionPlanInput } from '../../../shared/report-execution-plan.interface';

const now = new Date('2026-11-06T04:00:00Z');
const input = (): ReportExecutionPlanInput => {
  const text = 'AI 建议 / AI proposal: AAPL 价格不高于 100 时买入 10 股；价格下跌会造成损失。';
  return { schemaVersion: 1, parameterOrigin: 'ai_proposed', evidenceIds: ['e1'], gaps: [], strategy: {
    title: 'Fictional proposed plan', body: 'AI proposed investment parameters; review before applying.', timezone: 'Asia/Shanghai',
    startsAt: '2026-11-06T00:00:00Z', endsAt: '2026-11-09T00:00:00Z',
    limits: { maxPositionPct: 30, maxDailyIncreasePct: 10, maxDailyTurnoverPct: 30, minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 10 },
    entries: [{ id: 'apple', text, sourceKeys: ['untrusted-model-source'], directive: { ticker: 'AAPL', side: 'buy',
      trigger: { kind: 'price_lte', price: 100 }, quantity: 10, reviewedText: text,
      numericEvidence: [{ field: 'trigger.price', value: 100, quote: '100' }, { field: 'quantity', value: 10, quote: '10' }] } }],
  } };
};
const parse = (raw: unknown) => parseReportExecutionPlan(raw, new Set(['e1']), now);

test('complete cited AI proposals are ready and clear model supplied source authority without mutation', () => {
  const original = input(); const before = JSON.stringify(original); const plan = parse(original);
  assert.equal(plan.readiness, 'ready'); assert.equal(plan.preview.directives.length, 1);
  assert.deepEqual(plan.strategy.entries[0].sourceKeys, []);
  assert.equal(plan.strategy.entries[0].directive!.semanticAuthorized, false);
  assert.equal(JSON.stringify(original), before); assert.equal(REPORT_EXECUTION_SECTION_ID, 'execution-strategy');
});

test('unknown evidence and unbounded or unexpected fields fail validation', () => {
  assert.throws(() => parse({ ...input(), evidenceIds: ['fabricated'] }));
  assert.throws(() => parse({ ...input(), automaticAuthority: true }));
  assert.throws(() => parse({ ...input(), gaps: ['x'.repeat(2001)] }));
  assert.throws(() => parse({ ...input(), noTradeReason: 'x'.repeat(2001) }));
});

test('missing cited evidence cannot make a proposal ready', () => {
  const plan = parse({ ...input(), evidenceIds: [] });
  assert.equal(plan.readiness, 'needs_info'); assert.ok(plan.gaps.length);
});

test('missing amounts or limits stay explicit gaps instead of receiving defaults', () => {
  for (const field of ['quantity', 'limits'] as const) {
    const proposal = input(); if (field === 'quantity') delete proposal.strategy.entries[0].directive!.quantity; else delete proposal.strategy.limits;
    const plan = parse(proposal); assert.equal(plan.readiness, 'needs_info'); assert.equal(plan.preview.directives.length, 0);
    assert.ok(plan.gaps.length); assert.ok(plan.preview.issues.some(issue => issue.code === (field === 'quantity' ? 'AMOUNT_REQUIRED' : 'LIMITS_REQUIRED')));
    assert.equal(plan.strategy.entries[0].directive!.quantity, field === 'quantity' ? undefined : 10);
  }
});

test('missing price conditions and reported source gaps prevent readiness even when other parameters are complete', () => {
  const proposal = input(); delete proposal.strategy.entries[0].directive!.trigger.price;
  const missingCondition = parse(proposal); assert.equal(missingCondition.readiness, 'needs_info');
  assert.ok(missingCondition.preview.issues.some(issue => issue.code === 'CONDITION_REQUIRED')); assert.ok(missingCondition.gaps.length);
  const gap = parse({ ...input(), gaps: ['Recorded cash is unconfirmed.'] });
  assert.equal(gap.readiness, 'needs_info'); assert.equal(gap.preview.canConfirm, false);
  assert.ok(gap.preview.issues.some(issue => issue.code === 'REPORT_PLAN_GAPS'));
});

test('semantic authorization is always withheld even when requested in the model output', () => {
  const proposal = input(); const entry = proposal.strategy.entries[0]; entry.text += ' 条件为盈利恢复。';
  entry.directive!.reviewedText = entry.text; entry.directive!.trigger = { kind: 'semantic', text: '盈利恢复' };
  entry.directive!.semanticAuthorized = true;
  const plan = parse(proposal); assert.equal(plan.strategy.entries[0].directive!.semanticAuthorized, false);
  assert.equal(plan.readiness, 'needs_info'); assert.ok(plan.preview.issues.some(issue => issue.code === 'SEMANTIC_AUTHORIZATION_REQUIRED'));
});

test('invalid security and unsupported numbers are review issues; invalid periods and negative sizes reject', () => {
  const unsupported = input(); unsupported.strategy.entries[0].directive!.ticker = 'UNSUPPORTED:SECURITY';
  const plan = parse(unsupported); assert.equal(plan.readiness, 'needs_info'); assert.ok(plan.preview.issues.some(issue => issue.code === 'SECURITY_UNVERIFIED'));
  const changed = input(); changed.strategy.entries[0].directive!.quantity = 99;
  assert.ok(parse(changed).preview.issues.some(issue => issue.code === 'UNSUPPORTED_NUMBER'));
  assert.throws(() => parse({ ...input(), strategy: { ...input().strategy, endsAt: '2026-11-05T00:00:00Z' } }));
  const negative = input(); negative.strategy.entries[0].directive!.quantity = -10; assert.throws(() => parse(negative));
});

test('ticker case normalizes, while changed reviewed text never silently rebinds', () => {
  const proposal = input(); proposal.strategy.entries[0].directive!.ticker = 'aapl';
  assert.equal(parse(proposal).preview.directives[0].ticker, 'AAPL');
  proposal.strategy.entries[0].text += ' 只观察。';
  assert.equal(parse(proposal).readiness, 'needs_info'); assert.ok(parse(proposal).preview.issues.some(issue => issue.code === 'TEXT_CHANGED'));
});

test('explicit no trade requires no proposed directives and never masks an incomplete or actionable proposal', () => {
  const proposal = input(); proposal.noTradeReason = 'Evidence does not support a change.';
  assert.equal(parse(proposal).readiness, 'ready');
  delete proposal.strategy.entries[0].directive!.quantity; assert.equal(parse(proposal).readiness, 'needs_info');
  delete proposal.strategy.entries[0].directive; assert.equal(parse(proposal).readiness, 'no_trade');
  delete proposal.noTradeReason; assert.equal(parse(proposal).readiness, 'needs_info');
});

test('derived preview and readiness are recomputed instead of accepting forged executable authority', () => {
  const proposal = input(); delete proposal.strategy.limits;
  const plan = parse({ ...proposal, readiness: 'ready', preview: { canConfirm: true, directives: [{ ticker: 'FORGED' }] } });
  assert.equal(plan.readiness, 'needs_info'); assert.equal(plan.preview.directives.length, 0);
});

test('entry labels and derived gaps remain bounded and stable when archived plans are revalidated', () => {
  const proposal = input(); const entry = proposal.strategy.entries[0];
  entry.text = entry.text.replace('AI 建议 / AI proposal: ', ''); entry.directive!.reviewedText = entry.text;
  const plan = parse(proposal); assert.match(plan.strategy.entries[0].text, /^AI 建议 \/ AI proposal: /u);
  assert.equal(plan.strategy.entries[0].directive!.reviewedText, plan.strategy.entries[0].text);
  assert.equal(parse(plan).readiness, 'ready');
  proposal.gaps = Array.from({ length: 40 }, (_, index) => `Known source gap ${index}`); delete proposal.strategy.limits;
  const incomplete = parse(proposal); assert.ok(incomplete.gaps.length <= 40);
  assert.equal(parse(incomplete).readiness, 'needs_info');
  const oversized = input(); const originalText = oversized.strategy.entries[0].text.replace('AI 建议 / AI proposal: ', '');
  oversized.strategy.entries[0].text = originalText + 'x'.repeat(12000 - originalText.length);
  oversized.strategy.entries[0].directive!.reviewedText = oversized.strategy.entries[0].text;
  assert.throws(() => parse(oversized), 'AI labelling must not produce an unbounded archived entry');
});

test('legacy measurable rules cannot bypass report proposal validation', () => {
  const proposal = input(); proposal.strategy.entries[0].mandateRule = {} as never;
  assert.throws(() => parse(proposal));
});

test('human rendering preserves exact entry texts, periods, proposed limits and gaps without a JSON envelope', () => {
  const proposal = input(); proposal.gaps = ['Cash freshness needs review.']; const plan = parse(proposal);
  for (const language of ['en', 'zh-CN']) {
    const output = renderReportExecutionPlan(plan, language);
    assert.ok(output.includes(proposal.strategy.entries[0].text)); assert.ok(output.includes(proposal.strategy.startsAt));
    assert.ok(output.includes(proposal.strategy.endsAt)); assert.ok(output.includes('Asia/Shanghai'));
    assert.ok(output.includes('30%')); assert.ok(output.includes(proposal.gaps[0])); assert.match(output, /AI/);
    assert.equal(output.includes('"schemaVersion"'), false); assert.equal(output.includes('numericEvidence'), false);
  }
});

test('accepted plans fit the report import limit in both languages and oversized plans fail before publication', () => {
  const proposal = input(); const entry = proposal.strategy.entries[0];
  const accepted = parse(proposal);
  for (const language of ['en', 'zh-CN']) assert.ok(renderReportExecutionPlan(accepted, language).length <= 12000);
  assert.equal(parse(accepted).readiness, 'ready', 'archived plans remain valid when derived fields are rechecked');
  const longText = entry.text + ' Fictional rationale and risks.'.repeat(40);
  proposal.strategy.entries = Array.from({ length: 12 }, (_, index) => ({ ...entry, id: `proposal_${index}`, text: longText,
    directive: { ...entry.directive!, reviewedText: longText } }));
  assert.throws(() => parse(proposal), /REPORT_EXECUTION_TOO_LONG/u);
});

test('missing and rejected AI plans retain an honest importable observation with no trading authority', () => {
  for (const reason of ['missing', 'invalid'] as const) {
    const plan = createReportObservationPlan(reason, 'Recheck the original customer filing.', 'en', 'Asia/Shanghai', now);
    assert.equal(plan.parameterOrigin, 'system_observation'); assert.equal(plan.readiness, 'no_trade');
    assert.equal(plan.preview.directives.length, 0); assert.equal(plan.preview.mandateRules.length, 0);
    assert.match(plan.strategy.body, /system observation/i); assert.match(plan.strategy.entries[0].text, /original customer filing/);
    const section = renderReportExecutionPlan(plan, 'en');
    assert.match(section, /System observation plan/); assert.doesNotMatch(section, /AI proposed investment strategy|AI suggestion/i);
    const source = { key: 'report:fictional:execution-strategy', kind: 'report' as const, versionId: 'fictional', sectionId: 'execution-strategy', title: 'Fictional report', content: section, contentHash: 'fictional-hash', createdAt: now.toISOString(), capturedAt: now.toISOString(), ticker: null, executionPlan: plan };
    const addition = sourceAddition(plan.strategy, [], source);
    assert.equal(addition.entries.length, 1); assert.equal(addition.entries[0].directive, undefined);
    const preview = previewStrategy({ ...plan.strategy, entries: addition.entries }, [source], 1, now);
    assert.equal(preview.canConfirm, true); assert.equal(preview.directives.length, 0);
    assert.equal(parseReportExecutionPlan(plan, new Set(), now).parameterOrigin, 'system_observation');
  }
});

test('system observations cannot smuggle executable directives, legacy rules, or numeric risk limits', () => {
  const plan = createReportObservationPlan('missing', '', 'en', 'Asia/Shanghai', now);
  for (const entry of [{ ...plan.strategy.entries[0], directive: input().strategy.entries[0].directive },
    { ...plan.strategy.entries[0], mandateRule: {} }, { ...plan.strategy.entries[0], mandateReviewedText: 'Approved' }]) {
    assert.throws(() => parseReportExecutionPlan({ ...plan, strategy: { ...plan.strategy, entries: [entry] } }, new Set(), now));
  }
  assert.throws(() => parseReportExecutionPlan({ ...plan, strategy: { ...plan.strategy, limits: input().strategy.limits } }, new Set(), now));
  assert.throws(() => parseReportExecutionPlan({ ...plan, noTradeReason: undefined }, new Set(), now));
});
