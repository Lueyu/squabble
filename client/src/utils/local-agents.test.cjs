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
  connected: false, available: false, busy: false, source: 'native', models: [], ...overrides });
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
function editor(memberOverrides = {}, agents = [agent({ connected: true, available: true })], translate = key => key) {
  const states = [];
  let cursor = 0;
  let saved;
  const jsx = (type, props) => ({ type, props });
  const settingsFile = 'client/src/utils/local-agent-settings.ts';
  const settings = fs.existsSync(path.join(root, settingsFile)) ? load(settingsFile) : {};
  const component = load('client/src/pages/Council/CouncilMemberEditor.tsx', {
    react: { useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-i18next': { useTranslation: () => ({ t: translate }) },
    '@shared/council-templates': load('shared/council-templates.ts'),
    '@/utils/local-agent-settings': settings,
    './useCouncilModels': { councilModelValue: member => `${member.connectionId || 'default'}:${member.model}` },
  });
  const props = { member: { id: 'researcher', role: 'researcher', name: 'Researcher', instructions: '',
    executionMode: 'local', agentId: 'native-codex', model: 'slow', researchFocus: ['financials', 'web'], ...memberOverrides },
    webResearch: false, localAgents: agents,
    modelOptions: [{ value: 'default:slow', model: 'slow', label: 'Model API', disabled: false }],
    onSave: value => { saved = value; return null; }, onClose() {} };
  const render = () => { cursor = 0; return component.default(props); };
  const field = id => { const result = nodes(render()).find(node => node.props.id === id);
    assert.ok(result, `Missing field: ${id}`); return result; };
  return { render, field, props,
    change(id, value) { field(id).props.onChange({ target: { value } }); },
    save() { saved = undefined; nodes(render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {}, stopPropagation() {} });
      return saved; },
  };
}
function panel(initialStatus, translate = key => key) {
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
    'react-i18next': { useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) },
    '@tanstack/react-query': {
      useQuery(options) { queries.push(options); return { data: options.queryKey.includes('status') ? status : [],
        isSuccess: !queryFailed, isPending: false, isFetching: false, isError: queryFailed, refetch: async () => {} }; },
      useQueryClient: () => ({ invalidateQueries: async options => invalidated.push(options.queryKey) }),
      useMutation(options) { const index = mutations.length; mutations.push(options); return { isPending: index === pendingMutation,
        mutate: async value => { const result = await options.mutationFn(value); await options.onSuccess?.(result, value); },
        reset() {} }; },
    },
    '@/api/local-agents': api,
    '@/pages/AgentBuilder/errorMessage': load('client/src/pages/AgentBuilder/errorMessage.ts', {
      axios: { __esModule: true, default: { isAxiosError: error => error.isAxiosError } },
      i18next: { t: translate },
    }),
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

test('assigning a team clears provider settings only for members moving to another agent', () => {
  const { assignLocalAgents } = load('client/src/pages/Council/useCouncilModels.ts');
  const settings = { model: 'custom-model', reasoningEffort: 'high' };
  const members = [{ id: 'r', model: 'slow', executionMode: 'local', agentId: 'native-codex', agentSettings: settings },
    { id: 'm', model: 'fast', executionMode: 'local', agentId: 'native-claude', agentSettings: settings }];
  const result = assignLocalAgents(members, [agent({ connected: true, available: true })]);
  assert.equal(result[0].agentSettings, settings);
  assert.equal(result[1].agentSettings, undefined);
});

test('member agent settings inherit defaults and persist independently from the API model tier', () => {
  const view = editor({}, [agent({ connected: true, available: true, reasoningEfforts: ['low', 'high'],
    models: [{ id: 'model-a', name: 'Model A', reasoningEfforts: ['low', 'high'] }] })]);
  assert.equal(view.field('member-editor-agent-model').props.value, '');
  assert.equal(view.field('member-editor-agent-effort').props.value, '');
  assert.equal(view.save().agentSettings, undefined);
  view.change('member-editor-agent-model', 'model-a');
  view.change('member-editor-agent-effort', 'high');
  assert.ok(text(view.field('member-editor-agent-effort')).includes('council.localAgents.effortLevels.high'));
  const saved = view.save();
  assert.equal(saved.model, 'slow');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.agentSettings)), { model: 'model-a', reasoningEffort: 'high' });
  const reopened = editor(saved, view.props.localAgents);
  assert.equal(reopened.field('member-editor-agent-model').props.value, 'model-a');
  assert.equal(reopened.field('member-editor-agent-effort').props.value, 'high');
});

test('model changes preserve compatible effort and clear an unsupported model effort', () => {
  const view = editor({ agentSettings: { model: 'model-a', reasoningEffort: 'high' } },
    [agent({ connected: true, available: true, reasoningEfforts: ['low', 'high'], models: [
      { id: 'model-a', name: 'Model A', reasoningEfforts: ['high'] },
      { id: 'model-b', name: 'Model B', reasoningEfforts: ['high'] },
      { id: 'model-c', name: 'Model C', reasoningEfforts: [] },
    ] })]);
  view.change('member-editor-agent-model', 'model-b');
  assert.equal(view.field('member-editor-agent-effort').props.value, 'high');
  view.change('member-editor-agent-model', 'model-c');
  assert.equal(view.field('member-editor-agent-effort').props.value, '');
  assert.equal(view.field('member-editor-agent-effort').props.disabled, true);
  assert.ok(text(view.render()).includes('council.localAgents.reasoningUnsupported'));
  assert.deepEqual(JSON.parse(JSON.stringify(view.save().agentSettings)), { model: 'model-c' });
});

test('switching agent or execution route clears native settings without changing slow API choice', () => {
  const view = editor({ agentSettings: { model: 'model-a', reasoningEffort: 'high' } }, [
    agent({ connected: true, available: true, reasoningEfforts: ['high'] }),
    agent({ id: 'native-gemini', provider: 'gemini', name: 'Gemini CLI', connected: true, available: true }),
  ]);
  view.change('member-editor-agent', 'native-gemini');
  assert.equal(view.save().agentSettings, undefined);
  assert.equal(view.field('member-editor-agent-effort').props.disabled, true);
  assert.ok(text(view.render()).includes('council.localAgents.reasoningUnknown'));
  view.change('member-editor-execution', 'model');
  const saved = view.save();
  assert.equal(saved.agentSettings, undefined);
  assert.equal(saved.agentId, undefined);
  assert.equal(saved.model, 'slow');
});

test('custom models round-trip and unknown capability never invents reasoning levels', () => {
  const view = editor({ agentSettings: { model: 'provider/custom-model' } });
  assert.equal(view.field('member-editor-agent-custom-model').props.value, 'provider/custom-model');
  assert.equal(view.field('member-editor-agent-effort').props.disabled, true);
  assert.equal(nodes(view.field('member-editor-agent-effort')).filter(node => node.type === 'option').length, 1);
  view.change('member-editor-agent-custom-model', ' provider/new-model ');
  assert.equal(view.save().agentSettings.model, 'provider/new-model');
  view.change('member-editor-agent-model', '');
  assert.equal(view.save().agentSettings, undefined);
});

test('a model removed from refreshed suggestions remains editable as a custom model', () => {
  const view = editor({ agentSettings: { model: 'model-a' } },
    [agent({ connected: true, available: true, models: [{ id: 'model-a', name: 'Model A' }] })]);
  view.render();
  view.props.localAgents = [agent({ connected: true, available: true })];
  assert.equal(view.field('member-editor-agent-custom-model').props.value, 'model-a');
  assert.equal(view.save().agentSettings.model, 'model-a');
});

test('Chinese effort labels translate known values and preserve provider-specific values', async () => {
  const i18n = require('i18next').createInstance();
  await i18n.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: {
    council: JSON.parse(fs.readFileSync(path.join(root, 'client/src/i18n/council.zh-CN.json'), 'utf8')),
  } } } });
  const view = editor({}, [agent({ connected: true, available: true, reasoningEfforts: ['high', 'provider-variant'] })],
    i18n.t.bind(i18n));
  const options = nodes(view.field('member-editor-agent-effort')).filter(node => node.type === 'option');
  assert.equal(text(options.find(node => node.props.value === 'high')), '高');
  assert.equal(text(options.find(node => node.props.value === 'provider-variant')), 'provider-variant');
});

test('invalid model IDs and stale reasoning choices block saving instead of silently dropping settings', () => {
  for (const model of ['bad\nmodel', 'x'.repeat(161)]) {
    const view = editor({ agentSettings: { model } });
    assert.equal(view.save(), undefined);
    assert.ok(text(view.render()).includes('council.localAgents.modelInvalid'));
  }
  const view = editor({ agentSettings: { model: 'custom', reasoningEffort: 'high' } });
  assert.equal(view.save(), undefined);
  assert.ok(text(view.render()).includes('council.localAgents.reasoningInvalid'));
  for (const reasoningEffort of ['x'.repeat(33), 'high\n']) {
    const invalid = editor({ agentSettings: { reasoningEffort } },
      [agent({ connected: true, available: true, reasoningEfforts: [reasoningEffort] })]);
    assert.equal(invalid.save(), undefined);
    assert.ok(text(invalid.render()).includes('council.localAgents.reasoningInvalid'));
  }
});

test('models without an effort catalog use provider options and stale values can return to default', () => {
  const view = editor({ agentSettings: { model: 'model-a', reasoningEffort: 'retired' } },
    [agent({ connected: true, available: true, models: [{ id: 'model-a', name: 'Model A' }], reasoningEfforts: ['high'] })]);
  assert.equal(view.field('member-editor-agent-effort').props.disabled, false);
  assert.ok(nodes(view.field('member-editor-agent-effort')).some(node => node.props.value === 'high'));
  assert.equal(view.save(), undefined);
  button(view.render(), 'council.localAgents.inheritDefault').props.onClick();
  assert.equal(view.save().agentSettings.reasoningEffort, undefined);
});

test('older agents without model capability offer only default and let stale overrides be cleared', () => {
  const view = editor({ agentSettings: { model: 'old-model' } }, [agent({ connected: true, available: true, models: undefined })]);
  assert.equal(view.field('member-editor-agent-model').props.disabled, true);
  assert.equal(nodes(view.field('member-editor-agent-model')).filter(node => node.type === 'option').length, 1);
  assert.ok(text(view.render()).includes('council.localAgents.modelUnsupported'));
  assert.equal(view.save(), undefined);
  button(view.render(), 'council.localAgents.inheritDefault').props.onClick();
  assert.equal(view.save().agentSettings, undefined);
});

test('native configuration API errors become actionable translated messages', () => {
  const { errorMessage } = load('client/src/pages/AgentBuilder/errorMessage.ts', {
    axios: { __esModule: true, default: { isAxiosError: error => error.isAxiosError } },
    i18next: { t: key => key },
  });
  for (const [code, key] of [['LOCAL_INVALID_CONFIGURATION', 'configurationInvalid'],
    ['LOCAL_CONFIGURATION_UNSUPPORTED', 'configurationUnsupported'], ['LOCAL_VERSION_UNSUPPORTED', 'versionUnsupported'],
    ['LOCAL_LOGIN_REQUIRED', 'loginRequired']]) {
    assert.equal(errorMessage({ isAxiosError: true, response: { data: { error: { message: code } } } }, 'fallback'),
      `council.localAgents.${key}`);
  }
  assert.equal(errorMessage({ isAxiosError: true, response: { data: { message: 'Other error' } } }, 'fallback'), 'Other error');
  assert.equal(errorMessage(new Error('private detail'), 'fallback'), 'fallback');
});

test('all seven provider cards render localized capability help as text', () => {
  const providers = ['codex', 'claude', 'gemini', 'antigravity', 'opencode', 'kimi', 'doubao'];
  const help = '<script>provider help</script>';
  const view = panel({ mode: 'native', items: providers.map(provider => agent({ id: `native-${provider}`, provider,
    name: provider, configurationHelp: help })), companion: { connected: false } });
  const tree = view.render();
  assert.equal(nodes(tree).filter(node => node.type === 'article').length, 7);
  for (const provider of providers) assert.ok(text(tree).includes(`council.localAgents.providerHelp.${provider}`));
  assert.ok(!text(tree).includes(help));
  assert.ok(nodes(tree).every(node => !node.props.dangerouslySetInnerHTML));
});

test('agent settings and member editor explain live tools and snapshot fallback in both languages', async () => {
  const i18n = require('i18next').createInstance();
  const resources = Object.fromEntries(['zh-CN', 'en'].map(language => [language, { translation: {
    council: JSON.parse(fs.readFileSync(path.join(root, `client/src/i18n/council.${language}.json`), 'utf8')),
  } }]));
  await i18n.init({ lng: 'en', resources });
  for (const language of ['en', 'zh-CN']) {
    await i18n.changeLanguage(language);
    const t = i18n.t.bind(i18n);
    for (const capability of [{ mode: 'mcp', reason: 'supported' }, { mode: 'snapshot', reason: 'version_unsupported' },
      { mode: 'snapshot', reason: 'runtime_unsupported' }]) {
      const known = agent({ connected: true, available: true, researchTools: capability });
      const key = capability.mode === 'mcp' ? 'live' : capability.reason;
      const expected = resources[language].translation.council.localAgents.tools?.[key];
      assert.ok(expected, `Missing ${language} capability copy: ${key}`);
      assert.ok(text(editor({}, [known], t).render()).includes(expected));
      assert.ok(text(panel({ mode: 'native', items: [known], companion: { connected: false } }, t).render()).includes(expected));
      assert.doesNotMatch(expected, /MCP|JSON|A2A/);
    }
  }
});

test('provider help is bilingual, describes the Doubao community bridge, and falls back to server text', async () => {
  const i18n = require('i18next').createInstance();
  const resources = Object.fromEntries(['zh-CN', 'en'].map(language => [language, { translation: {
    council: JSON.parse(fs.readFileSync(path.join(root, `client/src/i18n/council.${language}.json`), 'utf8')),
  } }]));
  await i18n.init({ lng: 'zh-CN', resources });
  for (const language of ['zh-CN', 'en']) {
    await i18n.changeLanguage(language);
    const t = i18n.t.bind(i18n);
    const known = agent({ id: 'native-doubao', provider: 'doubao', connected: true, available: true,
      configurationHelp: 'Raw English help' });
    const help = resources[language].translation.council.localAgents.providerHelp?.doubao;
    assert.ok(help, `Missing ${language} Doubao help`);
    assert.match(help, language === 'zh-CN' ? /社区.*非字节跳动官方/ : /community.*not an official ByteDance/i);
    const view = editor({ agentId: known.id }, [known], t);
    assert.ok(text(view.render()).includes(help));
    assert.ok(text(panel({ mode: 'native', items: [known], companion: { connected: false } }, t).render()).includes(help));
    const unknown = agent({ provider: 'future-provider', configurationHelp: '<script>legacy help</script>' });
    const fallback = panel({ mode: 'native', items: [unknown], companion: { connected: false } }, t).render();
    assert.ok(text(fallback).includes(unknown.configurationHelp));
    assert.ok(nodes(fallback).every(node => !node.props.dangerouslySetInnerHTML));
  }
});

test('native settings show an actionable version error for an older companion', () => {
  const view = panel({ mode: 'native', items: [agent()], companion: { connected: false } });
  view.render();
  view.mutations[0].onError({ isAxiosError: true, response: { data: { message: 'LOCAL_VERSION_UNSUPPORTED' } } });
  assert.ok(text(view.render()).includes('council.localAgents.versionUnsupported'));
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
  const view = editor();
  const selector = view.field('member-editor-execution');
  assert.ok(nodes(selector).some(node => node.type === 'option' && node.props.value === 'local'));
  assert.ok(nodes(selector).some(node => node.type === 'option' && node.props.value === 'model'));
  selector.props.onChange({ target: { value: 'model' } });
  const saved = view.save();
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
