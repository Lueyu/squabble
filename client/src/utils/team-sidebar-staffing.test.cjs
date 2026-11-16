const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/teams/fixture?panel=organization' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'getComputedStyle']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const fixture = require('./simple-test-loader.cjs');
const models = [{ id: 'saved-model', available: true, fastModel: 'fast-name', slowModel: 'slow-name' }];
const agents = [
  { id: 'owl', name: 'Cashflow Owl', specialty: 'Read company accounts', availability: 'configured', status: 'active' },
  { id: 'bear', name: 'Offline Bear', specialty: 'Find downside', availability: 'unavailable', status: 'active' },
  { id: 'cat', name: 'Archived Cat', specialty: 'Check evidence', availability: 'configured', status: 'archived' },
].map(agent => ({ ...agent, avatar: 'technical', currentVersionId: `${agent.id}-v2`, currentVersion: { config: { executor: { executionMode: 'model', connectionId: 'saved-model', model: 'slow' }, allowedToolIds: [] } } }));
const state = () => ({
  config: { schemaVersion: 1, departments: [], relations: [], roles: [{ id: 'seat', departmentId: null, participation: 'placeholder', responsibility: 'Review accounts', expectedOutput: 'Cash bridge', executor: null, allowedToolIds: [], sourceGrantIds: [] }], defaults: { leadRoleId: 'seat', parallelism: 1 } },
  display: { name: 'Fixture', avatar: null, roleLabels: { seat: 'Financials' }, departmentLabels: {} },
  layout: { schemaVersion: 1, positions: {}, collapsedDepartmentIds: [], viewport: { x: 0, y: 0, zoom: 1 } },
});

async function scenario(run) {
  const f = fixture();
  f.state.queries.set('agent-roster', { data: { items: agents }, isPending: false, isError: false });
  const Sidebar = f.load('features/teams/TeamEditorSidebar.tsx').TeamEditorSidebar;
  const root = createRoot(document.getElementById('root'));
  const edits = [];
  const messages = [];
  const props = { state: state(), selected: ['seat'], models, zh: false, readOnly: false, edit: next => edits.push(next), select() {}, add() {}, locate() {}, notify: message => messages.push(message) };
  const render = async patch => {
    Object.assign(props, patch);
    await React.act(async () => root.render(React.createElement(Sidebar, props)));
  };
  const button = text => [...document.querySelectorAll('button')].find(item => item.textContent === text || item.getAttribute('aria-label') === text);
  const click = async target => { assert.ok(target); assert.equal(target.disabled, false); await React.act(async () => target.click()); };
  try { await render(); await run({ f, render, button, click, edits, messages }); } finally { await React.act(async () => root.unmount()); }
}

test('keyboard-focusable friend selection assigns the pinned agent to the selected draft seat only', async () => {
  await scenario(async ({ f, button, click, edits, messages }) => {
    await click(button('Friends'));
    const friend = document.querySelector('.team-sidebar-friend-option');
    assert.equal(friend.textContent.split('Cashflow Owl').length - 1, 1, 'the friend name appears once');
    friend.focus();
    assert.equal(document.activeElement, friend);
    await click(friend);
    assert.equal(friend.getAttribute('aria-pressed'), 'true');
    await click(button('Assign to selected seat'));
    assert.equal(edits.length, 1);
    assert.equal(edits[0].config.roles[0].agentId, 'owl');
    assert.equal(edits[0].config.roles[0].agentVersionId, 'owl-v2');
    assert.equal(edits[0].config.roles[0].executor.model, 'slow-name');
    assert.match(messages[0], /current draft/);
    assert.equal(f.state.requests.length, 0, 'assigning a draft seat does not save, publish or start research');
  });
});

test('unavailable friends and a missing target explain why explicit assignment is disabled', async () => {
  await scenario(async ({ render, button, click, edits }) => {
    await click(button('Friends'));
    const choices = [...document.querySelectorAll('.team-sidebar-friend-option')];
    await click(choices[1]);
    assert.equal(button('Assign to selected seat').disabled, true);
    assert.match(document.body.textContent, /Configure this agent’s connection/);
    await click(choices[2]);
    assert.equal(button('Assign to selected seat').disabled, true);
    assert.match(document.body.textContent, /archived and cannot be assigned/);
    await click(choices[0]);
    await render({ selected: [] });
    assert.equal(button('Assign to selected seat').disabled, true);
    assert.match(document.body.textContent, /Select one seat/);
    assert.equal(edits.length, 0);
  });
});

test('friend roster loading, failure with retry and empty states remain distinct', async () => {
  await scenario(async ({ f, render, button, click }) => {
    await click(button('Friends'));
    f.state.queries.set('agent-roster', { isPending: true });
    await render();
    assert.match(document.querySelector('[role=status]').textContent, /Loading friends/);
    let retries = 0;
    f.state.queries.set('agent-roster', { isPending: false, isError: true, refetch: async () => { retries++; } });
    await render();
    assert.match(document.querySelector('[role=alert]').textContent, /Could not load/);
    await click(button('Retry'));
    assert.equal(retries, 1);
    assert.doesNotMatch(document.body.textContent, /roster is empty/);
    f.state.queries.set('agent-roster', { data: { items: [] }, isPending: false, isError: false });
    await render();
    assert.match(document.body.textContent, /friend roster is empty/);
  });
});
