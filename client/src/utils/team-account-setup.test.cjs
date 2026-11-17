const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/teams/team' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'DocumentFragment', 'CustomEvent', 'Element', 'Node', 'Event']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, useLocation } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');

test('creating a paper account returns to the same team binding review with the acknowledged account selected', async () => {
  const f = fixture();
  f.state.mutationFactory = options => {
    const [state, setState] = React.useState({ isPending: false, isError: false });
    const mutate = async input => {
      try { const result = await options.mutationFn(input); await options.onSuccess?.(result); }
      catch (error) { setState({ isPending: false, isError: true, error }); }
    };
    return { ...state, mutate, reset() {} };
  };
  const accounts = [];
  f.state.queries.set('portfolio-accounts', { data: accounts, refetch: async () => {} });
  f.state.queries.set('teams', { data: { items: [] } });
  const dialog = f.load('components/ui/dialog.tsx');
  dialog.Dialog = ({ open, children }) => open ? React.createElement('div', null, children) : null;
  for (const name of ['DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']) dialog[name] = ({ children }) => React.createElement('div', null, children);
  f.load('features/teams/TeamPrimitives.tsx').TeamSelect = ({ label, value, options, onChange }) => React.createElement('select', { 'aria-label': label, value, onChange: event => onChange(event.target.value) }, options.map(option => React.createElement('option', { key: option.value, value: option.value }, option.label)));
  const Create = f.load('pages/Paper/CreateSimulationAccount.tsx');
  Create.default = ({ onClose, onCreated }) => React.createElement('button', { onClick: () => {
    accounts.push({ id: 'new-account', name: 'Fictional cash account', status: 'paused', strategyCount: 0, policyRevision: 1 });
    onClose(); onCreated('new-account');
  } }, 'Complete fictional creation');
  let bindingInput;
  f.load('api/teams.ts').teamsApi.bindingPreview = async (_id, input) => { bindingInput = input; return { result: {}, warnings: [], expiresAt: '2099-01-01T00:00:00Z' }; };
  const { TeamBindingDialog } = f.load('features/teams/TeamLifecycleDialogs.tsx');
  function Location() { return React.createElement('output', null, useLocation().pathname); }
  const root = createRoot(document.getElementById('root'));
  const button = name => [...document.querySelectorAll('button')].find(item => item.textContent === name);
  const click = async name => { const item = button(name); assert.ok(item, name); assert.equal(item.disabled, false); await React.act(async () => item.click()); };
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ['/teams/team'] }, React.createElement(TeamBindingDialog, {
      AccountCreator: Create.default, team: { id: 'team', currentVersionId: 'version', bindingRevision: 0, binding: null }, open: true, close() {}, committed() {}, zh: false, online: true,
    }), React.createElement(Location))));
    await click('Create a paper account');
    await click('Complete fictional creation');
    assert.match(document.body.textContent, /Fictional cash account/);
    assert.equal(document.querySelector('output').textContent, '/teams/team');
    await click('Preview this step');
    assert.equal(bindingInput.accountId, 'new-account');
    assert.equal(bindingInput.executionChoice, 'keep_confirmed_rules');
  } finally { await React.act(async () => root.unmount()); }
});
