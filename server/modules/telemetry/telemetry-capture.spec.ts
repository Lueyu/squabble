import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryCaptureService } from './telemetry-capture.service';
import { createLangfuseExporter, getTelemetryIntegration, stableTelemetryTraceId, type TelemetryExporter } from './telemetry-langfuse';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { TelemetrySpanRecord } from '../../../shared/telemetry.interface';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const record = (changes: Partial<TelemetrySpanRecord> = {}): TelemetrySpanRecord => ({
  id: 'span-one', runId: 'model:task-one', sourceId: 'task-one', parentId: null,
  kind: 'model', name: 'model-call', title: 'Model call', scene: 'analysis', status: 'completed',
  agentId: null, agentName: null, provider: 'https://fixture.invalid', model: 'actual-model', executionMode: 'api',
  startedAt: '2026-11-11T01:00:00.000Z', completedAt: '2026-11-11T01:00:00.100Z', durationMs: 100,
  inputTokens: null, outputTokens: null, totalTokens: null, estimatedCostUsd: null,
  errorCode: null, attempt: 1, traceId: null, ...changes,
});

function fixture(exporter?: TelemetryExporter, reject = false) {
  const writes: Array<Record<string, unknown>> = [];
  const db = { insert: () => ({ values: (value: Record<string, unknown>) => ({
    onConflictDoUpdate: async () => { writes.push(value); if (reject) throw new Error('private-db-credential'); },
  }) }) };
  return { capture: new TelemetryCaptureService(db as never, exporter), writes };
}

test('remote export requires explicit opt-in and complete URL/key configuration', () => {
  const keys = { LANGFUSE_BASE_URL: 'http://localhost:3001', LANGFUSE_PUBLIC_KEY: 'public', LANGFUSE_SECRET_KEY: 'secret' };
  assert.equal(getTelemetryIntegration(keys).status, 'disabled');
  assert.equal(getTelemetryIntegration({ LANGFUSE_ENABLED: 'true' }).status, 'unavailable');
  assert.equal(getTelemetryIntegration({ ...keys, LANGFUSE_ENABLED: 'true' }).status, 'ready');
  assert.equal(getTelemetryIntegration({ ...keys, LANGFUSE_ENABLED: 'true', LANGFUSE_BASE_URL: 'https://user:secret@fixture.invalid' }).status, 'unavailable');
  assert.equal(getTelemetryIntegration(keys).captureContent, false);
  assert.notEqual(stableTelemetryTraceId('owner-a', 'run'), stableTelemetryTraceId('owner-b', 'run'));
});

test('capture persists only allowlisted metadata and leaves unavailable usage null', async () => {
  const sent: TelemetrySpanRecord[] = [];
  const { capture, writes } = fixture({ export: value => { sent.push(value); } });
  capture.recordSpan('owner-a', Object.assign(record(), { prompt: 'private prompt', completion: 'private completion', apiKey: 'private key' }));
  await capture.flush();
  assert.equal(writes.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(writes[0].owner, 'owner-a');
  assert.equal(writes[0].totalTokens, null);
  assert.equal(sent[0].totalTokens, null);
  assert.equal(sent[0].traceId, stableTelemetryTraceId('owner-a', 'model:task-one'));
  assert.doesNotMatch(JSON.stringify([writes, sent]), /private prompt|private completion|private key/);
});

test('capture database and exporter failures never reject caller or flush', async () => {
  const broken = fixture({ export: () => { throw new Error('private-exporter-key'); }, flush: async () => { throw new Error('private-flush-key'); } }, true);
  assert.doesNotThrow(() => broken.capture.recordSpan('owner', record()));
  await assert.doesNotReject(broken.capture.flush());
  const exported = fixture({ export: () => { throw new Error('private-exporter-key'); } });
  exported.capture.recordSpan('owner', record());
  await assert.doesNotReject(exported.capture.flush());
});

test('lifecycle updates keep span identity, terminal export is deduplicated, shutdown is idempotent', async () => {
  let exports = 0; let shutdowns = 0;
  const { capture, writes } = fixture({ export: () => { exports += 1; }, shutdown: async () => { shutdowns += 1; } });
  capture.recordSpan('owner', record({ status: 'running', completedAt: null, durationMs: null }));
  capture.recordSpan('owner', record());
  capture.recordSpan('owner', record());
  await capture.flush();
  assert.equal(writes.length, 3);
  assert.equal(new Set(writes.map(value => value.id)).size, 1);
  assert.equal(exports, 1);
  await capture.onModuleDestroy();
  await capture.onModuleDestroy();
  assert.equal(shutdowns, 1);
  capture.recordSpan('owner', record({ id: 'after-shutdown' }));
  await capture.flush();
  assert.equal(writes.length, 3);
});

test('queue and shutdown are bounded even when the database never settles', async () => {
  const db = { insert: () => ({ values: () => ({ onConflictDoUpdate: () => new Promise<void>(() => undefined) }) }) };
  const capture = new TelemetryCaptureService(db as never, undefined, { maxPending: 2, flushTimeoutMs: 15 });
  for (let index = 0; index < 10; index += 1) capture.recordSpan('owner', record({ id: `span-${index}` }));
  assert.ok(capture.pendingCount <= 2);
  assert.equal(capture.getCaptureHealth('owner').dropped, 8);
  assert.equal(capture.getCaptureHealth('other-owner').incomplete, false);
  const started = Date.now();
  await capture.onModuleDestroy();
  assert.ok(Date.now() - started < 500);
});

test('official SDK transport receives stable private spans with actual timing and known usage only', async () => {
  const sent: ReadableSpan[] = [];
  const exporter = createLangfuseExporter({ LANGFUSE_ENABLED: 'true', LANGFUSE_BASE_URL: 'https://langfuse.fixture.invalid',
    LANGFUSE_PUBLIC_KEY: 'fixture-public', LANGFUSE_SECRET_KEY: 'fixture-private-key' }, {
    export: (spans, done) => { sent.push(...spans); done({ code: 0 }); }, shutdown: async () => undefined,
  });
  assert.ok(exporter);
  const span = record({ parentId: 'parent-call', traceId: stableTelemetryTraceId('owner', 'model:task-one'),
    inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  exporter.export(span);
  exporter.export(span);
  await exporter.flush?.();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].spanContext().traceId, span.traceId);
  assert.equal(sent[0].spanContext().spanId, sent[1].spanContext().spanId);
  assert.deepEqual(sent[0].duration, [0, 100_000_000]);
  assert.equal(sent[0].attributes['langfuse.observation.type'], 'generation');
  assert.equal(sent[0].attributes['langfuse.observation.usage_details'], '{"input":2,"output":3,"total":5}');
  assert.equal(sent[0].attributes['langfuse.trace.public'], false);
  assert.doesNotMatch(JSON.stringify(sent.map(value => value.attributes)), /fixture-private-key|prompt|completion|portfolio/);
  await exporter.shutdown?.();
});

test('asynchronous SDK batch callback failure is visible without leaking another owner failure count', async () => {
  let sent = 0;
  const exporter = createLangfuseExporter({ LANGFUSE_ENABLED: 'true', LANGFUSE_BASE_URL: 'https://langfuse.fixture.invalid',
    LANGFUSE_PUBLIC_KEY: 'fixture-public', LANGFUSE_SECRET_KEY: 'fixture-private-key' }, {
    export: (_spans, done) => { sent += 1; queueMicrotask(() => done({ code: 1, error: new Error('private-transport-detail') })); },
    shutdown: async () => undefined,
  });
  const { capture } = fixture(exporter);
  capture.recordSpan('owner-a', record());
  await assert.doesNotReject(capture.flush());
  assert.equal(sent, 1);
  assert.equal(capture.getCaptureHealth('owner-a').incomplete, true);
  assert.equal(capture.getCaptureHealth('owner-a').exportUnavailable, true);
  assert.equal(capture.getCaptureHealth('owner-b').incomplete, true, 'mixed transport batches disclose only generic global failure');
  assert.equal(capture.getCaptureHealth('owner-b').exportFailures, 0, 'another owner counter is not exposed');
  await capture.onModuleDestroy();
});

test('production default official OTLP transport failure reaches capture health', async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    assert.equal(request.url, '/api/public/otel/v1/traces');
    assert.equal(request.headers['x-langfuse-ingestion-version'], '4');
    request.resume();
    response.writeHead(401); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const exporter = createLangfuseExporter({ LANGFUSE_ENABLED: 'true', LANGFUSE_BASE_URL: `http://127.0.0.1:${port}`,
    LANGFUSE_PUBLIC_KEY: 'fixture-public', LANGFUSE_SECRET_KEY: 'fixture-private-key' });
  const { capture, writes } = fixture(exporter);
  try {
    capture.recordSpan('owner', record());
    await assert.doesNotReject(capture.flush());
    assert.equal(requests, 1);
    assert.equal(writes.length, 1, 'remote export failure never rolls back durable local metadata');
    assert.equal(capture.getCaptureHealth('owner').incomplete, true);
  } finally {
    await capture.onModuleDestroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
