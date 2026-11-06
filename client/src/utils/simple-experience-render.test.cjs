const assert = require('node:assert/strict');
const { test } = require('node:test');
const fixture = require('./simple-test-loader.cjs');
const { state, load, render } = fixture();

test('today retains facts without an AI and highlights only the top three real items', () => {
  const Page = load('pages/Today/TodayPage.tsx').default;
  state.queries.set('today', { data: { date: '2026-11-06', timezone: 'Asia/Shanghai', asOf: '2026-11-06T10:00:00Z',
    overview: { totalValueUsd: 12345, cashUsd: 250, dailyPnlUsd: null, returnPct: null, holdingCount: 2 },
    holdings: [], summary: null, attention: ['First', 'Second', 'Third', 'Fourth'].map((title, i) => ({ id: String(i), kind: 'data_gap', title, detail: 'Source gap' })),
    analysis: { state: 'empty' }, gaps: ['Missing opening valuation'], aiAvailable: false, marketTimes: [{ market: 'US', dataAsOf: null }] } });
  for (const language of ['en', 'zh-CN']) {
    state.language = language;
    const html = render(Page);
    assert.match(html, /12,345/);
    assert.match(html, /Missing opening valuation/);
    assert.match(html, /Third/);
    assert.doesNotMatch(html, /Fourth/);
    assert.match(html, language === 'en' ? /Connect AI/ : /连接 AI/u);
  }
});
test('a refresh keeps the last complete analysis readable while generation is pending', () => {
  const Panel = load('pages/Today/CurrentAnalysisPanel.tsx').default;
  state.language = 'en';
  const html = render(Panel, { view: { title: 'Test security', content: 'Saved complete finding', state: 'generating', updatedAt: '2026-11-05T10:00:00Z', dataAsOf: null }, topicKey: 'ticker:TEST' });
  assert.match(html, /Saved complete finding/);
  assert.match(html, /Updating/);
  assert.doesNotMatch(html, /Adopt|Publish|Create branch/);
});
test('a historical report renders original time and evidence without management actions', () => {
  const Reader = load('pages/Analysis/SimpleReportReader.tsx').default;
  state.queries.set('research-document', { data: { version: { id: 'old', title: 'Original rationale', createdAt: '2026-10-01T10:00:00Z',
    dataAsOf: '2026-09-30', sourceStatus: 'available', sections: [{ id: 'basis', title: 'Frozen basis', content: 'Facts at decision time' }] } } });
  const html = render(Reader, { versionId: 'old' });
  assert.match(html, /Original rationale/);
  assert.match(html, /2026-09-30/);
  assert.match(html, /Facts at decision time/);
  assert.doesNotMatch(html, /Adopt|Publish|Revise|branch|Latest generated/);
});
test('debate summary distinguishes an unresolved claim from missing evidence without voting', () => {
  const Summary = load('pages/Council/DebateSummary.tsx').default;
  state.language = 'en';
  const html = render(Summary, { mode: 'single', outcome: { confirmed: ['Reported cash balance'], disagreements: [
    { claimId: 'Demand recovery', positions: [{ memberId: 'researcher', view: 'Needs next filing', evidenceIds: [] }] }],
    currentAction: 'research_more', nextEvidence: ['Audited next quarter filing'] }, members: [{ id: 'researcher', name: 'Actual member' }] });
  assert.match(html, /Reported cash balance/);
  assert.match(html, /Demand recovery/);
  assert.match(html, /Needs next filing/);
  assert.match(html, /Audited next quarter filing/);
  assert.doesNotMatch(html, /consensus|votes|majority/i);
});
test('an empty portfolio leads with import while retaining cash and strategy access', () => {
  const Page = load('pages/Today/TodayPage.tsx').default;
  state.language = 'en';
  state.queries.set('today', { data: { date: '2026-11-06', timezone: 'Asia/Shanghai', asOf:'2026-11-06T04:00:00Z', overview: { holdingCount: 0,totalValueUsd:null,cashUsd:null,dailyPnlUsd:null,returnPct:null }, attention: [], gaps: [], holdings: [], analysis: { state: 'empty' }, aiAvailable: false, marketTimes: [] } });
  const html = render(Page);
  assert.match(html, /href="\/import"[^>]*>Import holdings/);
  assert.match(html, /Start with a research conversation/);
  assert.match(html, /Confirm cash/);
  assert.match(html, /Write a strategy/);
  assert.doesNotMatch(html, /Full portfolio analysis/);
});
test('settings names actual participants and stops selecting a fourth connection', () => {
  const Participants = load('pages/Settings/ResearchParticipantsPanel.tsx').default;
  state.language = 'en';
  state.queries.set('experience', { data: { defaultMembers: ['native-codex', 'model-one', 'model-two'] } });
  state.queries.set('["settings","local-agents"]', { data: [{ id: 'native-codex', name: 'Codex CLI', provider: 'codex', source: 'native', connected: true, available: true }] });
  state.queries.set('["settings","model-connections"]', { data: ['one', 'two', 'three'].map(id => ({ id: `model-${id}`, name: `Saved ${id}`, fastModel: `actual-model-${id}`, available: true })) });
  state.queries.set('["settings","integrations"]', { data: { llm: { available: false, engine: 'basic' } } });
  const html = render(Participants);
  assert.match(html, /Codex CLI/);
  assert.match(html, /actual-model-three/);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 4);
  assert.equal((html.match(/type="checkbox"[^>]*disabled=""/g) || []).length, 1);
  assert.match(html, /Save participation scope/);
});
