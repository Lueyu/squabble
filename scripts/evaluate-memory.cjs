/* Offline, fictional evaluation. A missing prerequisite or required skip is an incomplete run, never a pass. */
const { spawn } = require('node:child_process');
const postgres = require('postgres');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const runner = require.resolve('tsx/cli');
const suites = [
  'server/modules/research-memory/research-memory.retrieval.spec.ts',
  'server/modules/research-memory/research-memory.retrieval.integration.spec.ts',
  'server/modules/research-memory/research-memory.context.spec.ts',
  'server/modules/research-memory/research-memory.temporal.integration.spec.ts',
  'server/modules/research-memory/research-memory.archive.integration.spec.ts',
  'server/modules/research-memory/research-memory.monitor.integration.spec.ts',
  'server/modules/research-memory/research-memory.replacement.integration.spec.ts',
  'server/modules/research-memory/research-memory.paper-race.integration.spec.ts',
  'server/modules/research-memory/research-memory.handoff.integration.spec.ts',
  'server/modules/council/council.workflow-memory.spec.ts',
  'server/modules/research-tools/research-tools.integration.spec.ts',
  'server/modules/local-agents/research-handoff.spec.ts',
  'server/modules/local-agents/research-submission.spec.ts',
  'server/modules/local-agents/local-agents.store.spec.ts',
];
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, '--tsconfig', 'tsconfig.node.json', ...args], { cwd: root, env: process.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) { process.stderr.write(stdout + stderr); reject(new Error('REQUIRED_EVALUATION_FAILED')); }
      else resolve(stdout);
    });
  });
}
async function main() {
  const required = ['MEMORY_TEST_DATABASE_URL', 'COUNCIL_TEST_DATABASE_URL'];
  for (const key of required) if (!process.env[key]) throw new Error(`MISSING_PREREQUISITE_${key}`);
  for (const url of new Set(required.map(key => process.env[key]))) {
    const db = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
    try { await db`SELECT 1`; } catch { throw new Error('DATABASE_PREREQUISITE_UNAVAILABLE'); }
    finally { await db.end({ timeout: 1 }); }
  }
  const measured = JSON.parse(await run(['server/modules/research-memory/research-memory.evaluation.ts']));
  const tap = await run(['--test', '--test-concurrency=1', '--test-reporter=tap', ...suites]);
  const count = name => Number(tap.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'))?.[1] ?? NaN);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'].map(name => [name, count(name)]));
  if (!counts.tests || counts.fail !== 0 || counts.skipped !== 0 || counts.cancelled !== 0 || counts.todo !== 0 || counts.pass !== counts.tests) {
    process.stderr.write(tap); throw new Error('REQUIRED_OPERATIONS_INCOMPLETE');
  }
  const requests = [...tap.matchAll(/^# MEMORY_REQUEST_MEASUREMENT (\{.*\})$/gm)].map(match => JSON.parse(match[1]));
  if (requests.length !== 2 || requests.some(item => item.apiRequests < 1 || item.nativeRequests < 1 || item.agreements !== item.apiRequests + item.nativeRequests)) {
    throw new Error('REQUEST_INVENTORY_MEASUREMENTS_MISSING');
  }
  process.stdout.write(JSON.stringify({ schema: 'memory-evaluation/v1', status: 'passed', ...measured,
    operations: { suites, counts, durationMs: Number(tap.match(/^# duration_ms ([\d.]+)$/m)?.[1] ?? 0), requestInventory: requests,
      coverage: ['publish/archive-failure/retry/delete', 'known-at-cutoff/restatement/period/currency',
        '101-report-history/old-active-thesis', 'prepare/edit/send/API/native', 'queued/revoked/final-handoff/restart',
        'repeated-monitor/latched-breach', 'revocation/physical-deletion/actual-ledger/protective-exits'] } }, null, 2) + '\n');
}
main().catch(error => {
  process.stdout.write(JSON.stringify({ schema: 'memory-evaluation/v1', status: 'incomplete', error: error.message }) + '\n');
  process.exitCode = 1;
});
