import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ScreenshotExtractRequest, ScreenshotJob } from '../../../shared/screenshot-import.interface';
import { validateNativeImage } from '../../local-agents/native-image';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { parseNativeAgentConfiguration } from '../local-agents/local-agents.requests';
import { OcrService } from './ocr.service';
import { EXTRACTION_PROMPT, parseScreenshotResult, ScreenshotError } from './screenshot-result';

interface JobRecord { owner: string; fingerprint: string; view: ScreenshotJob; abort: AbortController; done?: Promise<void>; active: boolean }
interface JobOptions { now?: () => number; timeoutMs?: number; ttlMs?: number; maxJobs?: number }
const SAFE_ERRORS = new Set(['INVALID_RESULT', 'NO_HOLDINGS', 'INVALID_API_CONFIGURATION', 'VISION_USAGE_LIMIT', 'VISION_RATE_LIMIT',
  'VISION_AUTH_REQUIRED', 'VISION_TIMEOUT', 'VISION_FAILED', 'LOCAL_USAGE_LIMIT', 'LOCAL_RATE_LIMIT', 'LOCAL_LOGIN_REQUIRED',
  'LOCAL_UNAVAILABLE', 'LOCAL_BUSY', 'LOCAL_IMAGE_UNSUPPORTED', 'LOCAL_AGENT_NOT_FOUND', 'LOCAL_INVALID_CONFIGURATION',
  'LOCAL_CONFIGURATION_UNSUPPORTED', 'LOCAL_VERSION_UNSUPPORTED', 'LOCAL_INTERRUPTED', 'LOCAL_DISPATCH_UNCERTAIN',
  'LOCAL_TOOL_ISOLATION_FAILED', 'LOCAL_INVALID_RESULT', 'LOCAL_CANCELLED', 'LOCAL_PAUSED', 'LOCAL_TASK_FAILED']);

@Injectable()
export class ScreenshotJobsService implements OnModuleDestroy {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly now: () => number;
  private readonly sweep: ReturnType<typeof setInterval>;
  private stopping = false;
  constructor(private readonly agents: LocalAgentsService, private readonly ocr: OcrService,
    @Optional() @Inject('SCREENSHOT_JOB_OPTIONS') private readonly options: JobOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sweep = setInterval(() => this.prune(), 60_000);
    this.sweep.unref();
  }

  private key(owner: string, id: string) { return `${owner}:${id}`; }
  private prune() {
    const before = this.now() - (this.options.ttlMs ?? 20 * 60_000);
    for (const [key, job] of this.jobs) if (!job.active && Date.parse(job.view.updatedAt) < before) this.jobs.delete(key);
  }
  private snapshot(job: JobRecord): ScreenshotJob { return structuredClone(job.view); }
  private update(job: JobRecord, patch: Partial<ScreenshotJob>) {
    Object.assign(job.view, patch, { updatedAt: new Date(this.now()).toISOString() });
  }
  private find(owner: string, id: string) {
    this.prune();
    const job = this.jobs.get(this.key(owner, id));
    if (!job) throw new NotFoundException('JOB_NOT_FOUND');
    return job;
  }
  get(owner: string, id: string) { return this.snapshot(this.find(owner, id)); }
  cancel(owner: string, id: string) {
    const job = this.find(owner, id);
    if (job.view.status === 'queued' || job.view.status === 'running') {
      this.update(job, { status: 'cancelled', phase: 'done' });
      job.abort.abort();
    }
    return this.snapshot(job);
  }

  start(owner: string, input: ScreenshotExtractRequest): ScreenshotJob {
    if (this.stopping) throw new ConflictException('IMPORT_BUSY');
    if (!input || typeof input !== 'object' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId ?? '')) {
      throw new BadRequestException('INVALID_REQUEST');
    }
    let image: ScreenshotExtractRequest['image'];
    try { image = validateNativeImage(input.image); } catch { throw new BadRequestException('INVALID_IMAGE'); }
    let dto: ScreenshotExtractRequest;
    if (input.executor === 'local' && typeof input.agentId === 'string' && input.agentId.length <= 100) {
      let agentSettings;
      try { agentSettings = parseNativeAgentConfiguration(input.agentSettings); } catch { throw new BadRequestException('INVALID_REQUEST'); }
      dto = { requestId: input.requestId, image, executor: 'local', agentId: input.agentId, agentSettings };
    } else if (input.executor === 'vision' && typeof input.apiKey === 'string' && input.apiKey.trim() && input.apiKey.length <= 4096
      && !/[\r\n]/.test(input.apiKey) && typeof input.model === 'string' && input.model.trim() && input.model.length <= 200
      && (input.baseUrl === undefined || typeof input.baseUrl === 'string' && input.baseUrl.length <= 500)) {
      dto = { requestId: input.requestId, image, executor: 'vision', apiKey: input.apiKey.trim(), model: input.model.trim(), baseUrl: input.baseUrl?.trim() };
    } else throw new BadRequestException(input.executor === 'vision' ? 'INVALID_API_CONFIGURATION' : 'INVALID_REQUEST');
    this.prune();
    const fingerprint = createHash('sha256').update(JSON.stringify(dto)).digest('hex');
    const key = this.key(owner, dto.requestId);
    const existing = this.jobs.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new BadRequestException('INVALID_REQUEST');
      return this.snapshot(existing);
    }
    const active = [...this.jobs.values()].filter(job => job.active);
    if (active.some(job => job.owner === owner) || active.length >= 8 || this.jobs.size >= (this.options.maxJobs ?? 100)) {
      throw new ConflictException('IMPORT_BUSY');
    }
    const timestamp = new Date(this.now()).toISOString();
    const job: JobRecord = { owner, fingerprint, abort: new AbortController(), active: true,
      view: { id: dto.requestId, status: 'queued', phase: 'queued', executor: dto.executor, createdAt: timestamp, updatedAt: timestamp } };
    this.jobs.set(key, job);
    // Enqueue without keeping screenshot/key in the public job or durable task metadata.
    job.done = Promise.resolve().then(() => this.run(job, dto));
    return this.snapshot(job);
  }

  private async run(job: JobRecord, dto: ScreenshotExtractRequest): Promise<void> {
    const timer = setTimeout(() => {
      if (job.abort.signal.aborted) return;
      this.update(job, { status: 'failed', phase: 'done', error: { code: 'EXTRACTION_TIMEOUT' } });
      job.abort.abort();
    }, this.options.timeoutMs ?? 180_000);
    timer.unref();
    try {
      if (job.abort.signal.aborted) return;
      this.update(job, { status: 'running', phase: 'recognizing' });
      let result;
      if (dto.executor === 'local') {
        const response = await this.agents.execute(job.owner, { agentId: dto.agentId, messageId: `screenshot:${job.view.id}`,
          prompt: EXTRACTION_PROMPT, image: dto.image, agentSettings: dto.agentSettings, signal: job.abort.signal,
          onTask: async () => { if (job.abort.signal.aborted) throw new ScreenshotError('LOCAL_CANCELLED'); },
          onDispatch: async () => { if (job.abort.signal.aborted) throw new ScreenshotError('LOCAL_CANCELLED'); },
          onProgress: async () => undefined, shouldContinue: async () => !job.abort.signal.aborted });
        if (job.abort.signal.aborted) return;
        this.update(job, { phase: 'validating' });
        result = parseScreenshotResult(response.text);
      } else {
        result = await this.ocr.extract({ apiKey: dto.apiKey, model: dto.model, baseUrl: dto.baseUrl,
          imageBase64: `data:${dto.image.mimeType};base64,${dto.image.data}` }, job.abort.signal);
      }
      if (!job.abort.signal.aborted) this.update(job, { status: 'completed', phase: 'done', result });
    } catch (error) {
      if (!job.abort.signal.aborted) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        this.update(job, { status: 'failed', phase: 'done', error: { code: SAFE_ERRORS.has(code) ? code : dto.executor === 'vision' ? 'VISION_FAILED' : 'LOCAL_TASK_FAILED' } });
      }
    } finally {
      clearTimeout(timer);
      job.active = false;
      // dto (including screenshot and one-call key) becomes unreachable after this invocation.
    }
  }

  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.sweep);
    for (const job of this.jobs.values()) job.abort.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.done));
    this.jobs.clear();
  }
}
