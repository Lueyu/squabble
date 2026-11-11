import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import type { ToolCapabilityPackId } from '../../../shared/tool-capabilities.interface';

export interface CapabilityPreparationFact {
  ready: boolean;
  facts: Record<string, string | number | boolean | null>;
  reasonCode?: string;
}
export interface CapabilityReadinessPort {
  probe(): Promise<Record<ToolCapabilityPackId, CapabilityPreparationFact>>;
  aktoolsEndpoint(): string | undefined;
  aktoolsCredential(): string | undefined;
}

/** Only deployment-owned fixed origins are read. A health response never runs a business tool. */
@Injectable()
export class ToolCapabilityReadinessService implements CapabilityReadinessPort {
  aktoolsEndpoint(): string | undefined { return process.env.FINANCIAL_AKTOOLS_MCP_URL; }
  aktoolsCredential(): string | undefined {
    const file = process.env.FINANCIAL_AKTOOLS_MCP_TOKEN_FILE;
    return file ? readFileSync(file, 'utf8').trim() : process.env.FINANCIAL_AKTOOLS_MCP_TOKEN;
  }
  private async health(endpoint?: string): Promise<Record<string, unknown>> {
    if (!endpoint) throw new Error('TOOL_SERVICE_NOT_CONFIGURED');
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('TOOL_SERVICE_CONFIGURATION_INVALID');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok || !response.body) throw new Error('TOOL_SERVICE_UNAVAILABLE');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break;
      bytes += part.value.length; if (bytes > 16_384) throw new Error('TOOL_HEALTH_RESPONSE_RESTRICTED'); chunks.push(part.value);
    } } finally { await reader.cancel().catch(() => undefined); }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('TOOL_HEALTH_RESPONSE_INVALID');
    return result as Record<string, unknown>;
  }
  private async checked(operation: () => Promise<CapabilityPreparationFact>): Promise<CapabilityPreparationFact> {
    try { return await operation(); } catch { return { ready: false, facts: {}, reasonCode: 'TOOL_SERVICE_UNAVAILABLE' }; }
  }
  async probe(): Promise<Record<ToolCapabilityPackId, CapabilityPreparationFact>> {
    const [documents, market_data, browser, compute] = await Promise.all([
      this.checked(async () => {
        const data = await this.health(process.env.TOOL_CAPABILITIES_DOCLING_HEALTH_URL);
        const ready = data.ready === true && data.engine === 'docling' && data.engineVersion === '1.38.2'
          && data.modelsVerified === true && typeof data.modelManifestSha256 === 'string' && /^[a-f0-9]{64}$/u.test(data.modelManifestSha256);
        return { ready, facts: { engineVersion: String(data.engineVersion ?? ''), modelsVerified: data.modelsVerified === true,
          modelManifestSha256: typeof data.modelManifestSha256 === 'string' ? data.modelManifestSha256 : null },
          ...(ready ? {} : { reasonCode: 'DOCUMENT_MODELS_NOT_READY' }) };
      }),
      this.checked(async () => {
        const endpoint = this.aktoolsEndpoint();
        const health = endpoint ? new URL('/health', endpoint).href : undefined;
        const data = await this.health(health);
        const ready = data.ready === true && data.engine === 'aktools' && data.engineVersion === '0.1.5';
        return { ready, facts: { engineVersion: String(data.engineVersion ?? '') }, ...(ready ? {} : { reasonCode: 'AKTOOLS_NOT_READY' }) };
      }),
      this.checked(async () => {
        if (process.platform === 'linux' && process.getuid?.() === 0) throw new Error('BROWSER_SANDBOX_UNAVAILABLE');
        const instance = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 10_000,
          args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
        try { const page = await instance.newPage(); await page.route('**/*', route => route.abort()); await page.goto('about:blank');
          return { ready: true, facts: { chromium: true, version: instance.version(), sandbox: true } };
        } finally { await instance.close(); }
      }),
      this.checked(async () => {
        const endpoint = process.env.SANDBOX_BROKER_URL;
        const data = await this.health(endpoint ? new URL('/health', endpoint).href : undefined);
        const ready = data.status === 'ready' && data.provider === 'local-container' && data.protocolVersion === 1
          && typeof data.imageId === 'string' && /^sha256:[a-f0-9]{64}$/u.test(data.imageId);
        return { ready, facts: { protocolVersion: typeof data.protocolVersion === 'number' ? data.protocolVersion : null,
          imageId: typeof data.imageId === 'string' ? data.imageId : null }, ...(ready ? {} : { reasonCode: 'SANDBOX_NOT_READY' }) };
      }),
    ]);
    return { documents, market_data, browser, compute };
  }
}
