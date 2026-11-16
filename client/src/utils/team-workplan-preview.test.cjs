const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/teams/fixture' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement', 'MutationObserver', 'DocumentFragment', 'Element', 'Node', 'Event', 'getComputedStyle']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const fixture = require('./simple-test-loader.cjs');

function initialState() {
  return {
    config: {
      schemaVersion: 1,
      departments: [],
      roles: ['lead', 'financials'].map(id => ({ id, departmentId: null, participation: 'placeholder', responsibility: 'Fictional research', expectedOutput: 'Evidence', executor: null, allowedToolIds: [], sourceGrantIds: [] })),
      relations: [], defaults: { leadRoleId: 'lead', parallelism: 1 },
      workBlueprint: { schemaVersion: 1, works: [{ workId: 'internal-financials', roleId: 'financials', taskKind: 'financials', objective: '', expectedOutput: '', dependencyWorkIds: [], reviewerRoleId: 'financials', reviewMode: 'self_check' }], summary: { reviewerRoleId: 'lead', reviewMode: 'self_check', expectedOutput: '' } },
    },
    display: { name: 'Fixture', roleLabels: { lead: 'Portfolio lead', financials: 'Financials specialist' }, departmentLabels: {} },
    layout: { schemaVersion: 1, positions: {}, collapsedDepartmentIds: [], viewport: { x: 0, y: 0, zoom: 1 } },
  };
}

test('read-only work previews expire when any compilation input changes', async () => {
  const f = fixture();
  const Component = f.load('features/teams/TeamWorkPlanPreview.tsx').TeamWorkPlanPreview;
  f.load('api/teams.ts').teamsApi.workPlanPreview = async () => ({ mode: 'blueprint_v1', structurallyValid: true, minimumCallCount: 2, work: [], issues: [], warnings: [], nonParticipatingRoleIds: [], unusedReviewRelationIds: [] });
  const root = createRoot(document.getElementById('root'));
  const state = initialState();
  const render = async next => React.act(async () => root.render(React.createElement(Component, { teamId: 'fixture', semanticRevision: 1, state: next, edit() {}, zh: false, readOnly: false, online: true })));
  const mutations = {
    lead: config => ({ ...config, defaults: { ...config.defaults, leadRoleId: 'financials' } }),
    participation: config => ({ ...config, roles: config.roles.map(role => ({ ...role, participation: 'enabled' })) }),
    executor: config => ({ ...config, roles: config.roles.map(role => ({ ...role, executor: { executionMode: 'model', connectionId: 'fixture', model: 'fixture' } })) }),
    identity: config => ({ ...config, roles: config.roles.map(role => ({ ...role, agentId: `agent-${role.id}` })) }),
    reviews: config => ({ ...config, relations: [{ id: 'review', fromRoleId: 'lead', toRoleId: 'financials', kind: 'reviews', responsibilityScope: 'Fictional review' }] }),
  };
  try {
    for (const [name, mutate] of Object.entries(mutations)) {
      await render(state);
      const button = [...document.querySelectorAll('button')].find(item => item.textContent.includes('Generate read-only structural preview'));
      assert.ok(button, 'the settings expose a read-only preview action');
      await React.act(async () => button.click());
      assert.doesNotMatch(document.body.textContent, /draft changed after this preview/i);
      await render({ ...state, config: mutate(state.config) });
      assert.match(document.body.textContent, /draft changed after this preview/i, `${name} changes invalidate the compiled preview`);
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});
