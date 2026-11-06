const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SKILL_PATH = '.agents/skills/squabble-contributor';
const unique = values => [...new Set(values)].sort();
const slash = value => value.split(path.sep).join('/');
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function noSymlinks(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink path is not allowed: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function bounded(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || relative.includes(':') || path.isAbsolute(relative) || relative.split('/').includes('..')) {
    throw new Error(`Invalid bounded relative path: ${String(relative)}`);
  }
  const target = path.resolve(root, relative);
  if (!inside(root, target) || target === root) throw new Error(`Path escapes its root: ${relative}`);
  noSymlinks(target);
  return target;
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Cannot read valid JSON: ${file}`); }
}
function git(repo, args, optional = false) {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    if (optional) return null;
    throw new Error(`Local Git inspection failed (${args[0]}). Check --repo and local access; no fetch was attempted.`);
  }
}
function parseArgs(argv, allowed = []) {
  const values = new Set(['--repo', ...allowed]);
  const args = { repo: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (['--help', '--json', '--apply'].includes(flag) && (flag !== '--apply' || allowed.includes(flag))) args[flag.slice(2)] = true;
    else if (values.has(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      args[flag.slice(2)] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return args;
}
function workspace(repoArgument) {
  const selected = path.resolve(repoArgument);
  const root = git(selected, ['rev-parse', '--show-toplevel']).trim();
  const repo = fs.realpathSync(root);
  const skill = bounded(repo, SKILL_PATH);
  const manifest = readJson(bounded(skill, 'context-manifest.json'));
  return { repo, skill, manifest };
}
function manifestErrors({ repo, skill, manifest }) {
  const errors = [];
  if (manifest.schemaVersion !== 1) errors.push('Manifest schemaVersion must be 1.');
  if (manifest.repository !== 'Lueyu/squabble') errors.push('Manifest repository must be Lueyu/squabble.');
  if (!/^[a-f0-9]{40}$/i.test(manifest.verifiedCommit || '')) errors.push('Manifest verifiedCommit must be a full Git commit hash.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.verifiedAt || '')) errors.push('Manifest verifiedAt must be YYYY-MM-DD.');
  if (!Array.isArray(manifest.areas) || !manifest.areas.length) return [...errors, 'Manifest areas must be a nonempty array.'];
  const ids = new Set();
  for (const area of manifest.areas) {
    if (!area || typeof area.id !== 'string' || !/^[a-z0-9-]+$/.test(area.id) || ids.has(area.id)) {
      errors.push('Manifest areas require unique lowercase IDs.');
      continue;
    }
    ids.add(area.id);
    if (area.verifiedCommit && !/^[a-f0-9]{40}$/i.test(area.verifiedCommit)) errors.push(`${area.id}: invalid verifiedCommit.`);
    for (const key of ['paths', 'entrypoints', 'references', 'diagrams']) {
      if (!Array.isArray(area[key]) || area[key].some(item => typeof item !== 'string' || !item)) {
        errors.push(`${area.id}: ${key} must be a string array.`);
        continue;
      }
      for (const relative of area[key]) {
        if (key === 'diagrams') continue;
        try { bounded(key === 'references' ? skill : repo, relative); }
        catch (error) { errors.push(`${area.id}: ${error.message}`); }
      }
    }
  }
  return errors;
}
function dirtyPaths(repo) {
  const entries = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
  const paths = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (!entries[i]) continue;
    paths.push(entries[i].slice(3));
    if (/[RC]/.test(entries[i].slice(0, 2)) && entries[i + 1]) paths.push(entries[++i]);
  }
  return unique(paths);
}
function matchesArea(file, area) {
  // Manifest paths are literal prefixes, including filename stems; entrypoints are exact.
  return area.paths.some(prefix => file.startsWith(prefix)) || area.entrypoints.includes(file);
}
function drift(context) {
  const { repo, manifest } = context;
  const dirty = dirtyPaths(repo);
  const warnings = ['Path checks and Git drift do not establish semantic accuracy; review affected source and document the impact or no-impact reasoning.'];
  const revisions = unique([manifest.verifiedCommit, ...manifest.areas.map(area => area.verifiedCommit || manifest.verifiedCommit)]);
  const changes = new Map();
  for (const revision of revisions) {
    const result = git(repo, ['diff', '--name-only', '-z', '--no-renames', `${revision}^{commit}`, 'HEAD', '--'], true);
    changes.set(revision, result === null ? null : unique([...result.split('\0').filter(Boolean), ...dirty]));
    if (result === null) warnings.push(`Verification baseline ${revision} unavailable locally; freshness unknown. No fetch was attempted.`);
  }
  const affectedAreas = manifest.areas.flatMap(area => {
    const changedPaths = (changes.get(area.verifiedCommit || manifest.verifiedCommit) || dirty).filter(file => matchesArea(file, area));
    return changedPaths.length ? [{ id: area.id, changedPaths, references: area.references, diagrams: area.diagrams }] : [];
  });
  const changedPaths = unique([...changes.values()].flatMap(value => value || dirty));
  return { dirtyPaths: dirty, changedPaths, affectedAreas, warnings,
    freshness: [...changes.values()].some(value => value === null) ? 'unknown' : affectedAreas.length ? 'review-required' : 'no-detected-drift' };
}
function remoteIdentity(raw) {
  if (!raw) return null;
  let host;
  let pathname;
  try {
    const url = new URL(raw.trim());
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return 'local-or-unrecognized';
    host = url.hostname;
    pathname = url.pathname;
  } catch {
    const match = raw.trim().match(/^(?:[^@\s]+@)?([a-z0-9.-]+):([^?#\s]+)(?:[?#].*)?$/i);
    if (!match) return 'local-or-unrecognized';
    [, host, pathname] = match;
  }
  const parts = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
  if (!/^[a-z0-9.-]+$/i.test(host) || parts.length !== 2 || parts.some(value => !/^[a-z0-9_.-]+$/i.test(value))) return 'unrecognized';
  return `${host}/${parts.join('/')}`;
}
function migrations(repo) {
  const directory = bounded(repo, 'scripts/db');
  const registry = bounded(repo, 'server/common/platform/database.provider.ts');
  const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^\d{2,}_.+\.sql$/.test(name) && Number(name.split('_')[0]) >= 3).sort() : [];
  const registered = fs.existsSync(registry) ? unique([...fs.readFileSync(registry, 'utf8').matchAll(/['"](\d{2,}_[^'"\r\n]+\.sql)['"]/g)].map(match => match[1])) : [];
  return { files, registered, registryExists: fs.existsSync(registry), missingFiles: registered.filter(name => !files.includes(name)), unregisteredFiles: files.filter(name => !registered.includes(name)) };
}
function npmVersion() {
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/package.json'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/package.json')];
  for (const candidate of candidates) {
    try { return readJson(candidate).version || null; } catch { /* npm may not be installed beside Node. */ }
  }
  return null;
}
function locatorHints(configFile) {
  const locator = readJson(path.resolve(configFile));
  if (locator.schemaVersion !== 1 || !Array.isArray(locator.repositories) || !Array.isArray(locator.instances)) throw new Error('Locator requires schemaVersion 1, repositories and instances arrays.');
  return {
    notice: 'Unverified location hints only. Environment files were not opened and no URLs or services were contacted.',
    repositories: locator.repositories.map(item => ({ root: typeof item.root === 'string' ? item.root : null })),
    instances: locator.instances.map(item => {
      const hint = {};
      for (const key of ['name', 'releaseDirectory', 'environmentFile', 'databaseVersionHint']) if (typeof item[key] === 'string') hint[key] = item[key];
      if (typeof item.baseUrl === 'string') {
        try { const url = new URL(item.baseUrl); hint.baseUrl = ['http:', 'https:'].includes(url.protocol) ? url.origin : 'unsupported'; }
        catch { hint.baseUrl = 'invalid'; }
      }
      return hint;
    }),
  };
}
function inspect(context, configFile) {
  const errors = manifestErrors(context);
  if (errors.length) throw new Error(errors.join('\n'));
  const { repo, manifest } = context;
  return { repository: manifest.repository, repo, branch: git(repo, ['branch', '--show-current']).trim() || '(detached)',
    head: git(repo, ['rev-parse', 'HEAD']).trim(), remote: remoteIdentity(git(repo, ['config', '--get', 'remote.origin.url'], true)),
    versions: { node: process.versions.node, npm: npmVersion() }, verifiedCommit: manifest.verifiedCommit,
    ...drift(context), entrypoints: manifest.areas.flatMap(area => area.entrypoints.map(file => ({ area: area.id, path: file, exists: fs.existsSync(bounded(repo, file)) }))),
    migrations: migrations(repo), ...(configFile ? { locator: locatorHints(configFile) } : {}) };
}
function listFiles(root, prefix = '') {
  const files = [];
  const directory = prefix ? bounded(root, prefix) : root;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    const file = bounded(root, relative);
    if (entry.isDirectory()) files.push(...listFiles(root, `${relative}/`));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported skill resource: ${file}`);
  }
  return files.sort();
}
function check(context) {
  const { repo, skill, manifest } = context;
  const errors = manifestErrors(context);
  if (errors.length) return { valid: false, errors, warnings: [], freshness: 'unknown' };
  const requireFile = (root, relative, label) => {
    try { if (!fs.statSync(bounded(root, relative)).isFile()) throw new Error('not a file'); }
    catch { errors.push(`Missing or unsafe ${label}: ${relative}`); }
  };
  requireFile(skill, 'SKILL.md', 'skill entrypoint');
  const architecture = bounded(repo, 'docs/architecture.md');
  const diagramText = fs.existsSync(architecture) ? fs.readFileSync(architecture, 'utf8') : '';
  const diagramIds = new Set([...diagramText.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
  for (const match of diagramText.matchAll(/^#{1,6}\s+(.+)$/gm)) diagramIds.add(match[1].trim().toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/\s/g, '-'));
  for (const area of manifest.areas) {
    for (const file of area.entrypoints) requireFile(repo, file, 'entrypoint');
    for (const file of area.references) requireFile(skill, file, 'reference');
    for (const id of area.diagrams) if (!diagramIds.has(id)) errors.push(`Missing architecture diagram ID: ${id}`);
  }
  for (const relative of listFiles(skill).filter(file => file.endsWith('.md'))) {
    const file = bounded(skill, relative);
    const markdown = fs.readFileSync(file, 'utf8').replace(/```[^\n]*\n[\s\S]*?```/g, '');
    const links = [...markdown.matchAll(/\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)].map(match => match[1] || match[2]);
    links.push(...[...markdown.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map(match => match[1]));
    for (const link of links) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(link)) continue;
      try {
        const target = path.resolve(path.dirname(file), decodeURIComponent(link.split(/[?#]/)[0]));
        if (!inside(repo, target)) throw new Error('outside repository');
        noSymlinks(target);
        if (!fs.existsSync(target)) throw new Error('missing');
      } catch { errors.push(`Missing or unsafe local link in ${relative}: ${link}`); }
    }
  }
  const state = drift(context);
  const migrationState = migrations(repo);
  if (migrationState.missingFiles.length || migrationState.unregisteredFiles.length) state.warnings.push('Migration files and registry differ; inspect the migrations section of inspect-workspace.');
  return { valid: errors.length === 0, errors, ...state };
}
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function main(action) {
  try { action(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { SKILL_PATH, bounded, check, git, inspect, inside, listFiles, main, noSymlinks, parseArgs, print, readJson, slash, workspace };
