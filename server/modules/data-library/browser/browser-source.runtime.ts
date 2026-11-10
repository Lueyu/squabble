import { createHash } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright-core';
import { publicSourceUrl, type ResolvePublic } from '../data-library.fetch';
import { BrowserEgressProxy, type PublicTunnelConnector } from './browser-egress';
import { browserExecutable, configuredBrowserUpstream, inspectBrowserEnvironment } from './browser-environment';
import { extractBrowserContent, redactBrowserContent } from './browser-content';
import { assertSourceBrowserOrigin, restoreSourceBrowserStorageState, sourceBrowserStorageState } from './browser-session';
import {
  BrowserSourceError, type BrowserAvailability, type BrowserSourceKey,
  type BrowserSourceReadRequest, type BrowserSourceReadResult, type BrowserSourceRuntimePort,
} from './browser-source.types';

export interface BrowserRuntimeDependencies {
  resolve?: ResolvePublic;
  connect?: PublicTunnelConnector;
  launch?: (options: LaunchOptions) => Promise<Browser>;
  inspect?: () => Promise<BrowserAvailability>;
  upstream?: () => Promise<URL | undefined>;
}

interface BrowserOperation {
  id: string;
  ownerId: string;
  mode: 'login' | 'read';
  controller: AbortController;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  proxy?: BrowserEgressProxy;
  failure?: BrowserSourceError;
  closing?: Promise<void>;
  pendingSetup?: Promise<Page>;
  source?: URL;
}

const keyId = (key: BrowserSourceKey): string => createHash('sha256')
  .update(JSON.stringify([key.ownerId, key.sourceId])).digest('hex');

/** Dedicated ephemeral browsers only. No user profile, global browser connection, or Agent browser control. */
export class BrowserSourceRuntime implements BrowserSourceRuntimePort {
  private readonly operations = new Map<string, BrowserOperation>();

  constructor(private readonly dependencies: BrowserRuntimeDependencies = {}) {}

  availability(): Promise<BrowserAvailability> {
    return (this.dependencies.inspect ?? inspectBrowserEnvironment)();
  }

  loginWindowOpen(key: BrowserSourceKey): boolean {
    const operation = this.operations.get(keyId(key));
    return Boolean(operation?.mode === 'login' && operation.page && !operation.page.isClosed()
      && !operation.controller.signal.aborted && operation.expiresAt > Date.now());
  }

  private reserve(key: BrowserSourceKey, mode: BrowserOperation['mode']): BrowserOperation {
    if (!key.ownerId || !key.sourceId) throw new BrowserSourceError('BLOCKED');
    if ([...this.operations.values()].some(operation => operation.ownerId === key.ownerId)) {
      throw new BrowserSourceError('BUSY');
    }
    const operation: BrowserOperation = {
      id: keyId(key), ownerId: key.ownerId, mode, controller: new AbortController(),
      expiresAt: Date.now() + (mode === 'login' ? 10 * 60_000 : 54_000),
    };
    this.operations.set(keyId(key), operation);
    operation.timer = setTimeout(() => {
      operation.failure = new BrowserSourceError('TIMEOUT');
      operation.controller.abort();
      void this.closeOperation(operation);
    }, operation.expiresAt - Date.now());
    operation.timer.unref();
    return operation;
  }

  private check(operation: BrowserOperation): void {
    if (operation.failure || operation.proxy?.failure) throw operation.failure ?? operation.proxy!.failure;
    if (operation.controller.signal.aborted) throw new BrowserSourceError('CANCELLED');
  }

  private remaining(operation: BrowserOperation, maximum: number): number {
    this.check(operation);
    const remaining = Math.min(maximum, operation.expiresAt - Date.now());
    if (remaining <= 0) throw new BrowserSourceError('TIMEOUT');
    return remaining;
  }

  private async cancellable<T>(operation: BrowserOperation, promise: Promise<T>): Promise<T> {
    this.check(operation);
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        abort = () => reject(operation.failure ?? new BrowserSourceError('CANCELLED'));
        operation.controller.signal.addEventListener('abort', abort, { once: true });
      })]);
    } finally { if (abort) operation.controller.signal.removeEventListener('abort', abort); }
  }

  private async prepare(operation: BrowserOperation, url: string, storageState?: string): Promise<Page> {
    const validated = await this.cancellable(operation, publicSourceUrl(url, this.dependencies.resolve));
    operation.source = validated.url;
    const status = await this.cancellable(operation, this.availability());
    if (!status.available || operation.mode === 'login' && !status.canOpenInteractive) {
      throw new BrowserSourceError('UNAVAILABLE');
    }
    const upstream = await this.cancellable(operation, (this.dependencies.upstream ?? configuredBrowserUpstream)());
    operation.proxy = await BrowserEgressProxy.create({ resolve: this.dependencies.resolve, connect: this.dependencies.connect, upstream });
    this.check(operation);
    const launch = this.dependencies.launch ?? (options => chromium.launch(options));
    operation.browser = await launch({
      executablePath: this.dependencies.launch ? undefined : await browserExecutable(),
      headless: operation.mode === 'read', chromiumSandbox: true, timeout: this.remaining(operation, 15_000),
      proxy: { server: `http://127.0.0.1:${operation.proxy.port}`, username: operation.proxy.username, password: operation.proxy.password },
      args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--disable-background-networking',
        '--disable-component-update', '--disable-sync', '--disable-extensions', '--no-first-run',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
    this.check(operation);
    operation.context = await operation.browser.newContext({
      acceptDownloads: false, serviceWorkers: 'block', ignoreHTTPSErrors: false,
      storageState: restoreSourceBrowserStorageState(storageState, operation.source),
      permissions: [],
    });
    let requests = 0;
    await operation.context.route('**/*', async route => {
      try {
        this.check(operation);
        requests++;
        if (requests > 160) throw new BrowserSourceError('BLOCKED');
        const request = route.request();
        let requestPage: Page;
        try { requestPage = request.frame().page(); }
        catch { await route.abort('blockedbyclient'); return; }
        if (operation.page && requestPage !== operation.page) {
          await route.abort('blockedbyclient'); return;
        }
        await this.cancellable(operation, publicSourceUrl(request.url(), this.dependencies.resolve));
        if (operation.mode === 'read' && !['GET', 'HEAD'].includes(request.method())) {
          await route.abort('blockedbyclient'); return;
        }
        if (['image', 'media', 'font'].includes(request.resourceType())) {
          await route.abort('blockedbyclient'); return;
        }
        await route.fallback();
      } catch {
        if (!operation.controller.signal.aborted) operation.failure ??= new BrowserSourceError('BLOCKED');
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
    await operation.context.routeWebSocket('**/*', socket => socket.close());
    operation.page = await operation.context.newPage();
    operation.context.on('page', popup => { if (popup !== operation.page) void popup.close(); });
    operation.page.on('download', download => { void download.cancel(); });
    operation.page.once('close', () => {
      if (operation.mode === 'login') void this.closeOperation(operation);
    });
    this.check(operation);
    return operation.page;
  }

  private async waitForContent(operation: BrowserOperation, page: Page): Promise<void> {
    await page.waitForFunction(() => Boolean(document.querySelector('input[type="password"]'))
      || (document.querySelector<HTMLElement>('main article, article, main, [role="main"]') ?? document.body)?.innerText?.trim().length >= 120,
    undefined, { timeout: this.remaining(operation, 8_000) }).catch(() => undefined);
    await this.cancellable(operation, new Promise(resolve => setTimeout(resolve, Math.min(400, this.remaining(operation, 400)))));
    this.check(operation);
  }

  async open(key: BrowserSourceKey, url: string, storageState?: string): Promise<{ expiresAt: string }> {
    const operation = this.reserve(key, 'login');
    try {
      operation.pendingSetup = this.prepare(operation, url, storageState);
      const page = await operation.pendingSetup;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.remaining(operation, 40_000) });
      this.check(operation);
      return { expiresAt: new Date(operation.expiresAt).toISOString() };
    } catch (error) {
      const mapped = this.error(operation, error);
      await this.closeOperation(operation);
      throw mapped;
    }
  }

  async confirm(key: BrowserSourceKey): Promise<{ storageState: string; url: string; title: string }> {
    const operation = this.operations.get(keyId(key));
    if (!operation || !this.loginWindowOpen(key) || !operation.page || !operation.context) {
      await this.close(key);
      throw new BrowserSourceError('NEEDS_AUTH');
    }
    try {
      this.check(operation);
      await publicSourceUrl(operation.page.url(), this.dependencies.resolve);
      assertSourceBrowserOrigin(operation.page.url(), operation.source!);
      await this.waitForContent(operation, operation.page);
      const content = await extractBrowserContent(operation.page);
      const state = await operation.context.storageState();
      this.check(operation);
      assertSourceBrowserOrigin(content.url, operation.source!);
      assertSourceBrowserOrigin(operation.page.url(), operation.source!);
      const storageState = JSON.stringify(sourceBrowserStorageState(state, operation.source!));
      if (storageState.length > 2 * 1024 * 1024) throw new BrowserSourceError('RESPONSE_TOO_LARGE');
      return { storageState, url: content.url, title: content.title };
    } catch (error) { throw this.error(operation, error); }
    finally { await this.closeOperation(operation); }
  }

  async read(request: BrowserSourceReadRequest): Promise<BrowserSourceReadResult> {
    if (request.signal?.aborted) throw new BrowserSourceError('CANCELLED');
    const operation = this.reserve(request.key, 'read');
    const abort = (): void => { operation.controller.abort(); void this.dispose(operation); };
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      operation.pendingSetup = this.prepare(operation, request.url, request.storageState);
      const page = await operation.pendingSetup;
      const response = await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: this.remaining(operation, 40_000) });
      this.check(operation);
      if (response && [401, 403, 402].includes(response.status())) throw new BrowserSourceError('NEEDS_AUTH');
      if (response && (response.status() < 200 || response.status() >= 400)) throw new BrowserSourceError('NETWORK_ERROR');
      // Dynamic pages often render after DOMContentLoaded. Bounded polling never clicks or submits anything.
      await this.waitForContent(operation, page);
      await this.cancellable(operation, publicSourceUrl(page.url(), this.dependencies.resolve));
      assertSourceBrowserOrigin(page.url(), operation.source!);
      const content = await this.cancellable(operation, extractBrowserContent(page));
      const state = await this.cancellable(operation, operation.context!.storageState());
      this.check(operation);
      assertSourceBrowserOrigin(content.url, operation.source!);
      assertSourceBrowserOrigin(page.url(), operation.source!);
      const snapshot = redactBrowserContent(content, state);
      // A normal GET may rotate a login session. Only an existing explicit session can be refreshed durably.
      const refreshedStorageState = request.storageState
        ? JSON.stringify(sourceBrowserStorageState(state, operation.source!)) : undefined;
      if (refreshedStorageState && refreshedStorageState.length > 2 * 1024 * 1024) {
        throw new BrowserSourceError('RESPONSE_TOO_LARGE');
      }
      this.check(operation);
      return { ...snapshot, observedAt: new Date().toISOString(), mimeType: 'text/html', provenance: 'browser-rendered',
        ...(refreshedStorageState ? { refreshedStorageState } : {}) };
    } catch (error) { throw this.error(operation, error); }
    finally { request.signal?.removeEventListener('abort', abort); await this.closeOperation(operation); }
  }

  private error(operation: BrowserOperation, error: unknown): BrowserSourceError {
    if (operation.failure || operation.proxy?.failure) return operation.failure ?? operation.proxy!.failure;
    if (operation.controller.signal.aborted) return new BrowserSourceError('CANCELLED');
    if (error instanceof BrowserSourceError) return error;
    if (error instanceof Error && error.name === 'TimeoutError') return new BrowserSourceError('TIMEOUT');
    return new BrowserSourceError('NETWORK_ERROR');
  }

  private dispose(operation: BrowserOperation): Promise<void> {
    if (operation.timer) clearTimeout(operation.timer);
    // Resources can finish being created after cancellation; each disposal rechecks the current handles.
    operation.closing = Promise.allSettled([
      operation.browser?.close(), operation.proxy?.close(),
    ]).then(() => undefined);
    return operation.closing;
  }

  async close(key: BrowserSourceKey): Promise<void> {
    const operation = this.operations.get(keyId(key));
    if (!operation) return;
    await this.closeOperation(operation);
  }

  private async closeOperation(operation: BrowserOperation): Promise<void> {
    operation.controller.abort();
    await operation.pendingSetup?.catch(() => undefined);
    await this.dispose(operation);
    if (this.operations.get(operation.id) === operation) this.operations.delete(operation.id);
  }

  async shutdown(): Promise<void> {
    const operations = [...this.operations.values()];
    for (const operation of operations) operation.controller.abort();
    await Promise.allSettled(operations.map(operation => this.closeOperation(operation)));
    this.operations.clear();
  }
}
