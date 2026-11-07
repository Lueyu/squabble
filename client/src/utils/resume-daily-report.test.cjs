const assert = require('node:assert/strict');
const { test } = require('node:test');
const fixture = require('./simple-test-loader.cjs');

test('a paused daily session with no final report offers continuation instead of claiming formatting is pending', () => {
  const { load, render } = fixture();
  const html = render(load('pages/Today/CurrentAnalysisPanel.tsx').default, {
    topicKey: 'portfolio', view: { state: 'failed', readingState: 'pending', sessionId: 'saved-daily', documentId: null, returnedDocumentId: null },
  });
  assert.match(html, /Complete saved daily report/);
  assert.doesNotMatch(html, /Reformat saved result|Research returned · Formatting pending/);
});

test('resuming saved daily research retains the exact intent after a lost response', async () => {
  const { state, load, render } = fixture();
  const api = load('api/research-conversations.ts');
  let reads = 0;
  const attempts = [];
  api.fetchResearchConversation = async () => { reads++; return { revision: 4 }; };
  api.resumeDailyReport = async (id, input) => {
    attempts.push({ id, ...input });
    if (attempts.length === 1) throw new Error('response lost');
    return { id, revision: 5 };
  };
  let mutation;
  state.mutationFactory = options => {
    mutation = options;
    return { isPending: false, mutate() {} };
  };
  const html = render(load('pages/Today/ResumeDailyReportButton.tsx').default, { sessionId: 'saved-daily' });
  assert.match(html, /Complete saved daily report/);
  assert.match(html, /Locally reformats returned results first/);
  assert.equal(mutation.retry, false);
  await assert.rejects(mutation.mutationFn(), /response lost/);
  await mutation.mutationFn();
  assert.equal(reads, 1);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(attempts[0].expectedRevision, 4);
});

test('the daily report recovery API uses its dedicated endpoint', async () => {
  const { state, load } = fixture();
  await load('api/research-conversations.ts').resumeDailyReport('saved/daily', { requestKey: 'key', expectedRevision: 4 });
  assert.deepEqual(state.requests, [{ method: 'post', args: ['/api/research-conversations/saved%2Fdaily/resume-report', { requestKey: 'key', expectedRevision: 4 }] }]);
});
