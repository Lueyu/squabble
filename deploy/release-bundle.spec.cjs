const test = require('node:test');
const assert = require('node:assert/strict');

test('release compose rejects unpublished local tags and incomplete image sets', async () => {
  const { releaseCompose } = require('./release-bundle.cjs');
  assert.throws(() => releaseCompose('services: {}', {}), /MISSING_IMAGE/u);
  const images = Object.fromEntries(['app', 'docling', 'aktools', 'sandbox', 'analytics', 'db'].map(name => [name, 'local:tag']));
  assert.throws(() => releaseCompose('services: {}', images), /IMMUTABLE_IMAGE/u);
});

test('release pins app/init/worker references together and removes legacy updater', () => {
  const { releaseCompose } = require('./release-bundle.cjs');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'docker-compose.yml'), 'utf8').replaceAll('\r\n', '\n');
  const images = Object.fromEntries(['app', 'docling', 'aktools', 'sandbox', 'analytics', 'db'].map(name => [name, `registry.example/test/${name}@sha256:${'a'.repeat(64)}`]));
  const result = releaseCompose(source, images);
  assert.ok(!result.includes(':local'));
  assert.ok(!result.includes('  updater:'));
  assert.ok(result.includes(`SANDBOX_IMAGE: ${images.analytics}`));
  assert.equal(result.split(images.app).length - 1, 2);
});
