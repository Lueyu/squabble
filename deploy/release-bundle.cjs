const { readFileSync, writeFileSync, mkdirSync, cpSync, mkdtempSync, rmSync } = require('node:fs');
const { resolve, join, basename, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const required = ['app', 'docling', 'aktools', 'sandbox', 'analytics', 'db'];
function releaseCompose(source, images) {
  for (const name of required) {
    if (!images[name]) throw new Error(`MISSING_IMAGE:${name}`);
    if (!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/u.test(images[name])) throw new Error(`IMMUTABLE_IMAGE_REQUIRED:${name}`);
  }
  const variables = { APP: 'app', DOCLING: 'docling', AKTOOLS: 'aktools', SANDBOX: 'sandbox', ANALYTICS: 'analytics' };
  let compose = source.replace(/\$\{SQUABBLE_(APP|DOCLING|AKTOOLS|SANDBOX|ANALYTICS)_IMAGE:-[^}]+\}/gu, (_, name) => images[variables[name]]);
  compose = compose.replace(/\$\{DB_IMAGE:-[^}]+\}/gu, images.db);
  // Generated bundle never exposes the legacy independent app updater.
  compose = compose.replace(/  updater:\n[\s\S]*?(?=\n  bundle-init:)/u, '');
  return compose;
}

function buildRelease(imageFile, output) {
  const root = resolve(__dirname, '..');
  const images = JSON.parse(readFileSync(imageFile, 'utf8'));
  const compose = releaseCompose(readFileSync(join(root, 'docker-compose.yml'), 'utf8').replaceAll('\r\n', '\n'), images);
  const anonymous = mkdtempSync(join(tmpdir(), 'squabble-anonymous-registry-'));
  writeFileSync(join(anonymous, 'config.json'), '{}');
  try {
    for (const name of required) {
      // Empty credential store proves these exact manifests are public.
      execFileSync('docker', ['--config', anonymous, 'buildx', 'imagetools', 'inspect', images[name], '--raw'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    }
  } finally {
    const target = resolve(anonymous);
    if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(target).startsWith('squabble-anonymous-registry-')) throw new Error('UNSAFE_TEMP_DIRECTORY');
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(output, { recursive: true });
  mkdirSync(join(output, 'deploy'), { recursive: true });
  writeFileSync(join(output, 'docker-compose.yml'), compose);
  cpSync(join(root, 'deploy', 'chromium-seccomp.json'), join(output, 'deploy', 'chromium-seccomp.json'));
  cpSync(join(root, 'scripts', 'db'), join(output, 'scripts', 'db'), { recursive: true });
  cpSync(join(root, 'workers', 'documents', 'licenses'), join(output, 'licenses', 'documents'), { recursive: true });
  cpSync(join(root, 'workers', 'aktools', 'licenses'), join(output, 'licenses', 'aktools'), { recursive: true });
  cpSync(join(root, 'deploy', 'THIRD-PARTY-NOTICES.md'), join(output, 'THIRD-PARTY-NOTICES.md'));
  const manifest = { formatVersion: 1, platform: 'linux/amd64', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    anonymousManifestChecks: true, images, composeSha256: createHash('sha256').update(compose).digest('hex'),
    browser: { playwright: '1.65.0', nonroot: true, chromiumSandbox: true }, document: { doclingServe: '1.38.2', ocr: 'rapidocr', language: 'iso:zh', models: 'docling-model-manifest.json' } };
  writeFileSync(join(output, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(output, 'README.txt'), 'Requires Docker Engine/Desktop Linux containers and Compose v2.24+.\nStart: docker compose up -d\nOpen: http://127.0.0.1:3000\nNo host Python, OCR, browser or model installation is required.\nKeep DB, settings-secrets, capability-secrets, research-artifacts, local-agents-data and sandbox-state in one matched backup. Never update using down -v.\n');
  process.stdout.write('Created immutable bundle; all six image manifests verified without credentials.\n');
}

if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('Usage: node deploy/release-bundle.cjs <actual-images.json> <output-directory>');
  buildRelease(resolve(process.argv[2]), resolve(process.argv[3]));
}
module.exports = { releaseCompose };
