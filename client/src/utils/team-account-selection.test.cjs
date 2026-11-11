const { test } = require('node:test');
const assert = require('node:assert/strict');
const { QueryClient, QueryObserver } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

const context = () => fixture().load('features/assets/account-context.ts');

test('asset deep links make URL identity authoritative and only old missing context defaults to real', () => {
  const { readAssetAccount, holdingsHref, assetHref } = context();
  assert.deepEqual({ ...readAssetAccount('') }, { kind: 'real', id: 'real' });
  assert.deepEqual({ ...readAssetAccount('?accountId=real') }, { kind: 'real', id: 'real' });
  assert.deepEqual({ ...readAssetAccount('?accountId=foreign-id') }, { kind: 'paper', id: 'foreign-id' });
  assert.throws(() => readAssetAccount('?accountId='), /INVALID_ACCOUNT_CONTEXT/);
  assert.throws(() => readAssetAccount('?accountId=%20'), /INVALID_ACCOUNT_CONTEXT/);
  assert.equal(holdingsHref('account/a'), '/holdings?accountId=account%2Fa');
  assert.equal(assetHref('/transactions', 'a', '?ticker=FICT&accountId=old'), '/transactions?ticker=FICT&accountId=a');
});

test('real QueryObserver drops prior account rows on a switch and late A cannot overwrite B', async () => {
  const { paperAssetsQueryOptions } = context();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let resolveA;
  const pendingA = new Promise(resolve => { resolveA = resolve; });
  const a = paperAssetsQueryOptions('a', () => pendingA);
  const b = paperAssetsQueryOptions('b', async () => ({ accountId: 'b', positions: [{ ticker: 'B' }] }));
  const observer = new QueryObserver(client, a);
  const unsubscribe = observer.subscribe(() => {});
  observer.setOptions(b);
  assert.equal(observer.getCurrentResult().data, undefined, 'A rows must leave the interactive view immediately');
  await client.fetchQuery(b);
  resolveA({ accountId: 'a', positions: [{ ticker: 'A' }] });
  await pendingA;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observer.getCurrentResult().data.accountId, 'b');
  assert.equal(client.getQueryData(a.queryKey).accountId, 'a');
  assert.equal(client.getQueryData(b.queryKey).accountId, 'b');
  unsubscribe(); client.clear();
});

test('inaccessible explicit accounts remain failed rather than reading the real portfolio', async () => {
  const f = fixture();
  const { portfolioWorkspaceApi } = f.load('api/portfolio-workspace.ts');
  await portfolioWorkspaceApi.assets('foreign/account');
  assert.equal(f.state.requests[0].args[0], '/api/ai-investment/accounts/foreign%2Faccount/assets');
  await assert.rejects(portfolioWorkspaceApi.assets(''), /explicit simulation account/);
  const { paperAssetsQueryOptions } = context();
  const client = new QueryClient();
  const options = paperAssetsQueryOptions('missing', async () => { throw new Error('ACCOUNT_NOT_FOUND'); });
  await assert.rejects(client.fetchQuery(options), /ACCOUNT_NOT_FOUND/);
  assert.equal(client.getQueryData(options.queryKey), undefined);
  assert.equal(client.getQueryCache().findAll().length, 1);
  client.clear();
});
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');

test('a direct paper import blocks the real workflow until an explicit real choice', () => {
  const f = fixture();
  const { ImportAccountBoundary } = f.load('features/assets/AccountAssetsPage.tsx');
  const render = path => renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [path] },
    React.createElement(ImportAccountBoundary, null, React.createElement('div', null, 'REAL_IMPORT_WORKFLOW'))));
  const paper = render('/import?accountId=paper-a');
  assert.doesNotMatch(paper, /REAL_IMPORT_WORKFLOW/);
  assert.match(paper, /\/holdings\?accountId=paper-a/);
  assert.match(paper, /\/import\?accountId=real/);
  assert.doesNotMatch(render('/import?accountId='), /REAL_IMPORT_WORKFLOW/);
  assert.match(render('/import'), /REAL_IMPORT_WORKFLOW/);
  assert.match(render('/import?accountId=real'), /REAL_IMPORT_WORKFLOW/);
});

test('paper holdings render their own nullable ledger values and expose no real edit or import workflow', () => {
  const f = fixture();
  f.state.queries.set(JSON.stringify(['portfolio-assets', 'b']), { data: { accountId: 'b', positions: [{ id: 'p', ticker: 'FICT-B', company: null, market: 'HK', currency: 'HKD', shares: '2.5', avgCost: null, currentPrice: null, marketValue: null, unrealizedPl: null }], cash: [{ currency: 'HKD', available: '123.45', frozen: null, unsettled: null, availabilityKnown: true }], equityUsd: null, valuedAt: null, gaps: ['QUOTE_UNAVAILABLE:FICT-B'], orders: [], trades: [] }, isPending: false });
  const Page = f.load('features/assets/PaperAccountAssets.tsx').default;
  const html = f.render(Page, { accountId: 'b', accountName: 'Fictional B', mode: 'holdings' });
  assert.match(html, /FICT-B/); assert.match(html, /2.5/); assert.match(html, /123.45/);
  assert.match(html, /assets.costNotRecorded/); assert.match(html, /assets.incompleteValuation/);
  assert.doesNotMatch(html, /AddHoldingDialog|\/import|\/paper\/a\//);
});
test('asset section tabs carry the same account, retain a global watchlist return path and hide paper imports', () => {
  const f = fixture();
  const { WorkspaceSectionTabs } = f.load('features/navigation/WorkspaceNavigationBar.tsx');
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: ['/holdings?accountId=b&q=FICT'] }, React.createElement(WorkspaceSectionTabs)));
  assert.match(html, /\/transactions\?accountId=b/);
  assert.match(html, /\/watchlist\?returnTo=%2Fholdings%3FaccountId%3Db%26q%3DFICT&amp;accountId=b/);
  assert.doesNotMatch(html, /href="\/import/);
});
