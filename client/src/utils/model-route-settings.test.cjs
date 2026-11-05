const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../..');
const load = (file, imports) => {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => imports[name] ?? new Proxy({ __esModule: true, default: name }, {
    get: (target, key) => key in target ? target[key] : String(key),
  }), URL, Date });
  return exports;
};
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes)
  : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('')
  : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const agent = patch => ({ id: 'native-codex', name: 'Codex', provider: 'codex', state: 'ready',
  connected: true, available: true, busy: false, models: [{ id: 'model-a', name: 'Model A', reasoningEfforts: ['high'] }], ...patch });
function panel({ route = { mode: 'basic' }, agents = [agent()], api = false, activeAvailable = true } = {}) {
  const settings = { llm: { route, engine: api ? 'llm' : 'basic', source: api ? 'user' : 'builtin',
    available: api && activeAvailable, hasApiKey: api, baseUrl: '', fastModel: '', slowModel: '' }, financial: {} };
  const states = []; let cursor = 0; const mutations = [];
  const jsx = (type, props) => ({ type, props });
  const component = load('client/src/pages/Settings/IntegrationSettingsPanel.tsx', {
    react: { useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; }, useEffect() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@tanstack/react-query': { useQuery: options => ({ data: options.queryKey.includes('local-agents') ? agents : settings }),
      useQueryClient: () => ({ setQueryData() {}, invalidateQueries() {} }),
      useMutation: options => { mutations.push(options); return { isPending: false, mutate: value => options.mutationFn(value) }; } },
    'react-i18next': { useTranslation: () => ({ t: key => key, i18n: { language: 'en' } }) },
    'react-router-dom': { Link: 'Link' },
    axios: { isAxiosError: () => false },
    sonner: { toast: { success() {} } },
    '@/api/settings': { saveLlmRoute: async value => { panel.saved = value; return settings; } },
    '@/utils/local-agent-settings': load('client/src/utils/local-agent-settings.ts', {}),
  });
  const render = () => { cursor = 0; return component.default({ section: 'models' }); };
  const field = id => { const result = nodes(render()).find(node => node.props?.id === id);
    assert.ok(result, `Missing field: ${id}`); return result; };
  return { render, field, mutations, change(id, value) { field(id).props.onChange({ target: { value } }); },
    save() { nodes(render()).find(node => node.type === 'Button' && text(node) === 'modelRoute.save').props.onClick(); } };
}

test('model settings offers Basic, API, and local routes with local configuration', () => {
  const view = panel({ api: true });
  assert.deepEqual(nodes(view.render()).filter(node => node.type === 'option' && ['basic', 'api', 'local'].includes(node.props?.value))
    .map(node => node.props.value), ['basic', 'api', 'local']);
  view.change('llm-default-route', 'local');
  assert.equal(view.field('llm-route-agent').props.value, 'native-codex');
  view.change('llm-route-model', 'model-a');
  view.change('llm-route-effort', 'high');
  view.save();
  assert.equal(JSON.stringify(panel.saved), JSON.stringify({ mode: 'local', agentId: 'native-codex',
    agentSettings: { model: 'model-a', reasoningEffort: 'high' } }));
});

test('API route requires a configured key and unavailable local routes cannot be saved', () => {
  panel.saved = undefined;
  const view = panel({ agents: [agent({ available: false })] });
  assert.equal(view.field('llm-default-route').props.children.find(option => option.props.value === 'api').props.disabled, true);
  view.change('llm-default-route', 'local');
  view.save();
  assert.equal(panel.saved, undefined);
});

test('a saved API key remains selectable when the active local route is unavailable', () => {
  panel.saved = undefined;
  const view = panel({ route: { mode: 'local', agentId: 'native-codex' },
    agents: [agent({ available: false })], api: true, activeAvailable: false });
  assert.equal(view.field('llm-default-route').props.children.find(option => option.props.value === 'api').props.disabled, false);
  view.change('llm-default-route', 'api');
  view.save();
  assert.equal(JSON.stringify(panel.saved), JSON.stringify({ mode: 'api' }));
});

test('route API uses the dedicated endpoint with raw route body', async () => {
  let request;
  const api = load('client/src/api/settings.ts', { './http': { __esModule: true, default: {
    put: async (url, body) => { request = { url, body }; return { data: { llm: {} } }; },
  } } });
  await api.saveLlmRoute({ mode: 'basic' });
  assert.equal(request.url, '/api/settings/integrations/llm-route');
  assert.equal(JSON.stringify(request.body), JSON.stringify({ mode: 'basic' }));
});
