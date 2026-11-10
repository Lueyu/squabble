import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { DataLibraryService } from './data-library.service';
import { dataLibrarySources, dataLibraryJobs, dataLibraryVersions } from '../../database/data-library.schema';
import { DataBrowserService } from './data-browser.service';
import { encodeDataSecret, decodeDataSecret } from './data-library.secrets';
import { BrowserSourceError, type BrowserSourceKey, type BrowserSourceReadRequest, type BrowserSourceReadResult,
  type BrowserSourceRuntimePort } from './browser/browser-source.types';

const session = JSON.stringify({ cookies: [{ name: 'session', value: 'test-cookie-only', domain: 'content-provider.org', path: '/' },
  { name: 'theme', value: 'e', domain: 'content-provider.org', path: '/' }],
  origins: [{ origin: 'https://content-provider.org', localStorage: [{ name: 'token', value: 'test-local-storage-only' }] }] });
class FakeRuntime implements BrowserSourceRuntimePort {
  windows = new Set<string>();
  reads: BrowserSourceReadRequest[] = [];
  closes: BrowserSourceKey[] = [];
  confirmState = session;
  readHandler?: (request: BrowserSourceReadRequest) => Promise<BrowserSourceReadResult>;
  confirmHandler?: () => Promise<void>;
  key(key: BrowserSourceKey) { return `${key.ownerId}:${key.sourceId}`; }
  async availability() { return { available: true, canOpenInteractive: true }; }
  loginWindowOpen(key: BrowserSourceKey) { return this.windows.has(this.key(key)); }
  async open(key: BrowserSourceKey) { this.windows.add(this.key(key)); return { expiresAt: new Date(Date.now() + 1000).toISOString() }; }
  async confirm(key: BrowserSourceKey) {
    if (!this.loginWindowOpen(key)) throw new BrowserSourceError('NEEDS_AUTH');
    await this.confirmHandler?.(); return { storageState: this.confirmState };
  }
  async read(request: BrowserSourceReadRequest): Promise<BrowserSourceReadResult> {
    this.reads.push(request);
    return this.readHandler ? this.readHandler(request) : this.snapshot(request.url);
  }
  snapshot(url: string, text = 'Rendered research test-cookie-only test-local-storage-only'): BrowserSourceReadResult {
    return { url, title: 'Rendered research', text, html: Buffer.from('<script>secret token</script>'),
      observedAt: '2026-11-10T02:00:00.000Z', mimeType: 'text/html', provenance: 'browser-rendered' };
  }
  async close(key: BrowserSourceKey) { this.windows.delete(this.key(key)); this.closes.push(key); }
  async shutdown() { this.windows.clear(); }
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function fixture(run: (context: { db: ReturnType<typeof drizzle>; runtime: FakeRuntime; browser: DataBrowserService;
  service: DataLibraryService; owner: string; other: string; namespace: string;
  client: ReturnType<typeof postgres>; admin: ReturnType<typeof postgres> }) => Promise<void>) {
  const namespace = `browser_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
  const client = postgres(databaseUrl!, { max: 5, onnotice: () => {}, connection: { search_path: namespace, application_name: namespace } });
  const priorKey = process.env.SETTINGS_ENCRYPTION_KEY, priorMode = process.env.AUTH_MODE, priorHost = process.env.SERVER_HOST;
  process.env.SETTINGS_ENCRYPTION_KEY = 'test-only-browser-encryption-key-123456'; process.env.AUTH_MODE = 'local'; process.env.SERVER_HOST = '127.0.0.1';
  const db = drizzle(client), runtime = new FakeRuntime(), browser = new DataBrowserService(db, runtime);
  const service = new DataLibraryService(db, undefined, browser);
  try {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    for (const file of ['50_data_library.sql', '51_browser_sources.sql']) await client.unsafe(readFileSync('scripts/db/' + file, 'utf8'));
    await run({ db, runtime, browser, service, owner: randomUUID(), other: randomUUID(), namespace, client, admin });
  } finally {
    service.onModuleDestroy(); await browser.onModuleDestroy(); await client.end();
    await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end();
    for (const [key, value] of [['SETTINGS_ENCRYPTION_KEY', priorKey], ['AUTH_MODE', priorMode], ['SERVER_HOST', priorHost]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
}
const addBrowser = (db: ReturnType<typeof drizzle>, owner: string) => db.insert(dataLibrarySources).values({ owner, kind: 'website',
  title: 'Saved browser page', format: 'html', url: 'https://content-provider.org/research', captureMode: 'browser', syncIntervalMinutes: 60 }).returning();

const databaseUrl = process.env.DATA_LIBRARY_TEST_DATABASE_URL ?? process.env.RESEARCH_TEST_DATABASE_URL;
test('browser schema preserves HTTP defaults and public source responses expose only session presence', { skip: !databaseUrl }, async () => {
  const namespace = `data_browser_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
  const client = postgres(databaseUrl!, { max: 3, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    await client.unsafe(readFileSync('scripts/db/50_data_library.sql', 'utf8'));
    await client.unsafe("INSERT INTO financial_data_connections(owner,provider,secret_enc) VALUES ('upgrade-owner','finnhub','test-only-preserved-key')");
    await client.unsafe("INSERT INTO data_library_sources(owner,kind,title,format,url,secret_enc,auth_kind) VALUES ('upgrade-owner','website','Existing HTTP','html','https://content-provider.org/research','test-only-preserved-http-secret','basic')");
    await client.unsafe(readFileSync('scripts/db/51_browser_sources.sql', 'utf8'));
    assert.equal((await client.unsafe("SELECT secret_enc FROM financial_data_connections WHERE owner='upgrade-owner'"))[0].secret_enc, 'test-only-preserved-key');
    const [upgraded] = await client.unsafe("SELECT secret_enc,capture_mode,browser_state_enc FROM data_library_sources WHERE owner='upgrade-owner'");
    assert.equal(upgraded.secret_enc, 'test-only-preserved-http-secret'); assert.equal(upgraded.capture_mode, 'http'); assert.equal(upgraded.browser_state_enc, null);
    const db = drizzle(client), owner = randomUUID();
    const [row] = await db.insert(dataLibrarySources).values({ owner, kind: 'website', title: 'Browser research',
      format: 'html', url: 'https://content-provider.org/research' }).returning();
    const service = new DataLibraryService(db);
    const result = await service.detail(owner, row.id);
    assert.equal(result.source.captureMode, 'http');
    assert.equal(result.source.hasBrowserSession, false);
    await db.update(dataLibrarySources).set({ browserStateEnc: 'test-encrypted-session' }).where(eq(dataLibrarySources.id, row.id));
    const withSession = await service.detail(owner, row.id);
    assert.equal(withSession.source.hasBrowserSession, true);
    assert.ok(!JSON.stringify(withSession).includes('test-encrypted-session'));
    await assert.rejects(service.detail(randomUUID(), row.id), /DATA_SOURCE_NOT_FOUND/u);
  } finally {
    await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end();
  }
});

test('browser login is owner/source scoped, encrypted, manually confirmed and never reuses HTTP Basic credentials', { skip: !databaseUrl }, async () => fixture(async ({ db, runtime, browser, service, owner, other }) => {
  const [source] = await addBrowser(db, owner), [second] = await addBrowser(db, owner);
  await db.update(dataLibrarySources).set({ authKind: 'basic', secretEnc: encodeDataSecret('old-user:old-password') }).where(eq(dataLibrarySources.id, source.id));
  assert.equal((await browser.status(owner, source.id)).state, 'not-connected'); assert.equal(runtime.reads.length, 0);
  await assert.rejects(browser.open(other, source.id), /DATA_SOURCE_NOT_FOUND/u);
  process.env.AUTH_MODE = 'account'; await assert.rejects(browser.open(owner, source.id), /BROWSER_LOGIN_LOCAL_ONLY/u); process.env.AUTH_MODE = 'local';
  await browser.open(owner, source.id); assert.equal((await browser.status(owner, source.id)).state, 'login-open');
  await assert.rejects(browser.confirm(owner, second.id), /NEEDS_AUTH/u);
  const connected = await browser.confirm(owner, source.id); assert.equal(connected.state, 'connected'); assert.equal(connected.loginWindowOpen, false);
  const [stored] = await db.select().from(dataLibrarySources).where(eq(dataLibrarySources.id, source.id));
  assert.notEqual(stored.browserStateEnc, session); assert.equal(decodeDataSecret(stored.browserStateEnc), session);
  assert.equal((await browser.status(owner, second.id)).state, 'not-connected');
  const first = await service.sync(owner, source.id), secondSync = await service.sync(owner, source.id);
  assert.equal(first.job.outcome, 'updated'); assert.equal(secondSync.job.outcome, 'unchanged'); assert.equal(first.job.versionId, secondSync.job.versionId);
  assert.equal(runtime.reads[0].storageState, session); assert.ok(!JSON.stringify(runtime.reads).includes('old-password'));
  const version = await service.version(owner, source.id, first.job.versionId!);
  assert.equal(version.acquisition, 'browser-rendered'); assert.equal(version.finalUrl, source.url); assert.equal(version.pageTitle, 'Rendered research');
  assert.equal(version.observedAt, '2026-11-10T02:00:00.000Z'); assert.match(version.rawContent, /\[redacted\]/u);
  assert.match(version.extractedText, /Rendered research/u, 'one-character preference cookies must not corrupt readable content');
  for (const result of [connected, first, await service.detail(owner, source.id), version, await service.search(owner, { query: 'Rendered' })]) {
    assert.ok(!JSON.stringify(result).includes('test-cookie-only')); assert.ok(!JSON.stringify(result).includes('test-local-storage-only'));
    assert.ok(!JSON.stringify(result).includes('browserStateEnc')); assert.ok(!JSON.stringify(result).includes('secretEnc'));
  }
  runtime.readHandler = async () => { throw new BrowserSourceError('NEEDS_AUTH'); };
  const expired = await service.sync(owner, source.id); assert.equal(expired.source.state, 'needs-auth'); assert.equal(expired.source.nextSyncAt, null);
  assert.equal(expired.job.errorCode, 'NEEDS_AUTH'); assert.equal((await browser.status(owner, source.id)).state, 'needs-login');
  runtime.readHandler = undefined;
  await service.sync(owner, second.id); assert.equal(runtime.reads.at(-1)?.storageState, undefined);
  await browser.open(owner, second.id); await browser.confirm(owner, second.id); await browser.clear(owner, source.id);
  assert.equal((await browser.status(owner, second.id)).state, 'connected');
  assert.equal((await service.detail(owner, source.id)).source.hasBrowserSession, false);
}));

test('disconnect, disable, capture mode change and delete reject late browser captures and close only that source', { skip: !databaseUrl }, async () => fixture(async ({ db, runtime, browser, service, owner }) => {
  for (const action of ['disconnect', 'disable', 'mode', 'delete']) {
    const [source] = await addBrowser(db, owner), entered = deferred(), release = deferred();
    await browser.open(owner, source.id); await browser.confirm(owner, source.id);
    runtime.readHandler = async request => { entered.resolve(); await release.promise;
      return { ...runtime.snapshot(request.url), refreshedStorageState: session.replace('test-cookie-only', 'test-cookie-revoked-v2-only') }; };
    const pending = service.sync(owner, source.id); await entered.promise;
    if (action === 'disconnect') await browser.clear(owner, source.id);
    if (action === 'disable') await service.update(owner, source.id, { enabled: false });
    if (action === 'mode') await service.update(owner, source.id, { captureMode: 'http' });
    if (action === 'delete') await service.remove(owner, source.id);
    release.resolve();
    if (action === 'delete') await assert.rejects(pending, /DATA_SOURCE_NOT_FOUND/u);
    else { const result = await pending; assert.equal(result.job.state, 'cancelled'); assert.equal(result.source.versionCount, 0); }
    const rows = await db.select().from(dataLibraryVersions).where(eq(dataLibraryVersions.sourceId, source.id)); assert.equal(rows.length, 0);
    assert.ok(runtime.closes.some(key => key.sourceId === source.id));
    const [stored] = await db.select().from(dataLibrarySources).where(eq(dataLibrarySources.id, source.id));
    if (action !== 'disable') assert.equal(stored.browserStateEnc, null);
    else assert.equal(decodeDataSecret(stored.browserStateEnc), session);
  }
}));

test('late manual confirmation cannot restore a disconnected or disabled session', { skip: !databaseUrl }, async () => fixture(async ({ db, runtime, browser, service, owner }) => {
  for (const action of ['disconnect', 'disable']) {
    const [source] = await addBrowser(db, owner), entered = deferred(), release = deferred();
    await browser.open(owner, source.id);
    runtime.confirmHandler = async () => { entered.resolve(); await release.promise; };
    const confirming = browser.confirm(owner, source.id); await entered.promise;
    if (action === 'disconnect') await browser.clear(owner, source.id); else await service.update(owner, source.id, { enabled: false });
    release.resolve(); await assert.rejects(confirming, /SOURCE_CHANGED/u);
    const [row] = await db.select().from(dataLibrarySources).where(eq(dataLibrarySources.id, source.id)); assert.equal(row.browserStateEnc, null);
  }
}));

test('superseded lease results cannot overwrite a newer precise HTTP version', { skip: !databaseUrl }, async () => fixture(async ({ db, service, owner }) => {
  const [source] = await db.insert(dataLibrarySources).values({ owner, kind: 'website', title: 'HTTP page', format: 'html', url: 'https://content-provider.org/research' }).returning();
  const entered = deferred(), release = deferred();
  const oldWorker = new DataLibraryService(db, async url => { entered.resolve(); await release.promise;
    return { status: 200, headers: {}, body: Buffer.from('<p>Outdated response</p>'), url }; });
  const newWorker = new DataLibraryService(db, async url => ({ status: 200, headers: {}, body: Buffer.from('<p>Current response</p>'), url }));
  const pending = oldWorker.sync(owner, source.id); await entered.promise;
  await db.update(dataLibrarySources).set({ leaseUntil: new Date(0) }).where(eq(dataLibrarySources.id, source.id));
  const recent = await newWorker.sync(owner, source.id); release.resolve(); const stale = await pending;
  assert.equal(stale.job.state, 'failed'); assert.equal(stale.job.errorCode, 'SYNC_INTERRUPTED');
  const detail = await service.detail(owner, source.id); assert.equal(detail.source.latestVersionId, recent.job.versionId); assert.equal(detail.source.versionCount, 1);
  assert.match((await service.version(owner, source.id, recent.job.versionId!)).extractedText, /Current response/u);
}));

test('caller cancellation and runtime timeout retain truthful job codes without publishing a version', { skip: !databaseUrl }, async () => fixture(async ({ db, runtime, browser, service, owner }) => {
  const [source] = await addBrowser(db, owner), entered = deferred(), release = deferred(), controller = new AbortController();
  await browser.open(owner, source.id); await browser.confirm(owner, source.id);
  runtime.readHandler = async request => { entered.resolve(); await release.promise; assert.equal(request.signal?.aborted, true);
    return { ...runtime.snapshot(request.url), refreshedStorageState: session.replace('test-cookie-only', 'test-cookie-cancelled-v2-only') }; };
  const pending = service.sync(owner, source.id, { signal: controller.signal }); await entered.promise; controller.abort(); release.resolve();
  const cancelled = await pending; assert.equal(cancelled.job.state, 'cancelled'); assert.equal(cancelled.job.errorCode, 'CANCELLED'); assert.equal(cancelled.job.versionId, null);
  const [stored] = await db.select().from(dataLibrarySources).where(eq(dataLibrarySources.id, source.id));
  assert.equal(decodeDataSecret(stored.browserStateEnc), session);
  runtime.readHandler = async () => { throw new BrowserSourceError('TIMEOUT'); };
  const timedOut = await service.sync(owner, source.id); assert.equal(timedOut.job.state, 'failed'); assert.equal(timedOut.job.errorCode, 'TIMEOUT');
  assert.equal((await db.select().from(dataLibraryJobs).where(eq(dataLibraryJobs.sourceId, source.id))).length, 2);
}));

test('an expired lease cannot publish even when no replacement worker has claimed it', { skip: !databaseUrl }, async () => fixture(async ({ db, runtime, browser, service, owner }) => {
  const [source] = await addBrowser(db, owner), entered = deferred(), release = deferred();
  await browser.open(owner, source.id); await browser.confirm(owner, source.id);
  runtime.readHandler = async request => { entered.resolve(); await release.promise;
    return { ...runtime.snapshot(request.url), refreshedStorageState: session.replace('test-cookie-only', 'test-cookie-expired-v2-only') }; };
  const pending = service.sync(owner, source.id); await entered.promise;
  await db.update(dataLibrarySources).set({ leaseUntil: new Date(0) }).where(eq(dataLibrarySources.id, source.id));
  release.resolve(); const result = await pending;
  assert.equal(result.job.state, 'failed'); assert.equal(result.job.errorCode, 'SYNC_LEASE_EXPIRED');
  assert.equal(result.job.versionId, null); assert.equal(result.source.versionCount, 0);
  const [row] = await db.select().from(dataLibrarySources).where(eq(dataLibrarySources.id, source.id));
  assert.equal(row.activeJobId, null); assert.equal(row.leaseToken, null); assert.equal(row.leaseUntil, null);
  assert.equal(decodeDataSecret(row.browserStateEnc), session);
}));

test('browser global/source concurrency is bounded while existing HTTP capacity remains independent', { skip: !databaseUrl }, async () => fixture(async ({ db, runtime, browser, owner, other }) => {
  const [first] = await addBrowser(db, owner), [second] = await addBrowser(db, other), [third] = await addBrowser(db, randomUUID());
  const enteredFirst = deferred(), enteredSecond = deferred(), release = deferred();
  runtime.readHandler = async request => {
    if (request.key.sourceId === first.id) enteredFirst.resolve(); else enteredSecond.resolve();
    await release.promise; return runtime.snapshot(request.url);
  };
  const service = new DataLibraryService(db, async url => ({ status: 200, headers: {}, body: Buffer.from('<p>HTTP content</p>'), url }), browser);
  const firstPending = service.sync(owner, first.id); await enteredFirst.promise;
  await assert.rejects(service.sync(owner, first.id), /SYNC_ALREADY_RUNNING/u);
  const secondPending = service.sync(other, second.id); await enteredSecond.promise;
  await assert.rejects(service.sync(third.owner, third.id), /SYNC_CAPACITY_REACHED/u);
  const [http] = await db.insert(dataLibrarySources).values({ owner: randomUUID(), kind: 'website', title: 'HTTP independent capacity', format: 'html', url: first.url }).returning();
  assert.equal((await service.sync(http.owner, http.id)).job.state, 'succeeded');
  release.resolve(); await Promise.all([firstPending, secondPending]);
}));

test('consecutive browser collections persist a provider-rotated session without reconfirming login', { skip: !databaseUrl }, async () => fixture(async ({ db, runtime, browser, service, owner }) => {
  const [source] = await addBrowser(db, owner);
  await browser.open(owner, source.id); const confirmed = await browser.confirm(owner, source.id);
  const rotated = session.replace('test-cookie-only', 'test-cookie-rotated-v2-only');
  let acceptedSession = session;
  runtime.readHandler = async request => {
    if (request.storageState !== acceptedSession) throw new BrowserSourceError('NEEDS_AUTH');
    acceptedSession = rotated;
    return { ...runtime.snapshot(request.url, 'Rendered research test-cookie-rotated-v2-only'), refreshedStorageState: rotated };
  };
  const first = await service.sync(owner, source.id), second = await service.sync(owner, source.id);
  assert.equal(first.job.state, 'succeeded'); assert.equal(second.job.state, 'succeeded');
  assert.equal(runtime.reads[1].storageState, rotated);
  const [row] = await db.select().from(dataLibrarySources).where(eq(dataLibrarySources.id, source.id));
  assert.equal(decodeDataSecret(row.browserStateEnc), rotated);
  assert.notEqual(row.browserStateEnc, rotated); assert.equal(row.browserConnectedAt?.toISOString(), confirmed.connectedAt);
  assert.equal(second.job.versionId, first.job.versionId, 'a refreshed session alone must not create another content version');
  const version = await service.version(owner, source.id, second.job.versionId!);
  const search = await service.search(owner, { query: 'Rendered' });
  assert.ok(!JSON.stringify([first, second, await service.detail(owner, source.id), version, search]).includes('test-cookie-rotated-v2-only'));
  const internal = await browser.read(owner, row);
  assert.equal(Object.hasOwn(internal, 'refreshedStorageState'), false); assert.ok(internal.refreshedStateEnc);
}));

test('caller abort during the archive transaction rolls back both new content and rotated session', { skip: !databaseUrl }, async () => fixture(async ({ db, runtime, browser, service, owner, client, admin, namespace }) => {
  const [source] = await addBrowser(db, owner), controller = new AbortController();
  await browser.open(owner, source.id); await browser.confirm(owner, source.id);
  const rotated = session.replace('test-cookie-only', 'test-cookie-rotated-late-only');
  runtime.readHandler = async request => ({ ...runtime.snapshot(request.url), refreshedStorageState: rotated });
  await client.unsafe(`CREATE FUNCTION wait_browser_version_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$;
    CREATE TRIGGER wait_browser_version_insert BEFORE INSERT ON data_library_versions FOR EACH ROW EXECUTE FUNCTION wait_browser_version_insert()`);
  const pending = service.sync(owner, source.id, { signal: controller.signal });
  let writingVersion = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await admin.unsafe("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='PgSleep'", [namespace]);
    if (rows.length) { writingVersion = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(writingVersion, 'the caller must cancel while the database is writing the new version');
  controller.abort(); const result = await pending;
  assert.equal(result.job.state, 'cancelled'); assert.equal(result.job.errorCode, 'CANCELLED'); assert.equal(result.job.versionId, null);
  const [row] = await db.select().from(dataLibrarySources).where(eq(dataLibrarySources.id, source.id));
  assert.equal(row.versionCount, 0); assert.equal(decodeDataSecret(row.browserStateEnc), session); assert.equal(row.activeJobId, null);
  assert.equal((await db.select().from(dataLibraryVersions).where(eq(dataLibraryVersions.sourceId, source.id))).length, 0);
}));

test('anonymous browser collection strips refreshed state without creating a durable login', { skip: !databaseUrl }, async () => fixture(async ({ db, runtime, browser, service, owner }) => {
  const [source] = await addBrowser(db, owner);
  const anonymousState = session.replace('test-cookie-only', 'test-cookie-anonymous-v2-only');
  runtime.readHandler = async request => ({ ...runtime.snapshot(request.url, 'Rendered research test-cookie-anonymous-v2-only'), refreshedStorageState: anonymousState });
  const capture = await service.sync(owner, source.id);
  assert.equal(capture.job.state, 'succeeded'); assert.equal(capture.source.hasBrowserSession, false);
  const [row] = await db.select().from(dataLibrarySources).where(eq(dataLibrarySources.id, source.id));
  assert.equal(row.browserStateEnc, null); assert.equal(row.browserConnectedAt, null);
  const internal = await browser.read(owner, row);
  assert.equal(Object.hasOwn(internal, 'refreshedStorageState'), false); assert.equal(internal.refreshedStateEnc, undefined);
  const version = await service.version(owner, source.id, capture.job.versionId!);
  assert.ok(!JSON.stringify([capture, version]).includes('test-cookie-anonymous-v2-only'));
}));

test('a superseded browser capture cannot overwrite a newer persisted rotated session', { skip: !databaseUrl }, async () => fixture(async ({ db, runtime, browser, service, owner }) => {
  const [source] = await addBrowser(db, owner), entered = deferred(), release = deferred();
  await browser.open(owner, source.id); await browser.confirm(owner, source.id);
  const staleState = session.replace('test-cookie-only', 'test-cookie-stale-v2-only');
  const currentState = session.replace('test-cookie-only', 'test-cookie-current-v3-only');
  let reads = 0;
  runtime.readHandler = async request => {
    reads++;
    if (reads === 1) {
      entered.resolve(); await release.promise;
      return { ...runtime.snapshot(request.url, 'Stale captured research'), refreshedStorageState: staleState };
    }
    return { ...runtime.snapshot(request.url, 'Current captured research'), refreshedStorageState: currentState };
  };
  const pending = service.sync(owner, source.id); await entered.promise;
  await db.update(dataLibrarySources).set({ leaseUntil: new Date(0) }).where(eq(dataLibrarySources.id, source.id));
  const replacement = new DataLibraryService(db, undefined, browser);
  const recent = await replacement.sync(owner, source.id); release.resolve(); const stale = await pending;
  assert.equal(recent.job.state, 'succeeded'); assert.equal(stale.job.errorCode, 'SYNC_INTERRUPTED');
  const [row] = await db.select().from(dataLibrarySources).where(eq(dataLibrarySources.id, source.id));
  assert.equal(row.latestVersionId, recent.job.versionId); assert.equal(row.versionCount, 1);
  assert.equal(decodeDataSecret(row.browserStateEnc), currentState);
}));
