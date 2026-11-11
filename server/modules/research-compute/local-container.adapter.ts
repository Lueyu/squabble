import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ComputeE2bError } from './e2b.adapter';
import type { E2bComputeInput, ComputeOutput } from './e2b.adapter';
import type { ComputeProvider } from './compute-provider';

export interface LocalSandboxConfig { endpoint: string; token?: string; tokenFile?: string }
const receiptSchema = z.object({ jobId: z.uuid(), sandboxId: z.string().regex(/^local:[a-f0-9-]+:[a-f0-9-]+$/u),
  state: z.enum(['creating', 'created', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'provider_unknown']),
  terminationConfirmed: z.boolean(), errorCode: z.string().nullable(), imageId: z.string(), protocolVersion: z.literal(1),
  stderr: z.string().max(16000).optional(),
});

/** Only the trusted deployment broker sees Docker. The app transfers bounded bytes, never host paths. */
@Injectable()
export class LocalContainerAdapter implements ComputeProvider {
  readonly provider = 'local-container' as const;
  private readonly config: LocalSandboxConfig | null;
  private imageId = 'unverified';
  constructor(@Optional() @Inject('LOCAL_SANDBOX_CONFIG') config?: LocalSandboxConfig | null) {
    this.config = config === undefined ? process.env.SANDBOX_BROKER_URL ? {
      endpoint: process.env.SANDBOX_BROKER_URL, tokenFile: process.env.SANDBOX_BROKER_TOKEN_FILE,
    } : null : config;
    if (this.config) {
      const endpoint = new URL(this.config.endpoint);
      if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', 'sandbox', 'sandbox-broker'].includes(endpoint.hostname)
        || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('SANDBOX_BROKER_URL_INVALID');
    }
  }
  status(): 'configured' | 'unconfigured' { return this.config && (this.config.token || this.config.tokenFile) ? 'configured' : 'unconfigured'; }
  template() { return this.config ? { id: 'squabble-analytics', version: this.imageId } : null; }
  private async request(path: string, method = 'GET', value?: unknown, maximum = 64000): Promise<unknown> {
    if (this.status() !== 'configured' || !this.config) throw new Error('LOCAL_SANDBOX_UNCONFIGURED');
    const token = this.config.token ?? (await readFile(this.config.tokenFile!, 'utf8')).trim();
    if (token.length < 32 || token.length > 1024) throw new Error('SANDBOX_TOKEN_INVALID');
    const response = await fetch(new URL(path, this.config.endpoint), { method, redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(30000) });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('LOCAL_BROKER_EMPTY_RESPONSE');
    let size = 0; const parts: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > maximum) { await reader.cancel(); throw new Error('OUTPUT_SIZE_LIMIT'); }
        parts.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!response.ok) throw new Error(typeof result.errorCode === 'string' ? result.errorCode : 'LOCAL_BROKER_FAILED');
    return result;
  }
  async readiness() {
    const value = z.object({ status: z.enum(['ready', 'unavailable']), provider: z.literal('local-container'),
      protocolVersion: z.literal(1), imageId: z.string().nullable(), deploymentId: z.uuid() }).parse(await this.request('/health'));
    if (value.status !== 'ready' || !value.imageId) throw new Error('LOCAL_SANDBOX_UNAVAILABLE');
    this.imageId = value.imageId; return value;
  }
  private identity(sandboxId: string): { deployment: string; jobId: string } {
    const parts = sandboxId.split(':');
    if (parts.length !== 3 || parts[0] !== 'local' || !z.uuid().safeParse(parts[1]).success || !z.uuid().safeParse(parts[2]).success) throw new Error('LOCAL_SANDBOX_ID_INVALID');
    return { deployment: parts[1], jobId: parts[2] };
  }
  async kill(sandboxId: string): Promise<boolean> {
    try {
      const { deployment, jobId } = this.identity(sandboxId);
      const readiness = z.object({ deploymentId: z.uuid() }).parse(await this.request('/health'));
      if (readiness.deploymentId !== deployment) throw new Error('LOCAL_BROKER_IDENTITY_CHANGED');
      const receipt = receiptSchema.parse(await this.request(`/v1/jobs/${jobId}/cleanup`, 'POST'));
      if (receipt.sandboxId !== sandboxId || !receipt.terminationConfirmed) throw new Error('LOCAL_CLEANUP_UNKNOWN');
      return true;
    } catch { throw new ComputeE2bError('LOCAL_CLEANUP_UNKNOWN', sandboxId, false); }
  }
  async run(input: E2bComputeInput, created: (sandboxId: string) => Promise<void>, shouldContinue = async () => true) {
    if (this.status() !== 'configured') throw new Error('LOCAL_SANDBOX_UNCONFIGURED');
    const ready = await this.readiness();
    const preparedImage = z.object({ dependencies: z.object({ sandboxImage: z.string() }) }).parse(input.manifest).dependencies.sandboxImage;
    if (preparedImage !== ready.imageId) throw new ComputeE2bError('COMPUTE_PROVIDER_IDENTITY_CHANGED', null, true);
    let sandboxId = ready.deploymentId ? `local:${ready.deploymentId}:${input.jobId}` : null;
    let terminated = false, receipt, createRequested = false;
    const checkedReceipt = (value: unknown) => {
      const parsed = receiptSchema.parse(value);
      if (parsed.jobId !== input.jobId || parsed.sandboxId !== sandboxId || parsed.imageId !== ready.imageId) throw new Error('LOCAL_IDENTITY_CONFLICT');
      return parsed;
    };
    try {
      if (!await shouldContinue()) throw new ComputeE2bError('COMPUTE_CANCELLED', null, true);
      try { createRequested = true; receipt = checkedReceipt(await this.request('/v1/jobs', 'POST', { version: 1, ...input,
        files: input.files.map(file => ({ name: file.name, base64: file.data.toString('base64') })) })); }
      catch { throw new ComputeE2bError('LOCAL_CREATE_UNKNOWN', sandboxId, false); }
      sandboxId = receipt.sandboxId;
      await created(sandboxId);
      if (!await shouldContinue()) throw new Error('COMPUTE_CANCELLED');
      receipt = checkedReceipt(await this.request(`/v1/jobs/${input.jobId}/start`, 'POST'));
      const deadline = Date.now() + input.maxRuntimeMs + 30000;
      while (['creating', 'created', 'running', 'cancel_requested'].includes(receipt.state)) {
        if (!await shouldContinue()) throw new Error('COMPUTE_CANCELLED');
        if (Date.now() > deadline) throw new Error('LOCAL_DEADLINE_EXCEEDED');
        await new Promise(resolve => setTimeout(resolve, 200));
        receipt = checkedReceipt(await this.request(`/v1/jobs/${input.jobId}`));
        if (receipt.sandboxId !== sandboxId) throw new Error('LOCAL_IDENTITY_CONFLICT');
      }
      terminated = receipt.terminationConfirmed;
      if (receipt.state !== 'succeeded' || !terminated) throw new ComputeE2bError(receipt.errorCode ?? 'LOCAL_EXECUTION_FAILED', sandboxId, terminated, '', receipt.stderr ?? '');
      const output = z.object({ files: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]+[.](json|csv|png|txt)$/u),
        mime: z.enum(['application/json', 'text/csv', 'image/png', 'text/plain']), sha256: z.string().regex(/^[a-f0-9]{64}$/u), base64: z.string() })).min(1).max(8),
        stdout: z.string().max(16000), stderr: z.string().max(16000) }).parse(await this.request(`/v1/jobs/${input.jobId}/result`, 'GET', undefined, 24 * 1024 * 1024));
      let total = 0; const names = new Set<string>();
      if (Buffer.byteLength(output.stdout) > 16000 || Buffer.byteLength(output.stderr) > 16000) throw new Error('OUTPUT_SIZE_LIMIT');
      const files: ComputeOutput[] = output.files.map(file => {
        if (names.has(file.name)) throw new Error('OUTPUT_INTEGRITY'); names.add(file.name);
        const data = Buffer.from(file.base64, 'base64'); total += data.length;
        if (total > input.maxOutputBytes) throw new Error('OUTPUT_SIZE_LIMIT');
        if (createHash('sha256').update(data).digest('hex') !== file.sha256 || file.mime === 'image/png'
          && !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('OUTPUT_INTEGRITY');
        return { name: file.name, mime: file.mime, sha256: file.sha256, data };
      });
      return { files, stdout: output.stdout, stderr: output.stderr, sandboxId, terminationConfirmed: true as const };
    } catch (error) {
      if (!createRequested) { terminated = true; sandboxId = null; }
      if (error instanceof ComputeE2bError && error.terminationConfirmed) terminated = true;
      if (sandboxId && !terminated) {
        try { await this.kill(sandboxId); terminated = true; } catch { /* Keep the durable unknown resource reservation. */ }
      }
      throw new ComputeE2bError(error instanceof ComputeE2bError ? error.code : error instanceof Error ? error.message : 'LOCAL_EXECUTION_UNKNOWN', sandboxId, terminated,
        error instanceof ComputeE2bError ? error.stdout : '', error instanceof ComputeE2bError ? error.stderr : '');
    }
  }
}
