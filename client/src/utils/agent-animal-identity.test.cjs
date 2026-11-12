const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');
const fixture = require('./simple-test-loader.cjs');

function setup() {
  const f = fixture();
  const dialog = f.load('components/ui/dialog.tsx');
  dialog.Dialog = ({ open, children }) => open ? React.createElement('section', { role: 'dialog' }, children) : null;
  for (const key of ['DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription'])
    dialog[key] = ({ children }) => React.createElement('div', null, children);
  let pending;
  f.state.mutationFactory = options => ({ isPending: false, mutate() {
    pending = Promise.resolve().then(() => options.mutationFn()).then(value => options.onSuccess?.(value));
  } });
  return { ...f, settled: () => pending };
}
const templates = [
  { id: 'financials', avatar: 'technical', name: '财报股友', nameEn: 'Financials friend', specialty: '财报', specialtyEn: 'Accounts', instructions: '核对现金流', instructionsEn: 'Check cash flow.', allowedToolIds: [] },
  { id: 'risk', avatar: 'macro', name: '风险股友', nameEn: 'Risk friend', specialty: '风险', specialtyEn: 'Risk', instructions: '检查集中度', instructionsEn: 'Check concentration.', allowedToolIds: [] },
];
const connection = { id: 'fictional-connection', available: true, name: 'Fictional model', fastModel: 'fake-fast', slowModel: 'fake-slow' };
const executor = { executionMode: 'model', connectionId: connection.id, model: 'slow' };
async function fill(id, text) {
  const input = document.getElementById(id);
  const prototype = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test('agent editor saves the selected animal and visible working instructions, separately from its introduction', async () => {
  const f = setup();
  const { AgentEditorDialog } = f.load('features/agent-roster/AgentEditorDialog.tsx');
  const root = createRoot(document.getElementById('root'));
  let saved = 0;
  try {
    await React.act(async () => root.render(React.createElement(AgentEditorDialog, {
      editing: null, templates, models: [connection], locals: [], defaultExecutor: executor,
      zh: false, onClose() {}, onSaved: async () => { saved++; },
    })));
    assert.equal(document.querySelectorAll('input[name="agent-avatar"]').length, 7);
    await React.act(async () => document.querySelector('input[aria-label="Fox"]').click());
    await React.act(async () => {
      const select = document.getElementById('agent-template');
      select.value = 'risk';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(document.querySelector('input[aria-label="Fox"]').checked, true, 'a specialty change preserves an explicitly chosen identity');
    assert.equal(document.getElementById('agent-instructions').value, 'Check concentration.');
    await fill('agent-instructions', 'Verify cash flow and flag uncertainty.');
    await fill('agent-preferences', 'Answer briefly.');
    await fill('agent-description', 'A fictional introduction.');
    await React.act(async () => {
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Save agent').click();
      await f.settled();
    });
    const request = f.state.requests.find(row => row.method === 'post' && row.args[0] === '/api/agent-roster');
    assert.ok(request);
    const payload = request.args[1];
    assert.equal(payload.avatar, 'news');
    assert.equal(payload.instructions, 'Verify cash flow and flag uncertainty.');
    assert.equal(payload.preferences.userPreferences, 'Answer briefly.');
    assert.equal(payload.preferences.language, 'en');
    assert.equal(payload.description, 'A fictional introduction.');
    assert.equal(saved, 1);
  } finally { await React.act(async () => root.unmount()); }
});

test('roster renders the saved animal and carries English into recommended creation', async () => {
  const f = setup();
  f.state.queries.set('agent-roster', { data: { items: [{ id: 'fictional-agent', avatar: 'news', name: 'Fictional fox', specialty: 'Cash flow', description: 'Fixture', status: 'active', availability: 'configured', currentVersion: { version: 1, config: { templateId: 'financials', executor, allowedSources: [], allowedToolIds: [], preferences: {} } } }] } });
  f.state.queries.set('agent-templates', { data: templates });
  f.state.queries.set(JSON.stringify(['settings', 'model-connections']), { data: [connection] });
  f.state.queries.set(JSON.stringify(['settings', 'local-agents']), { data: [] });
  const Workspace = f.load('features/agent-roster/AgentRosterWorkspace.tsx').default;
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Workspace))));
    assert.ok(document.querySelector('article [data-persona="news"]'));
    await React.act(async () => {
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Add recommended agents').click();
      await f.settled();
    });
    const request = f.state.requests.find(row => row.args[0] === '/api/agent-roster/recommended');
    assert.equal(request.args[1].language, 'en');
    assert.deepEqual(Array.from(request.args[1].templateIds), ['risk']);
    assert.equal(f.state.requests.some(row => /council|research\/sessions/u.test(row.args[0])), false);
  } finally { await React.act(async () => root.unmount()); }
});

test('editing an existing agent submits the changed work instructions instead of silently keeping the old ones', async () => {
  const f = setup();
  const { AgentEditorDialog } = f.load('features/agent-roster/AgentEditorDialog.tsx');
  const agent = {
    id: 'existing-friend', revision: 4, avatar: 'news', name: 'Fictional fox', description: 'Card only',
    currentVersion: { config: { templateId: 'financials', instructions: 'Old instructions.', executor,
      allowedSources: [], allowedToolIds: [], preferences: { language: 'en', responseStyle: 'concise', userPreferences: 'Old preference.' } } },
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(AgentEditorDialog, {
      editing: agent, templates, models: [connection], locals: [], defaultExecutor: null,
      zh: false, onClose() {}, onSaved: async () => {},
    })));
    assert.equal(document.getElementById('agent-instructions').value, 'Old instructions.');
    await fill('agent-instructions', 'Always verify cash flow.');
    await fill('agent-preferences', 'Show missing data first.');
    await React.act(async () => {
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Save agent').click();
      await f.settled();
    });
    const request = f.state.requests.find(row => row.method === 'patch');
    assert.equal(request.args[0], '/api/agent-roster/existing-friend');
    assert.equal(request.args[1].expectedRevision, 4);
    assert.equal(request.args[1].instructions, 'Always verify cash flow.');
    assert.equal(request.args[1].preferences.userPreferences, 'Show missing data first.');
    assert.equal(request.args[1].avatar, 'news');
    assert.equal(request.args[1].description, 'Card only');
  } finally { await React.act(async () => root.unmount()); }
});

for (const moderatorTools of [[], ['get_discussion_context']]) test(`changing an existing specialty saves its displayed tool ceiling (${moderatorTools.length ? 'moderator tools' : 'empty tools'}) and keeps its animal`, async () => {
  const f = setup();
  const { AgentEditorDialog } = f.load('features/agent-roster/AgentEditorDialog.tsx');
  const specialtyTemplates = [
    { ...templates[0], allowedToolIds: ['get_financials'] },
    { ...templates[1], id: 'moderator', nameEn: 'Moderator friend', avatar: 'moderator', allowedToolIds: moderatorTools },
  ];
  const agent = {
    id: 'existing-specialist', revision: 3, avatar: 'news', name: 'Fictional fox', description: 'Card only',
    currentVersion: { config: { templateId: 'financials', instructions: 'Verify financials.', executor,
      allowedSources: [], allowedToolIds: ['get_financials'], preferences: { language: 'en', responseStyle: 'concise', userPreferences: '' } } },
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(AgentEditorDialog, {
      editing: agent, templates: specialtyTemplates, models: [connection], locals: [], defaultExecutor: executor,
      zh: false, onClose() {}, onSaved: async () => {},
    })));
    await React.act(async () => {
      const select = document.getElementById('agent-template');
      select.value = 'moderator';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const financialTool = [...document.querySelectorAll('label')].find(label => label.textContent === 'get financials');
    assert.equal(financialTool.querySelector('[role="checkbox"]').getAttribute('aria-checked'), 'false');
    if (moderatorTools.length) {
      const discussionTool = [...document.querySelectorAll('label')].find(label => label.textContent === 'get discussion context');
      assert.equal(discussionTool.querySelector('[role="checkbox"]').getAttribute('aria-checked'), 'true');
    }
    assert.equal(document.querySelector('input[aria-label="Fox"]').checked, true);
    await React.act(async () => {
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Save agent').click();
      await f.settled();
    });
    const payload = f.state.requests.find(row => row.method === 'patch').args[1];
    assert.deepEqual(Array.from(payload.allowedToolIds ?? ['missing-ceiling']), moderatorTools);
    assert.equal(payload.templateId, 'moderator');
    assert.equal(payload.avatar, 'news');
  } finally { await React.act(async () => root.unmount()); }
});
