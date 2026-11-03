import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalAgentsService } from './local-agents.service';
import { LocalAgentStore } from './local-agents.store';
import { providerCatalog } from './local-agents.requests';
import type { ResearchToolDescriptor, ResearchToolResult } from '../../../shared/research-tools.interface';
import { validOutput } from '../research-tools/research-tools.registry';

test('native research calls reuse task-scoped tools, replay one result, and persist a complete public timeline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-research-execution-'));
  const prior = process.env.SQUABBLE_DESKTOP_ORIGIN;
  process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:43199';
  let calls = 0;
  const descriptor: ResearchToolDescriptor = { name: 'get_quotes', description: 'quote', inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } };
  const quote: ResearchToolResult = { status: 'succeeded', data: { price: '100', currency: 'USD' },
    sources: [{ title: 'Fixture price', url: 'https://example.com/price', fetchedAt: new Date().toISOString() }],
    asOf: new Date().toISOString(), truncated: false };
  const tools = { descriptors: () => [descriptor], bundle: async () => ({ descriptors: [descriptor], snapshot: '{"ticker":"AAPL"}' }),
    isCurrent: async () => true, call: async () => { calls++; return quote; } };
  const sessionId = randomUUID();
  const service = new LocalAgentsService({
    detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready' }], openNativeLogin: async () => undefined,
    runNativeAgent: async (_provider, _prompt, run) => {
      assert.ok(run.researchTools, 'automatically attach a research tool bundle');
      const request = { callId: 'quote-1', name: 'get_quotes', arguments: {} };
      const results = await Promise.all([run.researchTools.call(request, run.signal), run.researchTools.call(request, run.signal)]);
      assert.deepEqual(results, [quote, quote]);
      const denied = await run.researchTools.call({ ...request, name: 'place_paper_order', callId: 'forbidden' }, run.signal);
      assert.equal(denied.status, 'failed'); assert.ok(validOutput(denied), 'failed calls must satisfy their advertised MCP output schema');
      run.onEvent?.({ id: 'public-summary', kind: 'summary', status: 'succeeded', at: new Date().toISOString(), summary: 'Checked the quote currency.' });
      return { text: 'Price 100 USD, source: https://example.com/price', usageTokens: null };
    },
  }, new LocalAgentStore(directory), tools as never);
  try {
    await service.connect('alice', 'native-codex');
    const output = await service.execute('alice', { agentId: 'native-codex', messageId: randomUUID(), prompt: 'Research AAPL',
      researchScope: { sessionId, revision: 1, memberId: 'member', memberName: 'Analyst', turn: 0, ticker: 'AAPL', language: 'en', webResearch: false, expiresAt: Date.now() + 600_000 },
      onTask: async () => undefined, onProgress: async () => undefined, shouldContinue: async () => true });
    assert.match(output.text, /100 USD/); assert.equal(calls, 1);
    const page = await service.store.eventsForSession('alice', sessionId);
    assert.deepEqual(page.events.filter(e => e.kind === 'tool' && e.callId === 'quote-1').map(e => e.status), ['running', 'succeeded']);
    assert.ok(page.events.some(e => e.id === 'public-summary'));
    assert.equal(page.events.at(-1)?.status, 'succeeded');
    assert.equal((await service.callResearchTool('alice', output.taskId!, { callId: 'late', name: 'get_quotes', arguments: {} })).status, 'failed');
  } finally {
    await service.onModuleDestroy();
    if (prior === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN; else process.env.SQUABBLE_DESKTOP_ORIGIN = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
