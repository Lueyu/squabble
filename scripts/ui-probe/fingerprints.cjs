'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const TOKEN_SOURCES = [
  'client/src/tailwind-theme.css', 'client/src/themes.css',
  'client/src/typography.css', 'client/src/portfolio-workspace.css', 'client/src/index.css',
  'tailwind.config.ts',
];

const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const normalize = value => value.replace(/\s+/g, ' ').trim();

// Freeze selector-scoped variables, typography declarations and @theme mappings.
// Layout declarations in mixed stylesheets deliberately do not enter this hash.
function tokenDeclarations(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const result = [];
  for (const condition of clean.matchAll(/@(media|container|supports|theme|custom-media|custom-variant)\b[^{};]*/g)) {
    result.push({ condition: normalize(condition[0]) });
  }
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = normalize(match[1]);
    const declarations = [...match[2].matchAll(/(?:^|;)\s*((?:--[\w-]+|font-family)\s*:[^;{}]+)(?=;|$)/g)]
      .map(item => normalize(item[1]));
    if (declarations.length) result.push({ selector, declarations });
  }
  return result;
}

function sourceTokenFingerprint(root = ROOT) {
  const sources = TOKEN_SOURCES.map(file => {
    const content = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
    return { file, ...(file.endsWith('.css') ? { declarations: tokenDeclarations(content) } : { contentHash: hash(content) }) };
  });
  return { algorithm: 'sha256-scoped-css-tokens-v1', sources, hash: hash(sources) };
}

function detectorFingerprint(root = ROOT) {
  return hash(['dom-probe.cjs', 'probe.cjs', 'fixture-server.cjs', 'fixture-support.cjs', 'agent-templates.json']
    .map(file => ({ file, hash: hash(fs.readFileSync(path.join(root, 'scripts/ui-probe', file), 'utf8').replace(/\r\n/g, '\n')) })));
}

function matrixInfo(root = ROOT) {
  const matrix = JSON.parse(fs.readFileSync(path.join(root, '.ui/route-matrix.json'), 'utf8'));
  const scenarios = matrix.routes.flatMap(route => route.states.flatMap(state => matrix.viewports.map(viewport => ({
    ...route, ...state, viewport, id: route.id + '|' + state.name + '|' + viewport.width,
  }))));
  return { matrix, hash: hash(matrix), scenarios };
}

module.exports = { ROOT, hash, tokenDeclarations, sourceTokenFingerprint, detectorFingerprint, matrixInfo };
