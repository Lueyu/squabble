const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const file = path.resolve(__dirname, '../pages/Settings/settings-navigation.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const navigation = {};
vm.runInNewContext(compiled, { exports: navigation });

test('settings opens model configuration by default and preserves legacy shortcuts', () => {
  const resolve = navigation.resolveSettingsSection;
  assert.equal(resolve('/settings'), 'models');
  assert.equal(resolve('/settings/'), 'models');
  assert.equal(resolve('/settings', '#research-budget'), 'budget');
  assert.equal(resolve('/settings', '#local-agents'), 'agents');
  assert.equal(resolve('/settings', '#model-connections'), 'models');
});

test('every settings destination supports direct navigation and trailing slashes', () => {
  for (const section of navigation.SETTINGS_SECTIONS) {
    assert.equal(navigation.resolveSettingsSection(`/settings/${section.id}`), section.id);
    assert.equal(navigation.resolveSettingsSection(`/settings/${section.id}/`), section.id);
  }
});

test('explicit routes win over old hashes and unknown routes are not silently accepted', () => {
  assert.equal(navigation.resolveSettingsSection('/settings/security', '#research-budget'), 'security');
  assert.equal(navigation.resolveSettingsSection('/settings/missing'), null);
  assert.equal(navigation.resolveSettingsSection('/settings/models/extra'), null);
  assert.equal(navigation.resolveSettingsSection('/other'), null);
});

test('canonicalizing the settings entry keeps previously visited form panels mounted', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../pages/Settings/SettingsPage.tsx'), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const jsx = (type, props, key) => ({ type, props, key });
  const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes)
    : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
  for (const [pathname, hash] of [['/settings', ''], ['/settings', '#research-budget']]) {
    const exports = {};
    const imports = {
      react: { useEffect() {}, useRef: current => ({ current }), useState: () => [['models', 'data'], () => {}] },
      'react/jsx-runtime': { jsx, jsxs: jsx },
      'react-i18next': { useTranslation: () => ({ t: key => key }) },
      'react-router-dom': { useLocation: () => ({ pathname, hash, search: '' }), useNavigate: () => () => {} },
      './settings-navigation': navigation,
      '@/api/auth-mode': { getAuthMode: () => 'account' },
      '@/features/navigation/use-workspace-navigation': { useWorkspaceNavigation() {} },
    };
    vm.runInNewContext(output, { exports, require: name => imports[name] ?? {} });
    const tree = exports.default();
    const panels = nodes(tree).filter(node => node.props?.role === 'region');
    assert.ok(panels.some(node => node.key === 'models'), 'The model draft must stay mounted during redirect');
    assert.ok(panels.some(node => node.key === 'data'), 'The market-data draft must stay mounted during redirect');
  }
});

test('model-connection dialogs hide on inactive categories without losing the editor draft', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../pages/Settings/ModelConnectionsPanel.tsx'), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const states = [];
  let cursor = 0;
  const jsx = (type, props, key) => ({ type, props, key });
  const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes)
    : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
  const imports = {
    react: { useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    } },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-i18next': { useTranslation: () => ({ t: key => key, i18n: { language: 'en' } }) },
    '@tanstack/react-query': { useQuery: () => ({ data: [], isSuccess: true }),
      useMutation: () => ({ isPending: false }), useQueryClient: () => ({}) },
  };
  const exports = {};
  vm.runInNewContext(output, { exports, require: name => imports[name] ?? new Proxy({}, { get: (_, key) => key }) });
  const render = active => { cursor = 0; return nodes(exports.default({ active })); };
  render(true).find(node => node.type === 'Button' && node.props.children.includes('integrations.connections.add')).props.onClick();
  render(true).find(node => node.props.id === 'connection-name').props.onChange({ target: { value: 'Unsaved connection' } });
  assert.equal(render(true).find(node => node.type === 'Dialog').props.open, true);
  assert.equal(render(false).find(node => node.type === 'Dialog').props.open, false);
  const resumed = render(true);
  assert.equal(resumed.find(node => node.type === 'Dialog').props.open, true);
  assert.equal(resumed.find(node => node.props.id === 'connection-name').props.value, 'Unsaved connection');
});
