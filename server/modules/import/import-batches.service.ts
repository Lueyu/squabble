import { PortfolioHistoryService } from '../portfolio-history/portfolio-history.service';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '../../common/platform';
import { holdings, importLogs } from '../../database/schema';
import {
  importBatches,
  importCommitReceipts,
} from '../../database/import-batches.schema';
import type {
  ImportBatch,
  ImportBatchCommit,
  ImportBatchCreate,
  ImportBatchPreview,
  ImportBatchRow,
  ImportBatchUpload,
  ImportCommitReceipt,
  ImportExecutor,
  ScreenshotResult,
} from '../../../shared/screenshot-import.interface';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { OcrService } from './ocr.service';
import { ImportBatchFiles } from './import-batch-files';
import { EXTRACTION_PROMPT, parseScreenshotResult } from './screenshot-result';
import { mergeScreenshotRows, securityIdentity } from './screenshot-merge';
import { parseNativeAgentConfiguration } from '../local-agents/local-agents.requests';
import { ImportAnalysisHandoffService } from '../experience/import-analysis-handoff.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { recordPositionCheckpoint } from './position-checkpoint';
const terminal = (state: string) =>
  ['completed', 'failed', 'cancelled'].includes(state);
const terminationConfirmed = (task: {
  state: string;
  error?: string;
  runtimeEntered?: boolean;
  commandEmitted?: boolean;
}) =>
  terminal(task.state) &&
  task.error !== 'LOCAL_DISPATCH_UNCERTAIN' &&
  !(
    task.error === 'LOCAL_INTERRUPTED' &&
    (task.runtimeEntered || task.commandEmitted)
  );
const globalFailure = (code: string) =>
  /AUTH|LOGIN|USAGE_LIMIT|RATE_LIMIT|UNSUPPORTED|CONFIGURATION|UNAVAILABLE|TOOL_ISOLATION|AGENT_NOT_FOUND|BUSY|CREDENTIALS|PAUSED|COMPANION_OFFLINE/.test(
    code,
  );
const safeError = (error: unknown) => {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  return /^(?:LOCAL|VISION)_[A-Z_]+$/.test(code) ||
    ['NO_HOLDINGS', 'INVALID_RESULT'].includes(code)
    ? code
    : 'EXTRACTION_FAILED';
};
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (id: string) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw new BadRequestException('INVALID_REQUEST');
};
@Injectable()
export class ImportBatchesService implements OnModuleInit, OnModuleDestroy {
  private running = new Map<string, Promise<void>>();
  private aborts = new Map<string, AbortController>();
  private credentials = new Map<
    string,
    Extract<
      ImportExecutor,
      {
        executor: 'vision';
      }
    >
  >();
  private stopping = false;
  private sweep?: ReturnType<typeof setInterval>;
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
    private readonly agents: LocalAgentsService,
    private readonly ocr: OcrService,
    private readonly files: ImportBatchFiles,
    @Optional()
    private readonly handoff?: ImportAnalysisHandoffService,
    @Optional() private readonly portfolioHistory?: PortfolioHistoryService,
  ) {}
  async onModuleInit() {
    await this.recover();
    this.sweep = setInterval(() => {
      void this.expire().catch(() => undefined);
    }, 60000);
    this.sweep.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.sweep) clearInterval(this.sweep);
    for (const abort of this.aborts.values()) abort.abort();
    await Promise.allSettled(this.running.values());
    this.credentials.clear();
  }
  private async mutate(
    owner: string,
    id: string,
    change: (batch: ImportBatch) => void | Promise<void>,
    revision?: number,
  ): Promise<ImportBatch> {
    uuid(id);
    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .select()
        .from(importBatches)
        .where(and(eq(importBatches.id, id), eq(importBatches.owner, owner)))
        .for('update');
      if (!record) throw new NotFoundException('BATCH_NOT_FOUND');
      const batch = structuredClone(record.state);
      if (revision !== undefined && batch.revision !== revision)
        throw new ConflictException('BATCH_CHANGED');
      await change(batch);
      batch.revision++;
      batch.updatedAt = new Date().toISOString();
      await tx
        .update(importBatches)
        .set({ state: batch, revision: batch.revision, updatedAt: new Date() })
        .where(eq(importBatches.id, id));
      return batch;
    });
  }
  async list(owner: string) {
    return (
      await this.db
        .select()
        .from(importBatches)
        .where(eq(importBatches.owner, owner))
        .orderBy(desc(importBatches.updatedAt))
        .limit(20)
    ).map((record) => record.state);
  }
  async get(owner: string, id: string): Promise<ImportBatch> {
    uuid(id);
    const [record] = await this.db
      .select()
      .from(importBatches)
      .where(and(eq(importBatches.id, id), eq(importBatches.owner, owner)));
    if (!record) throw new NotFoundException('BATCH_NOT_FOUND');
    return structuredClone(record.state);
  }
  async create(owner: string, input: ImportBatchCreate) {
    uuid(input.id);
    const route = input.executor;
    let executor: ImportBatch['executor'];
    if (
      route?.executor === 'local' &&
      typeof route.agentId === 'string' &&
      route.agentId.length <= 100
    ) {
      executor = {
        executor: 'local',
        agentId: route.agentId,
        agentSettings: parseNativeAgentConfiguration(route.agentSettings),
      };
    } else if (
      route?.executor === 'vision' &&
      typeof route.apiKey === 'string' &&
      route.apiKey.trim() &&
      route.apiKey.length <= 4096 &&
      !/[\r\n]/.test(route.apiKey) &&
      typeof route.model === 'string' &&
      route.model.length <= 200 &&
      route.model.trim()
    ) {
      executor = {
        executor: 'vision',
        model: route.model,
        baseUrl: route.baseUrl,
      };
    } else throw new BadRequestException('INVALID_REQUEST');
    const timestamp = new Date().toISOString(),
      batch: ImportBatch = {
        id: input.id,
        revision: 0,
        status: 'draft',
        executor,
        images: [],
        rows: [],
        receipts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        performance: {
          strategy: 'single_image',
          maxConcurrency: 1,
          reason: 'SOURCE_ATTRIBUTION_NOT_VERIFIED',
        },
      };
    const inserted = await this.db
      .insert(importBatches)
      .values({ id: batch.id, owner, state: batch })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) {
      const previous = await this.get(owner, input.id);
      if (hash(previous.executor) !== hash(executor))
        throw new ConflictException('BATCH_REQUEST_CONFLICT');
      if (route.executor === 'vision')
        this.credentials.set(`${owner}:${input.id}`, route);
      return previous;
    }
    if (route.executor === 'vision')
      this.credentials.set(`${owner}:${input.id}`, route);
    return batch;
  }
  async upload(owner: string, id: string, input: ImportBatchUpload) {
    uuid(input.id);
    const batch = await this.get(owner, id);
    if (batch.images.some((image) => image.id === input.id)) return batch;
    if (batch.status !== 'draft' || batch.images.length >= 20)
      throw new ConflictException('BATCH_UPLOAD_CLOSED');
    const started = Date.now();
    const saved = await this.files
      .put(owner, input.id, input.image, id)
      .catch(() => {
        throw new BadRequestException('INVALID_IMAGE');
      });
    try {
      let duplicate = false;
      const updated = await this.mutate(owner, id, (current) => {
        if (
          current.status !== 'draft' ||
          current.images.length >= 20 ||
          current.images.reduce((bytes, image) => bytes + image.bytes, 0) +
            saved.bytes >
            160 * 1024 * 1024
        )
          throw new BadRequestException('BATCH_UPLOAD_CLOSED');
        if (
          current.images.some(
            (image) => image.fingerprint === saved.fingerprint,
          )
        ) {
          duplicate = true;
          return;
        }
        current.images.push({
          id: input.id,
          filename: String(input.filename ?? 'image').slice(0, 255),
          ...saved,
          mimeType: input.image.mimeType,
          status: 'queued',
          attempt: 0,
          expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
          fileAvailable: true,
          timings: { uploadMs: Date.now() - started },
        });
      });
      if (duplicate) await this.files.remove(owner, input.id, id);
      return updated;
    } catch (error) {
      await this.files.remove(owner, input.id, id);
      throw error;
    }
  }
  async image(owner: string, id: string, imageId: string) {
    const batch = await this.get(owner, id),
      image = batch.images.find((image) => image.id === imageId);
    if (!image?.fileAvailable || Date.parse(image.expiresAt) <= Date.now())
      throw new NotFoundException('IMAGE_EXPIRED');
    return this.files.read(
      owner,
      imageId,
      image.mimeType,
      async (bytes) => bytes,
      id,
    );
  }
  async start(
    owner: string,
    id: string,
    credentials?: Extract<
      ImportExecutor,
      {
        executor: 'vision';
      }
    >,
  ) {
    if (credentials) {
      const batch = await this.get(owner, id);
      if (
        batch.executor.executor !== 'vision' ||
        credentials.executor !== 'vision' ||
        credentials.model !== batch.executor.model ||
        (credentials.baseUrl ?? '') !== (batch.executor.baseUrl ?? '') ||
        typeof credentials.apiKey !== 'string' ||
        !credentials.apiKey.trim() ||
        credentials.apiKey.length > 4096 ||
        /[\r\n]/.test(credentials.apiKey)
      )
        throw new BadRequestException('INVALID_REQUEST');
      this.credentials.set(`${owner}:${id}`, credentials);
    }
    const batch = await this.mutate(owner, id, (current) => {
      if (current.images.some((image) => image.status === 'unknown'))
        throw new ConflictException('TASK_STATUS_UNKNOWN');
      if (!current.images.length) throw new BadRequestException('NO_IMAGES');
      current.status = 'queued';
      delete current.pauseReason;
    });
    this.kick(owner, id);
    return batch;
  }
  private kick(owner: string, id: string) {
    if (this.running.has(id) || this.stopping) return;
    const promise = Promise.resolve()
      .then(() => this.run(owner, id))
      .catch(() =>
        this.mutate(owner, id, (batch) => {
          batch.status = 'paused';
          batch.pauseReason = 'RECOVERY_REQUIRED';
        }).catch(() => undefined),
      )
      .then(() => undefined)
      .finally(() => this.running.delete(id));
    this.running.set(id, promise);
  }
  async waitForIdle(id: string) {
    await this.running.get(id);
  }
  private append(
    batch: ImportBatch,
    imageId: string,
    result: ScreenshotResult,
  ) {
    const additions: ImportBatchRow[] = result.rows.map((row) => ({
      ...row,
      id: randomUUID(),
      sourceImageIds: [imageId],
      revision: 0,
    }));
    for (const problem of result.problemRows ?? [])
      additions.push({
        id: randomUUID(),
        sourceImageIds: [imageId],
        ticker:
          typeof problem.raw.ticker === 'string' ? problem.raw.ticker : '',
        shares:
          typeof problem.raw.shares === 'number' ||
          typeof problem.raw.shares === 'string'
            ? problem.raw.shares
            : '',
        avgCost:
          typeof problem.raw.avgCost === 'number' ||
          typeof problem.raw.avgCost === 'string'
            ? problem.raw.avgCost
            : null,
        company:
          typeof problem.raw.company === 'string' ? problem.raw.company : null,
        currency:
          typeof problem.raw.currency === 'string' &&
          ['USD', 'HKD', 'CNY'].includes(problem.raw.currency.toUpperCase())
            ? problem.raw.currency.toUpperCase()
            : null,
        currentPrice:
          typeof problem.raw.currentPrice === 'number' ||
          typeof problem.raw.currentPrice === 'string'
            ? problem.raw.currentPrice
            : null,
        raw: problem.raw,
        issues: problem.issues,
        revision: 0,
      });
    batch.rows = mergeScreenshotRows([...batch.rows, ...additions]);
    const image = batch.images.find((image) => image.id === imageId)!;
    image.rowCount = result.rows.length;
    image.problemCount = result.problemRows?.length ?? 0;
    image.status = 'completed';
    batch.firstResultMs ??= Date.now() - Date.parse(batch.createdAt);
  }
  private async run(owner: string, id: string) {
    while (!this.stopping) {
      const batch = await this.get(owner, id);
      if (!['queued', 'running'].includes(batch.status)) return;
      const next = batch.images.find((image) => image.status === 'queued');
      if (!next) {
        await this.mutate(owner, id, (current) => {
          if (['queued', 'running'].includes(current.status))
            current.status = 'completed';
        });
        return;
      }
      if (!next.fileAvailable || Date.parse(next.expiresAt) <= Date.now()) {
        await this.mutate(owner, id, (current) => {
          const image = current.images.find((image) => image.id === next.id)!;
          image.status = 'cancelled';
          image.error = 'IMAGE_EXPIRED';
        });
        continue;
      }
      if (
        batch.executor.executor === 'vision' &&
        !this.credentials.has(`${owner}:${id}`)
      ) {
        await this.mutate(owner, id, (current) => {
          if (['queued', 'running'].includes(current.status)) {
            current.status = 'paused';
            current.pauseReason = 'VISION_CREDENTIALS_REQUIRED';
          }
        });
        return;
      }
      const abort = new AbortController();
      this.aborts.set(next.id, abort);
      const started = Date.now();
      let inferenceStarted = started;
      let claimed = false;
      await this.mutate(owner, id, (current) => {
        const image = current.images.find((image) => image.id === next.id)!;
        if (
          !['queued', 'running'].includes(current.status) ||
          image.status !== 'queued'
        )
          return;
        if (!image.fileAvailable || Date.parse(image.expiresAt) <= Date.now()) {
          image.status = 'cancelled';
          image.error = 'IMAGE_EXPIRED';
          return;
        }
        current.status = 'running';
        image.status = 'running';
        image.attempt++;
        delete image.error;
        claimed = true;
      });
      if (!claimed) {
        this.aborts.delete(next.id);
        continue;
      }
      try {
        const result = await this.files.read(
          owner,
          next.id,
          next.mimeType,
          async (image) => {
            if (batch.executor.executor === 'local') {
              const probeStarted = Date.now();
              await this.agents.validate(
                owner,
                batch.executor.agentId,
                batch.executor.agentSettings,
                true,
              );
              const probeMs = Date.now() - probeStarted;
              await this.mutate(owner, id, (current) => {
                const image = current.images.find(
                  (image) => image.id === next.id,
                )!;
                image.timings = { ...image.timings, probeMs };
              });
              const response = await this.agents.execute(owner, {
                ...batch.executor,
                messageId: `import:${id}:${next.id}:${next.attempt + 1}`,
                prompt: EXTRACTION_PROMPT,
                image,
                signal: abort.signal,
                onTask: async (ref) => {
                  await this.mutate(owner, id, (current) => {
                    current.images.find(
                      (image) => image.id === next.id,
                    )!.taskId = ref.taskId;
                  });
                },
                onDispatch: async () => {
                  inferenceStarted = Date.now();
                  await this.mutate(owner, id, (current) => {
                    current.images.find(
                      (image) => image.id === next.id,
                    )!.timings = {
                      ...next.timings,
                      probeMs,
                      startupMs: inferenceStarted - started - probeMs,
                    };
                  });
                },
                onProgress: async () => undefined,
                shouldContinue: async () => !abort.signal.aborted,
              });
              const validationStarted = Date.now(),
                result = parseScreenshotResult(response.text, next.id);
              await this.mutate(owner, id, (current) => {
                const image = current.images.find(
                  (image) => image.id === next.id,
                )!;
                image.timings = {
                  ...image.timings,
                  inferenceMs: validationStarted - inferenceStarted,
                  validationMs: Date.now() - validationStarted,
                  totalMs: Date.now() - started,
                };
              });
              return result;
            }
            const route = this.credentials.get(`${owner}:${id}`)!;
            return this.ocr.extract(
              {
                ...route,
                imageBase64: `data:${image.mimeType};base64,${image.data}`,
              },
              abort.signal,
            );
          },
          id,
        );
        await this.mutate(owner, id, (current) => {
          const image = current.images.find((image) => image.id === next.id)!;
          if (
            image.status !== 'running' ||
            current.status === 'cancelled' ||
            abort.signal.aborted
          )
            return;
          this.append(current, next.id, result);
          image.timings = { ...image.timings, totalMs: Date.now() - started };
        });
      } catch (error) {
        const code = safeError(error);
        await this.mutate(owner, id, (current) => {
          const image = current.images.find((image) => image.id === next.id)!;
          if (image.status !== 'running') return;
          image.status =
            code === 'LOCAL_DISPATCH_UNCERTAIN'
              ? 'unknown'
              : abort.signal.aborted
                ? 'cancelled'
                : 'failed';
          image.error = code;
          image.timings = { ...image.timings, totalMs: Date.now() - started };
          if (globalFailure(code) || image.status === 'unknown') {
            current.status = 'paused';
            current.pauseReason = code;
          }
        });
      } finally {
        this.aborts.delete(next.id);
      }
    }
  }
  async edit(
    owner: string,
    id: string,
    rowId: string,
    patch: Partial<ImportBatchRow>,
    expectedRevision: number,
  ) {
    const allowed = [
      'ticker',
      'market',
      'company',
      'shares',
      'avgCost',
      'currentPrice',
      'currency',
      'confirmed',
    ];
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      Object.keys(patch).some((key) => !allowed.includes(key)) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      (patch.ticker !== undefined &&
        (typeof patch.ticker !== 'string' || patch.ticker.length > 40)) ||
      (patch.market !== undefined &&
        !['US', 'HK', 'CN'].includes(patch.market)) ||
      (patch.company != null &&
        (typeof patch.company !== 'string' || patch.company.length > 200)) ||
      (patch.currency != null &&
        (typeof patch.currency !== 'string' ||
          !['USD', 'HKD', 'CNY'].includes(patch.currency))) ||
      (patch.confirmed !== undefined && typeof patch.confirmed !== 'boolean') ||
      ['shares', 'avgCost', 'currentPrice'].some(
        (field) =>
          patch[field] != null &&
          !['number', 'string'].includes(typeof patch[field]),
      )
    )
      throw new BadRequestException('INVALID_ROW_PATCH');
    return this.mutate(
      owner,
      id,
      (batch) => {
        const row = batch.rows.find((row) => row.id === rowId);
        if (!row) throw new NotFoundException('ROW_NOT_FOUND');
        Object.assign(row, patch);
        row.revision = (row.revision ?? 0) + 1;
        row.edits ??= [];
        row.edits.push({ at: new Date().toISOString(), patch: { ...patch } });
        if (patch.confirmed) {
          this.validateRow(row);
          row.issues = [];
          row.conflicts = [];
        }
      },
      expectedRevision,
    );
  }
  private validateRow(row: ImportBatchRow) {
    if (
      typeof row.ticker !== 'string' ||
      (row.company != null && typeof row.company !== 'string') ||
      (row.market !== undefined && !['US', 'HK', 'CN'].includes(row.market))
    )
      throw new BadRequestException('INVALID_ROWS');
    const identity = securityIdentity(row.ticker, row.market),
      quantity = Number(row.shares),
      cost =
        row.avgCost == null || row.avgCost === '' ? null : Number(row.avgCost),
      price =
        row.currentPrice == null || row.currentPrice === ''
          ? null
          : Number(row.currentPrice);
    if (
      !identity ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      quantity > Number.MAX_SAFE_INTEGER ||
      (cost !== null && (!Number.isFinite(cost) || cost < 0)) ||
      (price !== null && (!Number.isFinite(price) || price < 0)) ||
      !row.currency ||
      !['USD', 'HKD', 'CNY'].includes(row.currency) ||
      (row.company && row.company.length > 200)
    )
      throw new BadRequestException('INVALID_ROWS');
    return { identity, quantity, cost, price };
  }
  private async positions(owner: string) {
    return this.db
      .select()
      .from(holdings)
      .where(eq(holdings.owner, owner))
      .orderBy(holdings.id);
  }
  private holdingsRevision(
    positions: Awaited<ReturnType<ImportBatchesService['positions']>>,
  ) {
    return hash(
      positions.map((row) => [
        row.id,
        row.ticker,
        row.market,
        row.shares,
        row.buyPrice,
        row.company,
        row.currency,
        row.updatedAt,
      ]),
    );
  }
  async preview(owner: string, id: string): Promise<ImportBatchPreview> {
    const batch = await this.get(owner, id),
      positions = await this.positions(owner);
    return {
      holdingsRevision: this.holdingsRevision(positions),
      changes: batch.rows.map((row) => {
        const identity = securityIdentity(row.ticker, row.market),
          before = positions.find(
            (position) =>
              securityIdentity(position.ticker, position.market ?? undefined)
                ?.key === identity?.key,
          );
        let kind: 'new' | 'update' | 'unchanged' | 'review' = 'review';
        try {
          this.validateRow(row);
          if (!row.conflicts?.length && !row.issues?.length)
            kind = !before
              ? 'new'
              : Number(before.shares) !== Number(row.shares) ||
                  (before.buyPrice === null
                    ? null
                    : Number(before.buyPrice)) !==
                    (row.avgCost == null || row.avgCost === ''
                      ? null
                      : Number(row.avgCost))
                ? 'update'
                : 'unchanged';
        } catch {
          /* Review stays visible. */
        }
        return {
          rowId: row.id,
          ticker: row.ticker,
          kind,
          before: before
            ? { shares: before.shares, avgCost: before.buyPrice }
            : undefined,
          after: { shares: row.shares, avgCost: row.avgCost },
        };
      }),
    };
  }
  async commit(
    owner: string,
    id: string,
    input: ImportBatchCommit,
  ): Promise<ImportCommitReceipt> {
    if (
      !input.requestKey ||
      input.requestKey.length > 150 ||
      !Array.isArray(input.rowIds) ||
      !input.rowIds.length ||
      input.rowIds.length > 200
    )
      throw new BadRequestException('INVALID_REQUEST');
    const inputHash = hash({ id, ...input });
    return this.db
      .transaction(async (tx) => {
        await lockMemoryOwner(tx, owner);
        const [prior] = await tx
          .select()
          .from(importCommitReceipts)
          .where(
            and(
              eq(importCommitReceipts.owner, owner),
              eq(importCommitReceipts.requestKey, input.requestKey),
            ),
          );
        if (prior) {
          if (prior.inputHash !== inputHash)
            throw new ConflictException('IDEMPOTENCY_CONFLICT');
          return prior.receipt;
        }
        const [record] = await tx
          .select()
          .from(importBatches)
          .where(and(eq(importBatches.id, id), eq(importBatches.owner, owner)))
          .for('update');
        if (!record) throw new NotFoundException('BATCH_NOT_FOUND');
        const batch = structuredClone(record.state);
        if (batch.revision !== input.expectedRevision)
          throw new ConflictException('BATCH_CHANGED');
        const positions = await tx
          .select()
          .from(holdings)
          .where(eq(holdings.owner, owner))
          .orderBy(holdings.id)
          .for('update');
        if (this.holdingsRevision(positions) !== input.holdingsRevision)
          throw new ConflictException('HOLDINGS_CHANGED');
        const selected = input.rowIds.map((rowId) => {
          const row = batch.rows.find((row) => row.id === rowId);
          if (
            !row ||
            !row.confirmed ||
            row.conflicts?.length ||
            row.issues?.length
          )
            throw new BadRequestException('ROWS_REQUIRE_REVIEW');
          if (row.committedRevision === row.revision)
            throw new ConflictException('ROW_ALREADY_SAVED');
          this.validateRow(row);
          return row;
        });
        if (
          new Set(input.rowIds).size !== input.rowIds.length ||
          new Set(
            selected.map(
              (row) => securityIdentity(row.ticker, row.market)!.key,
            ),
          ).size !== selected.length
        )
          throw new BadRequestException('DUPLICATE_TICKER');
        const receipt: ImportCommitReceipt = {
          id: randomUUID(),
          requestKey: input.requestKey,
          rowIds: input.rowIds,
          created: 0,
          updated: 0,
          createdAt: new Date().toISOString(),
        };
        for (const row of selected) {
          const { identity, quantity, cost, price } = this.validateRow(row);
          const existing = positions.find(
            (position) =>
              securityIdentity(position.ticker, position.market ?? undefined)
                ?.key === identity.key,
          );
          const values = {
            ticker: identity.ticker,
            market: identity.market,
            currency: row.currency,
            company: row.company?.trim() || null,
            shares: String(quantity),
            buyPrice: cost === null ? null : String(cost),
            ...(price !== null ? { currentPrice: String(price) } : {}),
            updatedAt: new Date(),
          };
          values.ticker = await recordPositionCheckpoint(
            tx,
            owner,
            { ...values, currency: row.currency! },
            existing,
            'screenshot',
            receipt.id,
          );
          if (existing) {
            await tx
              .update(holdings)
              .set(values)
              .where(
                and(eq(holdings.owner, owner), eq(holdings.id, existing.id)),
              );
            receipt.updated++;
          } else {
            await tx.insert(holdings).values({ owner, ...values });
            receipt.created++;
          }
          row.committedRevision = row.revision;
        }
        await tx.insert(importLogs).values({
          owner,
          source: 'ocr',
          filename: batch.images
            .map((image) => image.filename)
            .join(', ')
            .slice(0, 255),
          rowsTotal: selected.length,
          rowsImported: receipt.created + receipt.updated,
          errors: [],
        });
        if (input.analyze) {
          if (!this.handoff)
            throw new ConflictException('ANALYSIS_UNAVAILABLE');
          const request = await this.handoff.enqueueInTransaction(
            tx,
            owner,
            receipt.id,
            {
              coverage: {
                totalImages: batch.images.length,
                includedImages: new Set(
                  batch.rows
                    .filter(
                      (row) =>
                        row.committedRevision !== undefined &&
                        row.committedRevision === row.revision,
                    )
                    .flatMap((row) => row.sourceImageIds),
                ).size,
                unresolvedRows: batch.rows.filter(
                  (row) =>
                    !row.confirmed || row.committedRevision !== row.revision,
                ).length,
              },
            },
          );
          receipt.analysisRequestId = request.id;
        }
        batch.receipts.push(receipt);
        batch.revision++;
        batch.updatedAt = new Date().toISOString();
        await tx
          .update(importBatches)
          .set({
            state: batch,
            revision: batch.revision,
            updatedAt: new Date(),
          })
          .where(eq(importBatches.id, id));
        await tx.insert(importCommitReceipts).values({
          id: receipt.id,
          owner,
          batchId: id,
          requestKey: input.requestKey,
          inputHash,
          receipt,
        });
        return receipt;
      })
      .then((receipt) => {
        // Only committed positions enter asynchronous market-data preparation.
        void Promise.resolve()
          .then(() => this.portfolioHistory?.prefetch(owner))
          .catch(() => undefined);
        return receipt;
      });
  }
  async retry(owner: string, id: string, imageId: string) {
    const batch = await this.mutate(owner, id, (current) => {
      const image = current.images.find((image) => image.id === imageId);
      if (!image || image.status !== 'failed')
        throw new ConflictException('IMAGE_NOT_RETRYABLE');
      if (!image.fileAvailable || Date.parse(image.expiresAt) <= Date.now())
        throw new BadRequestException('IMAGE_EXPIRED_RESELECT');
      image.status = 'queued';
      delete image.taskId;
      current.status = 'queued';
      delete current.pauseReason;
    });
    this.kick(owner, id);
    return batch;
  }
  async reselect(
    owner: string,
    id: string,
    imageId: string,
    input: ImportBatchUpload['image'],
  ) {
    const batch = await this.get(owner, id),
      image = batch.images.find((image) => image.id === imageId);
    if (
      !image ||
      image.fileAvailable ||
      !['failed', 'cancelled'].includes(image.status)
    )
      throw new ConflictException('IMAGE_NOT_RESELECTABLE');
    const saved = await this.files.put(owner, imageId, input, id).catch(() => {
      throw new BadRequestException('INVALID_IMAGE');
    });
    if (saved.fingerprint !== image.fingerprint) {
      await this.files.remove(owner, imageId, id);
      throw new BadRequestException('IMAGE_DOES_NOT_MATCH');
    }
    try {
      await this.mutate(owner, id, (current) => {
        const item = current.images.find((item) => item.id === imageId)!;
        if (
          item.fileAvailable ||
          !['failed', 'cancelled'].includes(item.status)
        )
          throw new ConflictException('IMAGE_NOT_RESELECTABLE');
        item.fileAvailable = true;
        item.status = 'failed';
        item.expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
        item.cleanupPending = false;
      });
    } catch (error) {
      await this.files.remove(owner, imageId, id);
      throw error;
    }
    return this.retry(owner, id, imageId);
  }
  async cancel(owner: string, id: string) {
    const batch = await this.mutate(owner, id, (current) => {
      current.status = 'cancelled';
      for (const image of current.images) {
        if (image.status === 'queued') image.status = 'cancelled';
        if (image.status === 'running' || image.status === 'unknown') {
          this.aborts.get(image.id)?.abort();
          image.cleanupPending = true;
        }
      }
    });
    for (const image of batch.images.filter(
      (image) => image.cleanupPending && image.taskId,
    )) {
      await this.agents.cancelTask(owner, image.taskId!).catch(() => undefined);
    }
    return batch;
  }
  async recover(owner?: string, id?: string) {
    const records = await this.db
      .select()
      .from(importBatches)
      .where(
        owner
          ? and(
              eq(importBatches.owner, owner),
              id ? eq(importBatches.id, id) : undefined,
            )
          : undefined,
      );
    for (const record of records) {
      await this.mutate(record.owner, record.id, async (batch) => {
        for (const image of batch.images.filter(
          (image) => image.status === 'running' || image.status === 'unknown',
        )) {
          if (image.taskId && batch.executor.executor === 'local') {
            try {
              const task = await this.agents.store.task(
                record.owner,
                image.taskId,
              );
              if (batch.status === 'cancelled' && terminationConfirmed(task)) {
                image.status = 'cancelled';
                image.cleanupPending = false;
              } else if (task.state === 'completed') {
                try {
                  this.append(
                    batch,
                    image.id,
                    parseScreenshotResult(task.text ?? '', image.id),
                  );
                } catch (error) {
                  image.status = 'failed';
                  image.error = safeError(error);
                }
              } else if (terminationConfirmed(task)) {
                image.status =
                  task.state === 'cancelled' ? 'cancelled' : 'failed';
                image.error = task.error ?? 'LOCAL_INTERRUPTED';
              } else {
                image.status = 'unknown';
                if (batch.status !== 'cancelled') batch.status = 'paused';
                batch.pauseReason = 'TASK_STATUS_UNKNOWN';
              }
            } catch {
              image.status = 'unknown';
              if (batch.status !== 'cancelled') batch.status = 'paused';
              batch.pauseReason = 'TASK_STATUS_UNKNOWN';
            }
          } else {
            image.status = 'unknown';
            if (batch.status !== 'cancelled') batch.status = 'paused';
            batch.pauseReason = 'TASK_STATUS_UNKNOWN';
          }
        }
      });
      const batch = await this.get(record.owner, record.id);
      if (['queued', 'running'].includes(batch.status))
        this.kick(record.owner, record.id);
    }
    await this.expire();
  }
  async expire(now = Date.now()) {
    for (const record of await this.db.select().from(importBatches)) {
      for (const image of record.state.images.filter(
        (image) => image.fileAvailable && Date.parse(image.expiresAt) <= now,
      )) {
        let mayDelete = !['running', 'unknown'].includes(image.status);
        if (!mayDelete) {
          this.aborts.get(image.id)?.abort();
          if (image.taskId) {
            try {
              await this.agents.cancelTask(record.owner, image.taskId);
              const task = await this.agents.store.task(
                record.owner,
                image.taskId,
              );
              mayDelete = terminationConfirmed(task);
            } catch {
              /* Retain until termination can be established. */
            }
          }
        }
        const removed =
          mayDelete &&
          (await this.files.remove(record.owner, image.id, record.id));
        await this.mutate(record.owner, record.id, (batch) => {
          const current = batch.images.find((value) => value.id === image.id)!;
          current.cleanupPending = !removed;
          if (removed) {
            current.fileAvailable = false;
            if (['queued', 'running', 'unknown'].includes(current.status)) {
              current.status = 'cancelled';
              current.error = 'IMAGE_EXPIRED';
            }
          }
        });
      }
    }
    const references = (await this.db.select().from(importBatches)).flatMap(
      (record) =>
        record.state.images
          .filter((image) => image.fileAvailable)
          .map((image) => ({
            owner: record.owner,
            batchId: record.id,
            imageId: image.id,
          })),
    );
    await this.files.cleanupUnreferenced(references, now);
  }
}
