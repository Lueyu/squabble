import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInterviewAnswer, answerInterview, acceptInterviewSuggestion, initialInterviewState, interviewDraft } from './strategy-interview.rules';

const now = new Date('2026-11-10T04:00:00Z');
test('free answers remain suggestions until explicitly accepted, and uncertain language stays pending', () => {
  let state = initialInterviewState('I want to invest slowly', now);
  assert.equal(state.confirmed.length, 0);
  assert.equal(state.suggestions[0].value.kind, 'idea');
  state = acceptInterviewSuggestion(state, state.suggestions[0].id, now);
  assert.equal(state.currentQuestion?.field, 'security');
  state = answerInterview(state, 'security', 'Maybe buy AAPL or MSFT, not sure', now);
  assert.equal(state.suggestions.length, 0);
  assert.equal(state.currentQuestion?.field, 'security');
  state = answerInterview(state, 'security', '买入 AAPL', now);
  assert.equal(state.confirmed.length, 1);
  assert.equal(state.suggestions[0].value.kind, 'security');
  state = acceptInterviewSuggestion(state, state.suggestions[0].id, now);
  assert.equal(state.confirmed[1].value.kind, 'security');
  assert.equal(state.currentQuestion?.field, 'condition');
});
test('strict operators and total targets are never confused with inclusive thresholds or increments', () => {
  assert.deepEqual(parseInterviewAnswer('condition', '价格低于 20', now), { kind: 'condition', trigger: { kind: 'price_lt', price: 20 } });
  assert.deepEqual(parseInterviewAnswer('condition', 'price <= 20', now), { kind: 'condition', trigger: { kind: 'price_lte', price: 20 } });
  assert.deepEqual(parseInterviewAnswer('amount', '买完后达到总资产的10%', now), { kind: 'amount', positionPct: 10 });
  assert.equal(parseInterviewAnswer('amount', '每次再增加10%', now), null);
  assert.equal(parseInterviewAnswer('amount', '大概目标10%', now), null);
  assert.equal(parseInterviewAnswer('condition', '价格低于20且成交量翻倍', now), null);
  assert.equal(parseInterviewAnswer('frequency', '每交易日最多一次', now)?.kind, 'frequency');
  assert.equal(parseInterviewAnswer('frequency', '本条规则每交易日最多执行一次', now)?.kind, 'frequency');
  assert.deepEqual(parseInterviewAnswer('amount', '买完后达到总资产的10%，不是每次再加10%', now), { kind: 'amount', positionPct: 10 });
  assert.deepEqual(parseInterviewAnswer('condition', 'price below 20', now), { kind: 'condition', trigger: { kind: 'price_lt', price: 20 } });
});
test('changing an answer preserves history and invalidates its dependent confirmations and old review', () => {
  let state = initialInterviewState('Observe value', now);
  state = acceptInterviewSuggestion(state, state.suggestions[0].id, now);
  for (const [field, text] of [['security', 'buy AAPL'], ['condition', 'price < 20'], ['amount', 'target total position 10%']] as const) {
    state = answerInterview(state, field, text, now);
    state = acceptInterviewSuggestion(state, state.suggestions[0].id, now);
  }
  const prior = state.confirmed.find(item => item.field === 'security')!;
  state.review = { strategyId: 'old', strategyRevision: 1, previewHash: 'hash', interviewRevision: 4 };
  state = answerInterview(state, 'security', 'buy MSFT', now);
  assert.deepEqual(state.confirmed.map(item => item.field), ['idea']);
  assert.equal(state.review, null);
  assert.equal(state.messages.at(-2)?.supersedesMessageId, prior.sourceMessageId);
  assert.ok(state.messages.some(item => item.id === prior.sourceMessageId));
});
test('incomplete interviews cannot produce executable directives, while observation retains exact original words', () => {
  const state = initialInterviewState('低频价值但不确定怎么买', now);
  assert.throws(() => interviewDraft(state, {}, false, now), /INTERVIEW_INCOMPLETE/);
  const draft = interviewDraft(state, {}, true, now);
  assert.match(draft.body, /低频价值但不确定怎么买/);
  assert.equal(draft.entries[0].directive, undefined);
});
test('explicit date ranges use the account timezone and invalid or unstated periods remain unresolved', () => {
  assert.deepEqual(parseInterviewAnswer('period', '2026-11-10 到 2026-11-11', now, 'Asia/Shanghai'), {
    kind: 'period', startsAt: '2026-11-09T16:00:00.000Z', endsAt: '2026-11-11T16:00:00.000Z', timezone: 'Asia/Shanghai',
  });
  assert.equal(parseInterviewAnswer('period', '长期', now), null);
  assert.equal(parseInterviewAnswer('period', '2026-02-30 到 2026-12-01', now), null);
  assert.equal(parseInterviewAnswer('period', '未来367天', now), null);
});

function throughCondition(side: 'buy' | 'sell') {
  let state = initialInterviewState('An explicit strategy', now);
  state = acceptInterviewSuggestion(state, state.suggestions[0].id, now);
  for (const [field, text] of [['security', `${side} AAPL`], ['condition', 'price < 100']] as const) {
    state = answerInterview(state, field, text, now);
    state = acceptInterviewSuggestion(state, state.suggestions[0].id, now);
  }
  return state;
}

test('amount answers cannot silently contradict the confirmed trade direction', () => {
  for (const [side, text] of [['buy', 'sell 5 shares'], ['buy', '卖出5股'], ['sell', 'buy 5 shares'],
    ['sell', '买完后达到总资产的10%'], ['sell', '买到总资产的10%'], ['sell', '补至总资产的10%']] as const) {
    const state = answerInterview(throughCondition(side), 'amount', text, now);
    assert.equal(state.suggestions.length, 0, `${side}: ${text} must stay unresolved`);
    assert.equal(state.currentQuestion?.field, 'amount');
    assert.equal(state.messages.at(-2)?.text, text, 'the contradictory original words remain saved');
  }
  for (const [side, text] of [['buy', 'buy 5 shares'], ['sell', '卖出5股'],
    ['buy', '买完后达到总资产的10%'], ['sell', 'target total position 10%']] as const) {
    assert.equal(answerInterview(throughCondition(side), 'amount', text, now).suggestions.length, 1, text);
  }
});

test('amount and condition answers never discard an extra ticker or mixed direction', () => {
  for (const text of ['sell MSFT 5 shares', '5 MSFT shares', '买入MSFT 5股', 'buy 5 shares and sell 2 shares']) {
    assert.equal(answerInterview(throughCondition('buy'), 'amount', text, now).suggestions.length, 0, text);
  }
  for (const text of ['MSFT price < 100', 'sell AAPL below 100', '价格低于100时卖出', 'price < 100 and sell MSFT']) {
    assert.equal(answerInterview(throughCondition('buy'), 'condition', text, now).suggestions.length, 0, text);
  }
});

test('saved contradictory amount suggestions and confirmations cannot authorize a draft', () => {
  const pending = answerInterview(throughCondition('buy'), 'amount', '5 shares', now);
  pending.messages.at(-2)!.text = 'sell 5 shares';
  pending.suggestions[0].quote = 'sell 5 shares';
  assert.throws(() => acceptInterviewSuggestion(pending, pending.suggestions[0].id, now), /INTERVIEW_SUGGESTION_CHANGED/);

  let confirmed = answerInterview(throughCondition('buy'), 'amount', '5 shares', now);
  confirmed = acceptInterviewSuggestion(confirmed, confirmed.suggestions[0].id, now);
  confirmed.confirmed.find(item => item.field === 'amount')!.quote = 'sell 5 shares';
  for (const [field, text] of [['frequency', 'once'], ['period', 'next 30 days']] as const) {
    confirmed = answerInterview(confirmed, field, text, now);
    confirmed = acceptInterviewSuggestion(confirmed, confirmed.suggestions[0].id, now);
  }
  assert.throws(() => interviewDraft(confirmed, { maxPositionPct: 30, maxDailyIncreasePct: 10, maxDailyTurnoverPct: 50 }, false, now), /INTERVIEW_ANSWER_CONFLICT/);
});

test('an independent edited field can be accepted while an earlier question remains pending', () => {
  let state = throughCondition('buy');
  for (const [field, text] of [['amount', '5 shares'], ['frequency', 'once'], ['period', 'next 30 days']] as const) {
    state = answerInterview(state, field, text, now);
    state = acceptInterviewSuggestion(state, state.suggestions[0].id, now);
  }
  state = answerInterview(state, 'security', 'buy MSFT', now);
  state = acceptInterviewSuggestion(state, state.suggestions[0].id, now);
  assert.equal(state.currentQuestion?.field, 'condition');
  state = answerInterview(state, 'frequency', 'once per trading day', now);
  state = acceptInterviewSuggestion(state, state.suggestions[0].id, now);
  assert.equal(state.currentQuestion?.field, 'condition');
  assert.deepEqual(state.confirmed.find(item => item.field === 'frequency')?.value,
    { kind: 'frequency', frequency: 'per_trading_day' });
});

test('acceptance requires the exact saved user message behind a pending suggestion', () => {
  const original = initialInterviewState('Preserve exact provenance', now);
  const missing = structuredClone(original);
  missing.suggestions[0].sourceMessageId = 'missing-message';
  assert.throws(() => acceptInterviewSuggestion(missing, missing.suggestions[0].id, now), /INTERVIEW_SUGGESTION_CHANGED/);
  const changed = structuredClone(original);
  changed.suggestions[0].quote = 'A different answer';
  assert.throws(() => acceptInterviewSuggestion(changed, changed.suggestions[0].id, now), /INTERVIEW_SUGGESTION_CHANGED/);
});

test('assistant replies provide locale-specific text while user messages remain exact', () => {
  const original = initialInterviewState('  My exact original idea  ', now);
  assert.equal(original.messages[0].text, '  My exact original idea  ');
  assert.equal(original.messages[0].localizedText, undefined);
  assert.equal(original.messages[1].localizedText?.en, 'Saved. Review the proposed reading before continuing.');
  const pending = answerInterview(throughCondition('buy'), 'amount', 'sell 5 shares', now);
  assert.match(pending.messages.at(-1)!.localizedText!.en, /exact share quantity/);
  assert.match(pending.messages.at(-1)!.localizedText!['zh-CN'], /多少股/);
});
