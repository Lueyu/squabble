const { randomBytes } = require('node:crypto');
const { mkdirSync, existsSync, writeFileSync, readFileSync, chmodSync, chownSync, readdirSync, lstatSync } = require('node:fs');
const { join } = require('node:path');

// Only named application volumes are mounted here. Repair root-image upgrade
// ownership without rotating any existing secret or following symlink targets.
function repair(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('BUNDLE_VOLUME_SYMLINK');
  chownSync(path, 1000, 1000);
  if (stat.isDirectory()) for (const name of readdirSync(path)) repair(join(path, name));
}
for (const path of ['/app/.secrets', '/app/.capability-secrets', '/app/.local-agents', '/app/.backups', '/app/.data/research-artifacts']) {
  mkdirSync(path, { recursive: true, mode: 0o750 });
  repair(path);
}
for (const name of ['docling-token', 'aktools-token', 'sandbox-token']) {
  const path = join('/app/.capability-secrets', name);
  if (!existsSync(path)) writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o640 });
  if (!/^[a-f0-9]{64}$/u.test(readFileSync(path, 'utf8').trim())) throw new Error('BUNDLE_TOKEN_INVALID');
  chownSync(path, 1000, 1000);
  chmodSync(path, 0o640);
  // Each worker receives only its own token, never another worker's credential.
  // The authoritative copy above is backed up with the app; these scoped copies
  // are recreated during preparation and cannot independently rotate.
  const scopedRoot = join('/credentials', name.replace('-token', ''));
  mkdirSync(scopedRoot, { recursive: true, mode: 0o750 });
  chownSync(scopedRoot, 1000, 1000);
  const scopedFile = join(scopedRoot, name);
  if (existsSync(scopedFile) && lstatSync(scopedFile).isSymbolicLink()) throw new Error('BUNDLE_VOLUME_SYMLINK');
  writeFileSync(scopedFile, readFileSync(path), { mode: 0o640 });
  chownSync(scopedFile, 1000, 1000);
  chmodSync(scopedFile, 0o640);
}
process.stdout.write('Bundled capability volumes and internal credentials are prepared.\n');
