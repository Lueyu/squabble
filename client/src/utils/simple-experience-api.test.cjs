const assert = require('node:assert/strict');
const { test } = require('node:test');
const fixture = require('./simple-test-loader.cjs');

test('opening the new experience only reads; preview and start require explicit separate actions', async () => {
  const { load, state } = fixture();
  const experience = load('api/simple-experience.ts');
  const investment = load('api/ai-investment.ts');
  await experience.fetchExperiencePreferences();
  await experience.fetchToday();
  await investment.fetchAiInvestment();
  assert.equal(state.requests.length, 3);
  assert.ok(state.requests.every(request => request.method === 'get'));
});
test('cash preview preserves original currency and explicit cash amount without account selection', async () => {
  const { load, state } = fixture();
  const investment = load('api/ai-investment.ts');
  await investment.previewAiInvestment({ origin: 'cash', cash: { amount: 5432, currency: 'HKD' }, requestKey: 'cash-request' });
  assert.equal(state.requests[0].args[0], '/api/ai-investment/preview');
  assert.equal(JSON.stringify(state.requests[0].args[1]), JSON.stringify({ origin: 'cash', cash: { amount: 5432, currency: 'HKD' }, requestKey: 'cash-request' }));
});
test('pause, resume and restriction confirmation carry revision plus stable request identity', async () => {
  const { load, state } = fixture();
  const investment = load('api/ai-investment.ts');
  await investment.pauseAiInvestment({ expectedRevision: 8, requestKey: 'pause-request' });
  await investment.resumeAiInvestment({ expectedRevision: 9, requestKey: 'resume-request' });
  await investment.confirmInvestmentConstraint('proposal/id', { expectedPolicyRevision: 10, requestKey: 'confirm-request' });
  assert.equal(state.requests[0].args[1].expectedRevision, 8);
  assert.equal(state.requests[1].args[1].expectedRevision, 9);
  assert.equal(state.requests[2].args[0], '/api/ai-investment/constraints/proposal%2Fid/confirm');
  assert.equal(state.requests[2].args[1].expectedPolicyRevision, 10);
  assert.ok(state.requests.every(request => request.args[1].requestKey));
});
test('historical question sends the exact frozen evidence context without live ticker fallback', async () => {
  const { load, state } = fixture();
  const discussion = load('api/research-conversations.ts');
  await discussion.createResearchConversation({ message: 'Why this decision?', context: { kind: 'decision', orderId: 'old-order' }, requestKey: 'question-request' });
  await discussion.postResearchConversationMessage('session/id', { message: 'What changed?', replyTo: 'original-message', requestKey: 'reply-request' });
  assert.equal(state.requests[0].args[1].context.orderId, 'old-order');
  assert.equal(state.requests[0].args[1].context.ticker, undefined);
  assert.equal(state.requests[1].args[0], '/api/research-conversations/session%2Fid/messages');
  assert.equal(state.requests[1].args[1].replyTo, 'original-message');
});
test('participant scope saves actual connection IDs once and never a role or invented identity', async () => {
  const { load, state } = fixture();
  await load('api/simple-experience.ts').saveExperiencePreferences({ defaultMembers: ['native-codex', 'actual-connection-id'], requestKey: 'scope-request' });
  assert.equal(state.requests[0].args[0], '/api/experience/preferences');
  assert.equal(state.requests[0].args[1].defaultMembers.join(','), 'native-codex,actual-connection-id');
});
