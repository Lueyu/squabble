const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, useLocation } = require('react-router-dom');
const { renderToStaticMarkup } = require('react-dom/server');
const fixture = require('./simple-test-loader.cjs');

for (const width of [1440, 390]) test(`feature search opens distinct holdings, simulation and daily destinations at ${width}px`, async () => {
  window.innerWidth = width;
  const f = fixture();
  const dialog = f.load('components/ui/dialog.tsx');
  dialog.Dialog = ({ open, children }) => open ? React.createElement('section', { role: 'dialog' }, children) : null;
  for (const key of ['DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']) dialog[key] = ({ children }) => React.createElement('div', null, children);
  const { WorkspaceSearch } = f.load('features/navigation/WorkspaceSearch.tsx');
  function Location() { const location = useLocation(); return React.createElement('output', null, location.pathname + location.search); }
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(WorkspaceSearch), React.createElement(Location))));
    for (const [label, path] of [['Holdings', '/holdings'], ['Simulation accounts', '/paper'], ['Daily report', '/daily']]) {
      await React.act(async () => document.querySelector('[aria-label="Find a feature"]').click());
      const button = [...document.querySelectorAll('[role="dialog"] button')].find(node => node.textContent === label);
      assert.ok(button, `${label} must be selectable in search`);
      await React.act(async () => button.click());
      assert.equal(document.querySelector('output').textContent, path);
      assert.equal(document.querySelector('[role="dialog"]'), null);
    }
    assert.equal(f.state.requests.length, 0);
  } finally { await React.act(async () => root.unmount()); }
});

test('ledger parent links preserve its account and holdings roots have no overview return', () => {
  const f = fixture();
  f.load('features/navigation/use-workspace-navigation.ts').useWorkspaceNavigation = () => ({ goBack() {} });
  const { WorkspaceNavigationBar, WorkspaceSectionTabs } = f.load('features/navigation/WorkspaceNavigationBar.tsx');
  const render = (path, component) => renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(component)));
  const ledger = render('/transactions?accountId=fictional-b', WorkspaceNavigationBar);
  assert.match(ledger, /href="\/holdings\?accountId=fictional-b"/);
  assert.match(ledger, /Holdings/);
  const holdings = render('/holdings?accountId=fictional-b', WorkspaceNavigationBar);
  assert.doesNotMatch(holdings, /Go back|Within/);
  const investment = render('/', WorkspaceSectionTabs);
  assert.match(investment, /href="\/paper"/);
  assert.match(investment, /Simulation accounts/);
});
