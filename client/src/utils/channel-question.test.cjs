const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

test('channel question payload carries selection and deferred facts retain their original scope', async () => {
  const local = fixture();
  const { channelQuestionPayload } = local.load('utils/channel-question.ts');
  const api = local.load('api/channel.ts');
  const payload = channelQuestionPayload('USD cash?', 'simulation-b', { kind: 'stock', ticker: 'AAPL' });
  await api.postChannelQuestion({ ...payload, requestKey: 'scope-receipt' });
  assert.equal(local.state.requests[0].args[1].accountId, 'simulation-b');
  assert.equal(local.state.requests[0].args[1].context.ticker, 'AAPL');
  const deferred = { id: 'saved-fact', text: 'Recorded shares?', accountId: 'simulation-a', context: { kind: 'stock', ticker: 'MSFT' } };
  const chosen = channelQuestionPayload(deferred.text, 'simulation-b', { kind: 'stock', ticker: 'AAPL' }, deferred);
  assert.equal(chosen.accountId, 'simulation-a');
  assert.equal(chosen.context.ticker, 'MSFT');
  const real = channelQuestionPayload('Real cash?', 'simulation-b', undefined, { id: 'old-owner-fact', text: 'Real cash?' });
  assert.equal(real.accountId, undefined, 'legacy real-ledger deferred facts never inherit a new simulation selection');
  await api.fetchChannelPending('simulation-b');
  assert.equal(local.state.requests[1].args[1].params.accountId, 'simulation-b', 'the pending drawer uses the same account as the channel view');
});

test('uncertain question retries preserve request identity and cannot silently retarget accounts', () => {
  const { createChannelQuestionIntent } = fixture().load('utils/channel-question.ts');
  let next = 0;
  const intent = createChannelQuestionIntent(() => `receipt-${++next}`);
  const input = { message: 'USD cash?', accountId: 'simulation-a' };
  const first = intent.request(input);
  assert.equal(intent.request(input).requestKey, first.requestKey);
  assert.throws(() => intent.request({ ...input, accountId: 'simulation-b' }), /CHANNEL_QUESTION_SCOPE_CHANGED/);
  assert.equal(intent.request(input).requestKey, first.requestKey, 'scope error does not lose the original receipt');
  assert.notEqual(intent.request({ message: 'A new question', accountId: 'simulation-b' }).requestKey, first.requestKey);
  intent.complete();
  assert.equal(intent.request(input).requestKey, 'receipt-3');
});
