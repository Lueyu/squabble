import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiSdkModelAdapter, publicModelFetch } from './ai-sdk-model.adapter';
import type { ModelStepRequest } from './model-step.interface';
import { ModelStepService } from './model-step.service';

const request: ModelStepRequest = {
  owner: 'owner', connectionId: 'connection', connectionRevision: 1, model: 'fixture-model',
  messages: [{ role: 'system', content: 'Frozen private input stays complete.' },
    { role: 'user', content: 'Read the entire supplied portfolio.' }],
  catalog: { catalogVersionId: 'catalog', schemaHash: 'a'.repeat(64), connectionRevisions: {},
    aliases: { lookup: 'read-tool' }, descriptors: [{ id: 'read-tool', name: 'lookup',
      connectionId: null, catalogVersionId: 'catalog', schemaHash: 'a'.repeat(64),
      description: 'Read a source', inputSchema: { type: 'object', properties: { ticker: { type: 'string' } },
        required: ['ticker'], additionalProperties: false }, effect: 'read', dataClasses: ['public'],
      timeoutMs: 1000, maxOutputBytes: 1000, supportsCancellation: false,
      supportsStatusLookup: false, remoteIdempotency: 'unsupported' }] },
};
const connection = { baseUrl: 'https://fixture.provider.com/v1', apiKey: 'fake-test-key' };

test('AI SDK adapter makes one request and leaves tool execution to the durable runtime', async () => {
  const bodies: Record<string, unknown>[] = [];
  const adapter = new AiSdkModelAdapter(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ id: 'provider-receipt', model: request.model, created: 1,
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"ticker":"US:EXAMPLE"}' } }] } }],
      usage: { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 } });
  });
  const result = await adapter.generate(request, connection);
  assert.equal(bodies.length, 1);
  assert.notEqual(bodies[0].stream, true);
  assert.deepEqual(result.toolCalls, [{ id: 'call-1', toolId: 'read-tool', arguments: { ticker: 'US:EXAMPLE' } }]);
  assert.equal(result.providerRequestId, 'provider-receipt');
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 8, totalTokens: 15 });
});

test('transport errors do not cause an SDK retry or repair call', async () => {
  let sends = 0;
  const adapter = new AiSdkModelAdapter(async () => { sends += 1; return new Response('unavailable', { status: 503 }); });
  await assert.rejects(adapter.generate(request, connection));
  assert.equal(sends, 1);
});

test('missing provider usage remains unknown and invalid arguments survive as local feedback', async () => {
  const adapter = new AiSdkModelAdapter(async () => Response.json({ id: 'unknown-usage', model: request.model, created: 1,
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [
      { id: 'bad-call', type: 'function', function: { name: 'lookup', arguments: '{broken' } },
    ] } }] }));
  const result = await adapter.generate(request, connection);
  assert.equal(result.usage, null);
  assert.equal(result.toolCalls[0].id, 'bad-call');
  assert.equal(result.toolCalls[0].invalid, true);
});

test('zero placeholders and inconsistent provider usage remain unknown', async () => {
  for (const usage of [
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    { prompt_tokens: 10, completion_tokens: 5, total_tokens: 4 },
  ]) {
    const adapter = new AiSdkModelAdapter(async () => Response.json({ id: 'placeholder', model: request.model, created: 1,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }], usage }));
    assert.equal((await adapter.generate(request, connection)).usage, null);
  }
});

test('provider total usage including additional billed tokens survives SDK normalization', async () => {
  const adapter = new AiSdkModelAdapter(async () => Response.json({ id: 'reasoning', model: request.model, created: 1,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
    usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 1000 } }));
  assert.deepEqual((await adapter.generate(request, connection)).usage, { inputTokens: 100, outputTokens: 100, totalTokens: 1000 });
});

test('a missing total is the exact sum only when both component counts are valid', async () => {
  const adapter = new AiSdkModelAdapter(async () => Response.json({ id: 'components', model: request.model, created: 1,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
    usage: { prompt_tokens: 7, completion_tokens: 3 } }));
  assert.deepEqual((await adapter.generate(request, connection)).usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
});

test('frozen descriptors reject remote schemas before transport', async () => {
  let sends = 0;
  const adapter = new AiSdkModelAdapter(async () => { sends += 1; throw new Error('must not send'); });
  const invalid = structuredClone(request);
  invalid.catalog.descriptors[0].inputSchema = { $ref: 'https://example.com/schema.json' };
  await assert.rejects(adapter.generate(invalid, connection), /TOOL_SCHEMA_REF/);
  assert.equal(sends, 0);
});

test('real model service freezes the selected connection and refuses changed credentials before transport', async () => {
  let key = 'first-fake-key', sends = 0;
  const service = new ModelStepService({ getLlmConfig: async () => ({ source: 'user', apiKey: key,
    baseUrl: connection.baseUrl, fastModel: 'fast', slowModel: 'slow' }) },
  new AiSdkModelAdapter(async () => { sends += 1; throw new Error('must not send'); }));
  const resolved = await service.resolve('owner', undefined, 'slow');
  assert.equal(resolved.connectionId, ''); assert.equal(resolved.model, 'slow');
  key = 'second-fake-key';
  await assert.rejects(service.generate({ ...request, ...resolved }), /MODEL_CONNECTION_CHANGED/);
  assert.equal(sends, 0);
  await assert.rejects(service.generate(request), /MODEL_CONNECTION_SNAPSHOT_REQUIRED/);
});

test('production SDK transport rejects local, private and non-HTTPS URLs before opening a socket', async () => {
  await assert.rejects(publicModelFetch('http://127.0.0.1/v1/chat/completions'), /MODEL_HTTPS_REQUIRED/);
  await assert.rejects(publicModelFetch('https://127.0.0.1/v1/chat/completions'), /public HTTPS host/);
});

test('a frozen aggregate catalog preserves different connection catalog versions on SDK descriptors', async () => {
  const mixed = structuredClone(request);
  mixed.catalog.catalogVersionId = 'aggregate-catalog';
  mixed.catalog.descriptors[0].catalogVersionId = 'connection-one-version';
  mixed.catalog.descriptors[0].connectionId = 'connection-one';
  mixed.catalog.descriptors.push({ ...mixed.catalog.descriptors[0], id: 'second-tool', name: 'second',
    catalogVersionId: 'connection-two-version', connectionId: 'connection-two' });
  mixed.catalog.aliases.second = 'second-tool';
  let sends = 0;
  const adapter = new AiSdkModelAdapter(async (_url, init) => {
    sends += 1;
    const body = JSON.parse(String(init.body)) as { tools: unknown[] };
    assert.equal(body.tools.length, 2);
    return Response.json({ id: 'mixed', model: request.model, created: 1,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] });
  });
  assert.equal((await adapter.generate(mixed, connection)).text, 'done');
  assert.equal(sends, 1);
  assert.deepEqual(mixed.catalog.descriptors.map(tool => tool.catalogVersionId), ['connection-one-version', 'connection-two-version']);
});

test('explicit JSON action mode sends the frozen action protocol and schemas in the single prompt', async () => {
  let sends = 0;
  const adapter = new AiSdkModelAdapter(async (_url, init) => {
    sends += 1;
    const body = JSON.parse(String(init.body)) as { tools?: unknown[]; messages: Array<{ role: string; content: string }> };
    assert.equal(body.tools, undefined);
    const content = body.messages.map(message => message.content).join('\n');
    assert.match(content, /"type":"tool_calls"/);
    assert.match(content, /read-tool/);
    assert.match(content, /additionalProperties/);
    return Response.json({ id: 'json-mode', model: request.model, created: 1,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"type":"final","text":"done"}' } }] });
  });
  await adapter.generate({ ...request, jsonActionMode: true }, connection);
  assert.equal(sends, 1);
});
