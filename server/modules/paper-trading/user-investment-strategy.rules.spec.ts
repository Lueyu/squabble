import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStrategyDraft, previewStrategy, sourceAddition } from './user-investment-strategy.rules';
import type { StrategyDraftInput, StrategyDirective, StrategySourceSnapshot } from '../../../shared/user-investment-strategy.interface';

const now = new Date('2026-11-06T04:00:00Z');
const text = 'AAPL 到 100 买 10 股；本周有效。';
const directive = (): StrategyDirective => ({ ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_lte', price: 100 },
  quantity: 10, reviewedText: text, numericEvidence: [{ field: 'trigger.price', value: 100, quote: '100' }, { field: 'quantity', value: 10, quote: '10' }] });
const input = (): StrategyDraftInput => ({ title: '本周策略', body: text, timezone: 'Asia/Shanghai',
  startsAt: '2026-11-06T00:00:00Z', endsAt: '2026-11-09T00:00:00Z',
  entries: [{ id: 'apple', text, sourceKeys: [], directive: directive() }],
  limits: { maxPositionPct: 30, maxDailyIncreasePct: 10, maxDailyTurnoverPct: 30, minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 10 } });

test('free text remains an observation without inventing a trade or numbers', () => {
  const draft = normalizeStrategyDraft({ ...input(), body: '回调时适量加仓', entries: [{ id: 'observe', text: '回调时适量加仓', sourceKeys: [] }] });
  const preview = previewStrategy(draft, [], 3, now);
  assert.equal(preview.entries[0].state, 'observation');
  assert.equal(preview.directives.length, 0);
  assert.equal(preview.revision, 3);
});
test('a reviewed concrete price and quantity compiles without fabricated stop loss or investment bounds', () => {
  const preview = previewStrategy(normalizeStrategyDraft(input()), [], 4, now);
  assert.equal(preview.entries[0].state, 'executable');
  assert.equal(preview.directives[0].quantity, 10);
  assert.equal(preview.directives[0].trigger.price, 100);
  assert.equal(preview.directives[0].stopLossPrice, undefined);
  assert.match(preview.entries[0].explanation.en, /10 shares/);
  assert.equal(preview.entries[0].endsAt, input().endsAt);
});
test('changed natural language invalidates its earlier executable explanation', () => {
  const draft = input(); draft.entries[0].text = 'AAPL 只观察';
  const preview = previewStrategy(normalizeStrategyDraft(draft), [], 5, now);
  assert.equal(preview.directives.length, 0);
  assert.equal(preview.entries[0].state, 'needs_review');
  assert.ok(preview.issues.some(issue => issue.code === 'TEXT_CHANGED'));
});
test('invented quantities and nonexistent numeric evidence cannot compile', () => {
  const draft = input(); draft.entries[0].directive!.quantity = 99;
  const preview = previewStrategy(normalizeStrategyDraft(draft), [], 1, now);
  assert.equal(preview.directives.length, 0);
  assert.ok(preview.issues.some(issue => issue.code === 'UNSUPPORTED_NUMBER'));
});
test('semantic conditions require explicit authorization and an explicit amount', () => {
  const draft = input(); draft.entries[0].directive!.trigger = { kind: 'semantic', text: '回调企稳' };
  let preview = previewStrategy(normalizeStrategyDraft(draft), [], 1, now);
  assert.equal(preview.directives.length, 0);
  draft.entries[0].text += '回调企稳'; draft.entries[0].directive!.reviewedText = draft.entries[0].text;
  draft.entries[0].directive!.semanticAuthorized = true;
  preview = previewStrategy(normalizeStrategyDraft(draft), [], 1, now);
  assert.equal(preview.directives[0].route, 'ai');
});
test('opposite overlapping actions block confirmation but disjoint periods do not conflict', () => {
  const draft = input();
  draft.entries.push({ ...draft.entries[0], id: 'sell', text: text.replace('买', '卖'), directive: { ...directive(), side: 'sell', reviewedText: text.replace('买', '卖') } });
  const conflicting = previewStrategy(normalizeStrategyDraft(draft), [], 1, now);
  assert.equal(conflicting.canConfirm, false);
  assert.ok(conflicting.issues.some(issue => issue.code === 'OPPOSITE_ACTIONS'));
  draft.entries[0].endsAt = '2026-11-07T00:00:00Z'; draft.entries[1].startsAt = '2026-11-07T00:00:00Z';
  assert.equal(previewStrategy(normalizeStrategyDraft(draft), [], 1, now).canConfirm, true);
});
test('an expired entry stops new candidates without producing an exit', () => {
  const draft = input(); draft.entries[0].endsAt = '2026-11-06T02:00:00Z';
  const preview = previewStrategy(normalizeStrategyDraft(draft), [], 1, now);
  assert.equal(preview.entries[0].state, 'expired');
  assert.deepEqual(preview.directives, []);
});
test('per-stock periods must fit the total strategy and valid timezones', () => {
  assert.throws(() => normalizeStrategyDraft({ ...input(), timezone: 'invalid' }));
  const draft = input(); draft.entries[0].endsAt = '2027-01-01T00:00:00Z';
  assert.throws(() => normalizeStrategyDraft(draft));
});
test('source additions are immutable, deduplicated, and leave manual text unchanged', () => {
  const source: StrategySourceSnapshot = { key: 'report:11111111-1111-4111-8111-111111111111', kind: 'report', versionId: '11111111-1111-4111-8111-111111111111',
    title: '报告', content: 'AAPL 保持观察', contentHash: 'abc', createdAt: now.toISOString(), capturedAt: now.toISOString(), ticker: 'AAPL' };
  const draft = normalizeStrategyDraft(input()); const original = JSON.stringify(draft);
  const addition = sourceAddition(draft, [], source);
  assert.equal(addition.entries.length, 1);
  assert.equal(JSON.stringify(draft), original);
  assert.equal(sourceAddition(draft, [source], source).alreadyAdded, true);
  assert.deepEqual(sourceAddition(draft, [source], source).entries, []);
});

test('long research imports preserve every character across bounded observation entries', () => {
  const readableContent = 'Fictional research paragraph.\n\n'.repeat(510);
  const source: StrategySourceSnapshot = { key: 'report:long-research', kind: 'report', versionId: 'long-research',
    title: 'Long report', content: readableContent, readableContent, contentHash: 'exact-raw-hash',
    createdAt: now.toISOString(), capturedAt: now.toISOString(), ticker: null };
  const original = JSON.stringify(source);
  const addition = sourceAddition(input(), [], source);
  assert.equal(addition.entries.length, 2);
  assert.equal(addition.entries.map(entry => entry.text).join(''), readableContent);
  assert.ok(addition.entries.every(entry => entry.text.length <= 12000 && !entry.directive && !entry.mandateRule));
  assert.ok(addition.entries.every(entry => entry.sourceKeys[0] === source.key));
  assert.equal(new Set(addition.entries.map(entry => entry.id)).size, 2);
  assert.equal(JSON.stringify(source), original);
});

test('report plan additions copy reviewed entries and their exact validity instead of the report prose', () => {
  const strategy = input();
  const source = { key: 'report:owned:execution-strategy', kind: 'report' as const, versionId: 'owned', sectionId: 'execution-strategy',
    title: 'Report plan', content: 'Readable report strategy card', contentHash: 'abc', createdAt: now.toISOString(), capturedAt: now.toISOString(), ticker: null,
    executionPlan: { schemaVersion: 1, parameterOrigin: 'ai_proposed', strategy, evidenceIds: [], gaps: [], readiness: 'ready', preview: previewStrategy(strategy, [], 1, now) } };
  const original = JSON.stringify(source);
  const addition = sourceAddition(input(), [], source as StrategySourceSnapshot);
  assert.equal(addition.entries[0].text, strategy.entries[0].text);
  assert.deepEqual(addition.entries[0].directive?.numericEvidence, strategy.entries[0].directive?.numericEvidence);
  assert.equal(addition.entries[0].directive?.reviewedText, text);
  assert.equal(addition.entries[0].startsAt, strategy.startsAt);
  assert.equal(addition.entries[0].endsAt, strategy.endsAt);
  assert.deepEqual(addition.entries[0].sourceKeys, [source.key]);
  assert.equal(JSON.stringify(source), original, 'copying must preserve the immutable source');
});

test('report plan additions never inherit semantic permission or caller supplied source keys', () => {
  const strategy = input(); strategy.entries[0].sourceKeys = ['forged']; strategy.entries[0].directive!.semanticAuthorized = true;
  const source = { key: 'report:owned:execution-strategy', kind: 'report' as const, sectionId: 'execution-strategy', title: 'Report plan', content: 'Observe',
    contentHash: 'abc', createdAt: now.toISOString(), capturedAt: now.toISOString(), ticker: null,
    executionPlan: { schemaVersion: 1, parameterOrigin: 'ai_proposed', strategy, evidenceIds: [], gaps: [], readiness: 'ready', preview: previewStrategy(strategy, [], 1, now) } };
  const addition = sourceAddition(input(), [], source as StrategySourceSnapshot);
  assert.deepEqual(addition.entries[0].sourceKeys, [source.key]);
  assert.notEqual(addition.entries[0].directive?.semanticAuthorized, true);
});

test('an incomplete report proposal remains reviewable without attaching executable directives', () => {
  const strategy = input();
  const source = { key: 'report:owned:execution-strategy', kind: 'report' as const, sectionId: 'execution-strategy', title: 'Report plan', content: 'Observe',
    contentHash: 'abc', createdAt: now.toISOString(), capturedAt: now.toISOString(), ticker: null,
    executionPlan: { schemaVersion: 1, parameterOrigin: 'ai_proposed', strategy, evidenceIds: [], gaps: ['Customer evidence is unavailable'], readiness: 'needs_info', preview: previewStrategy(strategy, [], 1, now) } };
  const addition = sourceAddition(input(), [], source as StrategySourceSnapshot);
  assert.equal(addition.entries[0].directive, undefined);
  assert.equal(addition.entries[0].text, strategy.entries[0].text);
  const preview = previewStrategy({ ...strategy, entries: addition.entries }, [source as StrategySourceSnapshot], 1, now);
  assert.equal(preview.entries[0].state, 'needs_review');
  assert.equal(preview.canConfirm, false);
  assert.ok(preview.issues.some(issue => issue.code === 'REPORT_PLAN_NEEDS_INFO'));
});

test('an empty report proposal with gaps cannot confirm until the investor explicitly edits it', () => {
  const strategy = input(); strategy.entries = [];
  const source = { key: 'report:owned:execution-strategy', kind: 'report' as const, sectionId: 'execution-strategy', title: 'Report plan', content: 'Observe',
    contentHash: 'abc', createdAt: now.toISOString(), capturedAt: now.toISOString(), ticker: null,
    executionPlan: { schemaVersion: 1, parameterOrigin: 'ai_proposed', strategy, evidenceIds: [], gaps: ['No conditions were supplied'], readiness: 'needs_info', preview: previewStrategy(strategy, [], 1, now) } };
  assert.equal(previewStrategy(strategy, [source as StrategySourceSnapshot], 1, now).canConfirm, false);
  assert.equal(previewStrategy({ ...strategy, body: 'Explicitly reviewed observation.' }, [source as StrategySourceSnapshot], 1, now).canConfirm, true);
});

test('an explicit empty no-trade plan imports its exact reason as one owned observation', () => {
  const strategy = input(); strategy.entries = []; strategy.body = '';
  const reason = 'Current evidence does not justify adding risk.';
  const source = { key: 'report:owned:execution-strategy', kind: 'report' as const, sectionId: 'execution-strategy', title: 'Report plan', content: 'Unrelated whole report prose',
    contentHash: 'abc', createdAt: now.toISOString(), capturedAt: now.toISOString(), ticker: null,
    executionPlan: { schemaVersion: 1, parameterOrigin: 'ai_proposed', strategy, evidenceIds: [], gaps: [], noTradeReason: reason,
      readiness: 'no_trade', preview: previewStrategy(strategy, [], 1, now) } };
  const addition = sourceAddition(strategy, [], source as StrategySourceSnapshot);
  assert.equal(addition.entries.length, 1);
  assert.match(addition.entries[0].text, /AI proposal/u);
  assert.ok(addition.entries[0].text.endsWith(reason));
  assert.doesNotMatch(addition.entries[0].text, /Unrelated whole report/u);
  assert.deepEqual(addition.entries[0].sourceKeys, [source.key]);
  assert.equal(addition.entries[0].startsAt, strategy.startsAt); assert.equal(addition.entries[0].endsAt, strategy.endsAt);
  assert.equal(addition.entries[0].directive, undefined); assert.equal(addition.entries[0].mandateRule, undefined);
  const preview = previewStrategy({ ...strategy, entries: addition.entries }, [source as StrategySourceSnapshot], 1, now);
  assert.equal(preview.canConfirm, true); assert.equal(preview.entries[0].state, 'observation');
  assert.equal(preview.directives.length, 0); assert.equal(preview.mandateRules.length, 0);
});
test('security symbols use exact tokens and canonical symbols for conflicts', () => {
  const draft = input(); draft.entries[0].directive!.ticker = 'A';
  assert.equal(previewStrategy(normalizeStrategyDraft(draft), [], 1, now).directives.length, 0, 'A must not match the AAPL identifier');
  draft.entries[0].directive!.ticker = 'aapl';
  assert.equal(previewStrategy(normalizeStrategyDraft(draft), [], 1, now).directives[0].ticker, 'AAPL');
});
test('legacy measurable rules also require an exact natural-language review binding', () => {
  const draft = input(); delete draft.entries[0].directive;
  draft.entries[0].mandateRule = { id: 'legacy', ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_below', value: 100 },
    referencePrice: 100, minPrice: 95, maxPrice: 105, stopLossPrice: 90, maxPositionPct: 10, expiresAt: draft.endsAt,
    evidenceIds: ['report-version'], rationale: 'Fictional legacy boundary' };
  const source = { key: 'old', kind: 'report' as const, versionId: 'report-version', title: 'Legacy evidence', content: 'Fictional', contentHash: 'abc', ticker: 'AAPL', createdAt: now.toISOString(), capturedAt: now.toISOString() };
  const preview = previewStrategy(normalizeStrategyDraft(draft), [source], 1, now);
  assert.equal(preview.mandateRules.length, 0);
  assert.ok(preview.issues.some(issue => issue.code === 'TEXT_CHANGED'));
});
