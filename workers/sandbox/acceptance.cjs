'use strict';
// Runs only fictional, fixed acceptance inputs against a freshly prepared deployment.
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
function packet(kind, code, parameters) {
  const data = Buffer.from('[{"return":"0.1"},{"return":"-0.1"},{"return":null}]');
  return { version: 1, jobId: randomUUID(), maxRuntimeMs: 60000, maxOutputBytes: 1048576,
    manifest: { version: 1, kind, templateId: kind === 'statistics' ? 'returns-v1' : 'free-code-v1', templateVersion: '1',
      codeHash: digest(code), seed: 7, parameters, effectiveDataClasses: ['public'], permittedUses: ['research'],
      dependencies: { worker: '1.0.0', python: '3.12.10', quantstats: '0.0.86', pandas: '2.3.3', numpy: '2.3.5', matplotlib: '3.10.7', backtrader: '1.9.78.123' },
      limits: { maxOutputBytes: 1048576 }, datasets: [{ datasetVersionId: randomUUID(), contentHash: 'a'.repeat(64),
        fileSha256: digest(data), path: 'dataset-0.json', rowCount: 3, dataClasses: ['public'], permittedUses: ['research'] }] },
    files: [{ name: 'dataset-0.json', base64: data.toString('base64') }, { name: 'code.py', base64: Buffer.from(code).toString('base64') }] };
}
async function main() {
  const origin = new URL(process.env.SANDBOX_BROKER_URL ?? 'http://127.0.0.1:8093');
  assert.ok(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', 'sandbox', 'sandbox-broker'].includes(origin.hostname)
    && !origin.username && !origin.password && origin.pathname === '/', 'Acceptance requires an explicit local deployment');
  const token = (await readFile(process.env.SANDBOX_BROKER_TOKEN_FILE ?? process.env.SANDBOX_TOKEN_FILE ?? '/run/secrets/sandbox-token', 'utf8')).trim();
  const request = async (route, method = 'GET', input) => {
    const response = await fetch(new URL(route, origin), { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const value = await response.json(); assert.equal(response.ok, true, value.errorCode); return value;
  };
  const health = await request('/health'); assert.equal(health.status, 'ready');
  const execute = async input => {
    try {
      const created = await request('/v1/jobs', 'POST', input); assert.equal(created.state, 'created');
      assert.equal(created.imageId, health.imageId);
      let receipt = await request(`/v1/jobs/${input.jobId}/start`, 'POST');
      const deadline = Date.now() + 100000;
      while (['created', 'running', 'cancel_requested'].includes(receipt.state)) {
        assert.ok(Date.now() < deadline, 'Acceptance deadline exceeded');
        await new Promise(resolve => setTimeout(resolve, 200)); receipt = await request(`/v1/jobs/${input.jobId}`);
      }
      assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt)); assert.equal(receipt.terminationConfirmed, true);
      const output = await request(`/v1/jobs/${input.jobId}/result`);
      for (const file of output.files) assert.equal(digest(Buffer.from(file.base64, 'base64')), file.sha256);
      return JSON.parse(Buffer.from(output.files.find(file => file.name === 'result.json').base64, 'base64'));
    } finally { await request(`/v1/jobs/${input.jobId}/cleanup`, 'POST').catch(() => {}); }
  };
  const statistics = await execute(packet('statistics', '# Squabble fixed template returns-v1 version 1\n',
    { returnColumn: 'return', benchmarkColumn: null, frequency: 'daily', annualizationFactor: 252, riskFreeRate: 0 }));
  assert.equal(statistics.missingPeriods, 1); assert.equal(statistics.positivePeriodRatio, 0.5);
  const security = await execute(packet('exploratory', "import os, socket\nfrom pathlib import Path\nchecks={'uid':os.getuid(),'socket':Path('/var/run/docker.sock').exists(),'credentials':any(k in os.environ for k in ['JWT_SECRET','DATABASE_URL','SANDBOX_TOKEN_FILE'])}\nfor name,target in [('public',('1.1.1.1',443)),('host',('host.docker.internal',8093))]:\n try:\n  socket.create_connection(target,.3).close();checks[name]=False\n except OSError:\n  checks[name]=True\ntry:\n Path('/forbidden-root-write').write_text('fictional');checks['readonly']=False\nexcept OSError:\n checks['readonly']=True\nchecks['memoryPeak']=int(Path('/sys/fs/cgroup/memory.peak').read_text())\nresult=checks", {}));
  assert.equal(security.classification, 'exploratory');
  assert.equal(security.result.uid, 10001); assert.equal(security.result.socket, false); assert.equal(security.result.credentials, false);
  assert.equal(security.result.public, true); assert.equal(security.result.host, true); assert.equal(security.result.readonly, true);
  process.stdout.write(JSON.stringify({ status: 'passed', provider: 'local-container', imageId: health.imageId,
    checks: ['statistics', 'exploratory', 'network', 'rootfs', 'credentials', 'termination'], observedWorkerMemoryPeakBytes: security.result.memoryPeak }) + '\n');
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
