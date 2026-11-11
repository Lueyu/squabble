import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright-core';
import type { AgentDataClass, AgentSourceVersionRef } from '../../../../shared/agent-tooling.interface';
import type { ResearchArtifactRef } from '../../../../shared/research-artifact.interface';
import type { ResearchArtifactsService } from '../../research-artifacts/research-artifacts.service';
import { BrowserEgressProxy, type PublicTunnelConnector } from './browser-egress';
import { browserExecutable, configuredBrowserUpstream, inspectBrowserEnvironment } from './browser-environment';
import { extractBrowserContent, redactBrowserContent } from './browser-content';
import { BrowserSourceError, type BrowserAvailability } from './browser-source.types';
import type { ResolvePublic } from '../data-library.fetch';
import { BrowserNavigationPolicy } from './browser-navigation-policy';

export interface BrowserResearchBinding {
  owner: string; runId: string; leaseToken: string; runRevision: string;
  /** Server-owned runtime scope only. No browser HTTP/model argument accepts these fields. */
  dataClasses?: AgentDataClass[];
}
export interface BrowserResearchAuthority {
  assert(binding: BrowserResearchBinding, dependencies: AgentSourceVersionRef[]): Promise<void>;
  beforeNavigate?(binding: BrowserResearchBinding, url: string, dependencies: AgentSourceVersionRef[]): Promise<void>;
}
export type BrowserResearchCommand = { action: 'navigate'; url: string } | { action: 'next' | 'expand'; index: number }
  | { action: 'read' | 'screenshot' };
export interface BrowserResearchSnapshot {
  sessionId: string; url: string; title?: string; text?: string;
  links?: Array<{ index: number; title: string; url: string }>;
  expansions?: Array<{ index: number; title: string }>;
  artifact?: ResearchArtifactRef; observedAt: string; untrusted: true;
}
export interface BrowserResearchReceipt {
  sessionId: string; owner: string; runId: string; reason: string; pages: number; closedAt: string;
}
export interface BrowserResearchDependencies {
  authority: BrowserResearchAuthority;
  artifacts?: Pick<ResearchArtifactsService, 'create' | 'discard'>;
  resolve?: ResolvePublic; connect?: PublicTunnelConnector;
  launch?: (options: LaunchOptions) => Promise<Browser>;
  inspect?: () => Promise<BrowserAvailability>; upstream?: () => Promise<URL | undefined>;
  maxPages?: number; timeoutMs?: number;
}
interface ResearchSession {
  id: string; binding: BrowserResearchBinding; dependencies: AgentSourceVersionRef[];
  expiresAt: number; controller: AbortController; policy: BrowserNavigationPolicy;
  pages: number; links: Array<{ index: number; title: string; url: string }>;
  browser?: Browser; context?: BrowserContext; page?: Page; proxy?: BrowserEgressProxy;
  timer?: ReturnType<typeof setTimeout>; failure?: Error; busy: boolean; popupClosures: Set<Promise<void>>;
  setup?: Promise<void>; closing?: Promise<void>;
}

/** Only fixed read operations reach Chromium. No profile, user JS, local paths, CDP URL or arbitrary clicks. */
export class BrowserResearchSession {
  private readonly sessions = new Map<string, ResearchSession>();
  private readonly closed: BrowserResearchReceipt[] = [];
  constructor(private readonly dependencies: BrowserResearchDependencies) {}

  private same(a: BrowserResearchBinding, b: BrowserResearchBinding): boolean {
    return a.owner === b.owner && a.runId === b.runId && a.leaseToken === b.leaseToken && a.runRevision === b.runRevision;
  }
  private check(session: ResearchSession): void {
    if (session.failure) throw session.failure;
    if (session.proxy?.failure) throw new Error(`BROWSER_${session.proxy.failure.code}`);
    if (session.controller.signal.aborted) throw new Error('BROWSER_CANCELLED');
    if (Date.now() >= session.expiresAt) throw new Error('BROWSER_TIMEOUT');
  }
  private async authorize(session: ResearchSession): Promise<void> {
    this.check(session);
    await this.dependencies.authority.assert(session.binding, session.dependencies);
    this.check(session);
  }
  private pageLimit(): number { return Math.min(10, Math.max(1, this.dependencies.maxPages ?? 5)); }
  private timeout(session: ResearchSession): number { this.check(session); return Math.max(1, session.expiresAt - Date.now()); }
  private async race<T>(session: ResearchSession, operation: Promise<T>): Promise<T> {
    this.check(session);
    let cancel: (() => void) | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        cancel = () => reject(session.failure ?? new Error('BROWSER_CANCELLED'));
        session.controller.signal.addEventListener('abort', cancel, { once: true });
      })]);
    } finally { if (cancel) session.controller.signal.removeEventListener('abort', cancel); }
  }
  async open(binding: BrowserResearchBinding, dependencies: AgentSourceVersionRef[] = [], signal?: AbortSignal): Promise<{ sessionId: string; expiresAt: string }> {
    if (!binding.owner || !binding.runId || !binding.leaseToken || !binding.runRevision) throw new Error('BROWSER_BINDING_REQUIRED');
    if (signal?.aborted) throw new Error('BROWSER_CANCELLED');
    await this.dependencies.authority.assert(binding, dependencies);
    if (signal?.aborted) throw new Error('BROWSER_CANCELLED');
    if (this.sessions.size >= 4 || [...this.sessions.values()].some(item => item.binding.owner === binding.owner)) throw new Error('BROWSER_BUSY');
    const session: ResearchSession = {
      id: randomUUID(), binding: { ...binding }, dependencies: structuredClone(dependencies),
      expiresAt: Date.now() + Math.min(60_000, Math.max(100, this.dependencies.timeoutMs ?? 54_000)),
      controller: new AbortController(), policy: new BrowserNavigationPolicy(this.dependencies.resolve), pages: 0, links: [], busy: false, popupClosures: new Set(),
    };
    this.sessions.set(session.id, session);
    session.timer = setTimeout(() => {
      session.failure = new Error('BROWSER_TIMEOUT'); session.controller.abort(); void this.dispose(session, 'timeout');
    }, this.timeout(session));
    session.timer.unref();
    const abort = (): void => { session.failure = new Error('BROWSER_CANCELLED'); session.controller.abort(); void this.dispose(session, 'cancelled'); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      session.setup = this.prepare(session); await session.setup;
      await this.authorize(session);
      return { sessionId: session.id, expiresAt: new Date(session.expiresAt).toISOString() };
    } catch (error) {
      const failure = session.failure ?? (error instanceof Error && /^(?:BROWSER_|SOURCE_)/u.test(error.message)
        ? error : new Error('BROWSER_UNAVAILABLE'));
      await this.dispose(session, 'setup_failed'); throw failure;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  private async prepare(session: ResearchSession): Promise<void> {
    const status = await this.race(session, (this.dependencies.inspect ?? inspectBrowserEnvironment)());
    if (!status.available) throw new Error('BROWSER_UNAVAILABLE');
    const upstream = await this.race(session, (this.dependencies.upstream ?? configuredBrowserUpstream)());
    session.proxy = await BrowserEgressProxy.create({ resolve: this.dependencies.resolve, connect: this.dependencies.connect, upstream });
    this.check(session);
    const launch = this.dependencies.launch ?? (options => chromium.launch(options));
    session.browser = await launch({ executablePath: this.dependencies.launch ? undefined : await browserExecutable(),
      headless: true, chromiumSandbox: true, timeout: Math.min(15_000, this.timeout(session)),
      proxy: { server: `http://127.0.0.1:${session.proxy.port}`, username: session.proxy.username, password: session.proxy.password },
      args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--disable-background-networking', '--disable-component-update',
        '--disable-sync', '--disable-extensions', '--no-first-run', '--js-flags=--max-old-space-size=128',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
    this.check(session);
    // A new context deliberately receives no storageState. Saved-source login remains in BrowserSourceRuntime.
    session.context = await session.browser.newContext({ acceptDownloads: false, permissions: [], serviceWorkers: 'block', ignoreHTTPSErrors: false });
    await session.context.addInitScript(() => {
      // Prevent script popups before they allocate another research tab. No user script is accepted here.
      Object.defineProperty(window, 'open', { value: () => null, writable: false, configurable: false });
    });
    await session.context.route('**/*', async route => {
      try { this.check(session); await session.policy.route(route, session.page); }
      catch (error) {
        session.failure ??= error instanceof Error ? error : new Error('BROWSER_BLOCKED');
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
    await session.context.routeWebSocket('**/*', socket => socket.close());
    session.page = await session.context.newPage();
    session.context.on('page', page => {
      if (page === session.page) return;
      const closing = page.close().catch(() => undefined);
      session.popupClosures.add(closing);
      void closing.finally(() => session.popupClosures.delete(closing));
    });
    session.page.on('request', request => {
      if (!request.isNavigationRequest() || request.frame() !== session.page!.mainFrame()) return;
      if (++session.pages > this.pageLimit()) {
        session.failure = new Error('BROWSER_PAGE_LIMIT'); session.controller.abort(); void this.dispose(session, 'BROWSER_PAGE_LIMIT');
      }
    });
    session.page.on('download', download => { void download.cancel(); });
    this.check(session);
  }
  private lookup(binding: BrowserResearchBinding, id: string): ResearchSession {
    const session = this.sessions.get(id);
    if (!session || !this.same(binding, session.binding)) throw new Error('BROWSER_SESSION_NOT_FOUND');
    return session;
  }
  async act(binding: BrowserResearchBinding, id: string, command: BrowserResearchCommand, signal?: AbortSignal): Promise<BrowserResearchSnapshot> {
    const session = this.lookup(binding, id);
    // Scope can become more sensitive after reading a source; never shrink an existing browser session.
    session.binding.dataClasses = [...new Set([...(session.binding.dataClasses ?? []), ...(binding.dataClasses ?? [])])];
    if (session.busy) throw new Error('BROWSER_BUSY');
    session.busy = true;
    const abort = (): void => { session.failure = new Error('BROWSER_CANCELLED'); session.controller.abort(); void this.dispose(session, 'cancelled'); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      await this.authorize(session);
      if (!session.page) throw new Error('BROWSER_UNAVAILABLE');
      await this.race(session, this.command(session, command));
      await this.authorize(session);
      return await this.race(session, this.snapshot(session, command.action === 'screenshot'));
    } catch (error) {
      const failure = session.failure ?? (session.proxy?.failure ? new Error(`BROWSER_${session.proxy.failure.code}`)
        : session.controller.signal.aborted ? new Error('BROWSER_CANCELLED')
          : error instanceof BrowserSourceError ? new Error(`BROWSER_${error.code}`)
          : error instanceof Error && /^(?:BROWSER_|SOURCE_)/u.test(error.message) ? error : new Error('BROWSER_NETWORK_ERROR'));
      await this.dispose(session, failure instanceof Error ? failure.message : 'failed');
      throw failure;
    } finally { signal?.removeEventListener('abort', abort); session.busy = false; }
  }
  private async command(session: ResearchSession, command: BrowserResearchCommand): Promise<void> {
    const page = session.page!;
    if (command.action === 'navigate' || command.action === 'next') {
      const url = command.action === 'navigate' ? command.url : session.links.find(item => item.index === command.index)?.url;
      if (!url) throw new Error('BROWSER_LINK_NOT_FOUND');
      await session.policy.url(url);
      if (command.action === 'navigate') await this.dependencies.authority.beforeNavigate?.(session.binding, url, session.dependencies);
      if (session.pages >= this.pageLimit()) throw new Error('BROWSER_PAGE_LIMIT');
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(20_000, this.timeout(session)) });
      this.check(session);
      if (response && [401, 402, 403].includes(response.status())) throw new Error('BROWSER_NEEDS_AUTH');
      if (response && response.status() >= 400) throw new Error('BROWSER_NETWORK_ERROR');
      await page.waitForFunction(() => Boolean(document.querySelector('input[type="password"]'))
        || (document.querySelector<HTMLElement>('main article, article, main, [role="main"]')?.innerText?.length ?? 0) >= 120,
        undefined, { timeout: Math.min(3000, this.timeout(session)) }).catch(() => undefined);
    } else if (command.action === 'expand') {
      if (!Number.isSafeInteger(command.index) || command.index < 0 || command.index > 29) throw new Error('BROWSER_EXPANSION_NOT_FOUND');
      const details = page.locator('main details, article details, [role="main"] details').nth(command.index);
      if (!await details.count()) throw new Error('BROWSER_EXPANSION_NOT_FOUND');
      // Fixed DOM property update expands native disclosure text without invoking arbitrary click handlers.
      await details.evaluate(element => { if (element instanceof HTMLDetailsElement) element.open = true; });
    } else if (!['read', 'screenshot'].includes(command.action)) throw new Error('BROWSER_ACTION_BLOCKED');
    this.check(session);
  }
  private async snapshot(session: ResearchSession, screenshot: boolean): Promise<BrowserResearchSnapshot> {
    const page = session.page!;
    await session.policy.url(page.url());
    const content = redactBrowserContent(await extractBrowserContent(page), await session.context!.storageState());
    const navigation = await page.evaluate(() => {
      const root = document.querySelector('main article, article, main, [role="main"]') ?? document.body;
      return {
        links: [...root.querySelectorAll('a[href]')].slice(0, 30).map((a, index) => ({ index, title: (a.textContent ?? '').trim().slice(0, 120), url: (a as HTMLAnchorElement).href })),
        expansions: [...document.querySelectorAll('main details, article details, [role="main"] details')].slice(0, 30)
          .map((a, index) => ({ index, title: (a.querySelector('summary')?.textContent ?? '').trim().slice(0, 120) })),
      };
    });
    session.links = [];
    for (const link of navigation.links) {
      try { await session.policy.url(link.url); session.links.push(link); } catch { /* Unsafe links are not tool targets. */ }
    }
    await this.authorize(session);
    let artifact: ResearchArtifactRef | undefined;
    if (screenshot) {
      if (!this.dependencies.artifacts) throw new Error('BROWSER_ARTIFACTS_UNAVAILABLE');
      const data = await page.screenshot({ type: 'png', fullPage: false, timeout: this.timeout(session),
        mask: [page.locator('input, textarea, select, [contenteditable="true"]')] });
      if (data.length > 4 * 1024 * 1024) throw new Error('BROWSER_SCREENSHOT_LIMIT');
      await this.authorize(session);
      const created = await this.dependencies.artifacts.create(session.binding.owner, {
        runId: session.binding.runId, type: 'file', mime: 'image/png', data,
        dependencies: session.dependencies, datasetVersionIds: [], dataClasses: ['public'], permittedUses: ['research'], retentionUntil: null,
      });
      try { await this.authorize(session); }
      catch (error) { await this.dependencies.artifacts.discard(session.binding.owner, created.id); throw error; }
      artifact = { artifactId: created.id, sha256: created.sha256 };
    }
    await Promise.all(session.popupClosures);
    this.check(session);
    return { sessionId: session.id, url: content.url, title: content.title, text: content.text.slice(0, 16_000),
      links: session.links, expansions: navigation.expansions, ...(artifact ? { artifact } : {}), observedAt: new Date().toISOString(), untrusted: true };
  }
  async close(binding: BrowserResearchBinding, id: string): Promise<void> { await this.dispose(this.lookup(binding, id), 'closed'); }
  private async dispose(session: ResearchSession, reason: string): Promise<void> {
    if (session.closing) return session.closing;
    if (session.timer) clearTimeout(session.timer);
    session.controller.abort();
    session.closing = (async () => {
      await session.setup?.catch(() => undefined);
      await Promise.allSettled([session.browser?.close(), session.proxy?.close()]);
      this.sessions.delete(session.id);
      this.closed.push({ sessionId: session.id, owner: session.binding.owner, runId: session.binding.runId,
        reason, pages: session.pages, closedAt: new Date().toISOString() });
      if (this.closed.length > 100) this.closed.shift();
    })();
    return session.closing;
  }
  receipts(owner: string): BrowserResearchReceipt[] { return this.closed.filter(item => item.owner === owner).map(item => ({ ...item })); }
  async shutdown(): Promise<void> { await Promise.allSettled([...this.sessions.values()].map(session => this.dispose(session, 'shutdown'))); }
}
