import { createHash } from 'node:crypto';
import { trace, ROOT_CONTEXT, SpanStatusCode, TraceFlags, type Attributes } from '@opentelemetry/api';
import { BasicTracerProvider, type IdGenerator, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { TelemetryIntegration, TelemetrySpanRecord } from '../../../shared/telemetry.interface';

export interface TelemetryExporter {
  export(record: TelemetrySpanRecord): void | Promise<void>;
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
  /** Batch results can arrive after export() returns; counts are instance-global, not owner facts. */
  getHealth?(): { exportFailures: number };
}

function displayUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/u, '');
  } catch { return null; }
}

/** Configuration status is local only: opening telemetry never contacts a remote server. */
export function getTelemetryIntegration(env: NodeJS.ProcessEnv = process.env): TelemetryIntegration {
  const enabled = env.LANGFUSE_ENABLED === 'true';
  const baseUrl = displayUrl(env.LANGFUSE_BASE_URL);
  const configured = Boolean(baseUrl && env.LANGFUSE_PUBLIC_KEY?.trim() && env.LANGFUSE_SECRET_KEY?.trim());
  return { enabled, configured, status: !enabled ? 'disabled' : configured ? 'ready' : 'unavailable',
    baseUrl, projectUrl: displayUrl(env.LANGFUSE_PROJECT_URL), captureContent: false };
}

export function stableTelemetryTraceId(owner: string, runId: string): string {
  return createHash('sha256').update(JSON.stringify(['squabble-telemetry', owner, runId])).digest('hex').slice(0, 32);
}

function spanId(runId: string, id: string): string {
  return createHash('sha256').update(JSON.stringify([runId, id])).digest('hex').slice(0, 16);
}

class StableIds implements IdGenerator {
  trace = '';
  span = '';
  generateTraceId(): string { return this.trace; }
  generateSpanId(): string { return this.span; }
}

/** A private provider exports only the explicitly built spans; it never registers globally. */
export function createLangfuseExporter(env: NodeJS.ProcessEnv = process.env, transport?: SpanExporter): TelemetryExporter | undefined {
  const integration = getTelemetryIntegration(env);
  if (integration.status !== 'ready') return undefined;
  const delegate = transport ?? new OTLPTraceExporter({
    url: `${integration.baseUrl}/api/public/otel/v1/traces`, timeoutMillis: 2000,
    headers: { Authorization: `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString('base64')}`,
      'x-langfuse-ingestion-version': '4' },
  });
  let exportFailures = 0;
  const markFailure = (): void => { exportFailures = Math.min(2_147_483_647, exportFailures + 1); };
  // The SDK deliberately swallows asynchronous batch failures. Observe its supported
  // exporter callback locally, preserving the SDK pipeline and global diagnostics.
  const observedTransport: SpanExporter = {
    export(spans, done) {
      let settled = false;
      const finish: Parameters<SpanExporter['export']>[1] = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result.code !== 0) {
          markFailure();
          done({ code: 1, error: new Error('TELEMETRY_REMOTE_EXPORT_FAILED') });
        } else done(result);
      };
      const timer = setTimeout(() => finish({ code: 1 }), 2000);
      try { delegate.export(spans, finish); }
      catch { finish({ code: 1 }); }
    },
    async shutdown() {
      try { await delegate.shutdown(); }
      catch { markFailure(); throw new Error('TELEMETRY_REMOTE_SHUTDOWN_FAILED'); }
    },
    async forceFlush() {
      try { await delegate.forceFlush?.(); }
      catch { markFailure(); throw new Error('TELEMETRY_REMOTE_FLUSH_FAILED'); }
    },
  };
  const processor = new LangfuseSpanProcessor({ baseUrl: integration.baseUrl!,
    publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY,
    exporter: observedTransport, flushAt: 64, flushInterval: 5, timeout: 2,
    mediaUploadEnabled: false,
    shouldExportSpan: ({ otelSpan }) => otelSpan.instrumentationScope.name === 'squabble.telemetry',
  });
  const ids = new StableIds();
  const provider = new BasicTracerProvider({ spanProcessors: [processor], idGenerator: ids, forceFlushTimeoutMillis: 2000,
    spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 1000, eventCountLimit: 0 } });
  const tracer = provider.getTracer('squabble.telemetry');
  return {
    export(record) {
      if (!record.completedAt || !record.traceId) return;
      ids.trace = record.traceId;
      ids.span = spanId(record.runId, record.id);
      const parent = record.parentId ? trace.setSpanContext(ROOT_CONTEXT, {
        traceId: record.traceId, spanId: spanId(record.runId, record.parentId), traceFlags: TraceFlags.SAMPLED,
      }) : ROOT_CONTEXT;
      const attributes: Attributes = {
        'langfuse.observation.type': record.kind === 'model' ? 'generation' : record.kind === 'task' ? 'span' : record.kind,
        'langfuse.trace.name': 'Squabble agent execution',
        'langfuse.trace.public': false,
        'squabble.run_id': record.runId, 'squabble.span_id': record.id, 'squabble.status': record.status,
        'squabble.attempt': record.attempt, 'squabble.scene': record.scene,
      };
      if (record.model) attributes['langfuse.observation.model.name'] = record.model;
      if (record.provider) attributes['gen_ai.provider.name'] = record.provider;
      if (record.agentId) attributes['squabble.agent_id'] = record.agentId;
      if (record.executionMode) attributes['squabble.execution_mode'] = record.executionMode;
      const usage: Record<string, number> = {};
      if (record.inputTokens !== null) usage.input = record.inputTokens;
      if (record.outputTokens !== null) usage.output = record.outputTokens;
      if (record.totalTokens !== null) usage.total = record.totalTokens;
      if (Object.keys(usage).length) attributes['langfuse.observation.usage_details'] = JSON.stringify(usage);
      if (record.estimatedCostUsd !== null) attributes['langfuse.observation.cost_details'] = JSON.stringify({ total: record.estimatedCostUsd });
      if (record.errorCode) attributes['langfuse.observation.status_message'] = record.errorCode;
      const span = tracer.startSpan(record.name, { startTime: new Date(record.startedAt), attributes }, parent);
      if (record.status === 'failed' || record.status === 'cancelled') span.setStatus({ code: SpanStatusCode.ERROR, message: record.errorCode ?? record.status });
      span.end(new Date(record.completedAt));
    },
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
    getHealth: () => ({ exportFailures }),
  };
}
