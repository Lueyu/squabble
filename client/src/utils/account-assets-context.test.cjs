const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');
const { JSDOM } = require('jsdom');
const fixture = require('./simple-test-loader.cjs');

function renderContext({ simple = true, path = '/holdings?accountId=real&q=FICT#cash', mode = 'holdings', team } = {}) {
  const f = fixture();
  f.state.simpleExperience = simple;
  f.state.queries.set('asset-account-teams', { data: team ? [team] : [] });
  const { AccountAssetsPage } = f.load('features/assets/AccountAssetsPage.tsx');
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [path] },
    React.createElement(AccountAssetsPage, { mode, real: React.createElement('article', null, 'REAL_ASSETS') })));
  return new JSDOM(html);
}

test('simple assets keeps the selected account without repeating links or another page’s scope notice', () => {
  for (const mode of ['holdings', 'transactions']) {
    const dom = renderContext({ mode, path: `/${mode}?accountId=real&q=FICT#cash` });
    try {
      const context = dom.window.document.querySelector('section[aria-label="assets.accountContext"]');
      assert.ok(context.querySelector('#asset-account-selector'), 'the account choice remains explicit');
      assert.doesNotMatch(context.textContent, /assets.globalWatchlist/, 'the watchlist page owns its scope notice');
      assert.equal(context.querySelectorAll('a').length, 0, 'section tabs already own ledger, watchlist and import navigation');
      assert.match(dom.window.document.body.textContent, /REAL_ASSETS/);
    } finally { dom.window.close(); }
  }
});

test('legacy assets preserves section destinations, exact account and source return URL', () => {
  const dom = renderContext({ simple: false });
  try {
    const document = dom.window.document;
    assert.ok(document.querySelector('a[href="/transactions?accountId=real"]'));
    assert.ok(document.querySelector('a[href="/import?accountId=real"]'));
    const watchlist = [...document.querySelectorAll('a')].find(link => link.textContent === 'assets.watchlist');
    const url = new URL(watchlist.getAttribute('href'), 'http://localhost');
    assert.equal(url.searchParams.get('accountId'), 'real');
    assert.equal(url.searchParams.get('returnTo'), '/holdings?accountId=real&q=FICT#cash');
  } finally { dom.window.close(); }
});

test('simple simulation assets retains its unique bound-team destination', () => {
  const dom = renderContext({ path: '/holdings?accountId=paper-a', team: { id: 'team/a', accountId: 'paper-a', binding: { state: 'active' } } });
  try {
    const context = dom.window.document.querySelector('section[aria-label="assets.accountContext"]');
    assert.equal(context.querySelectorAll('a').length, 1);
    assert.equal(context.querySelector('a').getAttribute('href'), '/teams/team%2Fa');
    assert.equal(context.querySelector('a').textContent, 'assets.openTeam');
  } finally { dom.window.close(); }
});
