const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

test('an older server with no provenance projection remains unknown rather than an asserted empty history', () => {
  const f = fixture();
  const { ExecutionProvenance } = f.load('features/assets/ExecutionProvenance.tsx');
  assert.match(f.render(ExecutionProvenance, {}), /This server did not return historical judgment links/);
  assert.match(f.render(ExecutionProvenance, { entries: [] }), /Historical judgment not recorded/);
});

test('execution links use the recorded order source or an exact trade target, never an empty order id', () => {
  const { teamLedgerHref } = fixture().load('features/teams/team-ledger-link.ts');
  assert.equal(teamLedgerHref('account-a', { kind: 'trade', targetId: 'trade-a', metadata: { sourceKind: 'order', sourceId: 'original-order' } }), '/transactions?accountId=account-a&orderId=original-order');
  assert.equal(teamLedgerHref('account-a', { kind: 'trade', targetId: 'trade-a', metadata: {} }), '/transactions?accountId=account-a&tradeId=trade-a');
  assert.equal(teamLedgerHref('account-a', { kind: 'order', targetId: 'order-a', metadata: {} }), '/transactions?accountId=account-a&orderId=order-a');
});

test('ledger actions expose their own frozen team decision, report and attempt without substituting current attribution', () => {
  const f = fixture();
  f.state.queries.set(JSON.stringify(['portfolio-assets', 'a']), { data: { accountId: 'a', positions: [], cash: [],
    equityUsd: null, valuedAt: null, gaps: [],
    orders: [{ id: 'order-1', ticker: 'FICT', side: 'buy', quantity: '1', status: 'filled', currency: 'USD', filledPrice: '10', filledAt: null, createdAt: '2020-01-01' },
      { id: 'legacy', ticker: 'FICT', side: 'buy', quantity: '1', status: 'pending', currency: 'USD', filledPrice: null, filledAt: null, createdAt: '2020-01-01' }], trades: [],
    executionProvenance: [{ kind: 'order', targetId: 'order-1', teamId: 'original', teamName: 'Original team', teamVersionId: 'version-1', teamVersion: 1,
      commissionId: 'commission-1', workKey: 'cash-flow', attemptId: 'accepted-attempt', reportAvailability: 'available',
      decision: { id: 'decision-1', proposalId: 'proposal-1', proposalRevision: 3, event: 'adopt', reason: 'Cash conversion improved', createdAt: '2020-01-01',
        basis: { reportVersionId: 'report-v3', acceptedAttemptId: 'accepted-attempt', thesisVersions: [{ thesisId: 'thesis-1', versionId: 'thesis-v3' }] } } }],
  }, isPending: false });
  const Page = f.load('features/assets/PaperAccountAssets.tsx').default;
  const html = f.render(Page, { accountId: 'a', accountName: 'Current replacement account', mode: 'transactions' });
  assert.match(html, /Original team/);
  assert.match(html, /Cash conversion improved/);
  assert.match(html, /\/teams\/original\?panel=history&amp;commissionId=commission-1&amp;proposalId=proposal-1&amp;decisionId=decision-1/);
  assert.match(html, /\/analysis\/reports\/report-v3/);
  assert.match(html, /accepted-attempt/);
  assert.match(html, /thesis-v3/);
  assert.match(html, /Historical judgment not recorded/);
});
