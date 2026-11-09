const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

const hookSource = readFileSync(resolve(__dirname, 'use-theme.ts'), 'utf8');
const compiledHook = ts.transpileModule(hookSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function createBrowser(initial = {}, blockedStorage = false) {
  const values = new Map(Object.entries(initial));
  const listeners = new Map();
  const subscribers = [];
  const writes = [];
  const root = {
    dataset: {},
    style: {},
    classList: {
      dark: false,
      toggle(name, enabled) { this[name] = enabled; },
      add(name) { this[name] = true; },
      remove(name) { this[name] = false; },
    },
  };
  const storage = {
    getItem(key) {
      if (blockedStorage) throw new Error('Storage is blocked');
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (blockedStorage) throw new Error('Storage is blocked');
      writes.push([key, value]);
      values.set(key, value);
    },
  };
  const document = { documentElement: root };
  const window = {
    get localStorage() {
      if (blockedStorage) throw new Error('Storage is blocked');
      return storage;
    },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const module = { exports: {} };
  runInNewContext(compiledHook, {
    module,
    exports: module.exports,
    window,
    document,
    localStorage: storage,
    require(name) {
      assert.equal(name, 'react');
      return {
        useSyncExternalStore(subscribe, getSnapshot) {
          const subscriber = { notifications: 0 };
          subscriber.unsubscribe = subscribe(() => { subscriber.notifications += 1; });
          subscribers.push(subscriber);
          return getSnapshot();
        },
      };
    },
  });
  return {
    useTheme: module.exports.useTheme,
    root,
    values,
    writes,
    subscribers,
    storage,
    dispatchStorage(key, newValue, storageArea = storage) {
      if (key === null) values.clear();
      else if (newValue === null) values.delete(key);
      else values.set(key, newValue);
      listeners.get('storage')?.({ key, newValue, storageArea });
    },
    runBootstrap() {
      const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
      const script = html.match(/<script id="appearance-bootstrap">([\s\S]*?)<\/script>/);
      assert.ok(script, 'Appearance should be applied before React loads');
      root.classList.dark = false;
      root.dataset = {};
      root.style = {};
      runInNewContext(script[1], { window, document });
    },
  };
}

test('opens new workspaces in light classic mode without overriding saved preferences', () => {
  const browser = createBrowser();
  const state = browser.useTheme();
  assert.equal(state.theme, 'light');
  assert.equal(state.designTheme, 'classic');
  assert.equal(browser.root.classList.dark, false);
  assert.equal(browser.root.dataset.designTheme, 'classic');
});

test('all mounted consumers are notified and mode changes preserve the design', () => {
  const browser = createBrowser({ 'pt-theme': 'light', 'sq-design-theme': 'arcade' });
  const first = browser.useTheme();
  browser.useTheme();
  first.setDesignTheme('comic');
  assert.equal(browser.subscribers[0].notifications, 1);
  assert.equal(browser.subscribers[1].notifications, 1);
  assert.equal(browser.useTheme().designTheme, 'comic');
  first.setTheme((previous) => previous === 'light' ? 'dark' : 'light');
  assert.equal(browser.useTheme().theme, 'dark');
  assert.equal(browser.useTheme().designTheme, 'comic');
  first.toggleTheme();
  assert.equal(browser.useTheme().theme, 'light');
  assert.equal(browser.values.get('sq-design-theme'), 'comic');
});

test('storage changes synchronize without being written back and clear resets both preferences', () => {
  const browser = createBrowser({ 'pt-theme': 'light', 'sq-design-theme': 'arcade' });
  browser.useTheme();
  browser.dispatchStorage('sq-design-theme', 'orbit');
  assert.equal(browser.useTheme().designTheme, 'orbit');
  assert.equal(browser.root.dataset.designTheme, 'orbit');
  browser.dispatchStorage('pt-theme', 'dark');
  assert.equal(browser.useTheme().theme, 'dark');
  browser.dispatchStorage('sq-design-theme', 'unsupported-theme');
  assert.equal(browser.useTheme().designTheme, 'classic');
  browser.dispatchStorage(null, null);
  assert.equal(browser.useTheme().theme, 'light');
  assert.equal(browser.useTheme().designTheme, 'classic');
  assert.deepEqual(browser.writes, []);
});

test('storage events from sessionStorage do not affect local preferences', () => {
  const browser = createBrowser({ 'sq-design-theme': 'arcade' });
  browser.useTheme();
  browser.dispatchStorage('sq-design-theme', 'orbit', {});
  assert.equal(browser.useTheme().designTheme, 'arcade');
});

test('unavailable localStorage still permits changing the appearance in memory', () => {
  const browser = createBrowser({}, true);
  const state = browser.useTheme();
  state.setTheme('light');
  state.setDesignTheme('orbit');
  assert.equal(browser.useTheme().theme, 'light');
  assert.equal(browser.useTheme().designTheme, 'orbit');
  assert.equal(browser.root.classList.dark, false);
  assert.equal(browser.root.dataset.designTheme, 'orbit');
});

test('startup bootstrap matches persisted preferences for every design and mode', () => {
  for (const theme of ['light', 'dark']) {
    for (const designTheme of ['classic', 'arcade', 'comic', 'orbit']) {
      const browser = createBrowser({ 'pt-theme': theme, 'sq-design-theme': designTheme });
      browser.runBootstrap();
      assert.equal(browser.root.classList.dark, theme === 'dark');
      assert.equal(browser.root.dataset.designTheme, designTheme);
      assert.equal(browser.root.style.colorScheme, theme);
    }
  }
});

test('startup bootstrap falls back safely for invalid or blocked storage', () => {
  for (const blocked of [false, true]) {
    const browser = createBrowser({ 'pt-theme': 'sepia', 'sq-design-theme': 'neon' }, blocked);
    browser.runBootstrap();
    assert.equal(browser.root.classList.dark, false);
    assert.equal(browser.root.dataset.designTheme, 'classic');
  }
});
