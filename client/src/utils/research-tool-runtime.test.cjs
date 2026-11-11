const assert = require('node:assert/strict');
const { test } = require('node:test');
const fixture = require('./simple-test-loader.cjs');

const pending = state => ({ runId: 'run', memberId: 'one', turn: 0, state, stepId: 'step', expectedCursor: 4 });
const session = state => ({ id: 'session', revision: 1, status: 'paused', members: [{ id: 'one', name: 'One' }],
  runtimePending: [pending(state)] });

test('unknown synchronous runs expose saved-status and explicit close, with no retry or false remote lookup', () => {
  const { load, render } = fixture();
  const html = render(load('features/research-workspace/ResearchToolActivity.tsx').ResearchToolActivity, { session: session('provider_unknown') });
  assert.match(html, /cannot retrieve a remote result/);
  assert.match(html, /Refresh saved status/);
  assert.match(html, /Close unknown run; retain reservation/);
  assert.doesNotMatch(html, /Resume original run|Revalidate saved response|Retry member/);
});

test('local reparse is shown only for a durable failed response and viewing history has no recovery controls', () => {
  const { state, load, render } = fixture();
  state.queries.set('research-runtime', { data: [{ id: 'run', state: 'failed', steps: [{ id: 'step', index: 0,
    state: 'parse_failed', model: 'fixture', hasStoredResponse: true, usageKnown: false }], tools: [] }] });
  const component = load('features/research-workspace/ResearchToolActivity.tsx').ResearchToolActivity;
  assert.match(render(component, { session: session('failed') }), /Revalidate saved response only/);
  const history = render(component, { session: session('failed'), readOnly: true });
  assert.match(history, /Usage unknown/);
  assert.doesNotMatch(history, /Revalidate saved response only|Refresh saved status|Resume original run/);
  assert.equal(state.requests.length, 0);
});

test('approval state alone never claims execution completed or enables an absent preview', () => {
  const { load, render } = fixture();
  const html = render(load('features/research-workspace/ResearchToolActivity.tsx').ResearchToolActivity, { session: session('waiting_approval') });
  assert.match(html, /waiting_approval/);
  assert.match(html, /disabled=""[^>]*>Resume original run after approval/);
  assert.doesNotMatch(html, /Write completed|Sent successfully/);
});
