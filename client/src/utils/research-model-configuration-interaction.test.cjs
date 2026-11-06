const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const { JSDOM } = require('jsdom');
const fixture = require('./simple-test-loader.cjs');

test('model repair saves only the original connection, preserves reasoning, and waits for explicit retry', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = dom.window; global.document = dom.window.document; global.IS_REACT_ACT_ENVIRONMENT = true;
  const { state, load } = fixture();
  const connection = { connectionId: 'native-opencode', name: 'OpenCode', provider: 'opencode', state: 'configuration_required',
    effectiveModel: { id: 'deepseek-v4-flash', source: 'default' }, configuration: { reasoningEffort: 'high' },
    models: [{ id: 'gateway/deepseek-v4-flash', name: 'Configured DeepSeek' }], reasoningEfforts: ['low', 'high'] };
  state.responses = new Map([['/api/research-execution/native-opencode/configuration', { items: [{ ...connection, state: 'ready', executable: true }] }]]);
  const Form = load('pages/Council/CouncilModelConfiguration.tsx').default;
  const api = load('api/research-conversations.ts'); let retries = 0;
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Form, { connection,
      memberName: 'OpenCode', retryAllowed: true, onRetry() { retries++; },
      onSave: async settings => (await api.configureResearchExecution(connection.connectionId, settings))[0] }))));
    assert.equal(state.requests.length, 0);
    await React.act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'gateway/deepseek-v4-flash').click());
    await React.act(async () => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].method, 'put');
    assert.equal(state.requests[0].args[0], '/api/research-execution/native-opencode/configuration');
    assert.equal(state.requests[0].args[1].model, 'gateway/deepseek-v4-flash');
    assert.equal(state.requests[0].args[1].reasoningEffort, 'high');
    assert.equal(retries, 0);
    const retry = [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry this member only');
    assert.ok(retry);
    await React.act(async () => retry.click());
    assert.equal(retries, 1);
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    global.window = previous.window; global.document = previous.document; global.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
