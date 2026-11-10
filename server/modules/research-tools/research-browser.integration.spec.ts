import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { councilSessions } from '../../database/council.schema';
import { dataLibrarySources, dataLibraryVersions } from '../../database/data-library.schema';
import { DataLibraryService } from '../data-library/data-library.service';
import { DataBrowserService } from '../data-library/data-browser.service';
import { BrowserSourceError, type BrowserSourceRuntimePort } from '../data-library/browser/browser-source.types';
import { ResearchToolsService } from './research-tools.service';
import type { ResearchToolScope } from '../../../shared/research-tools.interface';

test('Agent browser collection archives the exact owned rendered version and cancels revoked work without exposing sessions', async () => {
  const url = process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url, 'A disposable RESEARCH_TEST_DATABASE_URL is required');
  const namespace = `browser_tool_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const client = postgres(url, { max: 6, onnotice: () => {}, connection: { search_path: namespace } });
  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = 'browser-tool-fictional-encryption-key';
  let library: DataLibraryService | undefined;
  let browser: DataBrowserService | undefined;
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    for (const file of readdirSync('scripts/db').filter(name => /^\d+.*\.sql$/u.test(name) && !name.startsWith('02_')).sort()) {
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    }
    const db = drizzle(client);
    const owner = randomUUID(), foreign = randomUUID();
    await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},'browser-tool-alice','fixture'),(${foreign},'browser-tool-bob','fixture')`;
    const [source, other] = await db.insert(dataLibrarySources).values([owner, foreign].map(account => ({
      owner: account, kind: 'website', title: 'Fictional rendered filing', format: 'html',
      url: 'https://reports.fixture-provider.org/article', captureMode: 'browser', enabled: true,
    }))).returning();
    let reads = 0;
    let waitForCancellation = false;
    let entered: () => void = () => undefined;
    let receivedAbort = false;
    const runtime: BrowserSourceRuntimePort = {
      availability: async () => ({ available: true, canOpenInteractive: true }),
      loginWindowOpen: () => false,
      open: async () => ({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      confirm: async () => ({ storageState: '{"cookies":[],"origins":[]}' }),
      read: async request => {
        assert.equal(request.key.ownerId, owner);
        assert.equal(request.key.sourceId, source.id);
        reads++;
        if (waitForCancellation) {
          entered();
          await new Promise<never>((_resolve, reject) => {
            const cancel = () => { receivedAbort = true; reject(new BrowserSourceError('CANCELLED')); };
            if (request.signal?.aborted) cancel(); else request.signal?.addEventListener('abort', cancel, { once: true });
          });
        }
        const text = 'Fictional rendered disclosure: revenue USD 1000000 for the stated annual period. Source gaps remain explicit.';
        return { url: request.url, title: 'Fictional JS-rendered disclosure', text,
          html: Buffer.from(`<main><h1>Fictional disclosure</h1><p>${text}</p></main>`),
          observedAt: new Date().toISOString(), mimeType: 'text/html', provenance: 'browser-rendered' };
      },
      close: async () => undefined,
      shutdown: async () => undefined,
    };
    browser = new DataBrowserService(db, runtime);
    library = new DataLibraryService(db, undefined, browser);
    const [session] = await db.insert(councilSessions).values({ owner, profileVersion: 1,
      profileSnapshot: { name: 'Browser tool fixture', template: 'balanced', tickers: [], minimumRating: 'Buy',
        customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false,
        council: { enabled: true, webResearch: false, members: [{ id: 'researcher', name: 'Researcher', role: 'researcher', model: 'fast', instructions: '' }] } },
      ticker: 'PORTFOLIO', language: 'en', status: 'running', revision: 1,
      checkpoint: { cycleId: randomUUID(), nextTurn: 0, turns: [{ memberId: 'researcher', phase: 'opening' }] },
    }).returning();
    const scope: ResearchToolScope = { sessionId: session.id, revision: 1, memberId: 'researcher', memberName: 'Researcher',
      turn: 0, ticker: 'PORTFOLIO', language: 'en', webResearch: false, expiresAt: Date.now() + 120_000 };
    const tools = new ResearchToolsService(db, {} as never, {} as never, {} as never, library);
    const request = { callId: randomUUID(), name: 'read_browser_source', arguments: { sourceId: source.id } };
    const result = await tools.call(owner, scope, request);
    assert.equal(result.status, 'succeeded');
    assert.equal(reads, 1);
    assert.match(JSON.stringify(result), /Fictional rendered disclosure/u);
    const [version] = await db.select().from(dataLibraryVersions).where(eq(dataLibraryVersions.sourceId, source.id));
    assert.equal(version.acquisition, 'browser-rendered');
    assert.equal(version.finalUrl, source.url);
    assert.match(JSON.stringify(result.data), new RegExp(version.id));
    const [saved] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
    assert.deepEqual(saved.evidenceSnapshot.at(-1)?.libraryReferences, [{ sourceId: source.id, versionId: version.id }]);
    assert.doesNotMatch(JSON.stringify(result), /storageState|browserStateEnc|secretEnc|cookies/u);
    assert.equal((await tools.call(owner, scope, { ...request, arguments: { sourceId: source.id, url: 'https://unconfigured.org' } })).errorCode, 'RESEARCH_INVALID_ARGUMENTS');
    assert.notEqual((await tools.call(owner, scope, { ...request, arguments: { sourceId: other.id } })).status, 'succeeded');
    assert.equal(reads, 1, 'a foreign source cannot dispatch browser work');
    assert.equal((await tools.call(owner, scope, request)).status, 'succeeded');
    assert.equal((await db.select().from(dataLibraryVersions).where(eq(dataLibraryVersions.sourceId, source.id))).length, 1, 'unchanged rendered content retains one version');

    waitForCancellation = true;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const controller = new AbortController();
    const pending = tools.call(owner, scope, request, { signal: controller.signal });
    await ready;
    controller.abort();
    assert.equal((await pending).status, 'cancelled');
    for (let count = 0; count < 50 && !receivedAbort; count++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(receivedAbort, true, 'tool cancellation reaches the live browser operation');
    assert.equal((await db.select().from(dataLibraryVersions).where(eq(dataLibraryVersions.sourceId, source.id))).length, 1);
    await library.update(owner, source.id, { enabled: false });
    const readCount = reads;
    assert.notEqual((await tools.call(owner, scope, request)).status, 'succeeded');
    assert.equal(reads, readCount, 'a disabled evidence source cannot trigger another browser operation');
  } finally {
    library?.onModuleDestroy();
    await browser?.onModuleDestroy();
    if (previousKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    await client.end();
    await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`;
    await admin.end();
  }
});
