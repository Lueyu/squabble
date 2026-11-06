const assert = require('node:assert/strict');
const { test } = require('node:test');
const fixture = require('./simple-test-loader.cjs');

test('a saved report keeps its exact reading link while formatting needs review', () => {
  const { load, render } = fixture();
  const html = render(load('pages/Today/CurrentAnalysisPanel.tsx').default, {
    topicKey: 'portfolio', primary: true,
    view: { topicKey: 'portfolio', documentId: 'saved-version', content: '', summary: null,
      state: 'failed', readingState: 'pending', researchLevel: 'facts_only', taskId: 'returned-task' },
  });
  assert.match(html, /href="\/analysis\/reports\/saved-version"/);
  assert.match(html, /Read saved report/);
  assert.doesNotMatch(html, /have not completed this research yet|Portfolio facts · AI research pending/);
  assert.match(html, /Reformat saved result/);
});

test('a failed formatting retry shows an actionable error', () => {
  const { state, load, render } = fixture();
  state.mutationFactory = () => ({ isPending: false, isError: true, mutate() {} });
  const html = render(load('pages/Today/CurrentAnalysisPanel.tsx').default, {
    topicKey: 'portfolio', view: { documentId: 'saved-version', content: '', state: 'failed', readingState: 'pending' },
  });
  assert.match(html, /Could not reformat the saved result/);
  assert.match(html, /Read saved report/);
});

test('a returned daily report remains reachable without replacing an older complete report', () => {
  const { load, render } = fixture();
  const html = render(load('pages/Today/CurrentAnalysisPanel.tsx').default, {
    topicKey: 'portfolio', view: { documentId: 'previous-report', content: 'Earlier complete finding.', state: 'ready' },
    activityView: { state: 'failed', readingState: 'pending', returnedDocumentId: 'new-returned-report' },
  });
  assert.match(html, /href="\/analysis\/reports\/new-returned-report"/);
  assert.match(html, /Earlier complete finding/);
});
