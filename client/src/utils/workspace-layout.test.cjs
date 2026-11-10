const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const postcss = require('postcss');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const router = require('react-router-dom');
const { JSDOM } = require('jsdom');
const fixture = require('./simple-test-loader.cjs');
const sourceRoot = path.resolve(__dirname, '..');

// JSDOM does not evaluate viewport media queries. Select the applicable source
// rules first, then let its CSS cascade compute styles on the rendered shell.
function viewportCss(width) {
  const compare = (left, op, right) => ({ '<': left < right, '<=': left <= right, '>': left > right, '>=': left >= right })[op];
  const matches = query => {
    const limits = [...query.matchAll(/(width|height)\s*(<=|>=|<|>)\s*(\d+)px|(\d+)px\s*(<=|>=|<|>)\s*(width|height)/g)];
    return limits.length > 0 && limits.every(match => match[1]
      ? compare(match[1] === 'width' ? width : 1000, match[2], Number(match[3]))
      : compare(Number(match[4]), match[5], match[6] === 'width' ? width : 1000));
  };
  const rules = [];
  for (const file of ['themes.css', 'portfolio-workspace.css', 'workspace-navigation.css', 'pages/Settings/settings.css']) {
    postcss.parse(fs.readFileSync(path.join(sourceRoot, file), 'utf8')).walkRules(rule => {
      for (let parent = rule.parent; parent; parent = parent.parent) {
        if (parent.type === 'atrule' && parent.name === 'media' && !matches(parent.params)) return;
      }
      rules.push(rule.toString());
    });
  }
  return rules.join('\n');
}

function shell(pathname, width) {
  const f = fixture();
  f.load('api/auth-mode.ts').getAuthMode = () => 'local';
  f.load('features/navigation/use-workspace-navigation.ts').useWorkspaceNavigation = () => ({ goBack() {} });
  const navigation = f.load('features/navigation/WorkspaceNavigationBar.tsx');
  const SettingsNavigation = f.load('pages/Settings/SettingsNavigation.tsx').default;
  const children = ({ children }) => React.createElement(React.Fragment, null, children);
  const noop = () => null;
  const imports = {
    react: React,
    'react-router-dom': router,
    'react-i18next': { useTranslation: () => ({ t: key => key, i18n: { language: 'en' } }) },
    '@tanstack/react-query': { useQuery: () => ({}), useQueryClient: () => ({}) },
    'lucide-react': require('lucide-react'),
    '@/api': {}, '@/api/http': { hasSession: () => true }, '@/api/auth-mode': { getAuthMode: () => 'local' }, '@/i18n': {},
    '../hooks/use-theme': { useTheme: () => ({ theme: 'light', toggleTheme() {} }) },
    '../hooks/use-market-quotes': {},
    '@/hooks/use-simple-experience': { useSimpleExperience: () => ({ enabled: true }) },
    '@/features/navigation/workspace-navigation': f.load('features/navigation/workspace-navigation.ts'),
    '@/features/navigation/use-workspace-navigation': { useWorkspaceNavigation() {} },
    '@/features/navigation/WorkspaceNavigationBar': navigation,
    '@/features/navigation/WorkspaceSearch': { WorkspaceSearch: noop },
    '@/components/AppearancePicker': { AppearancePicker: noop },
    '@/components/Mascot': { Mascot: noop },
    '@/components/ui/skeleton': { Skeleton: noop },
    '@/components/ui/tooltip': { Tooltip: children, TooltipTrigger: children, TooltipContent: noop },
  };
  const exported = {};
  const output = ts.transpileModule(fs.readFileSync(path.join(sourceRoot, 'components/Layout.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(output, { exports: exported, require: id => imports[id] ?? require(id) });
  const content = pathname.startsWith('/settings')
    ? React.createElement('div', { className: 'settings-shell' }, React.createElement(SettingsNavigation, { active: 'models' }), React.createElement('article', { className: 'settings-content' }, 'Model configuration'))
    : React.createElement('article', { className: 'fixture-page' }, 'Saved holdings');
  const html = renderToStaticMarkup(React.createElement(router.MemoryRouter, { initialEntries: [pathname] },
    React.createElement(router.Routes, null, React.createElement(router.Route, { element: React.createElement(exported.default) },
      React.createElement(router.Route, { path: '*', element: content })))));
  const dom = new JSDOM(`<style>${viewportCss(width)}</style>${html}`);
  const element = selector => dom.window.document.querySelector(selector);
  return { dom, element, style: selector => dom.window.getComputedStyle(element(selector)) };
}

for (const width of [1440, 1024, 1023, 768, 390]) {
  test(`settings adds secondary navigation without changing the primary shell at ${width}px`, () => {
    const assets = shell('/holdings', width), settings = shell('/settings/models', width);
    try {
      assert.equal(assets.dom.window.document.querySelectorAll('.app-nav-link').length, 9);
      assert.equal(settings.dom.window.document.querySelectorAll('.app-nav-link').length, 9);
      for (const [selector, properties] of [
        ['.app-sidebar', ['width']], ['.app-brand', ['paddingLeft', 'paddingRight']],
        ['.app-brand-copy', ['display']], ['.app-nav-link > span', ['display']],
        ['.app-nav-link', ['paddingLeft', 'paddingRight', 'minHeight', 'justifyContent']],
        ['.app-nav-link svg', ['width', 'height']], ['.app-footer-actions', ['flexDirection']],
      ]) for (const property of properties) assert.equal(settings.style(selector)[property], assets.style(selector)[property], `${selector} ${property} must stay consistent`);
      assert.equal(settings.style('.settings-sidebar').display, width >= 1024 ? 'flex' : 'none');
      assert.equal(settings.style('.settings-mobile-navigation').display, width >= 1024 ? 'none' : 'block');
      assert.ok(settings.element('.settings-menu-link[aria-current="page"]'));
    } finally { assets.dom.window.close(); settings.dom.window.close(); }
  });

  test(`asset section navigation shares the content gutter at ${width}px`, () => {
    const page = shell('/holdings', width);
    try {
      const tabs = page.element('.workspace-section-tabs');
      assert.equal(tabs.parentElement, page.element('.fixture-page').parentElement);
      assert.equal(page.style('.workspace-section-tabs').paddingLeft, '0px', 'the content already supplies the horizontal gutter');
      assert.equal(page.style('.workspace-section-tabs').paddingRight, '0px');
      assert.equal(page.style('.workspace-section-tabs').maxWidth, page.style('.fixture-page').maxWidth);
    } finally { page.dom.window.close(); }
  });
}
