import type { ImportRowCandidate } from '@shared/api.interface';
import type { LocalAgentConnection } from '@shared/local-agents.interface';
import { MAX_NATIVE_IMAGE_BYTES, type NativeAgentImage } from '@shared/native-image.interface';
import type { ScreenshotExtractRequest, ScreenshotJob } from '@shared/screenshot-import.interface';

export function screenshotAgentReady(agent: LocalAgentConnection): boolean {
  return agent.connected && agent.available && !agent.busy && agent.imageInput === true;
}

export function preferredScreenshotAgent(agents: LocalAgentConnection[]): LocalAgentConnection | undefined {
  return agents.find(screenshotAgentReady);
}

export function screenshotFileValid(file: Pick<File, 'type' | 'size'>): boolean {
  return ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) && file.size > 0 && file.size <= MAX_NATIVE_IMAGE_BYTES;
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
  return rows.length > 0 && rows.every(row => row.ticker.trim().length > 0
    && Number.isFinite(Number(row.shares)) && Number(row.shares) > 0
    && (row.avgCost == null || row.avgCost === '' || (Number.isFinite(Number(row.avgCost)) && Number(row.avgCost) >= 0)));
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
