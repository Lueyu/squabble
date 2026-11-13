const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/teams' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'FormData', 'CustomEvent', 'DocumentFragment', 'MutationObserver', 'getComputedStyle', 'Element', 'Node', 'NodeFilter', 'Event']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');

test('removal reviews exact pause-all input, requires consent, and retries unknown preview and commit with the same payload', async () => {
  const f = fixture(); let serial = 0;
  f.state.randomUUID = () => 'removal-' + ++serial;
  const api = f.load('api/teams.ts').teamsApi;
  const calls = []; let previewUnknown = true; let confirmUnknown = true; let removed = null;
  api.detail = async () => ({ id: 'team-a', name: 'Retained team', bindingRevision: 7, currentVersionId: 'version-seven' });
  api.archivePreview = async (id, input) => {
    calls.push({ operation: 'preview', id, input });
    if (previewUnknown) { previewUnknown = false; throw new Error('Lost preview response'); }
    return { previewId: 'reviewed-preview', previewHash: 'exact-hash', expiresAt: '2099-01-01', warnings: [], result: { inflightCommissions: [], accountId: 'account-a', executionChoice: 'pause_all' } };
  };
  api.archive = async (id, input) => {
    calls.push({ operation: 'confirm', id, input });
    if (confirmUnknown) { confirmUnknown = false; throw new Error('Lost removal response'); }
    return { team: { id, status: 'archived' }, binding: null };
  };
  const { TeamRemovalDialog } = f.load('features/teams/TeamRemovalDialog.tsx');
  const root = createRoot(document.getElementById('root'));
  let closes = 0;
  const render = async teamId => React.act(async () => root.render(React.createElement(MemoryRouter, null,
    React.createElement(TeamRemovalDialog, { team: { id: teamId, name: 'Retained team' }, open: true, zh: false,
      online: true, close: () => { closes++; }, committed: team => { removed = team; } }))));
  const click = async text => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === text);
    assert.ok(button, 'Missing button: ' + text);
    assert.equal(button.disabled, false, 'Disabled button: ' + text);
    await React.act(async () => button.click());
  };
  try {
    await render('team-a');
    assert.match(document.body.textContent, /archived/i);
    assert.match(document.body.textContent, /accounts, trades, reports and versions/i);
    assert.match(document.body.textContent, /protective orders/i);
    await click('Review removal impact');
    await click('Retry the same review');
    const previews = calls.filter(call => call.operation === 'preview');
    assert.deepEqual(previews[1], previews[0]);
    assert.equal(previews[0].input.executionChoice, 'pause_all');
    assert.equal(previews[0].input.expectedBindingRevision, 7);
    assert.ok([...document.querySelectorAll('button')].find(item => item.textContent === 'Confirm removal').disabled);
    await React.act(async () => document.querySelector('[role="checkbox"]').click());
    await click('Confirm removal');
    assert.equal(removed, null, 'an unknown receipt never hides the card optimistically');
    assert.equal([...document.querySelectorAll('button')].find(item => item.textContent === 'Cancel').disabled, true);
    await render('team-b');
    await click('Check same removal receipt');
    const confirms = calls.filter(call => call.operation === 'confirm');
    assert.deepEqual(confirms[1], confirms[0], 'changed props cannot retarget a pending removal');
    assert.equal(confirms[0].id, 'team-a');
    assert.equal(removed.id, 'team-a');
    assert.equal(closes, 1);
  } finally { await React.act(async () => root.unmount()); }
});

test('a definitive stale review requires a new preview and fresh consent before removing the new version', async () => {
  const f = fixture(); let serial = 0; let revision = 1;
  f.state.randomUUID = () => 'renew-' + ++serial;
  const api = f.load('api/teams.ts').teamsApi;
  const reviews = [];
  api.detail = async () => ({ id: 'team', name: 'Team', bindingRevision: revision, currentVersionId: 'version-' + revision });
  api.archivePreview = async (_id, input) => {
    reviews.push(input);
    return { previewId: 'preview-' + revision, previewHash: 'hash-' + revision, expiresAt: '2099-01-01', warnings: [], result: { inflightCommissions: [] } };
  };
  api.archive = async () => {
    revision = 2;
    throw { isAxiosError: true, message: 'Stale review', response: { status: 409, data: { code: 'TEAM_PREVIEW_STALE' } } };
  };
  const { TeamRemovalDialog } = f.load('features/teams/TeamRemovalDialog.tsx');
  const root = createRoot(document.getElementById('root'));
  const button = text => [...document.querySelectorAll('button')].find(item => item.textContent === text);
  const click = async text => { assert.ok(button(text)); await React.act(async () => button(text).click()); };
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(TeamRemovalDialog,
      { team: { id: 'team', name: 'Team' }, open: true, online: true, zh: false, close() {}, committed() {} }))));
    await click('Review removal impact');
    await React.act(async () => document.querySelector('[role="checkbox"]').click());
    await click('Confirm removal');
    assert.equal(button('Confirm removal').disabled, true);
    await click('Review removal impact');
    assert.equal(reviews.length, 2);
    assert.notEqual(reviews[0].requestKey, reviews[1].requestKey);
    assert.equal(reviews[1].expectedCurrentVersionId, 'version-2');
    assert.equal(document.querySelector('[role="checkbox"]').getAttribute('aria-checked'), 'false');
    assert.equal(button('Confirm removal').disabled, true);
  } finally { await React.act(async () => root.unmount()); }
});
