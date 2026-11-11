const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

function decision(overrides = {}) {
  return { id: 'decision-a', teamId: 'original-team-a', accountId: 'account-a', commissionId: 'commission-a', proposalId: 'proposal-a', proposalRevision: 1, event: 'adopt', actorType: 'user', actorId: 'owner', reason: 'Maintain the original evidence-based judgment', createdAt: '2026-11-12T02:00:00Z', policyContext: null,
    basis: { teamVersionId: 'team-version-original', bindingId: 'binding-original', bindingRevision: 1, commissionId: 'commission-a', sessionId: 'session-a', cycleId: 'cycle-a', workKey: 'work-a', acceptedAttemptId: 'accepted-work-a', reportVersionId: 'report-output-a', thesisVersions: [], sourceRefs: [{ kind: 'document_version', id: 'same-new-information', revision: '2', availability: 'available' }] }, ...overrides };
}

test('historical decisions stay with their recorded account and latest judgment is separate from policy action', () => {
  const { accountDecisionRecords, decisionComparisonSummary } = fixture().load('features/portfolio-comparison/team-decision-comparison-state.ts');
  const adopted = decision();
  const applied = decision({ id: 'applied-a', event: 'applied', proposalRevision: 2, actorType: 'system', createdAt: '2026-11-12T03:00:00Z', reason: 'Confirmed policy applied' });
  const other = decision({ id: 'other-account', accountId: 'account-b', teamId: 'current-team-a', createdAt: '2026-11-12T04:00:00Z' });
  const records = accountDecisionRecords([other, applied, adopted], 'account-a');
  assert.equal(records.length, 2); assert.ok(records.every(row => row.accountId === 'account-a'));
  const summary = decisionComparisonSummary(records);
  assert.equal(summary.judgment.id, 'decision-a'); assert.equal(summary.action.id, 'applied-a');
  assert.equal(summary.judgment.teamId, 'original-team-a');
});

test('shared information is the exact intersection of versions actually used in decision bases', () => {
  const { sharedDecisionInputs } = fixture().load('features/portfolio-comparison/team-decision-comparison-state.ts');
  const a = decision();
  const b = decision({ id: 'decision-b', teamId: 'team-b', accountId: 'account-b', event: 'defer', reason: 'Weaken the earlier view because the new liquidity evidence is incomplete', createdAt: '2026-11-12T02:30:00Z' });
  const old = decision({ id: 'older-version-b', accountId: 'account-b', basis: { ...b.basis, sourceRefs: [{ kind: 'document_version', id: 'same-new-information', revision: '1', availability: 'available' }] } });
  const outputOnly = decision({ id: 'output-only-b', accountId: 'account-b', basis: { ...b.basis, reportVersionId: 'same-new-information', sourceRefs: [] } });
  assert.equal(sharedDecisionInputs(['account-a', 'account-b'], [a, old, outputOnly]).length, 0, 'different revisions and report outputs are not shared input');
  const groups = sharedDecisionInputs(['account-a', 'account-b'], [a, b, old]);
  assert.equal(groups.length, 1); assert.equal(groups[0].sourceRef.revision, '2');
  assert.equal(groups[0].members.find(row => row.accountId === 'account-b').judgment.id, 'decision-b');
});

test('current source availability requires an exact live grant and failed or missing reads remain unknown', () => {
  const { decisionSourceAvailability } = fixture().load('features/portfolio-comparison/team-decision-comparison-state.ts');
  const row = decision(), ref = row.basis.sourceRefs[0];
  const grant = { id: 'grant', teamId: row.teamId, state: 'active', sourceRef: ref };
  assert.equal(decisionSourceAvailability(row, ref, { sourceStatus: 'success', grants: [grant] }), 'available');
  assert.equal(decisionSourceAvailability(row, { ...ref, revision: '1' }, { sourceStatus: 'success', grants: [grant] }), 'unknown');
  assert.equal(decisionSourceAvailability(row, ref, { sourceStatus: 'error', grants: [grant] }), 'unknown');
  assert.equal(decisionSourceAvailability(row, ref, { sourceStatus: 'success', grants: [{ ...grant, state: 'revoked' }] }), 'revoked');
});

test('visible comparison uses recorded reasons, times and original links without a model winner', () => {
  const f = fixture(); const { TeamDecisionComparisonView } = f.load('features/portfolio-comparison/TeamDecisionComparison.tsx');
  const rows = [decision(), decision({ id: 'decision-b', teamId: 'team-b', accountId: 'account-b', event: 'defer', reason: 'Weaken the earlier judgment based on the same new evidence', createdAt: '2026-11-12T02:30:00Z' })];
  const teams = [{ id: 'original-team-a', name: 'Original team A', accountId: 'different-current-account', binding: { state: 'active' } }, { id: 'team-b', name: 'Team B', accountId: 'account-b', binding: { state: 'active' } }];
  const snapshots = Object.fromEntries(teams.map(team => [team.id, { scopeKey: 'account-a|account-b', decisionStatus: 'success', sourceStatus: 'success', decisions: rows.filter(row => row.teamId === team.id), grants: [{ teamId: team.id, state: 'active', sourceRef: rows[0].basis.sourceRefs[0] }], decisionsHaveMore: false, sourcesHaveMore: false }]));
  const html = f.render(TeamDecisionComparisonView, { accounts: [{ accountId: 'account-a', name: 'Account A', createdAt: '2026-11-01T00:00:00Z', strategyCount: 1 }, { accountId: 'account-b', name: 'Account B', createdAt: '2026-11-05T00:00:00Z', strategyCount: 3 }], teams, snapshots, scopeKey: 'account-a|account-b', zh: false, partial: false });
  for (const text of ['Maintain the original evidence-based judgment', 'Weaken the earlier judgment based on the same new evidence', 'Original team A', 'report-output-a', '2026', 'Currently available to both', 'does not attribute returns to models']) assert.ok(html.includes(text), text);
  assert.match(html, /\/teams\/original-team-a\?panel=history&amp;commissionId=commission-a/);
  assert.doesNotMatch(html, /Model winner|Team A is right|Both are free/);
});

test('account research status distinguishes active, currently empty and unknown without inventing history', () => {
  const { teamResearchStatus } = fixture().load('features/portfolio-comparison/team-decision-comparison-state.ts');
  assert.equal(teamResearchStatus(2, true), '研究中 2 项');
  assert.equal(teamResearchStatus(0, true), '当前无进行中委托');
  assert.equal(teamResearchStatus(undefined, true), '研究状态未知');
  assert.doesNotMatch(teamResearchStatus(0, false), /never|not started/);
});

test('folded comparison performs no decision reads; explicit pages and one-team errors stay independent', async () => {
  const { JSDOM } = require('jsdom'); const React = require('react'); const { createRoot } = require('react-dom/client');
  const { MemoryRouter } = require('react-router-dom'); const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const f = fixture({ realQuery: true }); const api = f.load('api/teams.ts').teamsApi;
  const a = decision(), b = decision({ id: 'decision-b', teamId: 'team-b', accountId: 'account-b', event: 'defer', reason: 'Weaken the view after the same input version' });
  const calls = [];
  api.decisions = async (id, cursor) => { calls.push(['GET decisions', id, cursor]); if (id === 'team-c') throw new Error('Fictional one-team failure'); return { items: id === a.teamId ? [cursor ? { ...a, id: 'older-a', createdAt: '2026-11-11T02:00:00Z' } : a] : [b], nextCursor: id === a.teamId && !cursor ? 'earlier-a' : null }; };
  api.sources = async (id, cursor) => { calls.push(['GET sources', id, cursor]); return { items: id === a.teamId && !cursor ? [] : [{ id: 'grant-'+id, teamId: id, state: 'active', sourceRef: a.basis.sourceRefs[0] }], nextCursor: id === a.teamId && !cursor ? 'source-next' : null }; };
  const teams = [{ id: a.teamId, name: 'Original team A', accountId: 'other-current-account', binding: { state: 'active' }, updatedAt: '2026-11-12T02:00:00Z' }, { id: 'team-b', name: 'Team B', accountId: 'account-b', binding: { state: 'active' }, updatedAt: '2026-11-12T02:00:00Z' }, { id: 'team-c', name: 'Team C', accountId: 'account-c', binding: { state: 'active' }, updatedAt: '2026-11-12T02:00:00Z' }];
  const accounts = ['a','b','c'].map(id => ({ accountId: 'account-'+id, name: 'Account '+id.toUpperCase(), createdAt: '2026-11-01T00:00:00Z', strategyCount: 1 }));
  const Component = f.load('features/portfolio-comparison/TeamDecisionComparison.tsx').TeamDecisionComparison;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const root = createRoot(document.getElementById('root'));
  const render = selected => React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(Component, { accounts: selected, teams, teamsLoading: false, teamsError: false, retryTeams() {}, zh: false })));
  const flush = async () => React.act(async () => new Promise(resolve => setTimeout(resolve, 50)));
  const button = name => [...document.querySelectorAll('button')].find(value => value.textContent === name);
  try {
    await React.act(async () => root.render(render(accounts))); await flush(); assert.equal(calls.length, 0);
    await React.act(async () => button('Compare judgments and actions').click()); await flush(); await flush();
    assert.match(document.body.textContent, /Maintain the original evidence-based judgment/); assert.match(document.body.textContent, /Weaken the view after the same input version/); assert.ok(button('Retry Team C judgments'));
    assert.doesNotMatch(document.body.textContent, /Currently available to both/);
    assert.equal(calls.filter(row => row[0] === 'GET decisions' && row[1] === a.teamId).length, 1, 'earlier decision pages require an explicit click');
    await React.act(async () => button('Read more Original team A source grants').click()); await flush();
    assert.match(document.body.textContent, /Currently available to both/);
    await React.act(async () => button('Load earlier Original team A decisions').click()); await flush();
    assert.equal(calls.filter(row => row[0] === 'GET decisions' && row[1] === a.teamId).length, 2);
    await React.act(async () => root.render(render([accounts[1]]))); await flush(); await flush();
    assert.doesNotMatch(document.body.textContent, /Maintain the original evidence-based judgment/); assert.match(document.body.textContent, /Weaken the view after the same input version/);
    assert.ok(calls.every(row => row[0].startsWith('GET')), 'the comparison has no write or paid dispatch operation');
  } finally { await React.act(async () => root.unmount()); client.clear(); dom.window.close(); global.window = previous.window; global.document = previous.document; global.IS_REACT_ACT_ENVIRONMENT = previous.act; }
});
