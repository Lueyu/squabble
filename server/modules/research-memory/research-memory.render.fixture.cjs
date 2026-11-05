// Render the production React evidence component against serialized service output.
// Only the unused network module is replaced; this exercises the actual presentation tree.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { MemoryRouter } = require('react-router-dom');
const { renderToStaticMarkup } = require('react-dom/server');
const client = path.resolve(__dirname, '../../../client/src');
const cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} }; cache.set(filename, module);
  const requireModule = id => {
    if (id === '@/api/research-memory') return {};
    if (id.startsWith('@/') || id.startsWith('.')) {
      const target = id.startsWith('@/') ? path.join(client, id.slice(2)) : path.resolve(path.dirname(filename), id);
      const resolved = [target, `${target}.ts`, `${target}.tsx`].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
      if (resolved) return load(resolved);
    }
    return require(id);
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports, require: requireModule, URL, Date });
  return module.exports;
}
exports.renderEvidenceGraph = (graph, citations, locale) => {
  const { EvidenceGraph } = load(path.join(client, 'pages/Council/MemoryEvidenceDetails.tsx'));
  const { memoryCopy } = load(path.join(client, 'pages/Council/memory-copy.ts'));
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(EvidenceGraph, {
    graph: JSON.parse(JSON.stringify(graph)), citations, thesisId: 'fixture-thesis', version: 1, copy: memoryCopy[locale], locale,
  })));
};
