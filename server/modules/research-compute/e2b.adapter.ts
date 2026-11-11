import { Inject, Injectable, Optional } from '@nestjs/common';
import { Sandbox } from '@e2b/code-interpreter';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export interface E2bAnalyticsConfig { apiKey: string; templateId: string; templateVersion: string }
export interface ComputeSandbox {
  id: string;
  write(path: string, data: string | Buffer): Promise<void>;
  read(path: string): Promise<ReadableStream<Uint8Array>>;
  execute(code: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; error: string | null }>;
  kill(): Promise<boolean>;
}
export interface ComputeSandboxOptions {
  idempotencyKey: string; timeoutMs: number; allowInternetAccess: false;
  network: { allowPublicTraffic: false; denyOut: string[] }; envs: Record<string, string>;
}
export type ComputeSandboxFactory = (options: ComputeSandboxOptions, config: E2bAnalyticsConfig) => Promise<ComputeSandbox>;
export interface E2bComputeInput {
  jobId: string; manifest: unknown; files: Array<{ name: string; data: Buffer }>;
  maxRuntimeMs: number; maxOutputBytes: number;
}
export interface ComputeOutput { name: string; mime: string; sha256: string; data: Buffer }
export class ComputeE2bError extends Error {
  constructor(readonly code: string, readonly sandboxId: string | null, readonly terminationConfirmed: boolean,
    readonly stdout = '', readonly stderr = '') { super(code); }
}

const outputSchema = z.object({ files: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]+[.](json|csv|png|txt)$/u),
  mime: z.enum(['application/json', 'text/csv', 'image/png', 'text/plain']),
  sizeBytes: z.number().int().min(0).max(32 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()).min(1).max(8) }).strict();

async function boundedRead(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const reader = stream.getReader(), parts: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('OUTPUT_SIZE_LIMIT'); }
      parts.push(Buffer.from(next.value));
    }
    return Buffer.concat(parts);
  } finally { reader.releaseLock(); }
}

/** The factory has no arbitrary endpoint, host filesystem or credential environment bridge. */
const cloudFactory: ComputeSandboxFactory = async (options, config) => {
  const sandbox = await Sandbox.create(config.templateId, { ...options, apiKey: config.apiKey, requestTimeoutMs: 30_000 });
  return { id: sandbox.sandboxId,
    write: async (path, data) => { await sandbox.files.write(path, data); },
    read: path => sandbox.files.read(path, { format: 'stream', requestTimeoutMs: 30_000, streamIdleTimeoutMs: 15_000 }),
    execute: async (code, timeoutMs) => {
      const execution = await sandbox.runCode(code, { language: 'python', timeoutMs, requestTimeoutMs: timeoutMs + 5000, envs: {} });
      return { stdout: execution.logs.stdout.join('').slice(0, 16_000), stderr: execution.logs.stderr.join('').slice(0, 16_000),
        error: execution.error ? `${execution.error.name}: ${execution.error.value}` : null };
    }, kill: () => sandbox.kill({ requestTimeoutMs: 15_000 }),
  };
};

/** One durable job creates at most one sandbox; every created sandbox reaches a cleanup attempt. */
@Injectable()
export class E2bAdapter {
  private readonly config: E2bAnalyticsConfig | null;
  private readonly factory: ComputeSandboxFactory;
  constructor(@Optional() @Inject('E2B_ANALYTICS_CONFIG') config?: E2bAnalyticsConfig | null,
    @Optional() @Inject('E2B_SANDBOX_FACTORY') factory?: ComputeSandboxFactory) {
    this.config = config === undefined ? process.env.E2B_API_KEY && process.env.E2B_ANALYTICS_TEMPLATE_ID && process.env.E2B_ANALYTICS_TEMPLATE_VERSION
      ? { apiKey: process.env.E2B_API_KEY, templateId: process.env.E2B_ANALYTICS_TEMPLATE_ID, templateVersion: process.env.E2B_ANALYTICS_TEMPLATE_VERSION } : null : config;
    this.factory = factory ?? cloudFactory;
  }
  status(): 'configured' | 'unconfigured' { return this.config ? 'configured' : 'unconfigured'; }
  template(): { id: string; version: string } | null {
    return this.config ? { id: this.config.templateId, version: this.config.templateVersion } : null;
  }
  async kill(sandboxId: string): Promise<boolean> {
    if (!this.config) throw new Error('E2B_UNCONFIGURED');
    try {
      await Sandbox.kill(sandboxId, { apiKey: this.config.apiKey, requestTimeoutMs: 15_000 });
      // The SDK returns false for 404: absence is still confirmed termination.
      return true;
    } catch { throw new ComputeE2bError('E2B_CLEANUP_UNKNOWN', sandboxId, false); }
  }
  async run(input: E2bComputeInput, created: (sandboxId: string) => Promise<void>,
    shouldContinue: () => Promise<boolean> = async () => true): Promise<{
      files: ComputeOutput[]; stdout: string; stderr: string; sandboxId: string; terminationConfirmed: true;
    }> {
    if (!this.config) throw new Error('E2B_UNCONFIGURED');
    if (!Number.isSafeInteger(input.maxRuntimeMs) || input.maxRuntimeMs < 1000 || input.maxRuntimeMs > 120_000
      || input.maxOutputBytes < 1 || input.maxOutputBytes > 32 * 1024 * 1024) throw new Error('COMPUTE_LIMIT_INVALID');
    let sandbox: ComputeSandbox;
    try { sandbox = await this.factory({ idempotencyKey: input.jobId, timeoutMs: input.maxRuntimeMs + 30_000,
      allowInternetAccess: false, network: { allowPublicTraffic: false, denyOut: ['0.0.0.0/0', '::/0'] }, envs: {} }, this.config); }
    catch { throw new ComputeE2bError('E2B_CREATE_UNKNOWN', null, false); }
    let failure: string | null = null, stdout = '', stderr = '', terminated = false;
    const files: ComputeOutput[] = [];
    try {
      await created(sandbox.id);
      if (!await shouldContinue()) throw new Error('COMPUTE_CANCELLED');
      await sandbox.write('/home/user/manifest.json', JSON.stringify(input.manifest));
      for (const file of input.files) {
        if (!await shouldContinue()) throw new Error('COMPUTE_CANCELLED');
        if (!/^(dataset-[0-9]+[.]json|code[.]py)$/u.test(file.name)) throw new Error('INPUT_PATH_INVALID');
        await sandbox.write(`/home/user/${file.name}`, file.data);
      }
      if (!await shouldContinue()) throw new Error('COMPUTE_CANCELLED');
      const execution = await sandbox.execute("from squabble_analytics.cli import run\nrun('/home/user/manifest.json')", input.maxRuntimeMs);
      stdout = execution.stdout.slice(0, 16_000); stderr = execution.stderr.slice(0, 16_000);
      if (execution.error) { stderr = `${stderr}\n${execution.error}`.slice(0, 16_000); throw new Error('E2B_EXECUTION_FAILED'); }
      const output = outputSchema.parse(JSON.parse((await boundedRead(await sandbox.read('/home/user/outputs/outputs.json'), 64_000)).toString('utf8')));
      let total = 0;
      for (const file of output.files) {
        if (!await shouldContinue()) throw new Error('COMPUTE_CANCELLED');
        if (file.sizeBytes + total > input.maxOutputBytes) throw new Error('OUTPUT_SIZE_LIMIT');
        const data = await boundedRead(await sandbox.read(`/home/user/outputs/${file.name}`), file.sizeBytes);
        const hash = createHash('sha256').update(data).digest('hex');
        if (data.length !== file.sizeBytes || hash !== file.sha256) throw new Error('OUTPUT_INTEGRITY');
        if (file.mime === 'image/png' && !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('OUTPUT_INTEGRITY');
        total += data.length; files.push({ name: file.name, mime: file.mime, sha256: hash, data });
      }
    } catch (error) {
      failure = error instanceof Error && ['OUTPUT_INTEGRITY', 'OUTPUT_SIZE_LIMIT', 'INPUT_PATH_INVALID',
        'COMPUTE_CANCELLED', 'E2B_EXECUTION_FAILED'].includes(error.message) ? error.message : 'E2B_EXECUTION_OR_DOWNLOAD_UNKNOWN';
    } finally {
      try { await sandbox.kill(); terminated = true; } catch { terminated = false; }
    }
    if (!terminated) throw new ComputeE2bError('E2B_CLEANUP_UNKNOWN', sandbox.id, false, stdout, stderr);
    if (failure) throw new ComputeE2bError(failure, sandbox.id, true, stdout, stderr);
    return { files, stdout, stderr, sandboxId: sandbox.id, terminationConfirmed: true };
  }
}
