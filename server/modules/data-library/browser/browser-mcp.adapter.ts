import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BrowserNavigationPolicy, verifiedRemoteBrowserPolicy, type RemoteBrowserNetworkVerification } from './browser-navigation-policy';
import type { BrowserResearchAuthority, BrowserResearchBinding } from './browser-research-session';

// Official package source checked 2026-11-11: github.com/microsoft/playwright-mcp/blob/main/package.json.
// This optional adapter does not install/launch stdio or resolve a floating package version.
export const PLAYWRIGHT_MCP_PACKAGE_VERSION = '0.0.85';
export const BROWSER_MCP_READ_TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_close'] as const;
export interface BrowserMcpRegistration {
  packageName: '@playwright/mcp'; packageVersion: string; deploymentId: string;
  verification: RemoteBrowserNetworkVerification;
  /** Provisions a fresh isolated browser endpoint, with the same pinned public-IP proxy policy, for this run only. */
  provision(binding: BrowserResearchBinding): Promise<{ endpoint: string; bearerToken: string; release(): Promise<void> }>;
}
interface McpSession {
  binding: BrowserResearchBinding; id: string; expiresAt: number; pages: number;
  client: Client; transport: StreamableHTTPClientTransport; release(): Promise<void>;
  timer?: ReturnType<typeof setTimeout>; busy: boolean;
}

/** Only the official read subset is callable; remote annotations never authorize clicks, JS, upload or file paths. */
export class BrowserMcpAdapter {
  private readonly sessions = new Map<string, McpSession>();
  private readonly policy = new BrowserNavigationPolicy();
  private readonly provisioning = new Set<string>();
  constructor(private readonly authority: BrowserResearchAuthority, private readonly registration?: BrowserMcpRegistration) {}
  availability(): { available: boolean; reason: string | null } {
    const available = this.registration?.packageName === '@playwright/mcp'
      && this.registration.packageVersion === PLAYWRIGHT_MCP_PACKAGE_VERSION
      && verifiedRemoteBrowserPolicy(this.registration.verification, this.registration.deploymentId);
    return { available: Boolean(available), reason: available ? null : 'BROWSER_MCP_DEPLOYMENT_UNVERIFIED' };
  }
  async open(binding: BrowserResearchBinding): Promise<{ sessionId: string; expiresAt: string }> {
    if (!this.availability().available || !this.registration) throw new Error('BROWSER_MCP_DEPLOYMENT_UNVERIFIED');
    await this.authority.assert(binding, []);
    if (this.sessions.size + this.provisioning.size >= 4 || this.provisioning.has(binding.owner)
      || [...this.sessions.values()].some(item => item.binding.owner === binding.owner)) throw new Error('BROWSER_BUSY');
    this.provisioning.add(binding.owner);
    let endpoint: Awaited<ReturnType<BrowserMcpRegistration['provision']>>;
    try { endpoint = await this.registration.provision(binding); }
    catch { this.provisioning.delete(binding.owner); throw new Error('BROWSER_MCP_PROVIDER_UNKNOWN'); }
    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | undefined;
    try {
      const url = new URL(endpoint.endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || !endpoint.bearerToken) throw new Error('BROWSER_MCP_ENDPOINT_UNVERIFIED');
      transport = new StreamableHTTPClientTransport(url, { requestInit: { redirect: 'error',
        headers: { Authorization: `Bearer ${endpoint.bearerToken}` } } });
      client = new Client({ name: 'squabble-run-browser', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport, { timeout: 10_000 });
      if (client.getServerVersion()?.version !== PLAYWRIGHT_MCP_PACKAGE_VERSION) throw new Error('BROWSER_MCP_VERSION_MISMATCH');
      const listed = await client.listTools({}, { timeout: 5000 });
      if (!BROWSER_MCP_READ_TOOLS.every(name => listed.tools.some(tool => tool.name === name))) throw new Error('BROWSER_MCP_TOOLS_UNAVAILABLE');
      await this.authority.assert(binding, []);
      const session: McpSession = { id: randomUUID(), binding: { ...binding }, expiresAt: Date.now() + 54_000,
        client, transport, release: endpoint.release, pages: 0, busy: false };
      this.sessions.set(session.id, session);
      session.timer = setTimeout(() => { void this.dispose(session); }, 54_000); session.timer.unref();
      return { sessionId: session.id, expiresAt: new Date(session.expiresAt).toISOString() };
    } catch {
      await Promise.allSettled([client?.close(), transport?.close(), endpoint.release()]);
      throw new Error('BROWSER_MCP_UNAVAILABLE');
    } finally { this.provisioning.delete(binding.owner); }
  }
  private session(binding: BrowserResearchBinding, id: string): McpSession {
    const session = this.sessions.get(id);
    if (!session || session.binding.owner !== binding.owner || session.binding.runId !== binding.runId
      || session.binding.leaseToken !== binding.leaseToken || session.binding.runRevision !== binding.runRevision) throw new Error('BROWSER_SESSION_NOT_FOUND');
    return session;
  }
  async act(binding: BrowserResearchBinding, id: string, command: { action: 'navigate'; url: string } | { action: 'read' }, signal?: AbortSignal) {
    const session = this.session(binding, id);
    if (session.busy) throw new Error('BROWSER_BUSY');
    session.busy = true;
    try {
      if (!this.availability().available || Date.now() >= session.expiresAt) throw new Error('BROWSER_MCP_DEPLOYMENT_UNVERIFIED');
      await this.authority.assert(binding, []);
      if (command.action === 'navigate') {
        await this.policy.url(command.url);
        if (++session.pages > 5) throw new Error('BROWSER_PAGE_LIMIT');
        await session.client.callTool({ name: 'browser_navigate', arguments: { url: command.url } }, undefined,
          { signal, timeout: Math.min(20_000, session.expiresAt - Date.now()) });
      } else if (command.action !== 'read') throw new Error('BROWSER_ACTION_BLOCKED');
      const result = await session.client.callTool({ name: 'browser_snapshot', arguments: { depth: 12 } }, undefined,
        { signal, timeout: Math.min(10_000, session.expiresAt - Date.now()) });
      if (result.isError) throw new Error('BROWSER_MCP_READ_FAILED');
      await this.authority.assert(binding, []);
      // Ignore remote file paths, resource links, HTML and images. Local screenshots use ResearchArtifactsService.
      const content = result.content;
      const text = Array.isArray(content) ? content.filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => String(block.text)).join('\n').slice(0, 16_000) : '';
      return { sessionId: id, text, untrusted: true as const, observedAt: new Date().toISOString() };
    } catch {
      await this.dispose(session);
      throw new Error(signal?.aborted ? 'BROWSER_CANCELLED' : 'BROWSER_MCP_READ_FAILED');
    } finally { session.busy = false; }
  }
  async close(binding: BrowserResearchBinding, id: string): Promise<void> { await this.dispose(this.session(binding, id)); }
  private async dispose(session: McpSession): Promise<void> {
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(session.id);
    await session.client.callTool({ name: 'browser_close', arguments: {} }, undefined, { timeout: 3000 }).catch(() => undefined);
    await Promise.allSettled([session.client.close(), session.transport.close(), session.release()]);
  }
  async shutdown(): Promise<void> { await Promise.allSettled([...this.sessions.values()].map(session => this.dispose(session))); }
}
