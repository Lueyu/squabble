const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./simple-test-loader.cjs');
const { JSDOM } = require('jsdom');
function load() {
  assert.ok(fs.existsSync(path.resolve(__dirname, '../api/strategy-interviews.ts')), 'persistent interview API must exist');
  return fixture();
}
test('interview transport keeps account, revision and exact request intent', async () => {
  const f = load();
  const { strategyInterviewsApi: api } = f.load('api/strategy-interviews.ts');
  await api.create({ accountId:'account-a', message:'Buy a little', requestKey:'create' });
  await api.answer('id/a', { expectedRevision:2, field:'amount', message:'10% total', requestKey:'answer' });
  await api.accept('id/a', { expectedRevision:3, suggestionId:'proposal', requestKey:'accept' });
  await api.preview('id/a', { expectedRevision:4, requestKey:'review' });
  assert.deepEqual(f.state.requests.map(r=>r.args[0]), [
    '/api/strategy-interviews','/api/strategy-interviews/id%2Fa/messages',
    '/api/strategy-interviews/id%2Fa/accept','/api/strategy-interviews/id%2Fa/preview',
  ]);
  assert.equal(f.state.requests[1].args[1].expectedRevision, 2);
});
test('resuming a revised answer preserves its field and a lost response reuses the request key', () => {
  globalThis.window = new JSDOM('', { url: 'http://localhost' }).window;
  const state = load().load('features/strategy-interview/interview-state.ts');
  state.saveComposer('interview-a', '12 shares', 'amount');
  assert.equal(state.readComposer('interview-a'), '12 shares');
  assert.equal(state.readComposerField('interview-a'), 'amount');
  let next = 0;
  const generate = () => 'request-' + ++next;
  const payload = { revision: 3, field: 'amount', text: '12 shares' };
  const first = state.createInterviewIntent('a', generate);
  const key = first.keyFor(payload);
  const restored = state.createInterviewIntent('a', generate);
  assert.equal(restored.keyFor(payload), key);
  assert.notEqual(restored.keyFor({ ...payload, text: '13 shares' }), key);
  restored.complete();
  assert.notEqual(state.createInterviewIntent('a', generate).keyFor(payload), key);
  state.saveComposer('interview-a', '');
  assert.equal(state.readComposerField('interview-a'), null);
  const sent = state.createInterviewIntent('lost', generate).prepare('answer', { expectedRevision: 2, field: 'amount', message: '12 shares' });
  const retried = state.createInterviewIntent('lost', generate).prepare('answer', { expectedRevision: 3, field: 'amount', message: '12 shares' });
  assert.deepEqual(JSON.parse(JSON.stringify(retried)), JSON.parse(JSON.stringify(sent)), 'retain original revision even when the reloaded server state already advanced');
});
test('revised strategy staging replaces only its base and requires explicit re-enabling', () => {
  const { stageInterviewAllocation } = load().load('features/strategy-interview/interview-state.ts');
  const original = [{strategyId:'a',strategyRevision:1,allocationPct:30,enabled:true},{strategyId:'b',strategyRevision:2,allocationPct:20,enabled:true}];
  const staged = stageInterviewAllocation(original,'a-new',1,'a');
  assert.equal(staged.some(item => item.strategyId === 'a'), false);
  assert.equal(staged.find(item=>item.strategyId==='b').enabled,true);
  const replacement = staged.find(item=>item.strategyId==='a-new');
  assert.equal(replacement.enabled,false);
  assert.equal(replacement.allocationPct,30);
});
test('an edited interview cannot reuse a previous strategy review', () => {
  const f = load();
  const { isInterviewReviewCurrent } = f.load('features/strategy-interview/interview-state.ts');
  const interview = {revision:8,review:{strategyId:'a',strategyRevision:3,previewHash:'hash',interviewRevision:8}};
  const strategy = {id:'a',revision:3,preview:{contentHash:'hash'}};
  assert.equal(isInterviewReviewCurrent(interview,strategy),true);
  assert.equal(isInterviewReviewCurrent({...interview,revision:9},strategy),false);
  assert.equal(isInterviewReviewCurrent(interview,{...strategy,revision:4}),false);
  assert.equal(isInterviewReviewCurrent(interview,{...strategy,preview:null}),false);
  assert.equal(isInterviewReviewCurrent({...interview,review:null},strategy),false);
});
