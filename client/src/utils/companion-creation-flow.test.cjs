const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, useLocation } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');

test('four starting points preview independently; a lost companion save retains the account and retries only that preference', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T16:00:00Z') });
  const f = fixture();
  const calls = [];
  let failCreate = true;
  const creationReceipts = new Map();
  let failCompanion = true;
  f.state.mutationFactory = options => {
    const [state, setState] = React.useState({ isPending: false, isError: false });
    const mutateAsync = async value => {
      setState({ isPending: true, isError: false });
      try {
        const result = await options.mutationFn(value);
        await options.onSuccess?.(result, value);
        setState({ isPending: false, isError: false });
        return result;
      } catch (error) {
        setState({ isPending: false, isError: true, error });
        throw error;
      }
    };
    return { ...state, mutateAsync, mutate: value => void mutateAsync(value).catch(() => {}) };
  };
  const dialog = f.load('components/ui/dialog.tsx');
  dialog.Dialog = ({ open, children }) => open ? React.createElement('div', null, children) : null;
  for (const name of ['DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']) {
    dialog[name] = ({ children }) => React.createElement('div', null, children);
  }
  const select = f.load('components/ui/select.tsx');
  select.Select = ({ children, value, onValueChange }) => React.createElement('select', { value, onChange: event => onValueChange(event.target.value) }, children);
  select.SelectTrigger = select.SelectValue = () => null;
  select.SelectContent = ({ children }) => React.createElement(React.Fragment, null, children);
  select.SelectItem = ({ children, value }) => React.createElement('option', { value }, children);
  f.load('api/ai-investment.ts').previewAiInvestment = async input => {
    calls.push(['preview', input]);
    return { id: 'fixture-preview', expiresAt: '2099-01-01T00:00:00Z', seed: {
      capturedAt: '2026-11-10T00:00:00Z', positions: [], gaps: [], initialEquityUsd: '10000',
      cash: [{ currency: 'USD', total: '10000', availabilityKnown: true }],
    } };
  };
  const api = f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi;
  f.state.queries.set('portfolio-accounts', { data: [{ id: 'owned-account', name: 'Original account', status: 'paused' }], isPending: false });
  api.create = async input => {
    calls.push(['create', input]);
    if (!creationReceipts.has(input.requestKey)) creationReceipts.set(input.requestKey, { accountId: 'created-account' });
    if (failCreate) { failCreate = false; throw new Error('Create response was lost'); }
    return creationReceipts.get(input.requestKey);
  };
  api.setCompanion = async (id, input) => {
    calls.push(['companion', id, input]);
    if (failCompanion) { failCompanion = false; throw new Error('Lost response'); }
    return { accountId: id, companionId: input.companionId, companionRevision: 1 };
  };
  const Create = f.load('pages/Paper/CreateSimulationAccount.tsx').default;
  function Location() { return React.createElement('output', null, useLocation().pathname); }
  const root = createRoot(document.getElementById('root'));
  const button = text => [...document.querySelectorAll('button')].find(item => item.textContent === text);
  const change = async (input, value) => React.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ['/paper?create=1'] },
      React.createElement(Create, { onClose() {}, initialCompanionId: 'macro' }), React.createElement(Location))));
    assert.match(document.body.textContent, /Create a simulation account/);
    assert.match(document.body.textContent, /Account style & seed/);
    await change(document.querySelector('input[placeholder]'), 'Fictional account');
    await React.act(async () => button('Copy real holdings').click());
    await React.act(async () => button('Preview starting point').click());
    assert.equal(calls.at(-1)[1].origin, 'holdings');
    await React.act(async () => button('Cancel creation').click());
    await React.act(async () => button('Copy a simulation account').click());
    assert.equal(button('Preview starting point').disabled, true);
    await React.act(async () => {
      const select = document.querySelector('select'); select.value = 'owned-account';
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await React.act(async () => button('Preview starting point').click());
    assert.equal(calls.at(-1)[1].sourceAccountId, 'owned-account');
    await React.act(async () => button('Cancel creation').click());
    await React.act(async () => button('Custom opening holdings').click());
    assert.equal(button('Preview starting point').disabled, true);
    await change(document.querySelector('input[placeholder^="AAPL"]'), '700.HK');
    await change(document.querySelector('.companion-seed-row input[type="number"]'), '10');
    await React.act(async () => button('Preview starting point').click());
    assert.equal(calls.at(-1)[1].origin, 'custom');
    assert.equal(calls.at(-1)[1].holdings[0].ticker, '0700.HK');
    assert.equal(calls.at(-1)[1].cash[0].amount, 0);
    await React.act(async () => button('Cancel creation').click());
    await React.act(async () => button('Start with virtual cash').click());
    await change(document.querySelector('input[type="number"]'), '10000');
    await React.act(async () => button('Preview starting point').click());
    assert.equal(calls.filter(call => call[0] === 'create').length, 0);
    await React.act(async () => button('Create and observe').click());
    assert.equal(Boolean(button('Refresh preview')), false, 'an unconfirmed creation must retry its exact frozen request');
    t.mock.timers.setTime(Date.parse('2100-01-01T00:00:00Z'));
    await React.act(async () => button('Retry creation confirmation').click());
    assert.match(document.body.textContent, /simulation account was created/);
    assert.equal(Boolean(button('Refresh preview')), false, 'an already-created account cannot select a different seed');
    t.mock.timers.setTime(Date.parse('2100-01-01T00:00:00Z'));
    await React.act(async () => button('Retry account style').click());
    const createCalls = calls.filter(call => call[0] === 'create');
    assert.equal(createCalls.length, 2);
    assert.deepEqual(createCalls[0], createCalls[1]);
    assert.equal(creationReceipts.size, 1);
    const companionCalls = calls.filter(call => call[0] === 'companion');
    assert.equal(companionCalls.length, 2);
    assert.deepEqual(companionCalls[0], companionCalls[1]);
    assert.equal(companionCalls[1][2].companionId, 'macro');
    assert.equal(document.querySelector('output').textContent, '/paper/created-account');
  } finally {
    await React.act(async () => root.unmount());
  }
});
