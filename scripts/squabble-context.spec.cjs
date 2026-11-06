const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const helperRoot = path.resolve(__dirname, '../.agents/skills/squabble-contributor/scripts');
const skillRelative = '.agents/skills/squabble-contributor';
function write(root, name, content) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}
function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squabble-context-test-')));
  t.after(() => {
    const resolved = fs.realpathSync(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('squabble-context-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const repo = path.join(temporary, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'user.name', 'Context test');
  git(repo, 'config', 'user.email', 'context@example.invalid');
  write(repo, 'server/report.ts', 'export const report = 1;\n');
  write(repo, 'docs/architecture.md', '<a id="research-report"></a>\n# Research report\n');
  write(repo, 'scripts/db/01_schema.sql', '-- fixture\n');
  write(repo, 'scripts/db/03_report.sql', '-- fixture\n');
  write(repo, 'server/common/platform/database.provider.ts', "const migrations = ['03_report.sql'];\n");
  write(repo, `${skillRelative}/SKILL.md`, '---\nname: squabble-contributor\ndescription: Test fixture\n---\n\n[Research](references/research.md)\n');
  write(repo, `${skillRelative}/references/research.md`, '# Research\n[Source](../../../../server/report.ts)\n');
  write(repo, `${skillRelative}/agents/openai.yaml`, 'policy:\n  allow_implicit_invocation: true\n');
  write(repo, `${skillRelative}/scripts/example.cjs`, "console.log('example');\n");
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'fixture baseline');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  const manifest = {
    schemaVersion: 1, repository: 'Lueyu/squabble', verifiedCommit: baseline,
    verifiedAt: '2026-11-07', areas: [{ id: 'research', paths: ['server/'],
      entrypoints: ['server/report.ts'], references: ['references/research.md'], diagrams: ['research-report'] }],
  };
  write(repo, `${skillRelative}/context-manifest.json`, JSON.stringify(manifest, null, 2));
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'fixture knowledge');
  return { temporary, repo, baseline, manifest, destination: path.join(temporary, 'installed', 'squabble-contributor') };
}
function run(name, repo, ...args) {
  return spawnSync(process.execPath, [path.join(helperRoot, name), '--repo', repo, ...args], {
    encoding: 'utf8', windowsHide: true,
  });
}
function report(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}
function snapshot(root, prefix = '') {
  return Object.fromEntries(fs.readdirSync(root, { withFileTypes: true }).filter(e => e.name !== '.git').flatMap(e => {
    const relative = `${prefix}${e.name}`;
    const file = path.join(root, e.name);
    return e.isDirectory() ? Object.entries(snapshot(file, `${relative}/`)) : [[relative, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
  }));
}

test('inspection is read-only, reports dirty paths and maps drift to references', t => {
  const f = fixture(t);
  write(f.repo, 'server/report.ts', 'export const report = 2;\n');
  write(f.repo, 'new-note.txt', 'untracked\n');
  const before = snapshot(f.repo);
  const statusBefore = git(f.repo, 'status', '--porcelain=v1', '-uall');
  const result = report(run('inspect-workspace.cjs', f.repo));
  assert.equal(result.head, git(f.repo, 'rev-parse', 'HEAD'));
  assert.ok(result.dirtyPaths.includes('server/report.ts'));
  assert.ok(result.changedPaths.includes('new-note.txt'));
  assert.deepEqual(result.affectedAreas[0].references, ['references/research.md']);
  assert.deepEqual(result.affectedAreas[0].changedPaths, ['server/report.ts']);
  assert.equal(result.entrypoints[0].exists, true);
  assert.equal(result.versions.node, process.versions.node);
  assert.deepEqual(snapshot(f.repo), before);
  assert.equal(git(f.repo, 'status', '--porcelain=v1', '-uall'), statusBefore);
});

test('inspection redacts remote credentials and reads locator hints without environment values', t => {
  const f = fixture(t);
  git(f.repo, 'remote', 'add', 'origin', 'https://secret-user:secret-password@github.com/Lueyu/squabble.git?access_token=secret-query#secret-fragment');
  write(f.temporary, 'private.env', 'DATABASE_URL=postgres://hidden-password\n');
  write(f.temporary, 'locator.json', JSON.stringify({ schemaVersion: 1, repositories: [{ root: f.repo }], instances: [{
    name: 'local', releaseDirectory: f.repo, baseUrl: 'http://private-user:private-pass@127.0.0.1:3000/path?secret=private-query',
    environmentFile: path.join(f.temporary, 'private.env'), databaseVersionHint: '16', password: 'private-extra',
  }] }));
  const result = run('inspect-workspace.cjs', f.repo, '--config', path.join(f.temporary, 'locator.json'));
  const data = report(result);
  assert.equal(data.remote, 'github.com/Lueyu/squabble');
  assert.equal(data.locator.instances[0].baseUrl, 'http://127.0.0.1:3000');
  assert.equal(data.locator.instances[0].environmentFile, path.join(f.temporary, 'private.env'));
  assert.doesNotMatch(result.stdout + result.stderr, /secret-user|secret-password|secret-query|secret-fragment|private-user|private-pass|private-query|private-extra|hidden-password/);
});

test('inspection reports migration file and registry discrepancies', t => {
  const f = fixture(t);
  write(f.repo, 'scripts/db/04_unregistered.sql', '-- fixture\n');
  write(f.repo, 'server/common/platform/database.provider.ts', "const migrations = ['03_report.sql', '05_missing.sql'];\n");
  const result = report(run('inspect-workspace.cjs', f.repo));
  assert.deepEqual(result.migrations.unregisteredFiles, ['04_unregistered.sql']);
  assert.deepEqual(result.migrations.missingFiles, ['05_missing.sql']);
});

test('checker validates references and reports source drift without claiming semantic freshness', t => {
  const f = fixture(t);
  write(f.repo, 'server/report.ts', 'export const report = 2;\n');
  const result = report(run('check-context.cjs', f.repo));
  assert.equal(result.valid, true);
  assert.equal(result.freshness, 'review-required');
  assert.ok(result.warnings.some(message => /semantic/i.test(message)));
});

test('checker fails missing entrypoints, references, local links and diagram IDs', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.repo, 'server/report.ts'));
  f.manifest.areas[0].references.push('references/missing.md');
  f.manifest.areas[0].diagrams.push('missing-flow');
  write(f.repo, `${skillRelative}/context-manifest.json`, JSON.stringify(f.manifest));
  write(f.repo, `${skillRelative}/references/research.md`, '[Missing](missing-link.md)\n');
  const result = run('check-context.cjs', f.repo);
  assert.equal(result.status, 1);
  const data = JSON.parse(result.stdout);
  assert.equal(data.valid, false);
  for (const missing of ['server/report.ts', 'references/missing.md', 'missing-link.md', 'missing-flow']) {
    assert.ok(data.errors.some(message => message.includes(missing)), missing);
  }
});

test('checker reports unavailable verification baseline as unknown without fetching', t => {
  const f = fixture(t);
  f.manifest.verifiedCommit = 'a'.repeat(40);
  write(f.repo, `${skillRelative}/context-manifest.json`, JSON.stringify(f.manifest));
  const result = report(run('check-context.cjs', f.repo));
  assert.equal(result.freshness, 'unknown');
  assert.ok(result.warnings.some(message => /baseline.*unavailable/i.test(message)));
});

test('helpers accept a linked worktree and provide help', t => {
  const f = fixture(t);
  const worktree = path.join(f.temporary, 'worktree');
  git(f.repo, 'worktree', 'add', '--quiet', '-b', 'fixture-worktree', worktree);
  const result = report(run('inspect-workspace.cjs', worktree));
  assert.equal(result.branch, 'fixture-worktree');
  for (const helper of ['inspect-workspace.cjs', 'check-context.cjs', 'sync-skill.cjs']) {
    const help = run(helper, worktree, '--help');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--repo/);
  }
});

test('sync is a read-only plan by default and installs all skill resources with provenance on apply', t => {
  const f = fixture(t);
  const planned = report(run('sync-skill.cjs', f.repo, '--destination', f.destination));
  assert.equal(planned.applied, false);
  assert.equal(fs.existsSync(f.destination), false);
  const installed = report(run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply'));
  assert.equal(installed.applied, true);
  const stamp = JSON.parse(fs.readFileSync(path.join(f.destination, '.install.json'), 'utf8'));
  assert.equal(stamp.repository, 'Lueyu/squabble');
  assert.equal(stamp.sourceRevision, git(f.repo, 'rev-parse', 'HEAD'));
  assert.equal(stamp.sourceDirty, false);
  assert.ok(stamp.managedFiles['scripts/example.cjs']);
  assert.ok(stamp.managedFiles['agents/openai.yaml']);
  assert.deepEqual(snapshot(f.destination), { ...snapshot(path.join(f.repo, skillRelative)), '.install.json': snapshot(f.destination)['.install.json'] });
  const before = snapshot(f.destination);
  assert.equal(report(run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply')).changed, false);
  assert.deepEqual(snapshot(f.destination), before);
});

test('managed updates replace/remove only managed files and preserve unrelated files', t => {
  const f = fixture(t);
  report(run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply'));
  write(f.destination, 'my-notes.txt', 'keep me');
  write(f.repo, `${skillRelative}/references/research.md`, '# Revised research\n');
  fs.unlinkSync(path.join(f.repo, skillRelative, 'scripts/example.cjs'));
  report(run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply'));
  assert.equal(fs.readFileSync(path.join(f.destination, 'my-notes.txt'), 'utf8'), 'keep me');
  assert.equal(fs.existsSync(path.join(f.destination, 'scripts/example.cjs')), false);
  assert.equal(fs.readFileSync(path.join(f.destination, 'references/research.md'), 'utf8'), '# Revised research\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.destination, '.install.json'), 'utf8')).sourceDirty, true);
});

test('sync refuses unmanaged, modified and missing managed copies without writing', t => {
  const f = fixture(t);
  write(f.destination, 'custom.txt', 'keep me');
  assert.equal(run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply').status, 1);
  fs.unlinkSync(path.join(f.destination, 'custom.txt'));
  fs.rmdirSync(f.destination);
  report(run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply'));
  write(f.destination, 'SKILL.md', 'custom instructions');
  const before = snapshot(f.destination);
  const modified = run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply');
  assert.equal(modified.status, 1);
  assert.match(modified.stderr, /locally modified/i);
  assert.deepEqual(snapshot(f.destination), before);
  fs.unlinkSync(path.join(f.destination, 'SKILL.md'));
  assert.equal(run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply').status, 1);
});

test('sync refuses overlap, symlink escapes and private source files', t => {
  const f = fixture(t);
  report(run('check-context.cjs', f.repo));
  const source = path.join(f.repo, skillRelative);
  for (const destination of [f.repo, source, path.join(source, 'nested')]) {
    assert.equal(run('sync-skill.cjs', f.repo, '--destination', destination, '--apply').status, 1);
  }
  const outside = path.join(f.temporary, 'outside');
  fs.mkdirSync(outside);
  const linked = path.join(f.temporary, 'linked');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(run('sync-skill.cjs', f.repo, '--destination', path.join(linked, 'skill'), '--apply').status, 1);
  fs.symlinkSync(outside, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply').status, 1);
  fs.unlinkSync(path.join(source, 'linked'));
  write(source, '.env.local', 'SECRET=do-not-copy');
  assert.equal(run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply').status, 1);
  assert.equal(fs.existsSync(f.destination), false);
});

test('checker rejects manifest traversal before reading files outside the repository', t => {
  const f = fixture(t);
  report(run('check-context.cjs', f.repo));
  f.manifest.areas[0].entrypoints = ['../private.env'];
  write(f.temporary, 'private.env', 'SECRET=do-not-read');
  write(f.repo, `${skillRelative}/context-manifest.json`, JSON.stringify(f.manifest));
  const result = run('check-context.cjs', f.repo);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /do-not-read/);
});


test('area paths match filename prefixes while per-area verification narrows drift', t => {
  const f = fixture(t);
  f.manifest.areas[0].paths = ['server/portfolio-metrics'];
  f.manifest.areas[0].entrypoints = [];
  write(f.repo, 'server/portfolio-metrics.service.ts', 'export const metric = 1;\n');
  write(f.repo, `${skillRelative}/context-manifest.json`, JSON.stringify(f.manifest));
  const result = report(run('inspect-workspace.cjs', f.repo));
  assert.deepEqual(result.affectedAreas.map(area => area.id), ['research']);
  assert.deepEqual(result.affectedAreas[0].changedPaths, ['server/portfolio-metrics.service.ts']);
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '--quiet', '-m', 'reviewed metric');
  f.manifest.areas[0].verifiedCommit = git(f.repo, 'rev-parse', 'HEAD');
  write(f.repo, `${skillRelative}/context-manifest.json`, JSON.stringify(f.manifest));
  assert.deepEqual(report(run('inspect-workspace.cjs', f.repo)).affectedAreas, []);
});

test('managed update refuses a new resource colliding with unrelated destination content', t => {
  const f = fixture(t);
  report(run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply'));
  write(f.destination, 'references/new.md', 'private user notes');
  write(f.repo, `${skillRelative}/references/new.md`, '# New maintained resource\n');
  const before = snapshot(f.destination);
  const result = run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unrelated destination file/i);
  assert.deepEqual(snapshot(f.destination), before);
});

test('failed managed writes roll back previous files and stamp, allowing a retry', t => {
  const f = fixture(t);
  report(run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply'));
  write(f.destination, 'notes.txt', 'keep unrelated content');
  const before = snapshot(f.destination);
  write(f.repo, `${skillRelative}/SKILL.md`, '---\nname: squabble-contributor\ndescription: Revised fixture\n---\n[Research](references/research.md)\n');
  write(f.repo, `${skillRelative}/references/research.md`, '# Revised reference\n');
  const { sync } = require(path.join(helperRoot, 'sync-skill.cjs'));
  const { workspace } = require(path.join(helperRoot, 'context-lib.cjs'));
  const originalRename = fs.renameSync;
  let failed = false;
  fs.renameSync = (from, to) => {
    if (!failed && to === path.join(f.destination, 'references/research.md')) {
      failed = true;
      const error = new Error('simulated disk failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(from, to);
  };
  try {
    assert.throws(() => sync(workspace(f.repo), f.destination, true), /restored|rolled back/i);
  } finally { fs.renameSync = originalRename; }
  assert.equal(failed, true);
  assert.deepEqual(snapshot(f.destination), before);
  report(run('sync-skill.cjs', f.repo, '--destination', f.destination, '--apply'));
  assert.match(fs.readFileSync(path.join(f.destination, 'references/research.md'), 'utf8'), /Revised/);
});
