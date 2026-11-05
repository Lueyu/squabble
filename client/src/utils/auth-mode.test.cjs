const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { AxiosHeaders } = require('axios');

const root = path.resolve(__dirname, '..');
const jsx = (type, props, key) => ({ type, props, key });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes)
  : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const unknown = new Proxy({}, { get: (_, key) => key });
function load(file, imports = {}, globals = {}) {
  const exports = {};
  const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(output, { exports, require: id => imports[id] ?? unknown, ...globals });
  return exports;
}
const language = { useTranslation: () => ({ t: key => key, i18n: { language: 'en' } }) };
const react = { useEffect() {}, useState: initial => [initial, () => {}], useRef: current => ({ current }) };

function httpHarness(mode, tokens = { 'sq-at': 'saved-access', 'sq-rt': 'saved-refresh' }) {
  const storage = new Map(Object.entries(tokens));
  const redirects = [];
  const requests = [];
  const handlers = {};
  const client = config => { requests.push(config); return Promise.resolve({ data: 'retried' }); };
  client.post = (url, body) => { requests.push({ url, body }); return Promise.resolve({ data: { accessToken: 'new-access', refreshToken: 'new-refresh' } }); };
  client.interceptors = {
    request: { use: handler => { handlers.request = config => handler({ ...config, headers: AxiosHeaders.from(config.headers) }); } },
    response: { use: (_success, failure) => { handlers.failure = failure; } },
  };
  const authMode = { getAuthMode: () => mode };
  const exports = load('api/http.ts', { axios: { default: { create: () => client } }, './auth-mode': authMode }, {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { location: { pathname: '/', assign: to => redirects.push(to) } },
  });
  return { exports, handlers, storage, redirects, requests };
}

test('local workspace has a session without credentials and never sends a saved Bearer token', () => {
  const empty = httpHarness('local', {});
  assert.equal(empty.exports.hasSession(), true);
  const { handlers, storage } = httpHarness('local');
  assert.equal(handlers.request({ url: '/api/auth/me', headers: {} }).headers.Authorization, undefined);
  assert.equal(storage.get('sq-at'), 'saved-access');
});

test('local API 401 keeps credentials and does not refresh or redirect', async () => {
  const { handlers, storage, redirects, requests } = httpHarness('local');
  const error = { response: { status: 401 }, config: { url: '/api/auth/me', headers: {} } };
  await assert.rejects(handlers.failure(error), caught => caught === error);
  assert.deepEqual(requests, []);
  assert.deepEqual(redirects, []);
  assert.equal(storage.get('sq-at'), 'saved-access');
  assert.equal(storage.get('sq-rt'), 'saved-refresh');
});

test('mode discovery never attaches credentials or redirects on 401 before mode is known', async () => {
  const { handlers, storage, redirects, requests } = httpHarness('account');
  const request = handlers.request({ url: '/api/auth/mode', headers: {} });
  assert.equal(request.headers.Authorization, undefined);
  const error = { response: { status: 401 }, config: request };
  await assert.rejects(handlers.failure(error), caught => caught === error);
  assert.deepEqual(requests, []);
  assert.deepEqual(redirects, []);
  assert.equal(storage.get('sq-at'), 'saved-access');
});

test('account mode still sends stored tokens and refreshes an expired session', async () => {
  const { exports, handlers, storage, redirects, requests } = httpHarness('account');
  assert.equal(exports.hasSession(), true);
  assert.equal(handlers.request({ url: '/api/auth/me', headers: {} }).headers.Authorization, 'Bearer saved-access');
  await handlers.failure({ response: { status: 401 }, config: { url: '/api/auth/me', headers: {} } });
  assert.equal(requests[0].url, '/api/auth/refresh');
  assert.equal(requests[1]._sessionRetried, true);
  assert.equal(storage.get('sq-at'), 'new-access');
  assert.deepEqual(redirects, []);
});

test('account mode still clears invalid sessions and sends users to login', async () => {
  const { exports, handlers, storage, redirects } = httpHarness('account', { 'sq-at': 'invalid' });
  const error = { response: { status: 401 }, config: { url: '/api/auth/me' } };
  await assert.rejects(handlers.failure(error), caught => caught === error);
  assert.equal(exports.hasSession(), false);
  assert.equal(storage.size, 0);
  assert.deepEqual(redirects, ['/login']);
});

test('local auth URLs redirect home while account mode retains all auth pages', () => {
  for (const mode of ['local', 'account']) {
    const app = load('app.tsx', { react, 'react/jsx-runtime': { jsx, jsxs: jsx },
      'react-router-dom': { Route: 'Route', Routes: 'Routes', Navigate: 'Navigate' },
      './api/auth-mode': { getAuthMode: () => mode },
    });
    const routes = nodes(app.default());
    for (const url of ['/login', '/register', '/recover']) {
      const page = routes.find(node => node.props?.path === url).props.element;
      if (mode === 'local') { assert.equal(page.type, 'Navigate'); assert.equal(page.props.to, '/'); }
      else assert.notEqual(page.type, 'Navigate');
    }
  }
});

test('local sidebar replaces account identity and logout with the workspace label', () => {
  for (const mode of ['local', 'account']) {
    const layout = load('components/Layout.tsx', { react, 'react/jsx-runtime': { jsx, jsxs: jsx },
      'react-i18next': language, 'react-router-dom': { useLocation: () => ({ pathname: '/' }) },
      '../hooks/use-theme': { useTheme: () => ({ theme: 'light' }) },
      '@/api/http': { hasSession: () => true }, '@/api/auth-mode': { getAuthMode: () => mode },
    });
    const tree = nodes(layout.default());
    const names = tree.map(node => node.type?.name);
    assert.equal(names.includes('SidebarUserBlock'), mode === 'account');
    assert.equal(names.includes('LogoutButton'), mode === 'account');
    assert.equal(tree.some(node => node.props?.children === 'layout.localWorkspace'), mode === 'local');
    if (mode === 'local') {
      const block = tree.find(node => node.props?.title === 'layout.localWorkspace');
      assert.ok(block, 'The compact sidebar must retain a workspace tooltip');
      assert.ok(block.props.className.includes('app-user-block'));
      const content = nodes(block);
      assert.ok(content.some(node => node.props?.className?.includes('app-user-copy')),
        'Visible workspace text must use the existing compact-sidebar collapse style');
      assert.ok(content.some(node => node.props?.className === 'sr-only' && node.props.children === 'layout.localWorkspace'));
    }
  }
});

test('privacy return link opens the local workspace without showing a login action', () => {
  for (const mode of ['local', 'account']) {
    const page = load('pages/Privacy/PrivacyPage.tsx', { 'react/jsx-runtime': { jsx, jsxs: jsx },
      'react-i18next': language, 'react-router-dom': { Link: 'Link' },
      '@/api/auth-mode': { getAuthMode: () => mode },
    });
    const link = nodes(page.default()).find(node => node.type === 'Link');
    assert.equal(link.props.to, mode === 'local' ? '/' : '/login');
    assert.equal(link.props.children, mode === 'local' ? 'privacy.backToWorkspace' : 'privacy.back');
  }
});

test('workspace status and failed initialization have Chinese and English copy', () => {
  for (const locale of ['en', 'zh-CN']) {
    const copy = JSON.parse(fs.readFileSync(path.join(root, 'i18n', `${locale}.json`), 'utf8'));
    for (const key of ['layout.localWorkspace', 'auth.modeLoading', 'auth.modeFailedTitle', 'auth.modeFailedDescription', 'privacy.backToWorkspace']) {
      const text = key.split('.').reduce((value, part) => value?.[part], copy);
      assert.equal(typeof text, 'string', `Missing ${locale} translation for ${key}`);
      assert.ok(text.trim());
    }
  }
});

test('local settings hides account security on desktop and mobile and redirects old security links', () => {
  const navigation = load('pages/Settings/settings-navigation.ts');
  for (const mode of ['local', 'account']) {
    const imports = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-i18next': language,
      '@/api/auth-mode': { getAuthMode: () => mode }, './settings-navigation': navigation,
      'react-router-dom': { NavLink: 'NavLink', useNavigate: () => () => {} },
    };
    const menu = nodes(load('pages/Settings/SettingsNavigation.tsx', imports).default({ active: 'models' }));
    assert.equal(menu.some(node => node.props?.to === '/settings/security'), mode === 'account');
    assert.equal(menu.some(node => node.props?.value === 'security'), mode === 'account');
    const redirects = [];
    const page = load('pages/Settings/SettingsPage.tsx', { ...imports,
      react: { ...react, useEffect: effect => effect() },
      'react-router-dom': { useLocation: () => ({ pathname: '/settings/security', hash: '', search: '' }),
        useNavigate: () => (...args) => redirects.push(args) },
    });
    const panels = nodes(page.default()).filter(node => node.props?.role === 'region');
    assert.equal(panels.some(node => node.key === 'security'), mode === 'account');
    if (mode === 'local') assert.equal(redirects[0][0].pathname, '/settings/models');
  }
});

function hookRunner() {
  const states = [], dependencies = [], effects = [];
  let cursor = 0;
  return {
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
      },
      useEffect(effect, deps) {
        const index = cursor++;
        if (!dependencies[index] || deps.some((dep, i) => !Object.is(dep, dependencies[index][i]))) {
          dependencies[index] = deps;
          effects.push(effect);
        }
      },
    },
    render(component) { cursor = 0; const result = component({ children: 'application-routes' }); effects.splice(0).forEach(effect => effect()); return result; },
  };
}

test('auth bootstrap blocks routes on failure, exposes retry, and sets verified mode before mounting', async () => {
  assert.ok(fs.existsSync(path.join(root, 'components/AuthModeGate.tsx')), 'Auth mode must be resolved before rendering routes');
  const hooks = hookRunner();
  let calls = 0, mode = 'account';
  const gate = load('components/AuthModeGate.tsx', { react: hooks.react,
    'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-i18next': language,
    '@/api/auth-mode': { setAuthMode: value => { mode = value; } },
    '@/api/http': { default: { get: async url => {
      assert.equal(url, '/api/auth/mode');
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return { data: { mode: 'local' } };
    } } },
  }).default;
  assert.notEqual(hooks.render(gate), 'application-routes');
  await new Promise(resolve => setImmediate(resolve));
  const failure = nodes(hooks.render(gate));
  assert.ok(failure.some(node => node.props?.role === 'alert'));
  assert.equal(mode, 'account');
  const retry = failure.find(node => node.type === 'Button');
  assert.ok(retry, 'Failed initialization needs a retry button');
  retry.props.onClick();
  hooks.render(gate);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mode, 'local');
  assert.equal(hooks.render(gate), 'application-routes');
  hooks.render(gate);
  assert.equal(calls, 2, 'Normal renders must not repeat mode discovery');
});

test('auth bootstrap rejects invalid server modes instead of silently opening routes', async () => {
  assert.ok(fs.existsSync(path.join(root, 'components/AuthModeGate.tsx')), 'Auth mode gate is required');
  const hooks = hookRunner();
  const gate = load('components/AuthModeGate.tsx', { react: hooks.react,
    'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-i18next': language,
    '@/api/auth-mode': { setAuthMode: () => assert.fail('Invalid modes must never be saved') },
    '@/api/http': { default: { get: async () => ({ data: { mode: 'unexpected' } }) } },
  }).default;
  hooks.render(gate);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(nodes(hooks.render(gate)).some(node => node.props?.role === 'alert'));
});
