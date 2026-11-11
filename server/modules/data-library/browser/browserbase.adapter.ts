import { createHash } from 'node:crypto';
import { verifiedRemoteBrowserPolicy, type RemoteBrowserNetworkVerification } from './browser-navigation-policy';
import type { BrowserResearchAuthority, BrowserResearchBinding } from './browser-research-session';

export interface BrowserbaseConfig {
  apiKey: string; projectId: string; deploymentId?: string; riskPolicyId?: string;
  verification?: RemoteBrowserNetworkVerification;
}
export interface BrowserbaseReceipt {
  owner: string; runId: string; bindingHash: string; state: 'pending' | 'created' | 'unknown' | 'released'; remoteId?: string;
}
/** Must be backed by a durable runtime receipt store before enabling a paid backend. */
export interface BrowserbaseReceipts {
  reserve(key: string, owner: string, runId: string, bindingHash: string): Promise<BrowserbaseReceipt & { fresh: boolean }>;
  update(key: string, state: 'created' | 'unknown' | 'released', remoteId?: string): Promise<void>;
  read(key: string): Promise<BrowserbaseReceipt | null>;
}
interface BrowserbaseDependencies {
  authority: BrowserResearchAuthority; receipts?: BrowserbaseReceipts;
  transport?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Official Sessions API lifecycle. API-host validation alone never enables remote navigation. */
export class BrowserbaseAdapter {
  constructor(private readonly config: BrowserbaseConfig | undefined, private readonly dependencies: BrowserbaseDependencies) {}
  availability(): { available: boolean; reason: string | null } {
    if (!this.config?.apiKey || !this.config.projectId) return { available: false, reason: 'BROWSERBASE_UNCONFIGURED' };
    if (!this.config.riskPolicyId || !verifiedRemoteBrowserPolicy(this.config.verification, this.config.deploymentId ?? '')) {
      return { available: false, reason: 'BROWSERBASE_NAVIGATION_EGRESS_UNVERIFIED' };
    }
    if (!this.dependencies.receipts) return { available: false, reason: 'BROWSERBASE_DURABLE_RECEIPTS_REQUIRED' };
    return { available: true, reason: null };
  }
  private bindingHash(binding: BrowserResearchBinding): string {
    return createHash('sha256').update(JSON.stringify([binding.owner, binding.runId, binding.leaseToken, binding.runRevision])).digest('hex');
  }
  private async request(path: string, method: 'POST' | 'GET', body?: unknown): Promise<{ id: string; status: string }> {
    if (!this.config?.apiKey || !/^(?:\/[a-zA-Z0-9_-]{1,128})?$/u.test(path)) throw new Error('BROWSERBASE_UNAVAILABLE');
    const response = await (this.dependencies.transport ?? fetch)(`https://api.browserbase.com/v1/sessions${path}`, {
      method, headers: { 'X-BB-API-Key': this.config.apiKey, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('BROWSERBASE_REQUEST_FAILED');
    if (Number(response.headers.get('content-length') ?? 0) > 64_000) throw new Error('BROWSERBASE_RESPONSE_LIMIT');
    // Stream bounds also apply when Content-Length is absent or false.
    if (!response.body) throw new Error('BROWSERBASE_RESPONSE_INVALID');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 64_000) { await reader.cancel(); throw new Error('BROWSERBASE_RESPONSE_LIMIT'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || typeof parsed.id !== 'string'
      || !/^[a-zA-Z0-9_-]{1,128}$/u.test(parsed.id) || !('status' in parsed) || typeof parsed.status !== 'string'
      || parsed.status.length > 64) throw new Error('BROWSERBASE_RESPONSE_INVALID');
    // connectUrl/signingKey/contextId never escape the adapter as a public tool result.
    return { id: parsed.id, status: parsed.status };
  }
  async createSession(binding: BrowserResearchBinding, dispatchKey: string): Promise<{ remoteId: string; status: string }> {
    const availability = this.availability();
    if (!availability.available || !this.config || !this.dependencies.receipts) throw new Error(availability.reason ?? 'BROWSERBASE_UNAVAILABLE');
    await this.dependencies.authority.assert(binding, []);
    if (!/^[a-zA-Z0-9_.:-]{1,256}$/u.test(dispatchKey)) throw new Error('BROWSERBASE_DISPATCH_KEY_INVALID');
    const reservation = await this.dependencies.receipts.reserve(dispatchKey, binding.owner, binding.runId, this.bindingHash(binding));
    if (reservation.owner !== binding.owner || reservation.runId !== binding.runId || reservation.bindingHash !== this.bindingHash(binding)) throw new Error('BROWSERBASE_SESSION_NOT_FOUND');
    if (!reservation.fresh) throw new Error('BROWSERBASE_ALREADY_DISPATCHED');
    let remoteId: string | undefined;
    try {
      const response = await this.request('', 'POST', { projectId: this.config.projectId, timeout: 60, keepAlive: false,
        browserSettings: { recordSession: false, logSession: false, solveCaptchas: false, ignoreCertificateErrors: false,
          riskPolicyId: this.config.riskPolicyId, viewport: { width: 1280, height: 720 } } });
      remoteId = response.id;
      await this.dependencies.receipts.update(dispatchKey, 'created', response.id);
      try { await this.dependencies.authority.assert(binding, []); }
      catch (error) { await this.release(binding, dispatchKey); throw error; }
      return { remoteId: response.id, status: response.status };
    } catch {
      const receipt = await this.dependencies.receipts.read(dispatchKey);
      if (receipt?.state !== 'released') await this.dependencies.receipts.update(dispatchKey, 'unknown', remoteId);
      throw new Error('BROWSERBASE_PROVIDER_UNKNOWN');
    }
  }
  private async owned(binding: BrowserResearchBinding, key: string): Promise<BrowserbaseReceipt> {
    const receipt = await this.dependencies.receipts?.read(key);
    if (!receipt || receipt.owner !== binding.owner || receipt.runId !== binding.runId || receipt.bindingHash !== this.bindingHash(binding) || !receipt.remoteId) throw new Error('BROWSERBASE_SESSION_NOT_FOUND');
    return receipt;
  }
  async status(binding: BrowserResearchBinding, key: string): Promise<{ remoteId: string; status: string }> {
    await this.dependencies.authority.assert(binding, []);
    const receipt = await this.owned(binding, key), result = await this.request(`/${receipt.remoteId}`, 'GET');
    if (result.id !== receipt.remoteId) throw new Error('BROWSERBASE_RESPONSE_INVALID');
    return { remoteId: result.id, status: result.status };
  }
  async release(binding: BrowserResearchBinding, key: string): Promise<void> {
    // Cleanup remains available after run cancellation/deletion; receipt ownership still fences the remote ID.
    const receipt = await this.owned(binding, key);
    if (receipt.state === 'released') return;
    try {
      const result = await this.request(`/${receipt.remoteId}`, 'POST', { projectId: this.config?.projectId, status: 'REQUEST_RELEASE' });
      if (result.id !== receipt.remoteId) throw new Error('BROWSERBASE_RESPONSE_INVALID');
      await this.dependencies.receipts!.update(key, 'released');
    } catch { await this.dependencies.receipts!.update(key, 'unknown'); throw new Error('BROWSERBASE_PROVIDER_UNKNOWN'); }
  }
}
