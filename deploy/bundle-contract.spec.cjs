const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const config = JSON.parse(execFileSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.source.yml', 'config', '--format', 'json'], { encoding: 'utf8' }));

test('default bundle contains prepared local engines and persistent artifacts', () => {
  for (const name of ['bundle-init', 'docling', 'aktools', 'sandbox', 'analytics-image']) assert.ok(config.services[name], name);
  assert.equal(config.services.app.environment.DOCUMENT_DOCLING_URL, 'http://docling:5002');
  assert.equal(config.services.app.environment.FINANCIAL_AKTOOLS_MCP_URL, 'http://aktools:8081/mcp');
  assert.equal(config.services.app.environment.SANDBOX_BROKER_URL, 'http://sandbox:8093');
  assert.ok(config.services.app.volumes.some(volume => volume.target === '/app/.data/research-artifacts'));
});

test('only broker receives Docker socket and internal services have no published ports', () => {
  for (const [name, service] of Object.entries(config.services)) {
    if (name !== 'sandbox' && name !== 'updater') assert.ok(!(service.volumes ?? []).some(volume => String(volume.source).includes('docker.sock')), name);
    if (['docling', 'aktools', 'sandbox'].includes(name)) assert.deepEqual(service.ports ?? [], [], name);
  }
  assert.ok(config.services.sandbox.volumes.some(volume => volume.target === '/var/run/docker.sock'));
  assert.ok(Object.values(config.services.docling.networks).length === 1);
  assert.equal(config.networks.tools.internal, true);
  assert.equal(config.services.app.user, '1000:1000');
  assert.ok(config.services.app.security_opt.some(value => value.startsWith('seccomp=')));
  for (const name of ['docling', 'aktools', 'sandbox']) assert.ok(!config.services[name].volumes.some(volume => volume.source.endsWith('settings-secrets')), name);
  assert.equal(config.services.app.environment.COMPUTE_CLEANUP_WORKER_ENABLED, 'true');
});
