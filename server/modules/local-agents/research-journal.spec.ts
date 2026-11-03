import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalAgentStore } from './local-agents.store';
import type { ResearchToolResult, ResearchToolScope } from '../../../shared/research-tools.interface';

const scope = (): ResearchToolScope => ({ sessionId: randomUUID(), memberId: 'analyst', memberName: 'Analyst',
  revision: 2, turn: 0, ticker: 'AAPL', language: 'en', webResearch: false, expiresAt: Date.now() + 600_000 });
const bundle = { descriptors: [], snapshot: '{"evidence":[]}' };
const result: ResearchToolResult = { status: 'succeeded', data: { price: '100', currency: 'USD' }, sources: [], asOf: '2026-11-03T00:00:00Z', truncated: false };
async function fixture(run: (store: LocalAgentStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'squabble-research-journal-'));
  try { await run(new LocalAgentStore(root), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function start(store: LocalAgentStore, value = scope()) {
  await store.connectNative('alice', 'codex');
  const task = await store.stage('alice', 'native-codex', 'codex', randomUUID(), 'Research AAPL', 'run', undefined, { scope: value, bundle });
  await store.activate('alice', task.id); await store.takeNative('alice', task.id);
  return { task, scope: value };
}
test('research scope and public task lifecycle are durably attached before native execution', async () => fixture(async (store, root) => {
  const { task, scope: value } = await start(store);
  assert.deepEqual((await store.task('alice', task.id)).researchScope, value);
  const first = await store.eventsForSession('alice', value.sessionId);
  assert.deepEqual(first.events.map(e => e.status), ['queued', 'running']);
  assert.equal((await store.eventsForSession('bob', value.sessionId)).events.length, 0);
  const recovered = await new LocalAgentStore(root).eventsForSession('alice', value.sessionId);
  assert.equal(recovered.events.at(-1)?.status, 'interrupted');
  assert.equal(recovered.events[0].id, first.events[0].id);
}));
test('activity is deduplicated, bounded and sanitized before persistence; terminal events stop pending tools', async () => fixture(async store => {
  const { task, scope: value } = await start(store);
  const event = { id: 'tool-1-start', kind: 'tool' as const, status: 'running' as const, at: new Date().toISOString(),
    toolName: 'WebSearch', callId: 'call-1', summary: 'Searching Bearer secret-token-value <think>private reasoning</think>',
    sources: [{ title: 'source', url: 'https://example.com/report?token=private', fetchedAt: new Date().toISOString() }] };
  await store.appendEvents('alice', task.id, [event, event]);
  let page = await store.eventsForSession('alice', value.sessionId);
  assert.equal(page.events.filter(e => e.id === event.id).length, 1);
  assert.doesNotMatch(JSON.stringify(page), /secret-token-value|private reasoning|token=private/);
  await assert.rejects(store.appendEvents('bob', task.id, [event]), /LOCAL_TASK_NOT_FOUND/);
  await store.update('alice', task.id, { state: 'completed', text: 'Report' });
  page = await store.eventsForSession('alice', value.sessionId);
  assert.equal(page.events.at(-1)?.status, 'succeeded');
  assert.equal(page.events.filter(e => e.callId === 'call-1').at(-1)?.status, 'interrupted');
  await store.appendEvents('alice', task.id, [{ ...event, id: 'late' }]);
  assert.equal((await store.eventsForSession('alice', value.sessionId)).events.some(e => e.id === 'late'), false);
}));
test('large timelines retain bounded recent events and signal truncation', async () => fixture(async store => {
  const { task, scope: value } = await start(store);
  for (let n = 0; n < 300; n += 30) await store.appendEvents('alice', task.id, Array.from({ length: 30 }, (_, i) => ({
    id: `summary-${n + i}`, kind: 'summary' as const, status: 'running' as const, at: new Date().toISOString(), summary: `Public step ${n + i}`,
  })));
  const page = await store.eventsForSession('alice', value.sessionId);
  assert.ok(page.events.length <= 256); assert.equal(page.truncated, true);
  assert.equal(new Set(page.events.map(e => e.sequence)).size, page.events.length);
}));
test('public citations retain query-addressed source identity across persistence', async () => fixture(async (store, root) => {
  const { task, scope: value } = await start(store);
  const sources = [123, 456].map(id => ({ title: 'Issuer release',
    url: `https://issuer.example/release?id=${id}&lang=en#section`, fetchedAt: new Date().toISOString() }));
  await store.appendEvents('alice', task.id, [{ id: 'query-sources', kind: 'tool', status: 'succeeded',
    at: new Date().toISOString(), summary: 'Read issuer releases', sources }]);
  await store.update('alice', task.id, { state: 'completed', text: 'Report' });
  const events = (await new LocalAgentStore(root).eventsForSession('alice', value.sessionId)).events;
  assert.deepEqual(events.find(event => event.id === 'query-sources')?.sources?.map(source => source.url), [
    'https://issuer.example/release?id=123&lang=en', 'https://issuer.example/release?id=456&lang=en',
  ]);
}));
test('sensitive citation query parameters never persist as links or secrets', async () => fixture(async store => {
  const { task, scope: value } = await start(store);
  const sources = ['token', 'api_key', 'Authorization', 'secret', 'password', 'X-Amz-Signature'].map(key => ({
    title: 'Issuer release', url: `https://issuer.example/release?id=123&${key}=PRIVATE_QUERY_VALUE`, fetchedAt: new Date().toISOString(),
  }));
  await store.appendEvents('alice', task.id, [{ id: 'sensitive-sources', kind: 'tool', status: 'succeeded',
    at: new Date().toISOString(), summary: 'Read issuer releases', sources }]);
  const event = (await store.eventsForSession('alice', value.sessionId)).events.find(entry => entry.id === 'sensitive-sources');
  assert.equal(event?.sources?.length, sources.length);
  assert.ok(event?.sources?.every(source => source.url === undefined));
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_QUERY_VALUE/);
}));
test('tool claims are atomic, request-bound, replay cached results, and reject terminal/expired tasks', async () => fixture(async store => {
  const { task } = await start(store);
  const request = { callId: 'quote-1', name: 'get_quotes', arguments: {} };
  const claims = await Promise.all([store.beginToolCall('alice', task.id, request), store.beginToolCall('alice', task.id, request)]);
  assert.equal(claims.filter(c => c.run).length, 1);
  await store.finishToolCall('alice', task.id, request.callId, result);
  assert.deepEqual((await store.beginToolCall('alice', task.id, request)).result, result);
  await assert.rejects(store.beginToolCall('alice', task.id, { ...request, name: 'get_news' }), /RESEARCH_CALL_CONFLICT/);
  await store.update('alice', task.id, { state: 'completed', text: 'Report' });
  await assert.rejects(store.beginToolCall('alice', task.id, request), /RESEARCH_TASK_INACTIVE/);
  const expired = await start(store, { ...scope(), expiresAt: Date.now() - 1 });
  await assert.rejects(store.beginToolCall('alice', expired.task.id, request), /RESEARCH_TASK_INACTIVE/);
}));
test('companion tool access requires the assigned live device; polling preserves terminal event batches', async () => fixture(async store => {
  const agents = [{ provider: 'codex' as const, state: 'ready' as const, name: 'Codex', loginCommand: '', installUrl: '' }];
  const alice = await store.pair((await store.createPairing('alice')).code, 'Alice');
  const bob = await store.pair((await store.createPairing('bob')).code, 'Bob');
  await store.poll(alice.token, { agents, updates: [] }); await store.connectCompanion('alice', 'codex');
  const value = scope();
  const task = await store.stage('alice', 'companion-codex', 'codex', randomUUID(), 'Research', 'run', undefined, { scope: value, bundle });
  await store.activate('alice', task.id);
  const dispatched = await store.poll(alice.token, { agents, updates: [] });
  assert.deepEqual(dispatched.commands[0].researchTools, bundle);
  assert.equal((await store.companionTask(alice.token, task.id)).owner, 'alice');
  await assert.rejects(store.companionTask(bob.token, task.id), /LOCAL_TASK_NOT_FOUND/);
  const done = { id: task.id, state: 'completed' as const, text: 'Report', events: [{ id: 'last-note', kind: 'summary' as const,
    status: 'succeeded' as const, at: new Date().toISOString(), summary: 'Checked two sources.' }] };
  await store.poll(alice.token, { agents, updates: [done] });
  await store.poll(alice.token, { agents, updates: [done] });
  const page = await store.eventsForSession('alice', value.sessionId);
  assert.equal(page.events.filter(e => e.id === 'last-note').length, 1);
  assert.equal(page.events.at(-1)?.status, 'succeeded');
  await assert.rejects(store.companionTask(alice.token, task.id), /RESEARCH_TASK_INACTIVE/);
}));
