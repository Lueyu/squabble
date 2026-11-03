import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ResearchEventBuffer } from './research-events.mjs';
import { researchFailure, validResearchBundle, validResearchRequest, validResearchResult,
  type ResearchActivity, type ResearchToolBundle, type ResearchToolCapability,
  type ResearchToolRequest, type ResearchToolResult } from './research-protocol.mjs';

// This package has an independent rootDir. Keep this narrow wire contract in sync
// with shared/local-agents.interface.ts without pulling backend sources into Electron.
const NATIVE_PROVIDERS = ['codex', 'claude', 'gemini', 'antigravity', 'opencode', 'kimi', 'doubao'] as const;
export type NativeProvider = typeof NATIVE_PROVIDERS[number];
interface NativeAgentConfiguration { model?: string; reasoningEffort?: string }
export interface NativeAgentStatus {
  provider: NativeProvider;
  name: string;
  state: 'not_installed' | 'login_required' | 'ready' | 'error';
  version?: string;
  loginCommand: string;
  installUrl: string;
  models?: Array<{ id: string; name: string; reasoningEfforts?: string[] }>;
  reasoningEfforts?: string[];
  configurationHelp?: string;
  researchTools?: ResearchToolCapability;
}
export interface NativeRuntime {
  detectNativeAgents(): Promise<NativeAgentStatus[]>;
  openNativeLogin(provider: NativeProvider): Promise<void>;
  runNativeAgent(provider: NativeProvider, prompt: string, options: {
    root: string; signal: AbortSignal; onProgress: (text: string) => void;
    agentSettings?: NativeAgentConfiguration;
    researchTools?: ResearchToolBundle & { call: (request: ResearchToolRequest, signal: AbortSignal) => Promise<ResearchToolResult> };
    onEvent?: (event: ResearchActivity) => void;
  }): Promise<{ text: string; usageTokens: number | null }>;
}
interface Command {
  id: string; kind: 'run' | 'login'; provider: NativeProvider; prompt?: string;
  agentSettings?: NativeAgentConfiguration; researchTools?: ResearchToolBundle;
}
interface Update {
  id: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  progress?: string;
  text?: string;
  usageTokens?: number | null;
  events?: ResearchActivity[];
  error?: 'LOCAL_INVALID_CONFIGURATION' | 'LOCAL_CONFIGURATION_UNSUPPORTED' | 'LOCAL_VERSION_UNSUPPORTED'
    | 'LOCAL_LOGIN_REQUIRED' | 'LOCAL_DISPATCH_UNCERTAIN' | 'LOCAL_TOOL_ISOLATION_FAILED' | 'LOCAL_USAGE_LIMIT' | 'LOCAL_RATE_LIMIT';
}
interface UpdateSnapshot { source: Update; wire: Update }
interface Pairing {
  origin: string; token: string; deviceId: string; processedTaskIds: string[];
}
interface RunningTask { controller: AbortController; provider: NativeProvider; promise: Promise<void> }
interface CompanionOptions {
  dataDir: string;
  name: string;
  native: NativeRuntime;
  fetch?: typeof fetch;
  now?: () => number;
}
export interface CompanionStatus {
  state: 'unpaired' | 'connecting' | 'connected' | 'offline';
  origin?: string;
  activeTasks: number;
  agents: NativeAgentStatus[];
}

const MAX_TEXT = 512_000;
const MAX_POLL_BYTES = 900_000;
const MAX_PROCESSED_TASKS = 10_000;
const OFFLINE_LIMIT_MS = 30_000;
const TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/u;

function localOrigin(value: string): string | null {
  // Validate the literal host before URL normalization (127.1 and integer IPs
  // would otherwise normalize to loopback and silently broaden the allowlist).
  if (!/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) return null;
    return url.origin;
  } catch { return null; }
}

export function parsePairingLink(value: string): { origin: string; code: string } | null {
  if (value.length > 2_048 || /[\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'squabble:' || url.hostname !== 'pair' || url.username || url.password
      || url.port || url.pathname || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 2 || !keys.includes('origin') || !keys.includes('code')) return null;
    const origin = localOrigin(url.searchParams.get('origin') ?? '');
    const code = url.searchParams.get('code') ?? '';
    return origin && /^[a-f0-9]{48}$/u.test(code) ? { origin, code } : null;
  } catch { return null; }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pairResponse(value: unknown): value is { token: string; deviceId: string } {
  return object(value) && typeof value.token === 'string' && /^[a-f0-9]{64}$/u.test(value.token)
    && typeof value.deviceId === 'string' && TASK_ID.test(value.deviceId);
}

function validPairing(value: unknown): value is Pairing {
  return object(value) && typeof value.origin === 'string'
    && localOrigin(value.origin) === value.origin && Array.isArray(value.processedTaskIds)
    && value.processedTaskIds.length <= MAX_PROCESSED_TASKS
    && value.processedTaskIds.every((id: unknown) => typeof id === 'string' && TASK_ID.test(id)) && pairResponse(value);
}

function pollResponse(value: unknown): value is { commands: Command[]; cancelTaskIds: string[] } {
  if (!object(value) || !Array.isArray(value.commands) || value.commands.length > 100
    || !Array.isArray(value.cancelTaskIds) || value.cancelTaskIds.length > 1_000) return false;
  return value.cancelTaskIds.every((id: unknown) => typeof id === 'string' && TASK_ID.test(id))
    && value.commands.every((command: unknown) => object(command)
      && typeof command.id === 'string' && TASK_ID.test(command.id)
      && NATIVE_PROVIDERS.some((provider) => provider === command.provider)
      && validConfiguration(command.agentSettings)
      && (command.researchTools === undefined || validResearchBundle(command.researchTools))
      && ((command.kind === 'login' && command.prompt === undefined && command.agentSettings === undefined && command.researchTools === undefined)
        || (command.kind === 'run' && typeof command.prompt === 'string'
          && command.prompt.length > 0 && command.prompt.length <= MAX_TEXT)));
}

function validConfiguration(value: unknown): value is NativeAgentConfiguration | undefined {
  if (value === undefined) return true;
  if (!object(value) || Object.keys(value).some((key) => key !== 'model' && key !== 'reasoningEffort')) return false;
  return [['model', 160], ['reasoningEffort', 32]].every(([key, limit]) => {
    const text = value[key];
    return text === undefined || typeof text === 'string' && text.trim().length > 0
      && text.length <= Number(limit) && !/[\u0000-\u001f\u007f]/u.test(text);
  });
}

function nativeFailureCode(error: unknown): Update['error'] {
  const codes: Record<string, NonNullable<Update['error']>> = {
    NATIVE_AGENT_LOGIN_REQUIRED: 'LOCAL_LOGIN_REQUIRED',
    NATIVE_AGENT_INVALID_CONFIGURATION: 'LOCAL_INVALID_CONFIGURATION',
    NATIVE_AGENT_CONFIGURATION_UNSUPPORTED: 'LOCAL_CONFIGURATION_UNSUPPORTED',
    NATIVE_AGENT_VERSION_UNSUPPORTED: 'LOCAL_VERSION_UNSUPPORTED',
    NATIVE_AGENT_TOOL_ISOLATION_FAILED: 'LOCAL_TOOL_ISOLATION_FAILED',
    NATIVE_AGENT_USAGE_LIMIT: 'LOCAL_USAGE_LIMIT',
    NATIVE_AGENT_RATE_LIMIT: 'LOCAL_RATE_LIMIT',
    NATIVE_AGENT_CANCEL_UNCONFIRMED: 'LOCAL_DISPATCH_UNCERTAIN',
    NATIVE_AGENT_UPSTREAM_PENDING: 'LOCAL_DISPATCH_UNCERTAIN',
  };
  return error instanceof Error ? codes[error.message] : undefined;
}

async function readJson(response: Response, limit = 2 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new Error('Empty companion response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Companion response too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export class LocalAgentCompanion {
  private pairing: Pairing | null = null;
  private state: CompanionStatus['state'] = 'unpaired';
  private agents: NativeAgentStatus[] = [];
  private readonly processed = new Set<string>();
  private readonly updates = new Map<string, Update>();
  private readonly events = new Map<string, ResearchEventBuffer>();
  private readonly tasks = new Map<string, RunningTask>();
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private active = false;
  private generation = 0;
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private requestController: AbortController | null = null;
  private pairingController: AbortController | null = null;
  private polling: Promise<void> | null = null;
  private detecting = false;
  private lastDetection = -Infinity;
  private lastSuccess = 0;
  private failures = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: CompanionOptions) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get status(): CompanionStatus {
    return { state: this.state, origin: this.pairing?.origin,
      activeTasks: this.tasks.size, agents: this.agents.map((agent) => ({ ...agent })) };
  }

  async restore(): Promise<void> {
    try {
      const contents = await readFile(join(this.options.dataDir, 'pairing.json'), 'utf8');
      if (contents.length > 2 * 1024 * 1024) throw new Error('Invalid companion pairing');
      const value: unknown = JSON.parse(contents);
      if (!validPairing(value)) throw new Error('Invalid companion pairing');
      this.pairing = value;
      this.processed.clear();
      for (const id of value.processedTaskIds) this.processed.add(id);
      this.updates.clear();
      this.events.clear();
      // Notify the broker immediately after a crash. It ignores already-terminal
      // task updates; recent IDs go first so interrupted work is released promptly.
      for (const id of [...this.processed].reverse()) this.updates.set(id, {
        id, state: 'failed', progress: 'Desktop companion restarted. Start a new task.',
      });
      this.state = 'connecting';
      this.lastSuccess = this.now();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not restore companion pairing');
    }
  }

  async pair(link: string, confirm: (origin: string) => Promise<boolean>): Promise<boolean> {
    const parsed = parsePairingLink(link);
    if (!parsed) throw new Error('Invalid local pairing link');
    const generation = this.generation;
    if (!await confirm(parsed.origin) || this.generation !== generation) return false;
    const controller = new AbortController();
    this.pairingController = controller;
    let credentials: { token: string; deviceId: string };
    try {
      const response = await this.request(`${parsed.origin}/api/local-agent-companion/pair`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: parsed.code, name: this.options.name.trim().slice(0, 80) || 'Squabble desktop' }),
      });
      if (!response.ok) throw new Error('Pair request rejected');
      const body = await readJson(response);
      if (!pairResponse(body)) throw new Error('Invalid pair response');
      credentials = body;
    } catch {
      if (generation !== this.generation) return false;
      throw new Error('Could not pair. Create a new pairing request in Squabble Settings and try again.');
    } finally {
      if (this.pairingController === controller) this.pairingController = null;
    }
    if (generation !== this.generation) return false;
    const restart = this.active;
    await this.stop();
    const stoppedGeneration = this.generation;
    const next: Pairing = { origin: parsed.origin, token: credentials.token,
      deviceId: credentials.deviceId, processedTaskIds: [] };
    await this.save(next);
    if (stoppedGeneration !== this.generation) return false;
    this.pairing = next;
    this.processed.clear();
    this.updates.clear();
    this.events.clear();
    this.state = 'connecting';
    this.lastSuccess = this.now();
    this.failures = 0;
    if (restart) this.start();
    return true;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    const generation = this.generation;
    this.watchdog = setInterval(() => this.checkLease(), 1_000);
    this.watchdog.unref();
    const tick = async (): Promise<void> => {
      if (!this.active || this.generation !== generation) return;
      await this.pollOnce();
      if (this.active && this.generation === generation) {
        this.timer = setTimeout(() => { void tick(); }, Math.min(5_000, 1_000 * 2 ** Math.min(3, this.failures)));
        this.timer.unref();
      }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.timer = this.watchdog = null;
    this.requestController?.abort();
    this.pairingController?.abort();
    for (const task of this.tasks.values()) task.controller.abort();
    const finishing = [...this.tasks.values()].map((task) => task.promise);
    if (this.polling) finishing.push(this.polling);
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(finishing), new Promise<void>((done) => {
      timeout = setTimeout(done, 5_000);
    })]);
    if (timeout) clearTimeout(timeout);
  }

  async disconnect(): Promise<void> {
    await this.stop();
    await this.forget();
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.poll();
    try { await this.polling; } finally { this.polling = null; }
  }

  private async poll(): Promise<void> {
    const pairing = this.pairing;
    if (!pairing) return;
    const generation = this.generation;
    this.refreshAgents();
    const snapshot = this.selectUpdates();
    const controller = new AbortController();
    this.requestController = controller;
    try {
      const requestOptions: RequestInit = {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairing.token}` },
      };
      const updates = snapshot.map(item => item.wire);
      const send = (wire: Update[]) => this.request(`${pairing.origin}/api/local-agent-companion/poll`, {
        ...requestOptions, body: JSON.stringify({ agents: this.agents, updates: wire }),
      });
      let response = await send(updates);
      const isLimitError = (error: Update['error']) => error === 'LOCAL_USAGE_LIMIT' || error === 'LOCAL_RATE_LIMIT';
      if (response.status === 400 && updates.some(update => isLimitError(update.error)) && generation === this.generation) {
        // Older servers reject new enum values before processing the poll. Retry only
        // this status acknowledgement once, retaining its safe progress and task IDs.
        // This never resubmits a model request or changes the durable local update.
        await response.body?.cancel();
        if (generation !== this.generation) return;
        response = await send(updates.map(update => isLimitError(update.error) ? { ...update, error: undefined } : update));
      }
      if (generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) { await this.forget(); return; }
      if (!response.ok) throw new Error('Companion poll failed');
      const result = await readJson(response);
      if (!pollResponse(result) || JSON.stringify(result).includes(pairing.token)) throw new Error('Invalid companion response');
      if (generation !== this.generation) return;
      this.lastSuccess = this.now();
      this.state = 'connected';
      this.failures = 0;
      for (const { source, wire } of snapshot) {
        const events = this.events.get(wire.id);
        events?.acknowledge(wire.events ?? []);
        if (!events?.length) this.events.delete(wire.id);
        if (!events?.length && wire.state === source.state && this.updates.get(wire.id) === source) this.updates.delete(wire.id);
      }
      for (const id of result.cancelTaskIds) this.tasks.get(id)?.controller.abort();
      const cancelled = new Set(result.cancelTaskIds);
      for (const command of result.commands) {
        if (generation !== this.generation) return;
        await this.accept(command, pairing, generation, cancelled.has(command.id));
      }
    } catch {
      if (generation !== this.generation) return;
      this.failures += 1;
      this.state = 'offline';
      this.checkLease();
    } finally {
      if (this.requestController === controller) this.requestController = null;
    }
  }

  private refreshAgents(): void {
    if (this.detecting || this.now() - this.lastDetection < 10_000) return;
    this.detecting = true;
    this.lastDetection = this.now();
    void this.options.native.detectNativeAgents().then((agents) => { this.agents = agents; })
      .catch(() => { this.agents = []; }).finally(() => { this.detecting = false; });
  }

  private selectUpdates(): UpdateSnapshot[] {
    const snapshot: UpdateSnapshot[] = [];
    const baseBytes = Buffer.byteLength(JSON.stringify({ agents: this.agents, updates: [] }), 'utf8');
    let bytes = baseBytes;
    for (const queued of this.updates.values()) {
      let source = queued;
      const buffer = this.events.get(queued.id);
      const events = buffer?.snapshot() ?? [];
      // A terminal update with a partial event batch would cause the broker to
      // reject later activity. Keep the terminal report until older batches drain.
      let update: Update = buffer && buffer.length > events.length
        ? { id: queued.id, state: 'running' } : { ...queued };
      if (events.length) update.events = events;
      let size = Buffer.byteLength(JSON.stringify(update), 'utf8');
      // JSON escaping can make a bounded UTF-8 report exceed the HTTP body limit.
      if (size + baseBytes > MAX_POLL_BYTES) {
        source = { id: queued.id, state: 'failed', progress: 'Native report exceeded the delivery limit. Start a new task.' };
        this.updates.set(source.id, source);
        update = { ...source, ...(events.length ? { events } : {}) };
        size = Buffer.byteLength(JSON.stringify(update), 'utf8');
      }
      const separator = snapshot.length ? 1 : 0;
      if (snapshot.length >= 16 || bytes + size + separator > MAX_POLL_BYTES) break;
      snapshot.push({ source, wire: update });
      bytes += size + separator;
    }
    return snapshot;
  }

  private checkLease(): void {
    if (this.pairing && this.now() - this.lastSuccess >= OFFLINE_LIMIT_MS) {
      this.state = 'offline';
      for (const task of this.tasks.values()) task.controller.abort();
    }
  }

  private async accept(command: Command, pairing: Pairing, generation: number, cancelled: boolean): Promise<void> {
    if (this.processed.has(command.id)) return;
    if (this.processed.size >= MAX_PROCESSED_TASKS) {
      this.updates.set(command.id, { id: command.id, state: 'failed', progress: 'Reconnect the desktop companion to continue.' });
      return;
    }
    this.processed.add(command.id);
    // Persist before invoking the CLI. A crash after this point cannot cause replay.
    await this.save({ ...pairing, processedTaskIds: [...this.processed] });
    if (this.pairing !== pairing || this.generation !== generation) return;
    if (cancelled) {
      this.updates.set(command.id, { id: command.id, state: 'cancelled' });
      return;
    }
    if ([...this.tasks.values()].some((task) => task.provider === command.provider)) {
      this.updates.set(command.id, { id: command.id, state: 'failed', progress: 'This native agent is busy. Start a new task when it finishes.' });
      return;
    }
    const controller = new AbortController();
    const task: RunningTask = { controller, provider: command.provider, promise: Promise.resolve() };
    this.tasks.set(command.id, task);
    this.updates.set(command.id, { id: command.id, state: 'running' });
    task.promise = this.execute(command, pairing, controller).finally(() => {
      if (this.tasks.get(command.id) === task) this.tasks.delete(command.id);
    });
  }

  private async execute(command: Command, pairing: Pairing, controller: AbortController): Promise<void> {
    let acceptingEvents = true;
    const update = (value: Update): void => {
      if (this.pairing === pairing) this.updates.set(command.id, value);
    };
    try {
      if (command.kind === 'login') {
        await this.options.native.openNativeLogin(command.provider);
        this.lastDetection = -Infinity;
        update({ id: command.id, state: controller.signal.aborted ? 'cancelled' : 'completed' });
        return;
      }
      const result = await this.options.native.runNativeAgent(command.provider, command.prompt ?? '', {
        root: join(this.options.dataDir, 'tasks', command.id), signal: controller.signal,
        agentSettings: command.agentSettings,
        ...(command.researchTools ? { researchTools: { ...command.researchTools,
          call: (request: ResearchToolRequest, signal: AbortSignal) => this.callResearchTool(command, pairing, request,
            AbortSignal.any([controller.signal, signal])) } } : {}),
        onEvent: (event) => {
          if (!acceptingEvents || this.pairing !== pairing) return;
          const buffer = this.events.get(command.id) ?? new ResearchEventBuffer();
          buffer.append(event, pairing.token);
          if (buffer.length) {
            this.events.set(command.id, buffer);
            if (!this.updates.has(command.id)) update({ id: command.id, state: 'running' });
          }
        },
        onProgress: (progress) => {
          if (!controller.signal.aborted) update({ id: command.id, state: 'running', progress: progress.slice(0, 500) });
        },
      });
      if (controller.signal.aborted) { update({ id: command.id, state: 'cancelled' }); return; }
      if (Buffer.byteLength(result.text, 'utf8') > MAX_TEXT) throw new Error('Native result too large');
      update({ id: command.id, state: 'completed', text: result.text,
        usageTokens: Number.isSafeInteger(result.usageTokens) && Number(result.usageTokens) >= 0 ? result.usageTokens : null });
    } catch (error) {
      const code = nativeFailureCode(error);
      const cancelled = controller.signal.aborted && code !== 'LOCAL_DISPATCH_UNCERTAIN';
      update({ id: command.id, state: cancelled ? 'cancelled' : 'failed', ...(code && !cancelled ? { error: code } : {}),
        progress: cancelled ? 'Task interrupted.'
          : code === 'LOCAL_USAGE_LIMIT' ? 'Provider usage limit or insufficient balance. Check the provider account or change the model. No automatic retry.'
            : code === 'LOCAL_RATE_LIMIT' ? 'Provider rate limit. Try again later or change the model. No automatic retry.'
              : 'Native agent failed. Check its installation and sign-in before starting another task.' });
    } finally { acceptingEvents = false; }
  }

  private async callResearchTool(command: Command, pairing: Pairing, request: ResearchToolRequest,
    signal: AbortSignal): Promise<ResearchToolResult> {
    if (signal.aborted || this.pairing !== pairing || !this.tasks.has(command.id)) return researchFailure('cancelled', 'RESEARCH_CANCELLED');
    if (!command.researchTools || !validResearchRequest(request, command.researchTools)) return researchFailure('failed', 'RESEARCH_INVALID_CALL');
    let cancellation: Promise<void> | undefined;
    const cancel = (): void => {
      cancellation ??= this.cancelResearchTool(command.id, request.callId, pairing);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await this.request(`${pairing.origin}/api/local-agent-companion/research-tools`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairing.token}` },
        body: JSON.stringify({ taskId: command.id, callId: request.callId, name: request.name, arguments: request.arguments }),
      });
      if (!response.ok) throw new Error('Research request failed');
      const result = await readJson(response, 64_000);
      if (signal.aborted || this.pairing !== pairing) return researchFailure('cancelled', 'RESEARCH_CANCELLED', true);
      if (!validResearchResult(result) || JSON.stringify(result).includes(pairing.token)) throw new Error('Invalid research response');
      return result;
    } catch {
      return signal.aborted || this.pairing !== pairing ? researchFailure('cancelled', 'RESEARCH_CANCELLED', true)
        : researchFailure('unavailable', 'RESEARCH_TRANSPORT_UNAVAILABLE', true);
    } finally {
      signal.removeEventListener('abort', cancel);
      await cancellation;
    }
  }

  private async cancelResearchTool(taskId: string, callId: string, pairing: Pairing): Promise<void> {
    // A transport disconnect is not a cancellation. Only the explicit call signal
    // sends this idempotent intent, using a fresh deadline rather than the aborted signal.
    for (let attempt = 0; attempt < 2 && this.pairing === pairing; attempt++) {
      try {
        const response = await this.request(`${pairing.origin}/api/local-agent-companion/research-tools/cancel`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairing.token}` },
          body: JSON.stringify({ taskId, callId }),
        });
        await response.body?.cancel();
        if (response.ok || response.status === 401 || response.status === 403) return;
      } catch { /* A lost acknowledgement can safely retry this cancellation. */ }
    }
  }

  private async forget(): Promise<void> {
    this.generation += 1;
    for (const task of this.tasks.values()) task.controller.abort();
    this.pairing = null;
    this.processed.clear();
    this.updates.clear();
    this.events.clear();
    this.state = 'unpaired';
    await this.writes.catch(() => undefined);
    await rm(join(this.options.dataDir, 'pairing.json'), { force: true });
  }

  private async save(pairing: Pairing): Promise<void> {
    const snapshot = JSON.stringify(pairing);
    const write = this.writes.catch(() => undefined).then(async () => {
      await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
      const temporary = join(this.options.dataDir, `.pairing-${randomBytes(12).toString('hex')}.tmp`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(snapshot); await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(this.options.dataDir, 'pairing.json'));
      } finally { await rm(temporary, { force: true }); }
    });
    this.writes = write;
    await write;
  }
}
