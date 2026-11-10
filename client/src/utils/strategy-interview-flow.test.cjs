const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, Routes, Route, Link, useLocation, useNavigate } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');

const accountId = 'fictional-account';
const interviewId = 'fictional-interview';
const interviewPath = '/strategies/interviews/' + interviewId;
const question = field => ({ field, text: { en: 'Clarify ' + field, 'zh-CN': field }, help: { en: 'Your own words', 'zh-CN': '原话' } });
const amount = { field: 'amount', value: { kind: 'amount', quantity: 12 }, quote: '12 shares', sourceMessageId: 'amount-message', confirmedAt: '2026-11-10T00:00:00Z' };
const initialView = () => ({
  id: interviewId, accountId, revision: 1, baseStrategyId: null, status: 'draft',
  createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
  account: { id: accountId, name: 'Fictional account', policyRevision: 7, limits: {} },
  messages: [{ id: 'idea-message', role: 'user', field: 'idea', text: 'A fictional dividend idea', createdAt: '2026-11-10T00:00:00Z' }],
  confirmed: [], suggestions: [], pending: [question('amount')], currentQuestion: question('amount'), review: null,
});
const strategy = () => ({
  id: 'fictional-strategy', revision: 3, status: 'draft', sources: [], confirmedAt: null,
  content: { title: 'Fictional reviewed strategy', entries: [{ id: 'entry', text: 'Buy 12 shares below a stated price', sourceKeys: [] }] },
  preview: { revision: 3, contentHash: 'fixture-hash', canConfirm: true, issues: [], entries: [{ id: 'entry', state: 'executable', explanation: { en: 'Explicitly confirmed rule', 'zh-CN': '确认规则' } }], directives: [], mandateRules: [] },
});

async function scenario(run, { view = initialView(), route = interviewPath } = {}) {
  window.sessionStorage.clear();
  const f = fixture();
  let nextKey = 0;
  f.state.randomUUID = () => 'fixture-request-' + ++nextKey;
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
  for (const key of ['DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription']) dialog[key] = ({ children }) => React.createElement('div', null, children);
  const select = f.load('components/ui/select.tsx');
  select.Select = ({ children, value, onValueChange, disabled }) => React.createElement('select', { value, disabled, onChange: event => onValueChange(event.target.value) }, children);
  select.SelectTrigger = select.SelectValue = () => null;
  select.SelectContent = ({ children }) => React.createElement(React.Fragment, null, children);
  select.SelectItem = ({ children, value }) => React.createElement('option', { value }, children);

  const calls = [];
  let saved = structuredClone(view);
  const setView = next => {
    saved = structuredClone(next);
    f.state.queries.set('strategy-interview', { data: saved, isPending: false, refetch: async () => ({ data: saved }) });
  };
  setView(saved);
  f.state.queries.set('portfolio-accounts', { data: [{ id: accountId, name: 'Fictional account', status: 'paused', companionId: null }], isPending: false });
  const api = f.load('api/strategy-interviews.ts').strategyInterviewsApi;
  api.create = async input => { calls.push(['create', structuredClone(input)]); return saved; };
  api.get = async id => { calls.push(['get', id]); return saved; };
  api.answer = async (id, input) => {
    calls.push(['answer', structuredClone(input)]);
    setView({ ...saved, revision: saved.revision + 1, review: null,
      messages: [...saved.messages, { id: 'answer-' + saved.revision, role: 'user', field: input.field, text: input.message, createdAt: '2026-11-10T01:00:00Z' }],
      suggestions: [{ id: 'amount-suggestion', ...amount, quote: input.message, explanation: { en: 'Confirm this exact quantity', 'zh-CN': '确认数量' } }],
      confirmed: saved.confirmed.filter(item => item.field !== input.field), pending: [], currentQuestion: null,
    });
    return saved;
  };
  api.accept = async (id, input) => {
    calls.push(['accept', structuredClone(input)]);
    setView({ ...saved, revision: saved.revision + 1, suggestions: [], confirmed: [...saved.confirmed, amount], pending: [], currentQuestion: null, review: null });
    return saved;
  };
  api.preview = async (id, input) => {
    calls.push(['preview', structuredClone(input)]);
    const reviewed = strategy();
    setView({ ...saved, status: 'review_ready', revision: saved.revision + 1, review: { strategyId: reviewed.id, strategyRevision: reviewed.revision, previewHash: reviewed.preview.contentHash, interviewRevision: saved.revision + 1 } });
    f.state.queries.set('investment-strategy', { data: reviewed, isPending: false });
    return { interview: saved, strategy: reviewed, examples: [{ id: 'fixture', scenario: { en: 'Condition not met', 'zh-CN': '条件未满足' }, outcome: 'no_action', explanation: { en: 'Do not trade', 'zh-CN': '不成交' } }] };
  };
  f.load('api/investment-strategies.ts').investmentStrategiesApi.get = async id => { calls.push(['strategy', id]); return strategy(); };
  const workspace = f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi;
  workspace.account = async id => { calls.push(['account', id]); return { id: accountId, combination: { policyRevision: 7, allocations: [], draft: null } }; };
  workspace.saveDraft = async (id, input) => { calls.push(['draft', id, structuredClone(input)]); return {}; };
  workspace.apply = async () => { throw Error('The interview must not apply a combination'); };

  const New = f.load('features/strategy-interview/NewStrategyInterviewPage.tsx').default;
  const Interview = f.load('features/strategy-interview/StrategyInterviewPage.tsx').default;
  let navigate;
  function Location() { navigate = useNavigate(); const location = useLocation(); return React.createElement('output', { id: 'location' }, location.pathname + location.search); }
  const root = createRoot(document.getElementById('root'));
  let mountKey = 0;
  const render = async path => React.act(async () => root.render(React.createElement(MemoryRouter, { key: ++mountKey, initialEntries: [path] },
    React.createElement(Routes, null,
      React.createElement(Route, { path: '/strategies/new', element: React.createElement(New) }),
      React.createElement(Route, { path: '/strategies/interviews/:interviewId', element: React.createElement(Interview) }),
      React.createElement(Route, { path: '/strategies', element: React.createElement(Link, { to: interviewPath }, 'Resume saved conversation') }),
      React.createElement(Route, { path: '/paper/:id/strategies', element: React.createElement('p', null, 'Account combination draft') })),
    React.createElement(Location))));
  const button = text => [...document.querySelectorAll('button')].find(item => item.textContent === text);
  const click = async text => { const element = button(text); assert.ok(element, 'Missing button: ' + text); assert.equal(element.disabled, false, 'Disabled button: ' + text); await React.act(async () => element.click()); };
  const type = async text => React.act(async () => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  try {
    await render(route);
    await run({ f, api, calls, button, click, type, setView, getView: () => saved, render, go: async path => React.act(async () => navigate(path)), location: () => document.querySelector('#location').textContent });
  } finally {
    await React.act(async () => root.unmount());
  }
}

test('create, save and resume, explicitly accept, preview, then stage a disabled account draft', async () => {
  await scenario(async ({ calls, button, click, type, location }) => {
    await type('A fictional dividend idea');
    await click('Start clarifying together');
    assert.equal(location(), interviewPath);
    assert.equal(calls[0][1].accountId, accountId);
    await type('12 shares');
    await click('Save & exit');
    assert.equal(location(), '/strategies?accountId=' + accountId);
    await React.act(async () => document.querySelector('a').click());
    assert.match(document.body.textContent, /12 shares/);
    assert.equal(document.querySelector('textarea').value, '');
    assert.equal(calls.some(call => call[0] === 'accept'), false);
    assert.equal(button('Review the rules').disabled, true);
    await click('Accept this interpretation');
    assert.equal(calls.filter(call => call[0] === 'accept').length, 1);
    await click('Review the rules');
    assert.equal(location(), interviewPath + '?step=review');
    assert.match(document.body.textContent, /These are rule boundary checks/);
    assert.equal(calls.some(call => call[0] === 'draft'), false);
    await click('Add to combination & review');
    assert.equal(location(), '/paper/' + accountId + '/strategies');
    const draft = calls.find(call => call[0] === 'draft');
    assert.equal(draft[1], accountId);
    assert.equal(draft[2].expectedPolicyRevision, 7);
    assert.deepEqual(draft[2].allocations, [{ strategyId: 'fictional-strategy', strategyRevision: 3, allocationPct: 0, enabled: false }]);
    assert.equal(calls.some(call => call[0] === 'apply'), false);
  }, { route: '/strategies/new?accountId=' + accountId });
});

test('a failed save retains text and retries the identical request before clearing the composer', async () => {
  await scenario(async ({ api, calls, click, type }) => {
    const answer = api.answer;
    let first = true;
    api.answer = async (id, input) => {
      if (first) { first = false; calls.push(['failed-answer', structuredClone(input)]); throw Error('Lost response'); }
      return answer(id, input);
    };
    await type('12 shares');
    await click('Send answer');
    assert.equal(document.querySelector('textarea').value, '12 shares');
    assert.ok(document.querySelector('[role="alert"]'));
    await click('Send answer');
    assert.deepEqual(calls.find(call => call[0] === 'failed-answer')[1], calls.find(call => call[0] === 'answer')[1]);
    assert.equal(document.querySelector('textarea').value, '');
  });
});

test('reloading an unsent revision preserves the edited field instead of using the next question', async () => {
  await scenario(async ({ calls, type, render, click }) => {
    await React.act(async () => document.querySelector('button[aria-label="Edit Position or quantity"]').click());
    await type('13 shares');
    await render(interviewPath);
    assert.equal(document.querySelector('textarea').value, '13 shares');
    assert.match(document.querySelector('label[for="interview-answer"]').textContent, /Revise: Position or quantity/);
    await click('Send answer');
    assert.equal(calls.find(call => call[0] === 'answer')[1].field, 'amount');
  }, { view: { ...initialView(), confirmed: [amount], pending: [question('frequency')], currentQuestion: question('frequency') } });
});

test('a server-accepted answer with a lost response retains its original request across reload', async () => {
  await scenario(async ({ api, calls, click, type, render }) => {
    const answer = api.answer;
    let first = true;
    api.answer = async (id, input) => {
      if (first) { first = false; await answer(id, input); throw Error('Accepted on server; response lost'); }
      calls.push(['retried-answer', structuredClone(input)]);
      return api.get(id);
    };
    await type('12 shares');
    await click('Send answer');
    assert.equal(document.querySelector('textarea').value, '12 shares');
    await render(interviewPath);
    await click('Send answer');
    assert.deepEqual(calls.find(call => call[0] === 'retried-answer')[1], calls.find(call => call[0] === 'answer')[1], 'reload must replay the original payload and receipt key even when the fetched revision advanced');
  });
});

test('editing after review cannot stage the previous preview', async () => {
  await scenario(async ({ click, type, go, calls, button }) => {
    await click('Review the rules');
    await React.act(async () => document.querySelector('button[aria-label="Edit Position or quantity"]').click());
    await type('13 shares');
    await click('Send answer');
    await go(interviewPath + '?step=review');
    assert.match(document.body.textContent, /Return and generate a fresh review/);
    assert.equal(button('Add to combination & review').disabled, true);
    assert.equal(calls.some(call => call[0] === 'draft'), false);
  }, { view: { ...initialView(), confirmed: [amount], pending: [], currentQuestion: null } });
});

test('a changed server revision prevents staging even while an earlier review remains visible', async () => {
  await scenario(async ({ click, api, calls, getView, setView }) => {
    await click('Review the rules');
    api.get = async () => {
      setView({ ...getView(), revision: getView().revision + 1, review: null });
      return getView();
    };
    await click('Add to combination & review');
    assert.match(document.body.textContent, /generate a fresh review/i);
    assert.equal(calls.some(call => call[0] === 'draft'), false);
  }, { view: { ...initialView(), confirmed: [amount], pending: [], currentQuestion: null } });
});
