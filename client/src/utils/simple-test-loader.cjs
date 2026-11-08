const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');

module.exports = function fixture() {
  const state = { language: 'en', queries: new Map(), requests: [] };
  const cache = new Map();
  function load(relative) {
    const filename = path.isAbsolute(relative) ? relative : path.resolve(__dirname, '..', relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} }; cache.set(filename, mod);
    const requireModule = id => {
      if (id.endsWith('.css')) return {};
      if (id === 'react-i18next') return { useTranslation: () => ({ i18n: { language: state.language, resolvedLanguage: state.language }, t: key => key }) };
      if (id === '@/hooks/use-simple-experience') return { useSimpleExperience: () => ({ enabled: true }) };
      if (id === '@tanstack/react-query') return {
        useQuery: options => state.queries.get(JSON.stringify(options.queryKey)) ?? state.queries.get(options.queryKey[0]) ?? { data: undefined, isPending: false },
        useMutation: options => state.mutationFactory ? state.mutationFactory(options) : state.mutation ?? ({ isPending: false, mutateAsync: async () => {}, mutate() {} }),
        useQueryClient: () => ({ invalidateQueries() {}, setQueryData() {} }),
      };
      if (id === './http') return { __esModule: true, default: Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map(method =>
        [method, async (...args) => { state.requests.push({ method, args }); return { data: state.responses?.get(args[0]) ?? (method === 'get' && args[0].endsWith('/preparation') ? { status: 'none' } : {}) }; }])) };
      if (id.startsWith('@/') || id.startsWith('@shared/') || id.startsWith('.')) {
        const target = id.startsWith('@/') ? path.resolve(__dirname, '..', id.slice(2))
          : id.startsWith('@shared/') ? path.resolve(__dirname, '../../../shared', id.slice(8)) : path.resolve(path.dirname(filename), id);
        const found = [target, `${target}.tsx`, `${target}.ts`].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
        if (found) return load(found);
      }
      return require(id);
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    } }).outputText, { module: mod, exports: mod.exports, require: requireModule, URL, URLSearchParams, Date, structuredClone, window: global.window, document: global.document, crypto: { randomUUID: () => state.randomUUID?.() ?? 'request-key' }, setTimeout, clearTimeout });
    return mod.exports;
  }
  return { state, load, render: (Component, props = {}) => renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Component, props))) };
};
