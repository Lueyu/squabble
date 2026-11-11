const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('dotenv');

// Exercise the real Docker copy/export path in a disposable source tree. It
// reads this fixture deployment's internal tokens without printing them and
// never changes the real source .env, account settings or deployment state.
const project = process.argv[2];
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(project ?? '')) throw new Error('A disposable Compose project is required');
const root = path.resolve(__dirname, '..');
const temporaryParent = path.join(root, 'tmp');
fs.mkdirSync(temporaryParent, { recursive: true });
const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, 'source-export-proof-'));
try {
  fs.mkdirSync(path.join(temporaryRoot, 'deploy'));
  for (const file of ['docker-compose.yml', 'docker-compose.source.yml', 'deploy/compose.source-host.yml', 'deploy/configure-source-host.cjs', 'deploy/source-host-settings.cjs']) {
    fs.copyFileSync(path.join(root, file), path.join(temporaryRoot, file));
  }
  const fixture = { DATABASE_URL: 'postgres://fixture-only:fixture@127.0.0.1:1/never-connect', PRIVATE_MODEL_KEY: 'fictional-keep-model-settings',
    TOOL_MCP_LOCAL_SERVICES_JSON: JSON.stringify([{ id: 'custom-existing', endpoint: 'http://127.0.0.1:9010/mcp' }]),
    DOCUMENT_ALLOWED_ORIGINS: 'http://127.0.0.1:8000' };
  fs.writeFileSync(path.join(temporaryRoot, '.env'), Object.entries(fixture).map(([key, value]) => `${key}='${value}'`).join('\n'));
  execFileSync(process.execPath, [path.join(temporaryRoot, 'deploy', 'configure-source-host.cjs'), project], { stdio: ['ignore', 'pipe', 'pipe'] });
  const result = parse(fs.readFileSync(path.join(temporaryRoot, '.env')));
  assert.equal(result.DATABASE_URL, fixture.DATABASE_URL);
  assert.equal(result.PRIVATE_MODEL_KEY, fixture.PRIVATE_MODEL_KEY);
  assert.deepEqual(JSON.parse(result.TOOL_MCP_LOCAL_SERVICES_JSON), [{ id: 'custom-existing', endpoint: 'http://127.0.0.1:9010/mcp' }, { id: 'aktools', endpoint: 'http://127.0.0.1:8081/mcp' }]);
  assert.equal(result.DOCUMENT_ALLOWED_ORIGINS, 'http://127.0.0.1:8000,http://127.0.0.1:5002');
  for (const key of ['DOCUMENT_DOCLING_KEY_FILE', 'FINANCIAL_AKTOOLS_MCP_TOKEN_FILE', 'SANDBOX_BROKER_TOKEN_FILE']) {
    assert.match(fs.readFileSync(result[key], 'utf8').trim(), /^[a-f0-9]{64}$/u);
  }
  assert.ok(fs.existsSync(path.join(temporaryRoot, '.env.before-bundle')));
  console.log(JSON.stringify({ status: 'passed', actualDockerCredentialExport: true, customRegistryPreserved: true, customDocumentOriginPreserved: true, databaseAndModelSettingsPreserved: true }));
} finally {
  const target = path.resolve(temporaryRoot);
  if (!target.startsWith(`${path.resolve(temporaryParent)}${path.sep}`) || !path.basename(target).startsWith('source-export-proof-')) throw new Error('UNSAFE_TEMP_DIRECTORY');
  fs.rmSync(target, { recursive: true, force: true });
}
