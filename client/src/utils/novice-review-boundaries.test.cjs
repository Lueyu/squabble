const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');

const person = (id, templateId) => ({ id, name: id, status: 'active', currentVersionId: id + '-v1', currentVersion: { config: { templateId } } });
function research(path, query) {
  const f = fixture();
  f.state.queries.set('agent-roster', query);
  const Page = f.load('pages/Analysis/ResearchWorkspacePage.tsx').default;
  return renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Page)));
}
test('an unavailable explicit friend never falls back to another paid research roster', () => {
  const html = research('/research?agent=archived', { data: { items: [person('Available friend', 'financials')] }, isPending: false });
  assert.match(html, /selected agent is unavailable/i);
  assert.doesNotMatch(html, /Send question/);
});
test('roster loading and read failure block creating a research task, while saved chats remain readable', () => {
  assert.doesNotMatch(research('/research', { isPending: true }), /Send question/);
  assert.doesNotMatch(research('/research', { isError: true }), /Send question/);
});
test('automatic run setup retries an unknown confirmation with the original frozen preview and request', async () => {
  const f = fixture();
  const { executeRunSetup } = f.load('features/teams/TeamRunPanel.tsx');
  const calls = [];
  const record = { key: 'intent', payload: { objective: 'Reviewed objective' } };
  let uncertain = true;
  const api = {
    preview: async (_team, input) => { calls.push(['preview', input]); return { previewId: 'exact-preview', previewHash: 'exact-hash' }; },
    confirm: async (_team, input) => { calls.push(['confirm', input]); if (uncertain) { uncertain = false; throw new Error('Lost response'); } return { revision: 7 }; },
    start: async (_team, input) => { calls.push(['start', input]); return { state: 'running' }; },
  };
  await assert.rejects(executeRunSetup('team', record, api), /Lost response/);
  await executeRunSetup('team', record, api);
  assert.equal(calls.filter(([operation]) => operation === 'preview').length, 1);
  assert.deepEqual(calls[1], calls[2]);
  assert.equal(calls[3][1].expectedRevision, 7);
});
test('definitively stale setup requires a fresh reviewed intent, while timeouts remain unknown', () => {
  const { runSetupNeedsReview } = fixture().load('features/teams/TeamRunPanel.tsx');
  assert.equal(runSetupNeedsReview({ response: { status: 409, data: { code: 'TEAM_PREVIEW_STALE' } } }), true);
  assert.equal(runSetupNeedsReview(new Error('Lost response')), false);
});
test('a suspended agreement still links its original paper account after the team changes binding', () => {
  const f = fixture();
  f.state.queries.set('team-run', { data: { agreement: { id: 'agreement', accountId: 'original-account', state: 'suspended', configuration: { market: 'US', cadence: { delayMinutes: 60 }, budget: { daily: { costUsd: '2' }, monthly: { costUsd: '40' } } }, members: [] }, recentCycles: [] } });
  const { TeamRunPanel } = f.load('features/teams/TeamRunPanel.tsx');
  const html = f.render(TeamRunPanel, { team: { id: 'team', accountId: 'different-account', status: 'active' }, zh: false });
  assert.match(html, /accountId=original-account/);
  assert.doesNotMatch(html, /accountId=different-account/);
});
