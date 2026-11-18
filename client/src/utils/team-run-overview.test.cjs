const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fixture = require('./simple-test-loader.cjs');

test('independent evidence failures never masquerade as empty fills or research', () => {
  const f = fixture();
  const Evidence = f.load('features/teams/TeamRunEvidence.tsx').TeamRunEvidence;
  const props = { teamId: 'team', teamName: 'Test team', zh: false, market: 'CN' };
  f.state.queries.set('team-run-fills', { isError: true });
  f.state.queries.set('team-run-research', { data: { report: { versionId: 'original', version: 2, commissionId: 'commission',
    source: 'manual', publishedAt: '2026-11-18T08:00:00Z', title: 'Pinned report', summary: 'Original evidence', applied: null } } });
  const research = f.state.queries.get('team-run-research').data;
  const html = f.render(Evidence, props);
  assert.match(html, /Fills are temporarily unavailable/);
  assert.doesNotMatch(html, /No paper fills yet/);
  assert.match(html, /Manual commission/);
  assert.match(html, /href="\/analysis\/reports\/original"/);
  f.state.queries.set('team-run-fills', { data: [] });
  f.state.queries.set('team-run-research', { isError: true });
  const other = f.render(Evidence, props);
  assert.match(other, /No paper fills yet/);
  assert.match(other, /Research is temporarily unavailable/);
  assert.doesNotMatch(other, /No published research yet/);
  f.state.queries.set('team-run-research', { data: research, isError: true, error: { response: { status: 503 } } });
  assert.match(f.render(Evidence, props), /Last read/);
  f.state.queries.set('team-run-research', { data: research, isError: true, error: { response: { status: 403 } } });
  assert.doesNotMatch(f.render(Evidence, props), /Pinned report/);
});

test('blocked and uncertain cycles identify the original commission while preserving run controls', () => {
  const f = fixture();
  const Panel = f.load('features/teams/TeamRunPanel.tsx').TeamRunPanel;
  const budget = { perRun: { ceiling: { amount: null }, callLimit: 8 }, daily: { costUsd: null, calls: null }, monthly: { costUsd: null, calls: null } };
  const agreement = { state: 'running', accountId: 'paper', members: [],
    configuration: { market: 'CN', budget, cadence: { delayMinutes: 60 } } };
  for (const [state, title] of [['blocked', 'Review the blocked cycle'], ['uncertain', 'Check the original request']]) {
    f.state.queries.set('team-run', { data: { agreement, confirmationRevision: 1, nextWindow: { kind: 'unknown' },
      recentCycles: [{ state, id: 'cycle', agreementRevision: 2, tradingDate: '2026-11-18', commissionId: 'original', lastError: 'Provider receipt pending' }] } });
    const doc = new JSDOM(f.render(Panel, { team: { id: 'team' }, zh: false })).window.document;
    assert.equal(doc.querySelector('.run-hero h2').textContent, title);
    assert.match(doc.querySelector('.run-hero').textContent, /Provider receipt pending/);
    assert.match(doc.querySelector('.run-hero').textContent, /Time to be confirmed/);
    assert.equal(doc.querySelector('.run-hero a').getAttribute('href'), '/teams/team?panel=history&commissionId=original');
  }
});
