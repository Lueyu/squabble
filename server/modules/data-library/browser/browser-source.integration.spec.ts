import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Browser, type LaunchOptions, type Route } from 'playwright-core';
import { connect } from 'node:net';
import { BrowserSourceRuntime } from './browser-source.runtime';

const key = { ownerId: 'fictional-owner', sourceId: 'fictional-source' };
const content = 'Fictional browser research article. Dynamic company demand increased while inventory declined. '
  + 'This is fixture evidence for a controlled browser collector, with sufficient rendered text to distinguish an article from a login shell. ';

function fixture() {
  let browser: Browser | undefined;
  const visited: string[] = [];
  let privateHits = 0;
  let proxyPort: number | undefined;
  let restoredState: unknown;
  let rotation = 0;
  const runtime = new BrowserSourceRuntime({
    inspect: async () => ({ available: true, canOpenInteractive: true }),
    upstream: async () => undefined,
    resolve: async host => [{ address: host === 'private.site' ? '127.0.0.1' : '93.184.216.34', family: 4 }],
    launch: async (options: LaunchOptions) => {
      proxyPort = Number(new URL(options.proxy!.server).port);
      browser = await chromium.launch({ ...options, executablePath: chromium.executablePath(), channel: undefined, headless: true });
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async options => {
        restoredState = options?.storageState;
        const context = await newContext(options);
        await context.route('**/*', async (route: Route) => {
          const url = new URL(route.request().url());
          visited.push(url.pathname);
          if (url.hostname === 'other.site') {
            await route.fulfill({ contentType: 'text/html', body: `<title>Third-party website</title><main><article>${content} Third-party body must not be archived as the source.</article></main>` });
            return;
          }
          if (url.hostname === 'private.site') privateHits++;
          if (url.pathname === '/slow') { return; }
          if (url.pathname === '/redirect') {
            await route.fulfill({ status: 302, headers: { location: 'https://private.site/secret' } });
            return;
          }
          if (url.pathname === '/login') {
            await route.fulfill({ contentType: 'text/html', body: '<main><h1>Fake login</h1><input type="password" id="password"><button onclick="localStorage.setItem(\'fake-session\',\'fixture-only\');location.href=\'/article\'">Sign in</button></main>' });
            return;
          }
          if (url.pathname === '/token') {
            await route.fulfill({ contentType: 'text/html', body: `<title>new-fake-cookie-secret</title><main><article>${content} new-fake-cookie-secret new-fake-storage-token normal dark theme and en locale</article></main><script>document.cookie='fixture=new-fake-cookie-secret;Secure';document.cookie='theme=dark;Secure';document.cookie='locale=en;Secure';localStorage.setItem('fake-auth',JSON.stringify({nested:{access_token:'new-fake-storage-token'}}))</script>` });
            return;
          }
          if (url.pathname === '/rotating') {
            const expected = rotation === 0 ? 'rotation-cookie-v1' : `rotation-cookie-v${rotation + 1}`;
            if (!route.request().headers().cookie?.includes(`rotating-session=${expected}`)) {
              await route.fulfill({ status: 403, contentType: 'text/html', body: '<main><input type="password">Fake session expired</main>' });
              return;
            }
            rotation++;
            const next = rotation + 1;
            await route.fulfill({ contentType: 'text/html', headers: {
              'set-cookie': `rotating-session=rotation-cookie-v${next}; Path=/; HttpOnly; Secure; SameSite=Lax`,
            }, body: `<title>Fictional rotating session</title><main><article>${content} rotation-cookie-v${next} rotation-storage-v${next}</article></main><script>localStorage.setItem('access_token','rotation-storage-v${next}')</script>` });
            return;
          }
          if (url.pathname === '/private-resource') {
            await route.fulfill({ contentType: 'text/html', body: `<main><article>${content}</article></main><script src="https://private.site/internal.js"></script>` });
            return;
          }
          if (url.pathname === '/readonly') {
            await route.fulfill({ contentType: 'text/html', body: `<main><article>${content}</article></main><script>fetch('/mutate',{method:'POST',body:'fictional-action'}).catch(()=>{});new WebSocket('wss://public.site/socket');window.open('/popup')</script>` });
            return;
          }
          if (url.pathname === '/cross-origin') {
            await route.fulfill({ contentType: 'text/html', body: `<script>location.href='https://other.site/third-party'</script><main><article>${content}</article></main>` });
            return;
          }
          if (url.pathname === '/path-redirect') {
            await route.fulfill({ contentType: 'text/html', body: `<script>location.href='/article'</script><main><article>${content}</article></main>` });
            return;
          }
          if (url.pathname === '/iframe') {
            await route.fulfill({ contentType: 'text/html', body: `<main><article>${content}</article></main><iframe src="https://other.site/embedded"></iframe>` });
            return;
          }
          const body = url.pathname === '/protected'
            ? `<script>if(localStorage.getItem('fake-session')!=='fixture-only') location.href='/login';</script>`
              + `<main><article>${content}</article></main>`
            : `<nav>Account fixture secret</nav><main><article id="article"></article><a href="/page2">Next page</a></main>`
              + `<script>setTimeout(()=>document.querySelector('#article').textContent=${JSON.stringify(content)},100)</script>`;
          await route.fulfill({ contentType: 'text/html', body: `<html><title>Fictional source</title>${body}</html>` });
        });
        return context;
      };
      return browser;
    },
  });
  return { runtime, visited, browser: () => browser, privateHits: () => privateHits, proxyPort: () => proxyPort, restoredState: () => restoredState };
}

async function assertClosed(port: number): Promise<void> {
  await assert.rejects(new Promise<void>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); resolve(); });
    socket.on('error', reject);
  }), { code: 'ECONNREFUSED' });
}

async function waitForFixturePage(browser: () => Browser | undefined, reading: Promise<unknown>): Promise<void> {
  const deadline = Date.now() + 10_000;
  let waiting = true;
  try {
    await Promise.race([
      (async () => {
        while (waiting && !browser()?.contexts()[0]?.pages()[0]) {
          if (Date.now() >= deadline) throw new Error('Browser fixture page was not ready within 10 seconds');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      })(),
      reading.then(() => { throw new Error('Read finished before browser fixture page became ready'); }),
    ]);
  } finally { waiting = false; }
}

test('real Chromium renders dynamic text and does not follow pagination or retain account navigation', async () => {
  const f = fixture();
  try {
    const result = await f.runtime.read({ key, url: 'https://public.site/article' });
    assert.match(result.text, /Dynamic company demand/u);
    assert.doesNotMatch(result.text, /Account fixture/u);
    assert.equal(result.provenance, 'browser-rendered');
    assert.ok(!f.visited.includes('/page2'));
    assert.equal(f.browser()?.isConnected(), false);
    await assertClosed(f.proxyPort()!);
  } finally { await f.runtime.shutdown(); }
});

test('fake interactive login exports internal state and a fresh read reuses it; expired state needs auth', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.runtime.read({ key, url: 'https://public.site/protected' }), { code: 'NEEDS_AUTH' });
    await f.runtime.open(key, 'https://public.site/login');
    const page = f.browser()!.contexts()[0].pages()[0];
    await page.locator('#password').fill('fictional-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/article');
    const state = await f.runtime.confirm(key);
    assert.equal(f.runtime.loginWindowOpen(key), false);
    const result = await f.runtime.read({ key, url: 'https://public.site/protected', storageState: state.storageState });
    assert.match(result.text, /Fictional browser/u);
    assert.doesNotMatch(result.text, /fixture-only/u);
    await assert.rejects(f.runtime.read({ key, url: 'https://public.site/protected', storageState: '{"cookies":[],"origins":[]}' }), { code: 'NEEDS_AUTH' });
  } finally { await f.runtime.shutdown(); }
});

test('production browser routing rejects a redirect to private DNS before fixture transport sees it', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.runtime.read({ key, url: 'https://public.site/redirect' }), { code: 'BLOCKED' });
    assert.equal(f.privateHits(), 0);
  } finally { await f.runtime.shutdown(); }
});

test('private subresources are blocked before transport; collection cannot submit POSTs or open sockets', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.runtime.read({ key, url: 'https://public.site/private-resource' }), { code: 'BLOCKED' });
    assert.equal(f.privateHits(), 0);
    await f.runtime.read({ key, url: 'https://public.site/readonly' });
    assert.ok(!f.visited.includes('/mutate'));
    assert.ok(!f.visited.includes('/socket'));
    assert.ok(!f.visited.includes('/popup'));
  } finally { await f.runtime.shutdown(); }
});

test('new cookies and nested local-storage tokens are redacted from captured title, body and HTML', async () => {
  const f = fixture();
  try {
    const result = await f.runtime.read({ key, url: 'https://public.site/token' });
    assert.doesNotMatch(JSON.stringify({ ...result, html: result.html.toString() }), /new-fake-cookie-secret|new-fake-storage-token/u);
    assert.match(result.text, /\[redacted\]/u);
    assert.match(result.text, /normal dark theme and en locale/u);
  } finally { await f.runtime.shutdown(); }
});

test('confirmation saves only source-applicable cookies and exact source-origin local storage', async () => {
  const f = fixture();
  try {
    await f.runtime.open(key, 'https://public.site/article');
    const context = f.browser()!.contexts()[0];
    await context.addCookies([
      { name: 'source-session', value: 'source-fixture-session', domain: '.public.site', path: '/', secure: true },
      { name: 'third-party-session', value: 'third-party-fixture-session', domain: '.other.site', path: '/', secure: true },
      { name: 'sibling-session', value: 'sibling-fixture-session', domain: 'sibling.public.site', path: '/', secure: true },
    ]);
    const page = context.pages()[0];
    await page.evaluate(() => localStorage.setItem('source-auth', 'source-fixture-token'));
    await page.goto('https://other.site/third-party');
    await page.evaluate(() => localStorage.setItem('third-party-auth', 'third-party-fixture-token'));
    await page.goto('https://public.site/article');
    const saved = JSON.parse((await f.runtime.confirm(key)).storageState);
    assert.deepEqual(saved.cookies.map((cookie: { name: string }) => cookie.name), ['source-session']);
    assert.deepEqual(saved.origins.map((origin: { origin: string }) => origin.origin), ['https://public.site']);
    assert.doesNotMatch(JSON.stringify(saved), /third-party|sibling/u);
  } finally { await f.runtime.shutdown(); }
});

test('cross-origin final pages are rejected on read and confirm; iframe text never replaces the configured main page', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.runtime.read({ key, url: 'https://public.site/cross-origin' }), { code: 'BLOCKED' });
    await f.runtime.open(key, 'https://public.site/article');
    await f.browser()!.contexts()[0].pages()[0].goto('https://other.site/third-party');
    await assert.rejects(f.runtime.confirm(key), { code: 'BLOCKED' });
    const result = await f.runtime.read({ key, url: 'https://public.site/iframe' });
    assert.equal(result.url, 'https://public.site/iframe');
    assert.doesNotMatch(result.text, /Third-party/u);
    const redirected = await f.runtime.read({ key, url: 'https://public.site/path-redirect' });
    assert.equal(redirected.url, 'https://public.site/article');
    assert.match(redirected.text, /Dynamic company/u);
  } finally { await f.runtime.shutdown(); }
});

test('restoring old mixed state filters third-party sessions before creating the read context', async () => {
  const f = fixture();
  const cookie = (name: string, domain: string) => ({ name, value: `${name}-fixture-token`, domain, path: '/',
    secure: true, httpOnly: true, expires: -1, sameSite: 'Lax' });
  try {
    await f.runtime.read({ key, url: 'https://public.site/article', storageState: JSON.stringify({
      cookies: [cookie('source-session', '.public.site'), cookie('third-party-session', '.other.site')],
      origins: [
        { origin: 'https://public.site', localStorage: [{ name: 'source-auth', value: 'source-fixture-token' }] },
        { origin: 'https://other.site', localStorage: [{ name: 'third-party-auth', value: 'third-party-fixture-token' }] },
      ],
    }) });
    const restored = f.restoredState() as { cookies: Array<{ name: string }>; origins: Array<{ origin: string }> };
    assert.deepEqual(restored.cookies.map(cookie => cookie.name), ['source-session']);
    assert.deepEqual(restored.origins.map(origin => origin.origin), ['https://public.site']);
  } finally { await f.runtime.shutdown(); }
});

test('normal GET cookie rotation returns internal refreshed source state for the next read', async () => {
  const f = fixture();
  const state = JSON.stringify({ cookies: [{ name: 'rotating-session', value: 'rotation-cookie-v1', domain: 'public.site',
    path: '/', secure: true, httpOnly: true, expires: -1, sameSite: 'Lax' }],
  origins: [{ origin: 'https://public.site', localStorage: [{ name: 'access_token', value: 'rotation-storage-v1' }] }] });
  try {
    const first = await f.runtime.read({ key, url: 'https://public.site/rotating', storageState: state });
    await assert.rejects(f.runtime.read({ key, url: 'https://public.site/rotating', storageState: state }), { code: 'NEEDS_AUTH' });
    assert.equal(typeof first.refreshedStorageState, 'string');
    const updated = JSON.parse(first.refreshedStorageState!);
    assert.equal(updated.cookies.find((cookie: { name: string }) => cookie.name === 'rotating-session').value, 'rotation-cookie-v2');
    assert.equal(updated.origins[0].localStorage.find((entry: { name: string }) => entry.name === 'access_token').value, 'rotation-storage-v2');
    assert.doesNotMatch(`${first.text}${first.title}${first.html}`, /rotation-cookie-v2|rotation-storage-v2/u);
    const second = await f.runtime.read({ key, url: 'https://public.site/rotating', storageState: first.refreshedStorageState });
    assert.match(second.text, /Dynamic company/u);
    assert.match(second.refreshedStorageState!, /rotation-cookie-v3/u);
    const anonymous = await f.runtime.read({ key, url: 'https://public.site/token' });
    assert.equal(anonymous.refreshedStorageState, undefined);
  } finally { await f.runtime.shutdown(); }
});

test('owner concurrency and cancellation close the browser, release locks and stop pending navigation', async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    const reading = f.runtime.read({ key, url: 'https://public.site/slow', signal: controller.signal });
    await waitForFixturePage(f.browser, reading);
    await assert.rejects(f.runtime.read({ key: { ...key, sourceId: 'other' }, url: 'https://public.site/article' }), { code: 'BUSY' });
    controller.abort();
    await assert.rejects(reading, { code: 'CANCELLED' });
    assert.equal(f.browser()?.isConnected(), false);
    await assertClosed(f.proxyPort()!);
    assert.match((await f.runtime.read({ key, url: 'https://public.site/article' })).text, /Dynamic company/u);
  } finally { await f.runtime.shutdown(); }
});

test('a failed browser launch rejects fixture readiness and still closes the proxy', { timeout: 5000 }, async () => {
  let proxyPort = 0;
  const runtime = new BrowserSourceRuntime({
    inspect: async () => ({ available: true, canOpenInteractive: true }),
    upstream: async () => undefined,
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    launch: async options => {
      proxyPort = Number(new URL(options.proxy!.server).port);
      throw new Error('fictional browser launch failure');
    },
  });
  try {
    const reading = runtime.read({ key, url: 'https://public.site/slow' });
    await assert.rejects(waitForFixturePage(() => undefined, reading), { code: 'NETWORK_ERROR' });
  } finally { await runtime.shutdown(); }
  await assertClosed(proxyPort);
});

test('interactive launch failures retain their original safe code after cleanup', async () => {
  let proxyPort = 0;
  const runtime = new BrowserSourceRuntime({
    inspect: async () => ({ available: true, canOpenInteractive: true }),
    upstream: async () => undefined,
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    launch: async options => {
      proxyPort = Number(new URL(options.proxy!.server).port);
      throw new Error('fictional interactive launch failure');
    },
  });
  try {
    await assert.rejects(runtime.open(key, 'https://public.site/article'), { code: 'NETWORK_ERROR' });
    assert.equal(runtime.loginWindowOpen(key), false);
    await assertClosed(proxyPort);
  } finally { await runtime.shutdown(); }
  const unavailable = new BrowserSourceRuntime({
    inspect: async () => ({ available: false, canOpenInteractive: false }),
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  try { await assert.rejects(unavailable.open(key, 'https://public.site/article'), { code: 'UNAVAILABLE' }); }
  finally { await unavailable.shutdown(); }
});

test('cancellation during browser startup closes the newly created process and proxy before releasing its lock', async () => {
  let browser: Browser | undefined;
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  let proxyPort = 0;
  const launching = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = new BrowserSourceRuntime({
    inspect: async () => ({ available: true, canOpenInteractive: true }),
    upstream: async () => undefined,
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    launch: async options => {
      proxyPort = Number(new URL(options.proxy!.server).port);
      started!();
      await gate;
      browser = await chromium.launch({ ...options, executablePath: chromium.executablePath(), headless: true });
      return browser;
    },
  });
  const controller = new AbortController();
  const reading = runtime.read({ key, url: 'https://public.site/article', signal: controller.signal });
  await launching;
  controller.abort();
  await assert.rejects(runtime.read({ key, url: 'https://public.site/article' }), { code: 'BUSY' });
  release!();
  await assert.rejects(reading, { code: 'CANCELLED' });
  assert.equal(browser?.isConnected(), false);
  await assertClosed(proxyPort);
  await runtime.shutdown();
});
