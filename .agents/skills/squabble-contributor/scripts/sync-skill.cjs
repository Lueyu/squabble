const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { SKILL_PATH, bounded, check, git, inside, listFiles, main, noSymlinks, parseArgs, print, readJson, workspace } = require('./context-lib.cjs');

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function safeResource(relative) {
  const parts = relative.split('/');
  if (parts.some(part => part.startsWith('.') || /(?:^|[-_.])(private|secrets?|credentials?|locator|tokens?)(?:[-_.]|$)/i.test(part))) return false;
  return ['SKILL.md', 'context-manifest.json'].includes(relative) ||
    (['references', 'scripts', 'agents', 'assets'].includes(parts[0]) && /\.(md|cjs|json|ya?ml|svg|png|jpe?g|webp)$/i.test(relative));
}
function assertParentDirectories(file, stop) {
  let directory = path.dirname(file);
  while (inside(stop, directory)) {
    if (fs.existsSync(directory) && !fs.statSync(directory).isDirectory()) throw new Error(`Destination parent is not a directory: ${directory}`);
    if (directory === stop) break;
    directory = path.dirname(directory);
  }
}
function atomicWrite(file, bytes, mode = 0o644) {
  noSymlinks(file);
  const temporary = path.join(path.dirname(file), `.squabble-write-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function applyChanges(destination, source, writes, removes, stamp, managedFiles) {
  const createdDirectories = [];
  const ensureDirectory = directory => {
    const missing = [];
    let current = directory;
    while (!fs.existsSync(current)) { missing.push(current); current = path.dirname(current); }
    for (const item of missing.reverse()) {
      noSymlinks(item);
      fs.mkdirSync(item);
      createdDirectories.push(item);
    }
  };
  // Buffer the bounded source before mutation so a concurrent source edit cannot corrupt provenance.
  const payloads = new Map(writes.map(relative => {
    const bytes = fs.readFileSync(bounded(source, relative));
    if (createHash('sha256').update(bytes).digest('hex') !== managedFiles[relative]) throw new Error('Source changed during planning; retry after finishing edits.');
    return [relative, bytes];
  }));
  payloads.set('.install.json', Buffer.from(`${JSON.stringify(stamp, null, 2)}\n`));
  const targets = [...writes, ...removes, '.install.json'];
  const previous = new Map(targets.map(relative => {
    const file = bounded(destination, relative);
    return [relative, fs.existsSync(file) ? { bytes: fs.readFileSync(file), mode: fs.statSync(file).mode } : null];
  }));
  ensureDirectory(path.dirname(destination));
  const backup = fs.mkdtempSync(path.join(path.dirname(destination), '.squabble-skill-backup-'));
  const backupFiles = [];
  const applied = [];
  const cleanupBackup = () => {
    for (const file of backupFiles.reverse()) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(backup);
  };
  try {
    // Flat numbered backups avoid recursive cleanup and remain usable if rollback itself fails.
    const recovery = targets.map((relative, index) => ({ path: relative, backup: previous.get(relative) ? `${index}.bin` : null }));
    for (const item of recovery) {
      if (!item.backup) continue;
      const file = bounded(backup, item.backup);
      backupFiles.push(file);
      fs.writeFileSync(file, previous.get(item.path).bytes, { flag: 'wx', mode: 0o600 });
    }
    const recoveryFile = bounded(backup, 'recovery.json');
    backupFiles.push(recoveryFile);
    fs.writeFileSync(recoveryFile, JSON.stringify({ destination, files: recovery }, null, 2), { flag: 'wx', mode: 0o600 });
    ensureDirectory(destination);
    for (const relative of [...writes, ...removes, '.install.json']) {
      const target = bounded(destination, relative);
      if (payloads.has(relative)) {
        ensureDirectory(path.dirname(target));
        atomicWrite(target, payloads.get(relative), relative === '.install.json' ? 0o600 : 0o644);
      } else fs.unlinkSync(target);
      applied.push(relative);
    }
  } catch (error) {
    let rollbackError;
    for (const relative of applied.reverse()) {
      try {
        const target = bounded(destination, relative);
        const original = previous.get(relative);
        if (original) atomicWrite(target, original.bytes, original.mode);
        else if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch (failure) { rollbackError = failure; }
    }
    for (const directory of createdDirectories.reverse()) {
      try { if (fs.existsSync(directory)) fs.rmdirSync(directory); }
      catch (failure) { if (!['ENOTEMPTY', 'EEXIST'].includes(failure.code)) rollbackError = failure; }
    }
    if (rollbackError) throw new Error(`Sync failed (${error.code || 'I/O'}); rollback incomplete. Preserve and restore the recorded files from ${backup}/recovery.json before retrying.`);
    cleanupBackup();
    throw new Error(`Sync failed (${error.code || 'I/O'}); previous managed files and stamp restored. Retry when the I/O problem is resolved.`);
  }
  try { cleanupBackup(); }
  catch { return `Update complete; old-file backup cleanup failed. Preserved backup: ${backup}`; }
  return null;
}
function sync(context, destination, apply) {
  const { repo, skill, manifest } = context;
  noSymlinks(destination);
  if (inside(skill, destination) || inside(destination, skill) || inside(repo, destination) || destination === path.parse(destination).root) {
    throw new Error('Source and destination must be separate bounded directories outside the selected repository.');
  }
  const validation = check(context);
  if (!validation.valid) throw new Error(`Source skill validation failed:\n${validation.errors.join('\n')}`);
  const resources = listFiles(skill);
  const managedFiles = Object.create(null);
  for (const relative of resources) {
    if (!safeResource(relative)) throw new Error(`Refusing private or unsupported source resource: ${relative}`);
    managedFiles[relative] = hash(bounded(skill, relative));
  }
  const stampPath = bounded(destination, '.install.json');
  let prior = null;
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isDirectory() || !fs.existsSync(stampPath)) throw new Error('Refusing unmanaged existing destination; choose a new directory or preserve and relocate the old copy explicitly.');
    prior = readJson(stampPath);
    if (prior.schemaVersion !== 1 || prior.repository !== manifest.repository || !prior.managedFiles || Array.isArray(prior.managedFiles) || typeof prior.managedFiles !== 'object' || !Object.keys(prior.managedFiles).length) {
      throw new Error('Refusing invalid or unmanaged installation stamp.');
    }
    for (const [relative, expected] of Object.entries(prior.managedFiles)) {
      if (!safeResource(relative) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Refusing unsafe installation stamp.');
      const target = bounded(destination, relative);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile() || hash(target) !== expected) throw new Error(`Refusing locally modified or missing managed file: ${relative}`);
    }
  }
  for (const relative of resources) {
    const target = bounded(destination, relative);
    assertParentDirectories(target, destination);
    if (fs.existsSync(target) && (!prior || !Object.hasOwn(prior.managedFiles, relative))) throw new Error(`Refusing to overwrite unrelated destination file: ${relative}`);
  }
  const sourceDirty = Boolean(git(repo, ['status', '--porcelain=v1', '--untracked-files=all', '--', SKILL_PATH]).trim() ||
    git(repo, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', SKILL_PATH]).trim());
  const stamp = { schemaVersion: 1, repository: manifest.repository, sourceRevision: git(repo, ['rev-parse', 'HEAD']).trim(), sourceDirty, managedFiles };
  const writes = resources.filter(relative => !prior || prior.managedFiles[relative] !== managedFiles[relative]);
  const removes = prior ? Object.keys(prior.managedFiles).filter(relative => !Object.hasOwn(managedFiles, relative)).sort() : [];
  const changed = writes.length > 0 || removes.length > 0 || JSON.stringify(prior) !== JSON.stringify(stamp);
  const result = { source: skill, destination, applied: Boolean(apply), changed, writes, removes,
    sourceRevision: stamp.sourceRevision, sourceDirty, warnings: validation.warnings };
  if (!apply || !changed) return result;
  const cleanupWarning = applyChanges(destination, skill, writes, removes, stamp, managedFiles);
  if (cleanupWarning) result.warnings.push(cleanupWarning);
  return result;
}
if (require.main === module) main(() => {
  const args = parseArgs(process.argv.slice(2), ['--destination', '--apply']);
  if (args.help) {
    console.log('Usage: node sync-skill.cjs [--repo PATH] [--destination PATH] [--apply] [--json]\nDefault: read-only synchronization plan. --apply explicitly copies validated skill resources.\nDefault destination: $CODEX_HOME/skills/squabble-contributor, otherwise ~/.codex/skills/squabble-contributor.\nRefuses unmanaged/customized copies, missing managed files, overlap, symlinks and private resource names.\nManaged updates preserve unrelated files; no recursive deletion, dependency installation or application actions.');
    return;
  }
  const destination = path.resolve(args.destination || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills/squabble-contributor'));
  print(sync(workspace(args.repo), destination, args.apply));
});

module.exports = { sync };
