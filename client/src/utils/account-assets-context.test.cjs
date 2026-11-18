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
  if (team) f.state.queries.set(JSON.stringify(['portfolio-assets', team.accountId]), { data: {
    accountId: team.accountId, positions: [], cash: [], orders: [], trades: [], gaps: [], equityUsd: null, valuedAt: null,
  } });
  const { AccountAssetsPage } = f.load('features/assets/AccountAssetsPage.tsx');
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [path] },
    React.createElement(AccountAssetsPage, { mode, real: React.createElement('article', null, 'REAL_ASSETS') })));
  return new JSDOM(html);
}

test('account controls show the selected real account and its separate management entry', () => {
  for (const mode of ['holdings', 'transactions']) {
    const dom = renderContext({ mode, path: `/${mode}?accountId=real&q=FICT#cash` });
    try {
      const context = dom.window.document.querySelector('section[aria-label="assets.accountContext"]');
      assert.match(context.querySelector('[aria-current="page"]').getAttribute('href'), /accountId=real/);
      assert.doesNotMatch(context.textContent, /assets.globalWatchlist/, 'the watchlist page owns its scope notice');
      assert.ok(context.querySelector('a[href="/holdings/accounts"]'));
      assert.equal(context.querySelector('a[href^="/import"]'), null, 'the header owns the import action');
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

test('paper holdings retain the bound-team link and omit the real import action', () => {
  const dom = renderContext({ path: '/holdings?accountId=paper-a', team: { id: 'team/a', accountId: 'paper-a', binding: { state: 'active' } } });
  try {
    const document = dom.window.document;
    const teamLinks = document.querySelectorAll('a[href="/teams/team%2Fa"]');
    assert.equal(teamLinks.length, 1);
    assert.match(teamLinks[0].textContent, /View team run/);
    assert.equal(document.querySelector('a[href^="/import"]'), null);
  } finally { dom.window.close(); }
});
