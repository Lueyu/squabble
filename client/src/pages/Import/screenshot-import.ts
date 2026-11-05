import type { ImportRowCandidate } from '@shared/api.interface';
import type { LocalAgentConnection } from '@shared/local-agents.interface';
import { MAX_NATIVE_IMAGE_BYTES, type NativeAgentImage } from '@shared/native-image.interface';
import type { ScreenshotExtractRequest, ScreenshotJob } from '@shared/screenshot-import.interface';

export function screenshotAgentReady(agent: LocalAgentConnection): boolean {
  return agent.connected && agent.available && !agent.busy && agent.imageInput === true;
}

/** The previous job can leave a cached busy flag until the agent list refreshes. */
export function screenshotAgentQueueReady(agent: LocalAgentConnection): boolean {
  return agent.connected && agent.available && agent.imageInput === true;
}

export function preferredScreenshotAgent(agents: LocalAgentConnection[]): LocalAgentConnection | undefined {
  return agents.find(screenshotAgentReady);
}

export function screenshotFileValid(file: Pick<File, 'type' | 'size'>): boolean {
  return ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) && file.size > 0 && file.size <= MAX_NATIVE_IMAGE_BYTES;
}

export function screenshotSelectionError(files: Pick<File, 'type' | 'size'>[]): 'FILE_COUNT' | 'TOTAL_SIZE' | 'INVALID_IMAGE' | null {
  if (files.length < 1 || files.length > 5) return 'FILE_COUNT';
  if (files.some(file => !screenshotFileValid(file))) return 'INVALID_IMAGE';
  if (files.reduce((size, file) => size + file.size, 0) > 24 * 1024 * 1024) return 'TOTAL_SIZE';
  return null;
}

export function screenshotImage(file: Pick<File, 'type' | 'size'>, dataUrl: string): NativeAgentImage {
  const prefix = `data:${file.type};base64,`;
  if (!screenshotFileValid(file) || !dataUrl.startsWith(prefix) || !dataUrl.slice(prefix.length)) throw new Error('INVALID_IMAGE');
  return { mimeType: file.type as NativeAgentImage['mimeType'], data: dataUrl.slice(prefix.length) };
}

export interface ScreenshotProvider { baseUrl: string; model: string; apiKey: string }
type ProviderStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function loadScreenshotProvider(storage: ProviderStorage): ScreenshotProvider {
  const provider = { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', apiKey: '' };
  try {
    provider.apiKey = storage.getItem('sq-ocr-key') ?? '';
    storage.removeItem('sq-ocr-key');
    provider.baseUrl = storage.getItem('sq-ocr-base') ?? provider.baseUrl;
    provider.model = storage.getItem('sq-ocr-model') ?? '';
  } catch { /* Storage can be disabled by the browser. Keep credentials in memory only. */ }
  return provider;
}

export function saveScreenshotProvider(storage: ProviderStorage, provider: ScreenshotProvider): void {
  try {
    storage.removeItem('sq-ocr-key');
    storage.setItem('sq-ocr-base', provider.baseUrl);
    storage.setItem('sq-ocr-model', provider.model);
  } catch { /* Provider preferences are optional. */ }
}

export function validScreenshotRows(rows: ImportRowCandidate[]): boolean {
  return Array.isArray(rows) && rows.length > 0 && rows.every(row => row && typeof row.ticker === 'string' && row.ticker.trim().length > 0
    && Number.isFinite(Number(row.shares)) && Number(row.shares) > 0
    && (row.avgCost == null || row.avgCost === '' || (Number.isFinite(Number(row.avgCost)) && Number(row.avgCost) >= 0)));
}

export function screenshotReviewProblem(rows: ImportRowCandidate[]): 'ROW_LIMIT' | 'DUPLICATE_TICKER' | 'INVALID_ROWS' | null {
  if (rows.length > 200) return 'ROW_LIMIT';
  if (!validScreenshotRows(rows)) return 'INVALID_ROWS';
  const seen = new Set<string>();
  for (const row of rows) {
    const raw = row.ticker.trim().toUpperCase();
    const hk = /^(\d{1,5})(?:\.HK)?$/.exec(raw);
    const cn = /^(\d{6})(?:\.(?:SH|SS|SZ|BJ))?$/.exec(raw);
    const key = hk && (raw.endsWith('.HK') || /^\d{4,5}$/.test(raw)) ? `HK:${Number(hk[1])}`
      : cn ? `CN:${cn[1]}` : `US:${raw}`;
    if (seen.has(key)) return 'DUPLICATE_TICKER';
    seen.add(key);
  }
  return null;
}

export const SCREENSHOT_ERROR_CODES = new Set([
  'INVALID_IMAGE', 'INVALID_REQUEST', 'INVALID_API_CONFIGURATION', 'IMPORT_BUSY', 'JOB_NOT_FOUND',
  'NO_HOLDINGS', 'INVALID_RESULT', 'EXTRACTION_TIMEOUT', 'VISION_USAGE_LIMIT', 'VISION_RATE_LIMIT',
  'VISION_AUTH_REQUIRED', 'VISION_TIMEOUT', 'VISION_FAILED', 'LOCAL_INVALID_CONFIGURATION',
  'LOCAL_CONFIGURATION_UNSUPPORTED', 'LOCAL_VERSION_UNSUPPORTED', 'LOCAL_LOGIN_REQUIRED',
  'LOCAL_DISPATCH_UNCERTAIN', 'LOCAL_TOOL_ISOLATION_FAILED', 'LOCAL_USAGE_LIMIT', 'LOCAL_RATE_LIMIT',
  'LOCAL_AGENT_UNAVAILABLE', 'LOCAL_AGENT_BUSY', 'LOCAL_AGENT_NOT_CONNECTED', 'LOCAL_AGENT_FAILED',
  'LOCAL_IMAGE_UNSUPPORTED', 'LOCAL_IMAGE_INPUT_UNSUPPORTED', 'LOCAL_EXECUTION_FAILED', 'LOCAL_TIMEOUT',
  'LOCAL_AGENT_NOT_FOUND', 'LOCAL_UNAVAILABLE', 'LOCAL_BUSY', 'LOCAL_INVALID_INPUT', 'LOCAL_INVALID_RESULT',
  'LOCAL_TASK_FAILED', 'LOCAL_INTERRUPTED', 'LOCAL_CANCELLED', 'LOCAL_PAUSED', 'LOCAL_COMPANION_OFFLINE',
]);

export function screenshotErrorCode(error: unknown): string {
  const body = (error as { response?: { data?: { code?: string; message?: string; error?: { code?: string; message?: string } } } })?.response?.data;
  const codes = [body?.code, body?.error?.code, body?.error?.message, body?.message];
  return codes.find(code => typeof code === 'string' && SCREENSHOT_ERROR_CODES.has(code)) ?? 'UNKNOWN';
}

export function screenshotJobActive(job: ScreenshotJob | null): boolean {
  return job?.status === 'queued' || job?.status === 'running';
}

export interface ScreenshotJobState {
  requestId: string | null;
  job: ScreenshotJob | null;
  submitting: boolean;
  polling: boolean;
  cancelling: boolean;
  uncertain: boolean;
  missing: boolean;
  error: string | null;
}
const emptyState = (): ScreenshotJobState => ({ requestId: null, job: null, submitting: false,
  polling: false, cancelling: false, uncertain: false, missing: false, error: null });
interface ScreenshotJobApi {
  create(request: ScreenshotExtractRequest): Promise<ScreenshotJob>;
  get(id: string): Promise<ScreenshotJob>;
  cancel(id: string): Promise<ScreenshotJob>;
}

/** Holds no credentials or image data. Epochs fence late submit, read and cancel responses. */
export class ScreenshotJobController {
  snapshot: ScreenshotJobState = emptyState();
  private epoch = 0;
  private disposed = false;
  private listener?: (state: ScreenshotJobState) => void;

  constructor(private readonly api: ScreenshotJobApi) {}

  attach(listener: (state: ScreenshotJobState) => void): void {
    this.disposed = false;
    this.listener = listener;
    listener(this.snapshot);
  }

  private emit(patch: Partial<ScreenshotJobState>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    if (!this.disposed) this.listener?.(this.snapshot);
  }

  private accept(job: ScreenshotJob): void {
    this.emit({ job, submitting: false, polling: false, cancelling: false, uncertain: false, missing: false,
      error: job.status === 'failed' ? job.error?.code ?? 'UNKNOWN' : null });
  }

  private abandon(id: string): void {
    void this.api.cancel(id).catch(() => { /* A late accepted POST is cancelled again when it returns. */ });
  }

  reset(): void {
    const { requestId, job, submitting, uncertain } = this.snapshot;
    this.epoch++;
    if (requestId && (submitting || uncertain || screenshotJobActive(job))) this.abandon(requestId);
    this.emit(emptyState());
  }

  dispose(): void {
    this.listener = undefined;
    this.disposed = true;
    this.reset();
  }

  async start(request: ScreenshotExtractRequest): Promise<void> {
    if (this.disposed || this.snapshot.submitting || this.snapshot.cancelling || this.snapshot.uncertain || screenshotJobActive(this.snapshot.job)) return;
    const epoch = ++this.epoch;
    this.emit({ ...emptyState(), requestId: request.requestId, submitting: true });
    try {
      const job = await this.api.create(request);
      if (epoch !== this.epoch || this.disposed) { this.abandon(job.id); return; }
      this.accept(job);
    } catch (error) {
      if (epoch !== this.epoch || this.disposed) return;
      const status = (error as { response?: { status?: number } })?.response?.status;
      const definitive = status != null && status >= 400 && status < 500 && status !== 408;
      this.emit({ submitting: false, uncertain: !definitive, error: definitive ? screenshotErrorCode(error) : 'SUBMISSION_UNKNOWN' });
    }
  }

  /** Recover only by reading the original ID. Never replay a potentially paid POST. */
  async refresh(): Promise<void> {
    const { requestId, polling, cancelling } = this.snapshot;
    if (!requestId || polling || cancelling || this.disposed) return;
    const epoch = this.epoch;
    this.emit({ polling: true });
    try {
      const job = await this.api.get(requestId);
      if (epoch === this.epoch && !this.disposed) this.accept(job);
    } catch (error) {
      if (epoch !== this.epoch || this.disposed) return;
      const missing = screenshotErrorCode(error) === 'JOB_NOT_FOUND';
      this.emit({ polling: false, missing, uncertain: this.snapshot.uncertain || missing,
        error: missing ? 'JOB_NOT_FOUND' : 'POLL_FAILED' });
    }
  }

  async cancel(): Promise<void> {
    const { requestId, cancelling } = this.snapshot;
    if (!requestId || cancelling || this.disposed) return;
    const epoch = ++this.epoch;
    this.emit({ cancelling: true, polling: false, submitting: false });
    try {
      const job = await this.api.cancel(requestId);
      if (epoch === this.epoch && !this.disposed) this.accept(job);
    } catch (error) {
      if (epoch !== this.epoch || this.disposed) return;
      const missing = screenshotErrorCode(error) === 'JOB_NOT_FOUND';
      this.emit({ cancelling: false, uncertain: true, missing, error: missing ? 'JOB_NOT_FOUND' : 'CANCEL_FAILED' });
    }
  }
}

export interface ScreenshotBatchItem { filename: string; image: NativeAgentImage; dataUrl?: string }
export interface ScreenshotBatchFile { filename: string; status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled'; error?: string }
export type ScreenshotBatchRow = ImportRowCandidate & { sourceFile: string };
export interface ScreenshotBatchState {
  files: ScreenshotBatchFile[];
  rows: ScreenshotBatchRow[];
  task: ScreenshotJobState;
  paused: boolean;
  stopped: boolean;
  started: boolean;
  pauseReason: 'ROUTE_UNAVAILABLE' | null;
}

/** Dispatches one existing screenshot job at a time; only GET can recover an uncertain POST. */
export class ScreenshotBatchController {
  readonly job: ScreenshotJobController;
  snapshot: ScreenshotBatchState;
  private items: ScreenshotBatchItem[] = [];
  private activeIndex: number | null = null;
  private pauseAfterRecovery = false;
  private requestFor?: (item: ScreenshotBatchItem, index: number) => ScreenshotExtractRequest;
  private canContinue?: () => boolean;
  private listener?: (state: ScreenshotBatchState) => void;
  private disposed = false;

  constructor(api: ScreenshotJobApi) {
    this.job = new ScreenshotJobController(api);
    this.snapshot = { files: [], rows: [], task: this.job.snapshot, paused: false, stopped: false, started: false, pauseReason: null };
  }

  attach(listener: (state: ScreenshotBatchState) => void): void {
    this.disposed = false;
    this.listener = listener;
    this.job.attach(task => this.onTask(task));
    listener(this.snapshot);
  }

  private emit(patch: Partial<ScreenshotBatchState>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    if (!this.disposed) this.listener?.(this.snapshot);
  }

  private file(index: number, patch: Partial<ScreenshotBatchFile>): void {
    this.emit({ files: this.snapshot.files.map((file, i) => i === index ? { ...file, ...patch } : file) });
  }

  private onTask(task: ScreenshotJobState): void {
    this.emit({ task });
    const index = this.activeIndex;
    if (index == null || this.disposed || this.snapshot.stopped) return;
    if (task.job?.status === 'completed') {
      this.activeIndex = null;
      if (this.pauseAfterRecovery) this.emit({ paused: true });
      this.pauseAfterRecovery = false;
      const rows = task.job.result?.rows;
      if (!rows || !validScreenshotRows(rows)) {
        this.file(index, { status: 'failed', error: 'INVALID_RESULT' });
        this.emit({ paused: true });
        return;
      }
      this.emit({ rows: [...this.snapshot.rows, ...rows.map(row => ({ ...row, avgCost: row.avgCost ?? null, sourceFile: this.items[index].filename }))] });
      this.file(index, { status: 'success' });
      if (!this.snapshot.paused) this.advance();
    } else if (task.job?.status === 'failed' || task.job?.status === 'cancelled' || (task.error && !task.uncertain && !screenshotJobActive(task.job))) {
      this.activeIndex = null;
      this.pauseAfterRecovery = false;
      this.file(index, { status: task.job?.status === 'cancelled' ? 'cancelled' : 'failed', error: task.error ?? undefined });
      this.emit({ paused: true });
    } else if (task.uncertain || task.error === 'POLL_FAILED') {
      this.pauseAfterRecovery = true;
      this.emit({ paused: true });
    } else if (this.pauseAfterRecovery && screenshotJobActive(task.job) && this.snapshot.paused) {
      this.emit({ paused: false });
    }
  }

  replace(items: ScreenshotBatchItem[]): void {
    this.activeIndex = null;
    this.pauseAfterRecovery = false;
    this.job.reset();
    this.items = items;
    this.requestFor = undefined;
    this.canContinue = undefined;
    this.emit({ files: items.map(item => ({ filename: item.filename, status: 'queued' })), rows: [],
      task: this.job.snapshot, paused: false, stopped: false, started: false, pauseReason: null });
  }

  start(requestFor: (item: ScreenshotBatchItem, index: number) => ScreenshotExtractRequest, canContinue: () => boolean = () => true): Promise<void> {
    if (this.disposed || this.snapshot.started || !this.items.length) return Promise.resolve();
    this.requestFor = requestFor;
    this.canContinue = canContinue;
    this.emit({ started: true });
    return this.advance();
  }

  private advance(): Promise<void> {
    if (this.disposed || this.snapshot.paused || this.snapshot.stopped || this.activeIndex != null || !this.requestFor) return Promise.resolve();
    const index = this.snapshot.files.findIndex(file => file.status === 'queued');
    if (index < 0) return Promise.resolve();
    if (!this.canContinue?.()) { this.emit({ paused: true, pauseReason: 'ROUTE_UNAVAILABLE' }); return Promise.resolve(); }
    this.job.reset();
    this.activeIndex = index;
    this.file(index, { status: 'running' });
    return this.job.start(this.requestFor(this.items[index], index));
  }

  async recover(): Promise<void> { await this.job.refresh(); }

  resume(): void {
    if (this.disposed || this.snapshot.stopped || !this.snapshot.paused || this.activeIndex != null || this.snapshot.task.uncertain) return;
    this.emit({ paused: false, pauseReason: null });
    void this.advance();
  }

  skipRemaining(): void {
    if (this.activeIndex != null) return;
    this.emit({ files: this.snapshot.files.map(file => file.status === 'queued' ? { ...file, status: 'cancelled' } : file), paused: false, pauseReason: null });
  }

  cancel(): void {
    if (this.disposed) return;
    const hadActive = this.activeIndex != null;
    this.emit({ stopped: true, paused: false, pauseReason: null, files: this.snapshot.files.map(file =>
      file.status === 'queued' || file.status === 'running' ? { ...file, status: 'cancelled' } : file) });
    this.activeIndex = null;
    this.pauseAfterRecovery = false;
    if (hadActive) void this.job.cancel();
  }

  dispose(): void {
    this.disposed = true;
    this.listener = undefined;
    this.activeIndex = null;
    this.job.dispose();
  }
}
