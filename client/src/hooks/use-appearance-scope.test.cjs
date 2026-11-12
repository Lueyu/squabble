const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const fixture = require('../utils/simple-test-loader.cjs');

test('workspace appearance applies before paint and releases its scope for legacy and auth screens', async () => {
  const { useAppearanceScope } = fixture().load('hooks/use-theme.ts');
  function Workspace({ simple }) { useAppearanceScope(simple); return null; }
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(Workspace, { simple: true })));
    assert.equal(document.documentElement.dataset.workspaceExperience, 'simple');
    await React.act(async () => root.render(React.createElement(Workspace, { simple: false })));
    assert.equal(document.documentElement.hasAttribute('data-workspace-experience'), false, 'legacy inherits only its selected theme');
    await React.act(async () => root.render(React.createElement(Workspace, { simple: true })));
    assert.equal(document.documentElement.dataset.workspaceExperience, 'simple');
  } finally { await React.act(async () => root.unmount()); }
  assert.equal(document.documentElement.hasAttribute('data-workspace-experience'), false, 'auth screens cannot retain the former workspace palette');
});
