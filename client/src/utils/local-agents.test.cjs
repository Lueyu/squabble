const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../..');
function load(file, imports = {}, globals = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, URL, URLSearchParams, Date,
    require: name => imports[name] ?? new Proxy({ __esModule: true, default: name.split('/').at(-1) }, {
      get: (target, key) => key in target ? target[key] : String(key),
    }), ...globals }, { filename: file });
  return exports;
}
const agent = (overrides = {}) => ({ id: 'native-codex', provider: 'codex', name: 'Codex',
  state: 'ready', loginCommand: 'codex login', installUrl: 'https://developers.openai.com/codex/cli/',
  connected: false, available: false, busy: false, source: 'native', ...overrides });
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  return tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null ? '' : String(tree);
}
function button(tree, key) {
  const found = nodes(tree).find(node => node.type === 'Button' && text(node).includes(key));
  assert.ok(found, `Missing button: ${key}`);
  return found;
}
function panel(initialStatus) {
  let status = initialStatus;
  let queryFailed = false;
  let pendingMutation = -1;
  const states = [];
  let cursor = 0;
  const queries = [];
  const mutations = [];
  const invalidated = [];
  const calls = [];
  const intervals = [];
  const jsx = (type, props) => ({ type, props });
  const api = Object.fromEntries(['fetchLocalAgents', 'fetchLocalAgentsStatus', 'connectLocalAgent',
    'disconnectLocalAgent', 'loginLocalAgent', 'createLocalAgentPairing', 'disconnectLocalCompanion'].map(name => [name, async value => {
    calls.push([name, value]);
    return name === 'createLocalAgentPairing' ? { code: 'pair-code', expiresAt: '2099-01-01T00:00:00Z' } : { ok: true };
  }]));
  const component = load('client/src/pages/Settings/LocalAgentsPanel.tsx', {
    react: { useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useEffect() {}, useMemo: fn => fn() },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-i18next': { useTranslation: () => ({ t: (key) => key, i18n: { language: 'en' } }) },
    '@tanstack/react-query': {
      useQuery(options) { queries.push(options); return { data: options.queryKey.includes('status') ? status : [],
        isSuccess: !queryFailed, isPending: false, isFetching: false, isError: queryFailed, refetch: async () => {} }; },
      useQueryClient: () => ({ invalidateQueries: async options => invalidated.push(options.queryKey) }),
      useMutation(options) { const index = mutations.length; mutations.push(options); return { isPending: index === pendingMutation,
        mutate: async value => { const result = await options.mutationFn(value); await options.onSuccess?.(result, value); },
        reset() {} }; },
    },
    '@/api/local-agents': api,
    '@/pages/AgentBuilder/errorMessage': { errorMessage: (_, fallback) => fallback },
  }, { window: { location: { origin: 'http://localhost:3001', assign: () => assert.fail('Pairing must not launch automatically') },
    setInterval: fn => { intervals.push(fn); return 1; }, clearInterval() {} },
    setInterval: fn => { intervals.push(fn); return 1; }, clearInterval() {} });
  return { queries, mutations, invalidated, calls, states,
    setStatus(value) { status = value; },
    setQueryFailed(value) { queryFailed = value; },
    setPendingMutation(value) { pendingMutation = value; },
    render() { cursor = 0; queries.length = 0; mutations.length = 0; return component.default(); } };
}

test('new teams select only connected, available agents and persist local execution mode', () => {
  const { assignLocalAgents } = load('client/src/pages/Council/useCouncilModels.ts');
  const members = [{ id: 'researcher', connectionId: 'old-model', model: 'slow' }, { id: 'manager', model: 'fast' }];
  const result = assignLocalAgents(members, [agent(), agent({ id: 'offline', connected: true, available: false }),
    agent({ id: 'companion-claude', connected: true, available: true })]);
  assert.equal(result[0].executionMode, 'local');
  assert.equal(result[0].agentId, 'companion-claude');
  assert.equal(result[1].agentId, 'companion-claude');
  assert.equal(result[0].connectionId, undefined);
  assert.equal(result[0].model, 'slow');
  assert.equal(assignLocalAgents(members, [agent()]), members);
});

test('saved team labels identify busy or unavailable local agents', () => {
  const models = load('client/src/pages/Council/useCouncilModels.ts', {
    'react-i18next': { useTranslation: () => ({ t: key => key }) },
    '@tanstack/react-query': { useQuery: options => ({ data: options.queryKey.includes('local-agents')
      ? [agent({ connected: true, available: true, busy: true }), agent({ id: 'companion-claude', name: 'Claude Code', connected: true })]
      : options.queryKey.includes('model-connections') ? [] : { llm: {} } }) },
  }).useCouncilModels();
  assert.ok(models.memberLabel({ executionMode: 'local', agentId: 'native-codex' }).includes('council.localAgents.states.busy'));
  assert.ok(models.memberLabel({ executionMode: 'local', agentId: 'companion-claude' }).includes('council.localAgents.states.offline'));
});

test('native settings offer install, login, connect, and disconnect from provider state', async () => {
  const view = panel({ mode: 'native', items: [agent({ state: 'not_installed' })], companion: { connected: false } });
  let tree = view.render();
  assert.ok(nodes(tree).some(node => node.type === 'a' && node.props.href === agent().installUrl));
  view.setStatus({ mode: 'native', items: [agent({ state: 'login_required' })], companion: { connected: false } });
  tree = view.render();
  await button(tree, 'council.localAgents.login').props.onClick();
  assert.deepEqual(view.calls.pop(), ['loginLocalAgent', 'native-codex']);
  assert.ok(text(view.render()).includes('council.localAgents.loginOpened'));
  view.setStatus({ mode: 'native', items: [agent()], companion: { connected: false } });
  tree = view.render();
  await button(tree, 'council.localAgents.connect').props.onClick();
  assert.deepEqual(view.calls.pop(), ['connectLocalAgent', 'native-codex']);
  assert.ok(view.invalidated.some(key => key.join('/') === 'settings/local-agents'));
  assert.ok(view.mutations.every(mutation => mutation.retry === false));
  view.setStatus({ mode: 'native', items: [agent({ connected: true, available: true, busy: true })], companion: { connected: false } });
  tree = view.render();
  assert.ok(text(tree).includes('council.localAgents.states.busy'));
  await button(tree, 'council.localAgents.disconnect').props.onClick();
  assert.deepEqual(view.calls.pop(), ['disconnectLocalAgent', 'native-codex']);
});

test('browser pairing waits for an explicit open action and polls while waiting', async () => {
  const view = panel({ mode: 'companion', items: [], companion: { connected: false } });
  let tree = view.render();
  await button(tree, 'council.localAgents.pair').props.onClick();
  tree = view.render();
  assert.ok(nodes(tree).some(node => node.type === 'a'
    && node.props.href === 'squabble://pair?origin=http%3A%2F%2Flocalhost%3A3001&code=pair-code'));
  assert.ok(nodes(tree).some(node => node.type === 'a' && node.props.href === 'https://github.com/Lueyu/squabble/releases/latest'));
  assert.ok(view.queries.some(query => query.queryKey.includes('status') && query.refetchInterval > 0));
  view.setStatus({ mode: 'companion', items: [agent({ source: 'companion', connected: true, available: false })], companion: { connected: false } });
  tree = view.render();
  assert.ok(text(tree).includes('council.localAgents.states.offline'));
});

test('an expired browser pairing offers regeneration instead of a launch link', () => {
  const view = panel({ mode: 'companion', items: [], companion: { connected: false } });
  view.render();
  // The pairing is the only object state containing a pair code.
  const stateIndex = view.states.findIndex(value => value === null);
  assert.ok(stateIndex >= 0);
  view.states[stateIndex] = { code: 'expired-code', expiresAt: '2000-01-01T00:00:00Z' };
  const tree = view.render();
  assert.ok(text(tree).includes('council.localAgents.pairExpired'));
  assert.ok(button(tree, 'council.localAgents.pairAgain'));
  assert.ok(!nodes(tree).some(node => node.type === 'a' && String(node.props.href).startsWith('squabble://')));
});

test('pending actions prevent another submission and polling errors stay visible during pairing', async () => {
  const view = panel({ mode: 'native', items: [agent()], companion: { connected: false } });
  view.setPendingMutation(0);
  assert.equal(button(view.render(), 'council.localAgents.connect').props.disabled, true);
  view.setPendingMutation(-1);
  view.setStatus({ mode: 'companion', items: [], companion: { connected: false } });
  await button(view.render(), 'council.localAgents.pair').props.onClick();
  view.setQueryFailed(true);
  const tree = view.render();
  assert.ok(nodes(tree).some(node => node.props.role === 'alert' && text(node).includes('council.localAgents.loadFailed')));
  assert.ok(nodes(tree).some(node => node.type === 'a' && String(node.props.href).startsWith('squabble://')));
  assert.ok(view.queries.some(query => query.retry === false));
  view.mutations[0].onError(new Error('private diagnostic'));
  assert.ok(text(view.render()).includes('council.localAgents.actionFailed'));
  assert.ok(!text(view.render()).includes('private diagnostic'));
});

test('member editor keeps the model API option and removes native-only web focus when switching', () => {
  const states = [];
  let cursor = 0;
  let saved;
  const jsx = (type, props) => ({ type, props });
  const component = load('client/src/pages/Council/CouncilMemberEditor.tsx', {
    react: { useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-i18next': { useTranslation: () => ({ t: key => key }) },
    '@shared/council-templates': load('shared/council-templates.ts'),
    './useCouncilModels': { councilModelValue: member => `${member.connectionId || 'default'}:${member.model}` },
  });
  const props = { member: { id: 'researcher', role: 'researcher', name: 'Researcher', instructions: '',
    executionMode: 'local', agentId: 'native-codex', model: 'slow', researchFocus: ['financials', 'web'] },
    webResearch: false, localAgents: [agent({ connected: true, available: true })],
    modelOptions: [{ value: 'default:slow', model: 'slow', label: 'Model API', disabled: false }],
    onSave: value => { saved = value; return null; }, onClose() {} };
  const render = () => { cursor = 0; return component.default(props); };
  let tree = render();
  const selector = nodes(tree).find(node => node.props.id === 'member-editor-execution');
  assert.ok(nodes(selector).some(node => node.type === 'option' && node.props.value === 'local'));
  assert.ok(nodes(selector).some(node => node.type === 'option' && node.props.value === 'model'));
  selector.props.onChange({ target: { value: 'model' } });
  tree = render();
  nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {}, stopPropagation() {} });
  assert.equal(saved.executionMode, 'model');
  assert.equal(saved.model, 'slow');
  assert.equal(saved.agentId, undefined);
  assert.deepEqual([...saved.researchFocus], ['financials']);
});

test('native API uses the catalog, connection, login, and companion routes', async () => {
  const calls = [];
  const response = { items: [agent({ connected: true })], code: 'pair-code', expiresAt: '2099-01-01T00:00:00Z' };
  const http = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, async url => {
    calls.push(`${method} ${url}`); return { data: response };
  }]));
  const api = load('client/src/api/local-agents.ts', { './http': { __esModule: true, default: http } });
  assert.equal((await api.fetchLocalAgents())[0].id, 'native-codex');
  await api.fetchLocalAgentsStatus();
  await api.connectLocalAgent('native-codex');
  await api.disconnectLocalAgent('native-codex');
  await api.loginLocalAgent('native-codex');
  assert.equal((await api.createLocalAgentPairing()).code, 'pair-code');
  await api.disconnectLocalCompanion();
  assert.deepEqual(calls, [
    'get /api/settings/local-agents', 'get /api/settings/local-agents/status',
    'post /api/settings/local-agents/native-codex/connect', 'post /api/settings/local-agents/native-codex/disconnect',
    'post /api/settings/local-agents/native-codex/login', 'post /api/settings/local-agents/pairing',
    'delete /api/settings/local-agents/companion',
  ]);
});
