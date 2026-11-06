const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const fixture = require('./simple-test-loader.cjs');
const { state, load, render } = fixture();
const optionalComponent = name => existsSync(resolve(__dirname, '..', name)) ? load(name).default : () => null;

const base = { id: 'room', title: 'A real question', revision: 1, status: 'completed', mode: 'team', stage: 'completed',
  messages: [{ id: 'answer', memberId: 'codex', memberName: 'Codex', role: 'researcher', content: 'A preserved finding.', revision: 1, createdAt: '2026-11-06T01:00:00Z' }],
  reports: [], members: [{ id: 'codex', name: 'Codex', role: 'researcher' }, { id: 'opencode', name: 'OpenCode', role: 'researcher' }],
  actualExecutors: [{ memberId: 'codex', identity: 'codex', connection: 'Codex CLI', provider: 'codex', model: 'unreported' }],
  unavailableMembers: [], outcome: null,
  memberStates: [{ memberId: 'codex', attempt: 1, status: 'completed', resultAcceptance: 'accepted', lastActivityAt: '2026-11-06T01:00:00Z', recoveries: [] },
    { memberId: 'opencode', attempt: 1, status: 'failed', resultAcceptance: 'rejected', lastActivityAt: '2026-11-06T01:00:00Z',
      failure: { category: 'content_rejected', message: 'Research returned; content needs formatting.' }, recoveries: ['reparse_existing'] }] };

test('returned research has local recovery without a misleading connection prompt', () => {
  const Card = optionalComponent('pages/Council/CouncilRecoveryCard.tsx');
  const html = render(Card, { session: base, onRecover() {}, pending: false });
  assert.match(html, /Reformat saved result/);
  assert.doesNotMatch(html, /Connect AI|No AI connection|New discussion/);
});

test('a durable initializing receipt never flashes a connection error', () => {
  const session = { ...base, initializing: true, mode: 'unavailable', stage: 'waiting', status: 'idle', actualExecutors: [], memberStates: [], messages: [] };
  state.queries.set('research-conversation', { data: session });
  const html = render(load('pages/Council/SimpleCouncilPage.tsx').default);
  assert.match(html, /Question received\. Arranging your stock friends/);
  assert.doesNotMatch(html, /Connect AI|No AI member is connected|Some research needs attention/);
});

test('model repair exposes existing qualified model options and preserves saved reasoning settings', () => {
  const Form = optionalComponent('pages/Council/CouncilModelConfiguration.tsx');
  const html = render(Form, { connection: { connectionId: 'native-opencode', name: 'OpenCode', provider: 'opencode', state: 'configuration_required',
    effectiveModel: { id: 'deepseek-v4-flash', source: 'default' }, configuration: { reasoningEffort: 'high' },
    models: [{ id: 'gateway/deepseek-v4-flash', name: 'Configured DeepSeek' }], reasoningEfforts: ['low', 'high'] }, memberName: 'OpenCode', onSave: async () => [], onRetry() {}, retryAllowed: true });
  assert.match(html, /gateway\/deepseek-v4-flash/);
  assert.match(html, /value="high" selected/);
  assert.match(html, /Save configuration/);
});

test('a failed member keeps another member’s accepted answer and one aggregate recovery area', () => {
  state.queries.set('research-conversation', { data: base });
  const html = render(load('pages/Council/SimpleCouncilPage.tsx').default);
  assert.match(html, /A preserved finding/);
  assert.equal((html.match(/aria-label="Research recovery"/g) || []).length, 1);
  assert.doesNotMatch(html, /No AI connection is available/);
  assert.match(html, /Only one member completed\. Other members have not cross-checked/);
});

test('unreported model appears as local default only in secondary details', () => {
  const html = render(load('pages/Council/CouncilChatMessage.tsx').default, { message: base.messages[0], session: base,
    executor: base.actualExecutors[0], simple: true, onQuestion() {} });
  assert.doesNotMatch(html, /unreported/);
  assert.match(html, /Local default model/);
  assert.match(html, /<details/);
});

test('Today suppresses raw ledger JSON and asks about the exact report being read', () => {
  const Panel = load('pages/Today/CurrentAnalysisPanel.tsx').default;
  const html = render(Panel, { view: { title: 'Portfolio', content: '{"dailyLedgerFacts":{"secret":"internal"}}', summary: 'Readable portfolio finding.',
    researchLevel: 'ai', documentId: 'frozen-report', state: 'ready', keyPoints: ['One', 'Two', 'Three', 'Four'] }, topicKey: 'portfolio', date: '2026-11-06' });
  assert.doesNotMatch(html, /dailyLedgerFacts|secret|Four/);
  assert.match(html, /Readable portfolio finding/);
  assert.match(html, /referenceVersionId=frozen-report/);
});

test('reading away from the bottom is preserved when messages arrive', () => {
  const helpers = existsSync(resolve(__dirname, 'research-experience.ts')) ? load('utils/research-experience.ts') : {};
  assert.equal(helpers.isReadingLatest?.({ scrollHeight: 1500, clientHeight: 500, scrollTop: 200 }), false);
  assert.equal(helpers.isReadingLatest?.({ scrollHeight: 1500, clientHeight: 500, scrollTop: 998 }), true);
});

test('repeated public tool activity is grouped while its full record stays available', () => {
  const Timeline = load('pages/Council/CouncilResearchTimeline.tsx').default;
  const at = '2026-11-06T01:00:00Z';
  const html = render(Timeline, { task: { status: 'succeeded', startedAt: at, activities: [
    { key: 'one', kind: 'tool', toolName: 'get_news', status: 'succeeded', at, startedAt: at, summary: 'First public lookup' },
    { key: 'two', kind: 'tool', toolName: 'get_news', status: 'succeeded', at, startedAt: at, summary: 'Second public lookup' },
  ], sourceCount: 0 } });
  assert.match(html, /× 2/);
  assert.match(html, /First public lookup/);
  assert.match(html, /Second public lookup/);
});
