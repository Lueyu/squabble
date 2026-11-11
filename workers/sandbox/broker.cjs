'use strict';
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const INPUT_BYTES = 32 * 1024 * 1024;
const PACKET_BYTES = 48 * 1024 * 1024;
const OUTPUT_BYTES = 16 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function validateInput(value) {
  const keys = ['version', 'jobId', 'manifest', 'files', 'maxRuntimeMs', 'maxOutputBytes'];
  if (!value || Object.keys(value).some(key => !keys.includes(key)) || value.version !== 1 || !UUID.test(value.jobId)
    || !value.manifest || typeof value.manifest !== 'object' || !Array.isArray(value.files) || value.files.length > 21
    || !Number.isInteger(value.maxRuntimeMs) || value.maxRuntimeMs < 1000 || value.maxRuntimeMs > 120000
    || !Number.isInteger(value.maxOutputBytes) || value.maxOutputBytes < 1 || value.maxOutputBytes > OUTPUT_BYTES) throw new Error('COMPUTE_PROTOCOL_INVALID');
  const names = new Set(); let total = 0;
  for (const file of value.files) {
    if (!file || Object.keys(file).some(key => !['name', 'base64'].includes(key)) || !/^(dataset-[0-9]+[.]json|code[.]py)$/u.test(file.name)
      || names.has(file.name)) throw new Error('COMPUTE_INPUT_PATH_INVALID');
    names.add(file.name);
    if (typeof file.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.base64)) throw new Error('COMPUTE_PROTOCOL_INVALID');
    total += Buffer.byteLength(file.base64, 'base64');
  }
  if (total > INPUT_BYTES || Buffer.byteLength(JSON.stringify(value)) > PACKET_BYTES) throw new Error('COMPUTE_INPUT_LIMIT');
  return value;
}

function containerArguments(name, imageId, deployment, jobId, runtime) {
  return ['create', '--pull=never', '--interactive', '--name', name,
    '--label', `io.squabble.sandbox.deployment=${deployment}`, '--label', `io.squabble.sandbox.job=${jobId}`,
    '--label', `io.squabble.sandbox.deadline=${Date.now() + runtime + 30000}`,
    '--read-only', '--network=none', '--user=10001:10001', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--memory=2g', '--memory-swap=2g', '--cpus=1', '--pids-limit=64',
    '--ipc=none', '--restart=no', '--log-driver=none', '--ulimit=nofile=256:256', '--ulimit=fsize=33554432:33554432',
    '--tmpfs', '/job:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001',
    '--env', 'OPENBLAS_NUM_THREADS=1', '--env', 'OMP_NUM_THREADS=1', '--env', 'MPLCONFIGDIR=/tmp/matplotlib',
    '--env', 'PYTHONDONTWRITEBYTECODE=1', imageId];
}

function validateOutput(value, maximum) {
  if (!value || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 8
    || typeof value.stdout !== 'string' || typeof value.stderr !== 'string'
    || Buffer.byteLength(value.stdout) > 16000 || Buffer.byteLength(value.stderr) > 16000) throw new Error('OUTPUT_PROTOCOL_INVALID');
  let total = 0; const names = new Set();
  for (const file of value.files) {
    const types = { json: 'application/json', csv: 'text/csv', png: 'image/png', txt: 'text/plain' };
    const match = /^([a-zA-Z0-9_-]+)[.](json|csv|png|txt)$/u.exec(file.name);
    if (!match || names.has(file.name) || types[match[2]] !== file.mime || typeof file.base64 !== 'string') throw new Error('OUTPUT_PATH_OR_TYPE_INVALID');
    names.add(file.name);
    const data = Buffer.from(file.base64, 'base64'); total += data.length;
    if (total > maximum) throw new Error('OUTPUT_SIZE_LIMIT');
    if (hash(data) !== file.sha256 || file.mime === 'image/png'
      && !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('OUTPUT_INTEGRITY');
  }
  if (!names.has('result.json')) throw new Error('OUTPUT_RESULT_REQUIRED');
  return value;
}

/** Commands are fixed argument arrays. Nothing from a model becomes a shell or Docker option. */
function docker(args, { input, timeout = 15000, maximum = 64000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, stderr = '', failure;
    const timer = setTimeout(() => { failure = new Error('DOCKER_OPERATION_UNKNOWN'); child.kill(); }, timeout);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maximum) { failure = new Error('OUTPUT_SIZE_LIMIT'); child.kill(); } else chunks.push(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(0, 16000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) { const error = new Error(`DOCKER_OPERATION_FAILED:${stderr}`); error.stderr = stderr; reject(error); }
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

class SandboxBroker {
  constructor(config = {}) {
    this.directory = config.directory ?? process.env.SANDBOX_STATE_DIR ?? '.data/sandbox-broker';
    this.tokenFile = config.tokenFile ?? process.env.SANDBOX_TOKEN_FILE ?? '.secrets/sandbox-token';
    this.image = config.image ?? process.env.SANDBOX_IMAGE ?? 'squabble-analytics:local';
    this.jobs = new Map(); this.executing = new Set(); this.readiness = { status: 'unavailable', provider: 'local-container', protocolVersion: 1, imageId: null };
  }
  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(this.tokenFile), { recursive: true, mode: 0o700 });
    try { await fs.writeFile(this.tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    this.token = (await fs.readFile(this.tokenFile, 'utf8')).trim();
    if (this.token.length < 32) throw new Error('SANDBOX_TOKEN_INVALID');
    const identity = path.join(this.directory, 'deployment-id');
    try { await fs.writeFile(identity, randomUUID(), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    this.deployment = (await fs.readFile(identity, 'utf8')).trim();
    for (const file of await fs.readdir(this.directory)) {
      if (!UUID.test(file.replace(/[.]json$/u, ''))) continue;
      const job = JSON.parse(await fs.readFile(path.join(this.directory, file), 'utf8'));
      this.jobs.set(job.jobId, job);
    }
    await this.probe();
    await this.recover();
    this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, 1000); this.timer.unref();
  }
  async probe() {
    try {
      const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
      if (info.OSType !== 'linux' || !info.MemoryLimit || !info.SwapLimit || !info.CpuCfsQuota || !info.PidsLimit
        || !info.SecurityOptions?.some(value => value.startsWith('name=seccomp'))) throw new Error('SANDBOX_LIMITS_UNAVAILABLE');
      const [image] = JSON.parse(await docker(['image', 'inspect', this.image]));
      if (image.Os !== 'linux') throw new Error('SANDBOX_IMAGE_PLATFORM_INVALID');
      this.readiness = { status: 'ready', provider: 'local-container', protocolVersion: 1, imageId: image.Id, deploymentId: this.deployment,
        architecture: image.Architecture, imageDigests: image.RepoDigests ?? [] };
    } catch { this.readiness = { status: 'unavailable', provider: 'local-container', protocolVersion: 1, imageId: null,
      deploymentId: this.deployment, errorCode: 'SANDBOX_ENGINE_OR_IMAGE_UNAVAILABLE' }; }
    return this.readiness;
  }
  async save(job) {
    const saved = { ...job }; delete saved.input; delete saved.output; delete saved.termination; delete saved.saving; delete saved.stderr;
    const target = path.join(this.directory, `${job.jobId}.json`), temporary = `${target}.${randomUUID()}.tmp`;
    const operation = (job.saving ?? Promise.resolve()).catch(() => {}).then(async () => {
      const handle = await fs.open(temporary, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(saved)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, target);
      if (process.platform !== 'win32') {
        const directory = await fs.open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    });
    job.saving = operation;
    try { await operation; } finally { if (job.saving === operation) delete job.saving; }
  }
  receipt(job) {
    return { jobId: job.jobId, sandboxId: job.sandboxId, state: job.state, terminationConfirmed: job.terminationConfirmed,
      errorCode: job.errorCode ?? null, imageId: job.imageId, protocolVersion: 1, stderr: job.stderr ?? '' };
  }
  async create(raw) {
    const input = validateInput(raw), requestHash = hash(JSON.stringify(canonical(input)));
    const existing = this.jobs.get(input.jobId);
    if (existing) { if (existing.requestHash !== requestHash) throw new Error('COMPUTE_REQUEST_CONFLICT'); return this.receipt(existing); }
    if (this.readiness.status !== 'ready') throw new Error('SANDBOX_UNAVAILABLE');
    if ([...this.jobs.values()].some(job => !job.terminationConfirmed)) throw new Error('COMPUTE_RESOURCE_LIMIT');
    const job = { jobId: input.jobId, requestHash, name: `squabble-compute-${this.deployment}-${input.jobId}`,
      sandboxId: `local:${this.deployment}:${input.jobId}`, state: 'creating', terminationConfirmed: false,
      imageId: this.readiness.imageId, deadline: Date.now() + input.maxRuntimeMs + 30000, input };
    this.jobs.set(job.jobId, job); await this.save(job);
    try {
      job.containerId = (await docker(containerArguments(job.name, job.imageId, this.deployment, job.jobId, input.maxRuntimeMs))).trim();
      job.state = 'created'; await this.save(job);
    } catch { job.state = 'provider_unknown'; job.createUnknown = true; job.errorCode = 'LOCAL_CREATE_UNKNOWN'; await this.save(job); }
    return this.receipt(job);
  }
  get(id) { const job = this.jobs.get(id); if (!job) throw new Error('COMPUTE_JOB_NOT_FOUND'); return job; }
  async start(id) {
    const job = this.get(id);
    if (job.state !== 'created') return this.receipt(job);
    if (!job.input) { await this.terminate(job, 'failed', 'LOCAL_INPUT_LOST'); return this.receipt(job); }
    job.state = 'running'; await this.save(job);
    this.executing.add(id);
    void this.execute(job).finally(() => this.executing.delete(id));
    return this.receipt(job);
  }
  async execute(job) {
    try {
      const result = await docker(['start', '--attach', '--interactive', job.containerId], {
        input: JSON.stringify(job.input), timeout: job.input.maxRuntimeMs + 10000, maximum: 24 * 1024 * 1024 });
      const output = validateOutput(JSON.parse(result), job.input.maxOutputBytes);
      // Make verified bytes available before publishing a succeeded receipt, even while journal fsync is slow.
      job.output = output;
      await this.terminate(job, 'succeeded');
      if (job.state === 'succeeded' && job.terminationConfirmed) {
        job.outputExpires = Date.now() + 300000;
        const cached = [...this.jobs.values()].filter(value => value.output);
        for (const old of cached.slice(0, Math.max(0, cached.length - 4))) delete old.output;
      } else delete job.output;
    } catch (error) {
      job.stderr = String(error.stderr ?? '').slice(0, 4000);
      if (!['cancelled', 'succeeded'].includes(job.state)) await this.terminate(job, 'failed',
        error.message.startsWith('OUTPUT_') ? error.message : 'LOCAL_EXECUTION_FAILED');
    } finally { delete job.input; }
  }
  async terminate(job, state = 'cancelled', code) {
    if (state === 'cancelled') job.cancelRequested = true;
    if (job.termination) { await job.termination; return; }
    if (job.terminationConfirmed) return;
    job.termination = this.terminateResource(job, state, code);
    try { await job.termination; } finally { delete job.termination; }
  }
  async terminateResource(job, state, code) {
    job.state = state === 'succeeded' ? 'running' : 'cancel_requested'; await this.save(job);
    try {
      // The exact deterministic name belongs to this deployment; never accept caller Docker identifiers.
      const found = JSON.parse(await docker(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${job.name}$`,
        '--filter', `label=io.squabble.sandbox.deployment=${this.deployment}`, '--filter', `label=io.squabble.sandbox.job=${job.jobId}`,
        '--format', '{{json .}}']).then(text => `[${text.trim().split('\n').filter(Boolean).join(',')}]`));
      if (found.length > 1) throw new Error('LOCAL_IDENTITY_CONFLICT');
      if (found.length === 1 && job.containerId && found[0].ID !== job.containerId) throw new Error('LOCAL_IDENTITY_CONFLICT');
      // A lost create acknowledgement can still be in flight. One absent list result is not proof of termination.
      if (found.length === 0 && job.createUnknown) throw new Error('LOCAL_CREATE_UNKNOWN');
      if (found.length === 1) await docker(['rm', '--force', found[0].ID]);
      job.terminationConfirmed = true; job.state = job.cancelRequested ? 'cancelled' : state; job.errorCode = code ?? null;
    } catch (error) { job.state = 'provider_unknown'; job.errorCode = 'LOCAL_CLEANUP_UNKNOWN';
      job.stderr = String(error.message).slice(0, 4000); }
    await this.save(job);
  }
  async recover() {
    for (const job of this.jobs.values()) {
      if (!job.terminationConfirmed) await this.terminate(job, 'failed', 'LOCAL_BROKER_RESTARTED');
      else if (job.state === 'succeeded' && !job.output) { job.state = 'failed'; job.errorCode = 'LOCAL_RESULT_LOST'; await this.save(job); }
    }
  }
  async sweep() {
    if (!this.lastProbe || Date.now() - this.lastProbe > 15000) { this.lastProbe = Date.now(); await this.probe(); }
    for (const job of this.jobs.values()) if (!job.terminationConfirmed && job.deadline <= Date.now()) await this.terminate(job, 'failed', 'LOCAL_DEADLINE_EXCEEDED');
    for (const job of this.jobs.values()) if (job.outputExpires <= Date.now()) delete job.output;
  }
  async close() { clearInterval(this.timer); for (const job of this.jobs.values()) if (!job.terminationConfirmed) await this.terminate(job); }
}

async function serve(config = {}) {
  const broker = new SandboxBroker(config); await broker.initialize();
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (request.method === 'GET' && request.url === '/health') return send(200, broker.readiness);
    const auth = request.headers.authorization ?? '', expected = `Bearer ${broker.token}`;
    if (Buffer.byteLength(auth) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return send(401, { errorCode: 'SANDBOX_AUTH_REQUIRED' });
    try {
      if (request.method === 'POST' && request.url === '/v1/jobs') {
        const parts = []; let bytes = 0;
        for await (const part of request) { bytes += part.length; if (bytes > PACKET_BYTES) throw new Error('COMPUTE_INPUT_LIMIT'); parts.push(part); }
        return send(200, await broker.create(JSON.parse(Buffer.concat(parts).toString('utf8'))));
      }
      const match = /^\/v1\/jobs\/([a-f0-9-]+)(?:\/(start|result|cancel|cleanup))?$/u.exec(request.url);
      if (!match || !UUID.test(match[1])) return send(404, { errorCode: 'COMPUTE_JOB_NOT_FOUND' });
      const job = broker.get(match[1]);
      if (request.method === 'GET' && !match[2]) return send(200, broker.receipt(job));
      if (request.method === 'GET' && match[2] === 'result') {
        if (!job.output || job.state !== 'succeeded' || !job.terminationConfirmed) throw new Error('COMPUTE_RESULT_UNAVAILABLE');
        return send(200, { ...broker.receipt(job), ...job.output });
      }
      if (request.method === 'POST' && match[2] === 'start') return send(200, await broker.start(job.jobId));
      if (request.method === 'POST' && ['cancel', 'cleanup'].includes(match[2])) { await broker.terminate(job); return send(200, broker.receipt(job)); }
      return send(404, { errorCode: 'COMPUTE_OPERATION_NOT_FOUND' });
    } catch (error) { return send(error.message.includes('NOT_FOUND') ? 404 : error.message.includes('CONFLICT') ? 409 : 400, { errorCode: error.message.split(':')[0] }); }
  });
  server.requestTimeout = 30000;
  server.maxConnections = 4;
  await new Promise(resolve => server.listen(config.port ?? Number(process.env.SANDBOX_PORT ?? 8093),
    config.host ?? process.env.SANDBOX_LISTEN_HOST ?? '127.0.0.1', resolve));
  return { server, broker };
}
module.exports = { validateInput, validateOutput, containerArguments, SandboxBroker, serve };
if (require.main === module) serve().then(({ server, broker }) => {
  const stop = async () => { server.close(); await broker.close(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
