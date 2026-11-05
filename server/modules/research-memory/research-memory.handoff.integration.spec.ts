import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { monitorFixture, seedMonitor } from './research-memory.monitor.fixtures';
import { memoryReference } from './research-memory.context';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { LocalAgentStore } from '../local-agents/local-agents.store';
import { providerCatalog } from '../local-agents/local-agents.requests';
import { councilReports } from '../../database/council.schema';

test('real queued companion handoff rejects intervening memory edits, privacy revocation and source deletion', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL, timeout: 60000,
}, async t => {
  for (const mutation of ['edit', 'exclude', 'source-delete', 'foreign-owner'] as const) await t.test(mutation,
    async () => monitorFixture(async (db, _client, owner) => {
      const f = await seedMonitor(db, owner), frozen = await f.memory.recall(owner, { ticker: 'AAPL' });
      const prepared = frozen.items.map(memoryReference), directory = await mkdtemp(join(tmpdir(), 'squabble-memory-handoff-'));
      const origin = process.env.SQUABBLE_DESKTOP_ORIGIN, mode = process.env.LOCAL_AGENTS_MODE;
      delete process.env.SQUABBLE_DESKTOP_ORIGIN; process.env.LOCAL_AGENTS_MODE = 'companion';
      const service = new LocalAgentsService(undefined, new LocalAgentStore(directory));
      const agents = [{ ...providerCatalog.codex, state: 'ready' as const }];
      let receipts = 0, commands = 0;
      try {
        const paired = await service.store.pair((await service.pairing(owner)).code, 'Fixture');
        await service.store.poll(paired.token, { agents, updates: [] }); await service.connect(owner, 'companion-codex');
        await assert.rejects(service.execute(owner, { agentId: 'companion-codex', messageId: mutation,
          prompt: 'Fictional prepared research memory', onTask: async () => {}, onProgress: async () => {},
          onSubmitted: async () => { receipts++; },
          withHandoff: emit => f.memory.withRecallHandoff(mutation === 'foreign-owner' ? 'other-owner' : owner,
            frozen, { ticker: 'AAPL' }, prepared, emit),
          shouldContinue: async () => {
            if (mutation === 'edit') {
              const { provenance: _provenance, ...content } = frozen.items[0].content!;
              await f.memory.updateThesis(owner, f.thesis.id, { expectedVersion: f.thesis.version, action: 'edit',
                content: { ...content, claim: 'A later changed claim' } });
            } else if (mutation === 'exclude') await f.memory.updateMemory(owner, f.memoryId, { excluded: true });
            else if (mutation === 'source-delete') await db.delete(councilReports).where(eq(councilReports.id, f.report.id));
            const polls = await Promise.all([service.store.poll(paired.token, { agents, updates: [] }),
              service.store.poll(paired.token, { agents, updates: [] })]);
            commands += polls.flatMap(poll => poll.commands).length;
            return true;
          } }), /MEMORY_CONTEXT_CHANGED/);
        assert.equal(commands, 0); assert.equal(receipts, 0);
      } finally {
        await service.onModuleDestroy();
        if (origin === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = origin;
        if (mode === undefined) delete process.env.LOCAL_AGENTS_MODE; else process.env.LOCAL_AGENTS_MODE = mode;
        await rm(directory, { recursive: true, force: true });
      }
    }));
});

test('handoff holds real owner and physical-source fences until one local command is durably emitted', {
  skip: !process.env.MEMORY_TEST_DATABASE_URL, timeout: 60000,
}, async t => { for (const kind of ['source-delete', 'exclude'] as const) await t.test(kind, async () => monitorFixture(async (db, client, owner) => {
  const f = await seedMonitor(db, owner), frozen = await f.memory.recall(owner, { ticker: 'AAPL' });
  const directory = await mkdtemp(join(tmpdir(), 'squabble-memory-race-')), store = new LocalAgentStore(directory);
  const agents = [{ ...providerCatalog.codex, state: 'ready' as const }];
  let mutation: Promise<unknown> | undefined, revoked = false;
  try {
    const paired = await store.pair((await store.createPairing(owner)).code, 'Fixture');
    await store.poll(paired.token, { agents, updates: [] }); await store.connectCompanion(owner, 'codex');
    const task = await store.stage(owner, 'companion-codex', 'codex', 'race', 'Fictional pinned prompt');
    store.registerHandoff(owner, task.id, emit => f.memory.withRecallHandoff(owner, frozen, { ticker: 'AAPL' }, frozen.items.map(memoryReference), async () => {
      if (!mutation) {
        mutation = (kind === 'source-delete' ? db.delete(councilReports).where(eq(councilReports.id, f.report.id))
          : f.memory.updateMemory(owner, f.memoryId, { excluded: true })).then(() => { revoked = true; });
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (Date.now() < deadline) {
          const pattern = kind === 'source-delete' ? '%delete from "council_reports"%' : '%research_memory_preferences%';
          const rows = await client`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${pattern}`;
          if (rows.length) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, 'revocation actually waits on PostgreSQL handoff locks');
        assert.equal(revoked, false);
      }
      await emit();
    }));
    await store.activate(owner, task.id);
    const polls = await Promise.all([store.poll(paired.token, { agents, updates: [] }), store.poll(paired.token, { agents, updates: [] })]);
    await mutation;
    const commands = polls.flatMap(poll => poll.commands);
    assert.equal(commands.length, 1); assert.equal(commands[0].prompt, task.prompt); assert.equal(revoked, true);
    assert.equal((await store.task(owner, task.id)).commandEmitted, true);
    assert.notEqual((await store.task(owner, task.id)).error, 'LOCAL_DISPATCH_UNCERTAIN',
      'a losing parallel poll must not misclassify the command successfully emitted by the winning poll');
    assert.equal((await store.poll(paired.token, { agents, updates: [] })).commands.length, 0);
  } finally { await mutation; await rm(directory, { recursive: true, force: true }); }
})); });
