import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { LlmService } from '../research-core/llm.service';
import type { TelemetrySpanRecord } from '../../../shared/telemetry.interface';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { LocalAgentStore } from '../local-agents/local-agents.store';
import { providerCatalog } from '../local-agents/local-agents.requests';
import { ResearchToolsService } from '../research-tools/research-tools.service';

test('paid transport metadata uses actual model, provider usage and one stable call parent across retries', async () => {
  const original = axios.post;
  const spans: TelemetrySpanRecord[] = []; let requests = 0;
  const service = new LlmService({ getLlmConfig: async () => ({ source: 'environment', baseUrl: 'https://fixture.invalid/v1', apiKey: 'private-key', fastModel: 'configured-alias', slowModel: 'alias' }) } as never,
    { reserve: async () => ({ id: `reservation-${requests}`, maxOutputTokens: 100,
      estimateRates: { inputUsdPerMillion: 2, outputUsdPerMillion: 5 } }),
      settle: async (_owner: string, _id: string, usage?: unknown) => ({ inputTokens: 2, outputTokens: 3, chargedTokens: 5, known: Boolean(usage) }) } as never,
    undefined, { recordSpan: (_owner: string, span: TelemetrySpanRecord) => spans.push(span) } as never);
  try {
    axios.post = (async () => {
      requests += 1;
      if (requests === 1) return { status: 500 };
      return { status: 200, data: { model: 'actual-model', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }, choices: [{ message: { content: 'private-completion' } }] } };
    }) as never;
    const result = await service.chatFast([{ role: 'user', content: 'private-prompt' }], 'owner', { taskId: 'task', route: { mode: 'api' } });
    assert.equal(result.content, 'private-completion');
    const models = spans.filter(span => span.kind === 'model' && span.completedAt);
    assert.equal(models.length, 2);
    assert.deepEqual(models.map(span => span.attempt), [1, 2]);
    assert.equal(new Set(models.map(span => span.parentId)).size, 1);
    assert.deepEqual(models.map(span => span.status), ['failed', 'completed']);
    assert.equal(models[0].totalTokens, null);
    assert.equal(models[1].totalTokens, 5);
    assert.equal(models[1].model, 'actual-model');
    assert.equal(models[0].estimatedCostUsd, null);
    assert.equal(models[1].estimatedCostUsd, 0.000019);
    assert.doesNotMatch(JSON.stringify(spans), /private-prompt|private-completion|private-key|configured-alias/);
  } finally { axios.post = original; }
});

test('telemetry failure never retries or rejects a completed model call; missing usage stays unknown', async () => {
  const original = axios.post; let requests = 0;
  const spans: TelemetrySpanRecord[] = [];
  const service = new LlmService({ getLlmConfig: async () => ({ source: 'environment', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', fastModel: 'alias' }) } as never,
    { reserve: async () => ({ id: 'reservation', maxOutputTokens: 100 }), settle: async () => ({ inputTokens: 99, outputTokens: 100, chargedTokens: 199, known: false }) } as never,
    undefined, { recordSpan: (_owner: string, span: TelemetrySpanRecord) => { spans.push(span); throw new Error('telemetry failed'); } } as never);
  try {
    axios.post = (async () => { requests += 1; return { status: 200, data: { choices: [{ message: { content: '{}' } }] } }; }) as never;
    await service.chatFastJSON([{ role: 'user', content: 'private' }], 'owner', { route: { mode: 'api' }, retryPolicy: 'none' });
    assert.equal(requests, 1);
    assert.equal(spans.find(span => span.kind === 'model' && span.completedAt)?.totalTokens, null);
    assert.equal(spans.find(span => span.kind === 'model' && span.completedAt)?.model, null);
  } finally { axios.post = original; }
});

test('native capture preserves task identity across reattachment, excludes configured model guesses and content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-telemetry-native-'));
  const spans: TelemetrySpanRecord[] = []; let executions = 0;
  const service = new LocalAgentsService({ detectNativeAgents: async () => [{ ...providerCatalog.codex, state: 'ready' }],
    openNativeLogin: async () => undefined, runNativeAgent: async () => { executions += 1; return { text: 'private-result', usageTokens: null }; } },
    new LocalAgentStore(directory), undefined, { recordSpan: (_owner: string, span: TelemetrySpanRecord) => spans.push(span) } as never);
  Object.defineProperty(service, 'mode', { get: () => 'native' });
  const options = { agentId: 'native-codex', messageId: 'message', prompt: 'private-prompt',
    onTask: async () => undefined, onProgress: async () => undefined, shouldContinue: async () => true };
  try {
    await service.connect('owner', 'native-codex');
    const result = await service.execute('owner', options);
    await service.execute('owner', { ...options, remoteTaskId: result.taskId });
    assert.equal(executions, 1);
    const terminal = spans.filter(span => span.completedAt);
    assert.ok(terminal.length >= 1);
    assert.equal(new Set(terminal.map(span => span.id)).size, 1);
    assert.equal(terminal[0].provider, 'codex');
    assert.equal(terminal[0].model, null);
    assert.equal(terminal[0].totalTokens, null);
    assert.doesNotMatch(JSON.stringify(spans), /private-result|private-prompt/);
  } finally { await service.onModuleDestroy(); await rm(directory, { force: true, recursive: true }); }
});

test('a correlated local model route retains source identity without granting research tools', async () => {
  let received: Parameters<LocalAgentsService['execute']>[1] | undefined;
  const service = new LlmService({} as never, {} as never);
  Object.defineProperty(service, 'localAgents', { value: () => ({
    validate: async () => undefined,
    execute: async (_owner: string, input: Parameters<LocalAgentsService['execute']>[1]) => {
      received = input;
      return { taskId: 'fixture-task', text: 'fixture completion', usageTokens: null };
    },
  }) });
  await service.chatFast([{ role: 'user', content: 'private prompt' }], 'owner', {
    route: { mode: 'local', agentId: 'native-codex' },
    telemetryContext: { sessionId: 'fixture-session', revision: 2, cycleId: 'fixture-cycle', memberId: 'manager' },
  });
  assert.equal(received?.activityContext?.sessionId, 'fixture-session');
  assert.equal(received?.activityContext?.cycleId, 'fixture-cycle');
  assert.equal(received?.activityContext?.revision, 2);
  assert.equal(received?.activityContext?.memberId, 'manager');
  assert.equal(received?.researchScope, undefined);
});

test('real research tool outcome is captured with explicit cycle, parent and call correlation only', async () => {
  const spans: TelemetrySpanRecord[] = [];
  const service = new ResearchToolsService(undefined as never, undefined as never, undefined as never, undefined as never,
    undefined, undefined, { recordSpan: (_owner: string, span: TelemetrySpanRecord) => spans.push(span) } as never);
  Object.defineProperty(service, 'currentSession', { value: async () => ({ authority: 'scope', session: {
    checkpoint: { cycleId: 'cycle' }, evidenceSnapshot: [], taskId: 'budget-task',
  } }) });
  Object.defineProperty(service, 'validateLibraryEvidence', { value: async () => true });
  Object.defineProperty(service, 'handle', { value: async () => ({ status: 'succeeded', data: 'private-tool-data', sources: [], asOf: new Date().toISOString(), truncated: false }) });
  Object.defineProperty(service, 'archiveProviderResult', { value: async (_tool: unknown, _owner: string, _scope: unknown, result: unknown) => result });
  const scope = { sessionId: 'b7b7a725-e92d-4995-aa07-5073642fe312', revision: 1, memberId: 'researcher',
    memberName: 'Researcher', turn: 0, ticker: 'AAPL', language: 'en' as const, webResearch: false, expiresAt: Date.now() + 60_000 };
  const result = await service.call('owner', scope, { callId: 'call-one', name: 'get_discussion_context', arguments: { limit: 1 } },
    { telemetryContext: { runId: `research:${scope.sessionId}:1:cycle`, sourceId: 'native-task', parentId: 'native:native-task' } });
  assert.equal(result.status, 'succeeded');
  assert.equal(spans.length, 2);
  assert.equal(spans[1].status, 'completed');
  assert.equal(spans[1].parentId, 'native:native-task');
  assert.equal(spans[1].sourceId, 'native-task');
  assert.equal(spans[1].runId, `research:${scope.sessionId}:1:cycle`);
  assert.doesNotMatch(JSON.stringify(spans), /private-tool-data|AAPL/);
});
