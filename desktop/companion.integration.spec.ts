import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { LocalAgentCompanion } from './companion.mts';
import { LocalAgentStore } from '../server/modules/local-agents/local-agents.store';
import { pairRequest, parseCompanionPoll, providerCatalog } from '../server/modules/local-agents/local-agents.requests';
import type { NativeAgentConfiguration } from '../shared/local-agents.interface';

test('desktop and broker exchange the actual pairing, task, recovery and revocation wire contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-companion-wire-'));
  const store = new LocalAgentStore(join(directory, 'broker'));
  const owner = 'fixture-owner';
  let runs = 0;
  const agentSettings = { model: 'fixture/research', reasoningEffort: 'high' };
  const native = {
    detectNativeAgents: async () => Object.values(providerCatalog).map((provider) => ({ ...provider, state: 'ready' as const,
      models: [], reasoningEfforts: ['low', 'high'] })),
    openNativeLogin: async () => undefined,
    runNativeAgent: async (_provider: string, _prompt: string, options: { signal: AbortSignal; agentSettings?: NativeAgentConfiguration }) => {
      runs += 1;
      if (runs === 1) {
        assert.deepEqual(options.agentSettings, agentSettings);
        return { text: 'Fixture research report', usageTokens: null };
      }
      return new Promise<{ text: string; usageTokens: null }>((_done, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('Fixture abort')), { once: true });
      });
    },
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/local-agent-companion/pair') {
        const input = pairRequest.parse(body);
        response.end(JSON.stringify(await store.pair(input.code, input.name)));
      } else if (request.url === '/api/local-agent-companion/poll') {
        response.end(JSON.stringify(await store.poll(request.headers.authorization?.slice(7) ?? '', parseCompanionPoll(body))));
      } else { response.writeHead(404); response.end(); }
    } catch {
      response.writeHead(401); response.end('{}');
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const helper = new LocalAgentCompanion({ dataDir: join(directory, 'desktop'), name: 'Fixture desktop', native });
  let restored: LocalAgentCompanion | undefined;
  try {
    const pairing = await store.createPairing(owner);
    await helper.pair(`squabble://pair?origin=${encodeURIComponent(origin)}&code=${pairing.code}`, async () => true);
    await helper.pollOnce();
    await helper.pollOnce();
    await store.connectCompanion(owner, 'codex');
    assert.equal((await store.deviceFor(owner))?.agents.length, 7);
    const first = await store.stage(owner, 'companion-codex', 'codex', randomUUID(), 'Fixture research', 'run', agentSettings);
    await store.activate(owner, first.id);
    await helper.pollOnce();
    await helper.pollOnce();
    assert.equal((await store.task(owner, first.id)).text, 'Fixture research report');
    const second = await store.stage(owner, 'companion-codex', 'codex', randomUUID(), 'Fixture pending research');
    await store.activate(owner, second.id);
    await helper.pollOnce();
    assert.equal((await store.task(owner, second.id)).state, 'running');
    await helper.stop();
    restored = new LocalAgentCompanion({ dataDir: join(directory, 'desktop'), name: 'Fixture desktop', native });
    await restored.restore();
    await restored.pollOnce();
    assert.equal(runs, 2);
    assert.equal((await store.task(owner, first.id)).state, 'completed');
    assert.equal((await store.task(owner, second.id)).state, 'failed');
    assert.equal(await store.busy(owner, 'companion-codex'), false);
    await store.revoke(owner);
    await restored.pollOnce();
    assert.equal(restored.status.state, 'unpaired');
    await assert.rejects(readFile(join(directory, 'desktop', 'pairing.json')), { code: 'ENOENT' });
  } finally {
    await restored?.stop();
    await helper.stop();
    await new Promise<void>((done) => server.close(() => done()));
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
