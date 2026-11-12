import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { telemetrySpans } from '../../database/telemetry.schema';
import type { TelemetrySpanRecord } from '../../../shared/telemetry.interface';
import { createLangfuseExporter, stableTelemetryTraceId, type TelemetryExporter } from './telemetry-langfuse';
import { telemetryDimensions } from './telemetry-identity.rules';

interface CaptureOptions { maxPending?: number; flushTimeoutMs?: number }
export interface TelemetryCaptureHealth {
  incomplete: boolean; dropped: number; persistenceFailures: number; exportFailures: number;
  /** A shared remote exporter failed; this is not another owner's execution counter. */
  exportUnavailable: boolean;
}

/** Instrumentation is observational even in reduced modules with a custom test provider. */
export function captureTelemetry(capture: TelemetryCaptureService | undefined, owner: string, record: TelemetrySpanRecord): void {
  try { capture?.recordSpan(owner, record); } catch { /* Telemetry cannot change execution outcomes. */ }
}
const identifier = (value: unknown, maximum = 250): string | null => typeof value === 'string'
  && value.length > 0 && value.length <= maximum && /^[\w.:/+-]+$/u.test(value) ? value : null;
const measurement = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value)
  && value >= 0 && value <= 2_147_483_647 ? value : null;

/** Explicit reconstruction makes accidentally forwarded private payload properties unrepresentable. */
function safeRecord(owner: string, input: TelemetrySpanRecord): TelemetrySpanRecord | null {
  const id = identifier(input.id); const runId = identifier(input.runId); const sourceId = identifier(input.sourceId);
  const start = new Date(input.startedAt);
  const end = input.completedAt ? new Date(input.completedAt) : null;
  if (!owner || !id || !runId || !sourceId || !Number.isFinite(start.getTime()) || end && !Number.isFinite(end.getTime())
    || !['task', 'agent', 'model', 'tool'].includes(input.kind)
    || !['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(input.status)) return null;
  return { ...telemetryDimensions(input), id, runId, sourceId, sessionId: identifier(input.sessionId), revision: measurement(input.revision),
    parentId: identifier(input.parentId), kind: input.kind, name: identifier(input.name, 100) ?? input.kind,
    title: input.kind === 'model' ? 'Model call' : input.kind === 'tool' ? 'Research tool' : 'Agent execution',
    scene: identifier(input.scene, 80) ?? 'analysis', status: input.status,
    agentId: identifier(input.agentId, 120), agentName: null, provider: identifier(input.provider, 200),
    model: identifier(input.model, 120), executionMode: identifier(input.executionMode, 40),
    startedAt: start.toISOString(), completedAt: end?.toISOString() ?? null,
    durationMs: end ? measurement(Math.max(0, end.getTime() - start.getTime())) : null,
    inputTokens: measurement(input.inputTokens), outputTokens: measurement(input.outputTokens), totalTokens: measurement(input.totalTokens),
    estimatedCostUsd: typeof input.estimatedCostUsd === 'number' && Number.isFinite(input.estimatedCostUsd)
      && input.estimatedCostUsd >= 0 ? input.estimatedCostUsd : null,
    errorCode: typeof input.errorCode === 'string' && /^[A-Z][A-Z_0-9]{1,79}$/u.test(input.errorCode) ? input.errorCode : null,
    attempt: Math.max(1, measurement(input.attempt) ?? 1), traceId: stableTelemetryTraceId(owner, runId) };
}

@Injectable()
export class TelemetryCaptureService implements OnModuleDestroy {
  private readonly logger = new Logger(TelemetryCaptureService.name);
  private readonly exporter?: TelemetryExporter;
  private readonly maxPending: number;
  private readonly flushTimeoutMs: number;
  private readonly pending = new Set<Promise<void>>();
  private readonly exported = new Set<string>();
  private readonly health = new Map<string, TelemetryCaptureHealth>();
  private healthOverflow = false;
  private exporterUnavailable = false;
  private tail: Promise<void> = Promise.resolve();
  private stopping = false;
  private shutdown?: Promise<void>;

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() @Inject('TELEMETRY_EXPORTER') exporter?: TelemetryExporter,
    @Optional() @Inject('TELEMETRY_CAPTURE_OPTIONS') options: CaptureOptions = {}) {
    this.maxPending = options.maxPending ?? 128;
    this.flushTimeoutMs = options.flushTimeoutMs ?? 2000;
    try { this.exporter = exporter ?? createLangfuseExporter(); }
    catch { this.exporterUnavailable = true; this.logger.warn('Telemetry exporter initialization failed'); }
  }

  get pendingCount(): number { return this.pending.size; }

  getCaptureHealth(owner: string): TelemetryCaptureHealth {
    const ownerHealth = this.health.get(owner);
    let batchFailed = false;
    try { batchFailed = (this.exporter?.getHealth?.().exportFailures ?? 0) > 0; }
    catch { batchFailed = true; }
    return { dropped: 0, persistenceFailures: 0, exportFailures: 0, ...ownerHealth,
      incomplete: Boolean(ownerHealth?.incomplete || this.healthOverflow || this.exporterUnavailable || batchFailed),
      exportUnavailable: this.exporterUnavailable || batchFailed };
  }

  private recordLoss(owner: string, field: 'dropped' | 'persistenceFailures' | 'exportFailures'): void {
    if (!this.health.has(owner) && this.health.size >= 4096) { this.healthOverflow = true; return; }
    const health = this.getCaptureHealth(owner);
    health.incomplete = true;
    health[field] = Math.min(2_147_483_647, health[field] + 1);
    this.health.set(owner, health);
  }

  /** No caller awaits capture. Failures can never retry or change a paid execution. */
  recordSpan(owner: string, input: TelemetrySpanRecord): void {
    if (this.stopping || this.pending.size >= this.maxPending) { this.recordLoss(owner, 'dropped'); return; }
    try {
      const record = safeRecord(owner, input);
      if (!record) { this.recordLoss(owner, 'dropped'); return; }
      const work = this.tail.then(async () => {
        const values = { ...record, owner, startedAt: new Date(record.startedAt),
          completedAt: record.completedAt ? new Date(record.completedAt) : null,
          estimatedCostUsd: record.estimatedCostUsd === null ? null : String(record.estimatedCostUsd) };
        try {
          await this.db.insert(telemetrySpans).values(values).onConflictDoUpdate({
            target: [telemetrySpans.owner, telemetrySpans.id], set: values,
            setWhere: sql`${telemetrySpans.completedAt} is null or excluded.completed_at is not null`,
          });
        } catch { this.recordLoss(owner, 'persistenceFailures'); this.logger.warn('Telemetry metadata persistence failed'); return; }
        const key = `${owner}:${record.id}`;
        if (!record.completedAt || this.exported.has(key)) return;
        this.exported.add(key);
        if (this.exported.size > 4096) this.exported.delete(this.exported.values().next().value!);
        try { await this.exporter?.export(record); }
        catch { this.recordLoss(owner, 'exportFailures'); this.logger.warn('Telemetry metadata export failed'); }
      });
      this.tail = work.catch(() => { this.logger.warn('Telemetry capture failed'); });
      this.pending.add(this.tail);
      const tracked = this.tail;
      void tracked.finally(() => this.pending.delete(tracked));
    } catch { this.recordLoss(owner, 'dropped'); this.logger.warn('Telemetry metadata rejected'); }
  }

  private async bounded(work: Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work.then(() => true, () => false), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), this.flushTimeoutMs);
    })]); } finally { if (timer) clearTimeout(timer); }
  }

  async flush(): Promise<void> {
    if (!await this.bounded(this.tail)) this.healthOverflow = true;
    try { if (this.exporter?.flush && !await this.bounded(this.exporter.flush())) this.exporterUnavailable = true; }
    catch { this.exporterUnavailable = true; this.logger.warn('Telemetry flush failed'); }
  }

  onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.shutdown ??= (async () => {
      await this.flush();
      try { if (this.exporter?.shutdown && !await this.bounded(this.exporter.shutdown())) this.exporterUnavailable = true; }
      catch { this.exporterUnavailable = true; this.logger.warn('Telemetry shutdown failed'); }
    })();
    return this.shutdown;
  }
}
