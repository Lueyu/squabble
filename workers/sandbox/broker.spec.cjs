const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

test('local protocol rejects caller-controlled isolation parameters and traversal', () => {
  const broker = require('./broker.cjs');
  const input = { version: 1, jobId: '2fc09c54-d29e-4ad4-8b76-6bb697814aa9', manifest: {},
    files: [{ name: 'code.py', base64: '' }], maxRuntimeMs: 1000, maxOutputBytes: 1024 };
  assert.deepEqual(broker.validateInput(input), input);
  for (const key of ['image', 'command', 'mounts', 'env', 'network', 'endpoint']) {
    assert.throws(() => broker.validateInput({ ...input, [key]: 'forbidden' }), /COMPUTE_PROTOCOL_INVALID/);
  }
  assert.throws(() => broker.validateInput({ ...input, files: [{ name: '../escape.py', base64: '' }] }), /COMPUTE_INPUT_PATH_INVALID/);
});

test('job profile has hard isolation and no host filesystem bridge', () => {
  const broker = require('./broker.cjs');
  const args = broker.containerArguments('squabble-job-test', 'sha256:fixed', 'deployment', 'job', 1000);
  for (const expected of ['--pull=never', '--read-only', '--network=none', '--user=10001:10001', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--memory=2g', '--memory-swap=2g', '--cpus=1', '--pids-limit=64']) {
    assert.ok(args.includes(expected), expected);
  }
  assert.ok(!args.some(value => value.includes('docker.sock') || value === '--privileged' || value === '--volume'));
  assert.equal(args.at(-1), 'sha256:fixed');
  assert.equal(path.basename(args[0]), 'create');
});

test('untrusted outputs require hashes, bounded logs, safe flat names and required result', () => {
  const { validateOutput } = require('./broker.cjs');
  const data = Buffer.from('{"classification":"exploratory"}');
  const hash = require('node:crypto').createHash('sha256').update(data).digest('hex');
  const output = { stdout: '', stderr: '', files: [{ name: 'result.json', mime: 'application/json',
    base64: data.toString('base64'), sha256: hash }] };
  assert.equal(validateOutput(output, 1024).files.length, 1);
  assert.throws(() => validateOutput({ ...output, files: [{ ...output.files[0], name: '../result.json' }] }, 1024), /OUTPUT/);
  assert.throws(() => validateOutput({ ...output, files: [{ ...output.files[0], sha256: '0'.repeat(64) }] }, 1024), /OUTPUT/);
  assert.throws(() => validateOutput(output, 1), /OUTPUT_SIZE_LIMIT/);
});

test('a durable job reuses canonical content and rejects changed payloads without Docker access', async () => {
  const { SandboxBroker } = require('./broker.cjs');
  const jobId = '2fc09c54-d29e-4ad4-8b76-6bb697814aa9';
  const canonical = { files: [{ base64: '', name: 'code.py' }], jobId, manifest: { a: 1, z: 2 }, maxOutputBytes: 1024, maxRuntimeMs: 1000, version: 1 };
  const requestHash = require('node:crypto').createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const broker = new SandboxBroker();
  broker.jobs.set(jobId, { jobId, requestHash, sandboxId: 'durable-original', state: 'provider_unknown', terminationConfirmed: false, imageId: 'sha256:fixed' });
  const reordered = { version: 1, maxRuntimeMs: 1000, maxOutputBytes: 1024, manifest: { z: 2, a: 1 }, jobId, files: [{ name: 'code.py', base64: '' }] };
  assert.equal((await broker.create(reordered)).sandboxId, 'durable-original');
  await assert.rejects(broker.create({ ...reordered, maxOutputBytes: 512 }), /COMPUTE_REQUEST_CONFLICT/);
});

test('an unknown resource retains the global reservation', async () => {
  const { SandboxBroker } = require('./broker.cjs');
  const broker = new SandboxBroker();
  broker.readiness.status = 'ready';
  broker.jobs.set('prior', { terminationConfirmed: false, state: 'provider_unknown' });
  await assert.rejects(broker.create({ version: 1, jobId: '2fc09c54-d29e-4ad4-8b76-6bb697814aa9',
    manifest: {}, files: [], maxRuntimeMs: 1000, maxOutputBytes: 1024 }), /COMPUTE_RESOURCE_LIMIT/);
});
