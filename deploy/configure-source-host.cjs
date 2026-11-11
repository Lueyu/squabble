const { execFileSync } = require('node:child_process');
const { mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync, chmodSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { parse } = require('dotenv');
const { mergeSourceHostSettings } = require('./source-host-settings.cjs');

// Export generated deployment credentials privately, never through stdout. This
// configures only tool endpoints; database/model/account settings are preserved.
const args = process.argv.slice(2);
const project = args[0] ?? 'squabble-local';
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(project)) throw new Error('Invalid Compose project');
const root = resolve(__dirname, '..');
const destination = resolve(root, '.data', 'bundle-host');
const envFile = join(root, '.env');
const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
const port = (name, fallback) => {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d{1,5}$/u.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid ${name}`);
  return value;
};
const docling = `http://127.0.0.1:${port('HOST_DOCLING_PORT', 5002)}`;
const aktools = `http://127.0.0.1:${port('HOST_AKTOOLS_PORT', 8081)}`;
const sandbox = `http://127.0.0.1:${port('HOST_SANDBOX_PORT', 8093)}`;
// Validate and merge before Docker export, file creation or .env backup/mutation.
const settings = mergeSourceHostSettings(parse(existing), {
  TOOL_CAPABILITIES_BUNDLE_ENABLED: 'true', DOCUMENT_DOCLING_URL: docling, DOCUMENT_ALLOWED_ORIGINS: docling,
  DOCUMENT_DOCLING_KEY_FILE: join(destination, 'docling-token').replaceAll('\\', '/'),
  TOOL_CAPABILITIES_DOCLING_HEALTH_URL: `${docling}/health`,
  FINANCIAL_AKTOOLS_MCP_URL: `${aktools}/mcp`,
  FINANCIAL_AKTOOLS_MCP_TOKEN_FILE: join(destination, 'aktools-token').replaceAll('\\', '/'),
  TOOL_CAPABILITIES_AKTOOLS_HEALTH_URL: `${aktools}/health`,
  TOOL_MCP_LOCAL_SERVICES_JSON: JSON.stringify([{ id: 'aktools', endpoint: `${aktools}/mcp` }]),
  SANDBOX_BROKER_URL: sandbox, SANDBOX_BROKER_TOKEN_FILE: join(destination, 'sandbox-token').replaceAll('\\', '/'),
  COMPUTE_CLEANUP_WORKER_ENABLED: 'true',
});
mkdirSync(destination, { recursive: true, mode: 0o700 });
const compose = ['compose', '-p', project, '-f', join(root, 'docker-compose.yml'), '-f', join(root, 'docker-compose.source.yml'), '-f', join(root, 'deploy', 'compose.source-host.yml')];
for (const name of ['docling-token', 'aktools-token', 'sandbox-token']) {
  const file = join(destination, name);
  execFileSync('docker', [...compose, 'cp', `bundle-init:/app/.capability-secrets/${name}`, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (!/^[a-f0-9]{64}$/u.test(readFileSync(file, 'utf8').trim())) throw new Error('Exported token is invalid');
  chmodSync(file, 0o600);
}
if (existsSync(envFile) && !existsSync(`${envFile}.before-bundle`)) copyFileSync(envFile, `${envFile}.before-bundle`);
const preserved = existing.split(/\r?\n/u).filter(line => !Object.keys(settings).some(key => line.startsWith(`${key}=`)) && line !== '# Generated bundled capability endpoints; keep token files private.');
const content = `${preserved.join('\n').trimEnd()}\n\n# Generated bundled capability endpoints; keep token files private.\n${Object.entries(settings).map(([key, value]) => `${key}='${value}'`).join('\n')}\n`;
writeFileSync(envFile, content, { mode: 0o600 });
process.stdout.write('Source Web tool endpoints and private credential files configured; existing database and model settings preserved.\n');
