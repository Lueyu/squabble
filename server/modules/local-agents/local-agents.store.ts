import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompanionPoll, CompanionPollResult, LocalAgentProvider, NativeAgentConfiguration, NativeAgentStatus } from '../../../shared/local-agents.interface';
import { LocalAgentError, nativeFailureCode, type LocalAgentHandoff } from './local-agents.types';
import { parseNativeAgentConfiguration, validateNativeAgentConfiguration } from './local-agents.requests';
import type { ResearchActivity, ResearchEventPage } from '../../../shared/research-events.interface';
import type { ResearchToolBundle, ResearchToolRequest, ResearchToolResult, ResearchToolScope } from '../../../shared/research-tools.interface';
import { appendResearchEvents, recordTaskLifecycle } from './research-journal';
import { researchFailure } from '../research-tools/research-tools.output';
import type { NativeAgentImage } from '../../../shared/native-image.interface';
import { nativeImageCapability, validateNativeImage } from '../../local-agents/native-image';

export interface AgentTask {
  hasImage?: boolean;
  researchScope?: ResearchToolScope; researchBundle?: ResearchToolBundle;
  events?: ResearchEventPage['events']; eventSequence?: number; eventIds?: string[]; eventsTruncated?: boolean;
  toolCalls?: Record<string, { fingerprint: string; result?: ResearchToolResult }>;
  cancelledToolCallIds?: string[];
  id: string; owner: string; agentId: string; provider: LocalAgentProvider;
  deviceId?: string; kind: 'run' | 'login'; messageId: string; prompt: string;
  agentSettings?: NativeAgentConfiguration;
  state: 'staged' | 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  createdAt: number; updatedAt: number; progress?: string; text?: string;
  usageTokens?: number | null; error?: string;
  commandEmitted?: boolean;
  runtimeEntered?: boolean;
  handoffRequired?: boolean;
}
export interface AgentDevice {
  id: string; owner: string; name: string; tokenHash: string;
  providers: LocalAgentProvider[]; agents: NativeAgentStatus[]; lastSeen: number;
}
interface State {
  nativeOwner?: string;
  nativeProviders: LocalAgentProvider[];
  devices: AgentDevice[];
  tasks: Record<string, AgentTask>;
}
const active = (task: AgentTask) => ['staged', 'queued', 'running', 'cancelling'].includes(task.state);
const requestCancellation = (task: AgentTask): void => {
  if (!active(task)) return;
  const dispatched = task.state === 'running' || task.state === 'cancelling';
  task.state = dispatched ? 'cancelling' : 'cancelled';
  task.error = dispatched ? 'LOCAL_PAUSED' : 'LOCAL_CANCELLED';
  task.updatedAt = Date.now();
};
const recordLateUncertainty = (task: AgentTask, change: { state?: string; error?: string }): boolean => {
  if (task.state !== 'failed' || task.error !== 'LOCAL_INTERRUPTED'
    || change.state !== 'failed' || change.error !== 'LOCAL_DISPATCH_UNCERTAIN') return false;
  task.error = 'LOCAL_DISPATCH_UNCERTAIN'; task.updatedAt = Date.now();
  return true;
};
const fail = (code: string): never => { throw new LocalAgentError(code); };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ownedTask = (state: State, owner: string, id: string): AgentTask => {
  const task = state.tasks[id];
  if (!task || task.owner !== owner) return fail('LOCAL_TASK_NOT_FOUND');
  return task;
};

/** One process owns this journal. Every mutation is serialized and durably written before dispatch. */
export class LocalAgentStore {
  private state: State = { nativeProviders: [], devices: [], tasks: {} };
  private tail: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private readonly pairs = new Map<string, { owner: string; expiresAt: number }>();
  private readonly images = new Map<string, { owner: string; image: NativeAgentImage; signal?: AbortSignal }>();
  private readonly handoffs = new Map<string, LocalAgentHandoff>();
  readonly sharedNative: boolean;
  constructor(readonly root: string, options: { sharedNative?: boolean } = {}) {
    this.sharedNative = options.sharedNative ?? false;
  }

  registerHandoff(owner: string, id: string, guard: LocalAgentHandoff): () => void {
    const key = `${owner}:${id}`;
    this.handoffs.set(key, guard);
    return () => { if (this.handoffs.get(key) === guard) this.handoffs.delete(key); };
  }
  /** Never execute an asynchronous validation callback under the journal's mutation queue. */
  async handoff(owner: string, id: string, emit: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    const task = await this.task(owner, id);
    const key = `${owner}:${id}`, guard = this.handoffs.get(key);
    if (guard) return guard(() => emit(() => this.handoffs.get(key) === guard));
    if (task.researchScope?.memoryReferences?.length) throw new LocalAgentError('MEMORY_CONTEXT_CHANGED');
    if (task.handoffRequired) throw new LocalAgentError('LOCAL_PAUSED');
    await emit(() => !this.handoffs.has(key) && !this.state.tasks[id]?.handoffRequired);
  }

  private async atomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(join(this.root, 'tasks'), { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(join(this.root, 'connections.json'), 'utf8'));
      if (!Array.isArray(saved.devices) || !Array.isArray(saved.nativeProviders)) fail('LOCAL_STATE_INVALID');
      this.state = { ...saved, tasks: {} };
      this.state.devices.forEach((device) => { device.lastSeen = 0; });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of await readdir(join(this.root, 'tasks'))) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
      const task = JSON.parse(await readFile(join(this.root, 'tasks', name), 'utf8')) as AgentTask;
      if (`${task.id}.json` !== name || !task.owner || !task.state) fail('LOCAL_STATE_INVALID');
      if (active(task)) {
        const previousState = task.state;
        task.state = 'failed'; task.error = 'LOCAL_INTERRUPTED'; task.updatedAt = Date.now();
        recordTaskLifecycle(task, previousState);
        await this.atomic(join(this.root, 'tasks', name), task);
      }
      this.state.tasks[task.id] = task;
    }
    this.loaded = true;
  }

  private access<T>(mutate: boolean, action: (state: State) => T): Promise<T> {
    const result = this.tail.then(async () => {
      await this.load();
      if (!mutate) return structuredClone(action(this.state));
      const next = structuredClone(this.state);
      const value = action(next);
      const { tasks, ...connections } = next;
      const { tasks: previousTasks, ...previousConnections } = this.state;
      // Write tasks first: interrupted jobs may be recovered, but never dispatched twice.
      for (const task of Object.values(tasks)) {
        recordTaskLifecycle(task, previousTasks[task.id]?.state);
        if (JSON.stringify(task) !== JSON.stringify(previousTasks[task.id])) {
          await this.atomic(join(this.root, 'tasks', `${task.id}.json`), task);
        }
      }
      if (JSON.stringify(connections) !== JSON.stringify(previousConnections)) {
        await this.atomic(join(this.root, 'connections.json'), connections);
      }
      this.state = next;
      return structuredClone(value);
    }).finally(() => {
      for (const [id] of this.images) {
        const task = this.state.tasks[id];
        if (!task || !active(task) || task.state === 'cancelling') this.images.delete(id);
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  createPairing(owner: string, ttl = 300_000): Promise<{ code: string; expiresAt: string }> {
    return this.access(false, () => {
      const now = Date.now();
      for (const [code, entry] of this.pairs) if (entry.owner === owner || entry.expiresAt <= now) this.pairs.delete(code);
      if (this.pairs.size >= 128) fail('LOCAL_BUSY');
      const code = randomBytes(24).toString('hex');
      const expiresAt = now + ttl;
      this.pairs.set(code, { owner, expiresAt });
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  pair(code: string, name: string): Promise<{ token: string; deviceId: string }> {
    return this.access(true, (state) => {
      const entry = this.pairs.get(code);
      if (!entry || entry.expiresAt <= Date.now()) return fail('LOCAL_PAIRING_EXPIRED');
      this.pairs.delete(code);
      this.revokeIn(state, entry.owner);
      const token = randomBytes(32).toString('hex');
      const deviceId = randomUUID();
      state.devices.push({ id: deviceId, owner: entry.owner, name: name.slice(0, 80),
        tokenHash: hash(token), providers: [], agents: [], lastSeen: Date.now() });
      return { token, deviceId };
    });
  }

  private revokeIn(state: State, owner: string): void {
    state.devices = state.devices.filter((device) => device.owner !== owner);
    for (const task of Object.values(state.tasks)) if (task.owner === owner && task.deviceId && active(task)) {
      const dispatched = task.state === 'running' || task.state === 'cancelling';
      task.state = dispatched ? 'failed' : 'cancelled';
      task.error = dispatched ? 'LOCAL_DISPATCH_UNCERTAIN' : 'LOCAL_CANCELLED'; task.updatedAt = Date.now();
    }
  }
  revoke(owner: string): Promise<void> { return this.access(true, (state) => this.revokeIn(state, owner)); }
  deviceFor(owner: string): Promise<AgentDevice | undefined> { return this.access(false, (state) => state.devices.find((device) => device.owner === owner)); }
  nativeProviders(owner: string): Promise<LocalAgentProvider[]> {
    return this.access(false, (state) => this.sharedNative || state.nativeOwner === owner ? state.nativeProviders : []);
  }
  nativeClaimedByOther(owner: string): Promise<boolean> { return this.access(false, (state) => !this.sharedNative && !!state.nativeOwner && state.nativeOwner !== owner); }
  claimNative(owner: string): Promise<void> {
    return this.access(true, (state) => {
      // Keep legacy ownership untouched so switching back to account mode is reversible.
      if (this.sharedNative) return;
      if (state.nativeOwner && state.nativeOwner !== owner) fail('LOCAL_AGENT_OWNED');
      state.nativeOwner = owner;
    });
  }
  connectNative(owner: string, provider: LocalAgentProvider): Promise<void> {
    return this.access(true, (state) => {
      if (!this.sharedNative) {
        if (state.nativeOwner && state.nativeOwner !== owner) fail('LOCAL_AGENT_OWNED');
        state.nativeOwner = owner;
      }
      if (!state.nativeProviders.includes(provider)) state.nativeProviders.push(provider);
    });
  }
  disconnectNative(owner: string, provider: LocalAgentProvider): Promise<void> {
    return this.access(true, (state) => {
      if (!this.sharedNative && state.nativeOwner !== owner) fail('LOCAL_AGENT_OWNED');
      state.nativeProviders = state.nativeProviders.filter((id) => id !== provider);
      this.cancelProvider(state, owner, `native-${provider}`);
      if (!this.sharedNative && !state.nativeProviders.length) delete state.nativeOwner;
    });
  }
  connectCompanion(owner: string, provider: LocalAgentProvider): Promise<void> {
    return this.access(true, (state) => {
      const device = state.devices.find((item) => item.owner === owner);
      if (!device || Date.now() - device.lastSeen > 15_000) fail('LOCAL_COMPANION_OFFLINE');
      if (!device!.agents.some((item) => item.provider === provider && item.state === 'ready')) fail('LOCAL_LOGIN_REQUIRED');
      if (!device!.providers.includes(provider)) device!.providers.push(provider);
    });
  }
  disconnectCompanion(owner: string, provider: LocalAgentProvider): Promise<void> {
    return this.access(true, (state) => {
      const device = state.devices.find((item) => item.owner === owner);
      if (!device) fail('LOCAL_COMPANION_OFFLINE');
      device!.providers = device!.providers.filter((item) => item !== provider);
      this.cancelProvider(state, owner, `companion-${provider}`);
    });
  }
  private inProviderScope(task: AgentTask, owner: string, agentId: string): boolean {
    return task.agentId === agentId && (task.owner === owner || this.sharedNative && agentId.startsWith('native-') && !task.deviceId);
  }
  private cancelProvider(state: State, owner: string, agentId: string): void {
    for (const task of Object.values(state.tasks)) if (this.inProviderScope(task, owner, agentId) && active(task)) {
      requestCancellation(task);
    }
  }
  findMessage(owner: string, messageId: string): Promise<AgentTask | undefined> {
    return this.access(false, (state) => Object.values(state.tasks).find((task) => task.owner === owner && task.messageId === messageId));
  }
  task(owner: string, id: string): Promise<AgentTask> { return this.access(false, (state) => ownedTask(state, owner, id)); }
  imageFor(owner: string, id: string): Promise<NativeAgentImage> {
    return this.access(false, state => {
      const task = ownedTask(state, owner, id);
      const entry = this.images.get(id);
      if (!task.hasImage || !entry || entry.owner !== owner) return fail('LOCAL_INVALID_INPUT');
      if (entry.signal?.aborted) return fail('LOCAL_CANCELLED');
      return entry.image;
    });
  }
  busy(owner: string, agentId: string): Promise<boolean> { return this.access(false, (state) => Object.values(state.tasks).some((task) => this.inProviderScope(task, owner, agentId) && active(task))); }

  stage(owner: string, agentId: string, provider: LocalAgentProvider, messageId: string, prompt: string,
    kind: 'run' | 'login' = 'run', inputSettings?: NativeAgentConfiguration,
    research?: { scope: ResearchToolScope; bundle: ResearchToolBundle }, imageOrHandoff?: NativeAgentImage | boolean, imageSignal?: AbortSignal,
    handoffRequired = typeof imageOrHandoff === 'boolean' && imageOrHandoff): Promise<AgentTask> {
    const inputImage = typeof imageOrHandoff === 'boolean' ? undefined : imageOrHandoff;
    const agentSettings = parseNativeAgentConfiguration(inputSettings);
    let image: NativeAgentImage | undefined;
    if (inputImage !== undefined) {
      if (imageSignal?.aborted) return Promise.reject(new LocalAgentError('LOCAL_CANCELLED'));
      try { image = validateNativeImage(inputImage); } catch { return Promise.reject(new LocalAgentError('LOCAL_INVALID_INPUT')); }
      if (kind !== 'run' || !nativeImageCapability(provider)) return Promise.reject(new LocalAgentError('LOCAL_IMAGE_UNSUPPORTED'));
    }
    return this.access(true, (state) => {
      const existing = Object.values(state.tasks).find((task) => task.owner === owner && task.messageId === messageId);
      if (existing) return existing;
      if (Object.values(state.tasks).some((task) => this.inProviderScope(task, owner, agentId) && active(task))) fail('LOCAL_BUSY');
      const device = agentId.startsWith('companion-') ? state.devices.find((item) => item.owner === owner) : undefined;
      if (agentId.startsWith('companion-')) {
        if (!device || Date.now() - device.lastSeen > 15_000) fail('LOCAL_COMPANION_OFFLINE');
        if (!device!.agents.some((agent) => agent.provider === provider)) fail('LOCAL_VERSION_UNSUPPORTED');
        if (kind === 'run' && !device!.providers.includes(provider)) fail('LOCAL_AGENT_NOT_FOUND');
        if (image && device!.agents.find(agent => agent.provider === provider)?.imageInput !== true) fail('LOCAL_IMAGE_UNSUPPORTED');
        validateNativeAgentConfiguration(agentSettings, device?.agents.find((agent) => agent.provider === provider));
      } else if (!this.sharedNative && state.nativeOwner !== owner || (kind === 'run' && !state.nativeProviders.includes(provider))) fail('LOCAL_AGENT_NOT_FOUND');
      const task: AgentTask = { id: randomUUID(), owner, agentId, provider, deviceId: device?.id, kind, messageId, prompt,
        ...(image ? { hasImage: true } : {}),
        ...(agentSettings ? { agentSettings } : {}),
        ...(research ? { researchScope: research.scope, researchBundle: research.bundle } : {}),
        ...(handoffRequired ? { handoffRequired: true } : {}),
        state: 'staged', createdAt: Date.now(), updatedAt: Date.now() };
      state.tasks[task.id] = task;
      if (image) this.images.set(task.id, { owner, image, signal: imageSignal });
      return task;
    });
  }
  requireHandoff(owner: string, id: string): Promise<void> {
    return this.access(true, state => { ownedTask(state, owner, id).handoffRequired = true; });
  }
  activate(owner: string, id: string): Promise<void> {
    return this.access(true, (state) => { const task = ownedTask(state, owner, id); if (task.state === 'staged') {
      if (this.images.get(id)?.signal?.aborted) requestCancellation(task);
      else { task.state = 'queued'; task.updatedAt = Date.now(); }
    } });
  }
  takeNative(owner: string, id: string): Promise<boolean> {
    return this.access(true, (state) => {
      const task = ownedTask(state, owner, id);
      if (task.deviceId || task.state !== 'queued') return false;
      if (this.images.get(id)?.signal?.aborted) { requestCancellation(task); return false; }
      task.state = 'running'; task.updatedAt = Date.now(); return true;
    });
  }
  markNativeEntry(owner: string, id: string): Promise<void> {
    return this.access(true, state => { ownedTask(state, owner, id).runtimeEntered = true; });
  }
  update(owner: string, id: string, change: Partial<Pick<AgentTask, 'state' | 'progress' | 'text' | 'usageTokens' | 'error'>>): Promise<void> {
    return this.access(true, (state) => {
      const task = ownedTask(state, owner, id);
      if (recordLateUncertainty(task, change)) return;
      if (!active(task)) return;
      if (task.state === 'cancelling' && change.state === 'completed') {
        Object.assign(task, { state: 'cancelled', error: 'LOCAL_CANCELLED', updatedAt: Date.now() });
      } else Object.assign(task, change, { updatedAt: Date.now() });
    });
  }
  cancel(owner: string, id: string): Promise<AgentTask['state']> {
    return this.access(true, (state) => {
      const task = ownedTask(state, owner, id);
      requestCancellation(task);
      return task.state;
    });
  }
  /** Execution lost its controller. Pre-entry work stops locally; dispatched work retains its evidence. */
  abandon(owner: string, id: string, runtimeEntered = false, uncertain = false): Promise<AgentTask> {
    return this.access(true, state => {
      const task = ownedTask(state, owner, id);
      if (runtimeEntered) task.runtimeEntered = true;
      // This controller failure, unlike explicit cancellation, must survive a faster runtime stop.
      if (uncertain && (task.runtimeEntered || task.commandEmitted)) {
        task.state = 'failed'; task.error = 'LOCAL_DISPATCH_UNCERTAIN'; task.updatedAt = Date.now();
      } else if (active(task)) {
        if (runtimeEntered || task.runtimeEntered || task.commandEmitted) requestCancellation(task);
        else { task.state = 'cancelled'; task.error = 'LOCAL_CANCELLED'; task.updatedAt = Date.now(); }
      }
      return task;
    });
  }

  appendEvents(owner: string, id: string, events: ResearchActivity[]): Promise<void> {
    return this.access(true, state => appendResearchEvents(ownedTask(state, owner, id), events));
  }

  eventsForSession(owner: string, sessionId: string): Promise<ResearchEventPage> {
    return this.access(false, state => {
      const tasks = Object.values(state.tasks).filter(task => task.owner === owner && task.researchScope?.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt);
      const events = tasks.flatMap(task => task.events ?? []);
      return { events: events.slice(-2048), cursor: events.length,
        truncated: events.length > 2048 || tasks.some(task => task.eventsTruncated) };
    });
  }

  private assertResearchTask(task: AgentTask): void {
    if (task.state !== 'running' || !task.researchScope || task.researchScope.expiresAt <= Date.now()
      || Date.now() - task.createdAt > 600_000) fail('RESEARCH_TASK_INACTIVE');
  }

  companionTask(token: string, id: string): Promise<AgentTask> {
    return this.access(false, state => {
      const fingerprint = hash(token);
      const device = state.devices.find(item => item.tokenHash.length === fingerprint.length
        && timingSafeEqual(Buffer.from(item.tokenHash), Buffer.from(fingerprint)));
      if (!device || Date.now() - device.lastSeen >= 30_000) return fail('LOCAL_COMPANION_UNAUTHORIZED');
      const task = ownedTask(state, device.owner, id);
      if (task.deviceId !== device.id) return fail('LOCAL_TASK_NOT_FOUND');
      this.assertResearchTask(task);
      return task;
    });
  }

  beginToolCall(owner: string, id: string, request: ResearchToolRequest): Promise<{ run: boolean; result?: ResearchToolResult }> {
    return this.access(true, state => {
      const task = ownedTask(state, owner, id); this.assertResearchTask(task);
      if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(request.callId) || !/^[a-z_]{1,80}$/u.test(request.name)
        || !request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)
        || Buffer.byteLength(JSON.stringify(request.arguments)) > 4096) fail('RESEARCH_INVALID_CALL');
      const fingerprint = hash(JSON.stringify([request.name, Object.entries(request.arguments).sort(([a], [b]) => a.localeCompare(b))]));
      const calls = task.toolCalls ??= {};
      const existing = Object.hasOwn(calls, request.callId) ? calls[request.callId] : undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('RESEARCH_CALL_CONFLICT');
        return { run: false, result: existing.result ?? { status: 'failed', data: { message: 'Prior call completion is unknown; it was not retried.' }, sources: [], asOf: new Date().toISOString(),
          truncated: false, errorCode: 'RESEARCH_CALL_UNCERTAIN' } };
      }
      if (task.cancelledToolCallIds?.includes(request.callId)) {
        return { run: false, result: researchFailure('cancelled', 'RESEARCH_CALL_CANCELLED') };
      }
      if (Object.keys(calls).length >= 24) fail('RESEARCH_TASK_LIMIT');
      Object.defineProperty(calls, request.callId, { value: { fingerprint }, enumerable: true, writable: true, configurable: true });
      return { run: true };
    });
  }

  cancelToolCall(owner: string, id: string, callId: string): Promise<boolean> {
    return this.access(true, state => {
      const task = ownedTask(state, owner, id); this.assertResearchTask(task);
      if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(callId)) fail('RESEARCH_INVALID_CALL');
      const entry = task.toolCalls && Object.hasOwn(task.toolCalls, callId) ? task.toolCalls[callId] : undefined;
      if (entry?.result) return entry.result.status === 'cancelled';
      const cancelled = task.cancelledToolCallIds ??= [];
      if (cancelled.includes(callId)) return true;
      if (cancelled.length >= 128) fail('RESEARCH_TASK_LIMIT');
      cancelled.push(callId);
      // Cancellation may arrive before the original HTTP request has claimed this ID.
      if (entry) entry.result = researchFailure('cancelled', 'RESEARCH_CALL_CANCELLED', true);
      return true;
    });
  }

  finishToolCall(owner: string, id: string, callId: string, result: ResearchToolResult): Promise<ResearchToolResult> {
    return this.access(true, state => {
      const task = ownedTask(state, owner, id);
      const entry = task.toolCalls && Object.hasOwn(task.toolCalls, callId) ? task.toolCalls[callId] : undefined;
      if (entry && !entry.result) entry.result = result;
      return entry?.result ?? result;
    });
  }

  async poll(token: string, request: CompanionPoll): Promise<CompanionPollResult> {
    const pendingImages = new Map<string, { owner: string; signal?: AbortSignal }>();
    const result = await this.pollState(token, request);
    let commandBytes = 0;
    const candidates = await this.access(false, state => {
      const tokenHash = hash(token), device = state.devices.find(item => item.tokenHash === tokenHash);
      if (!device) return fail('LOCAL_COMPANION_UNAUTHORIZED');
      return Object.values(state.tasks).filter(task => task.deviceId === device.id && task.owner === device.owner && task.state === 'queued');
    });
    for (const task of candidates) {
      let emittedHere = false;
      try {
        await this.handoff(task.owner, task.id, async isCurrent => {
          const emitted = await this.pollState(token, { agents: request.agents, updates: [] }, task.id, isCurrent,
            12 * 1024 * 1024 - 128_000 - commandBytes);
          for (const command of emitted.commands) {
            commandBytes += Buffer.byteLength(JSON.stringify(command));
            if (command.hasImage) pendingImages.set(command.id, { owner: task.owner, signal: this.images.get(command.id)?.signal });
          }
          emittedHere = emitted.commands.length > 0;
          result.commands.push(...emitted.commands);
        });
      } catch (error) {
        // A command already emitted remains an observable receipt, even if later bookkeeping fails.
        if (!(await this.task(task.owner, task.id)).commandEmitted) {
          await this.update(task.owner, task.id, { state: 'failed', error: nativeFailureCode(error) });
          result.cancelTaskIds.push(task.id);
        } else if (emittedHere) await this.update(task.owner, task.id, { state: 'failed', error: 'LOCAL_DISPATCH_UNCERTAIN' });
      }
    }
    return this.discardCancelledImages(result, pendingImages);
  }
  private async pollState(token: string, request: CompanionPoll, handoffId?: string, isCurrent?: () => boolean, maxCommandBytes = 12 * 1024 * 1024 - 128_000): Promise<CompanionPollResult> {
    const pendingImages = new Map<string, { owner: string; signal?: AbortSignal }>();
    const result = await this.access(true, (state) => {
      const tokenHash = hash(token);
      const device = state.devices.find((item) => item.tokenHash.length === tokenHash.length && timingSafeEqual(Buffer.from(item.tokenHash), Buffer.from(tokenHash)));
      if (!device) return fail('LOCAL_COMPANION_UNAUTHORIZED');
      const now = Date.now();
      // A lost lease is never revived by a late result or poll.
      for (const task of Object.values(state.tasks)) if (task.deviceId === device.id && active(task)
        && (now - task.createdAt > 600_000 || (['running', 'cancelling'].includes(task.state) && now - device.lastSeen > 30_000))) {
        task.state = 'failed'; task.error = 'LOCAL_INTERRUPTED'; task.updatedAt = now;
      }
      device.lastSeen = now; device.agents = request.agents;
      for (const update of request.updates) {
        const task = state.tasks[update.id];
        if (!task || task.deviceId !== device.id || task.owner !== device.owner) continue;
        if (recordLateUncertainty(task, update)) continue;
        if (!['running', 'cancelling'].includes(task.state)) continue;
        if (!task.hasImage) appendResearchEvents(task, update.events ?? []);
        if (task.state === 'cancelling' && update.state === 'running') continue;
        if (task.state === 'cancelling' && update.state === 'completed') {
          task.state = 'cancelled'; task.error = 'LOCAL_CANCELLED';
        } else if (update.state === 'completed' && task.kind === 'run' && (!update.text?.trim()
          || task.hasImage && !!this.images.get(task.id)?.image.data && update.text.includes(this.images.get(task.id)!.image.data))) {
          task.state = 'failed'; task.error = 'LOCAL_INVALID_RESULT';
        } else {
          task.state = update.state;
          if (update.progress !== undefined && !task.hasImage) task.progress = update.progress.slice(0, 500);
          if (update.text !== undefined && (!task.hasImage || update.state === 'completed')) task.text = update.text;
          if (update.usageTokens !== undefined) task.usageTokens = update.usageTokens;
          if (update.state === 'failed') task.error = update.error ?? 'LOCAL_TASK_FAILED';
          if (update.state === 'cancelled') task.error = 'LOCAL_CANCELLED';
        }
        task.updatedAt = now;
      }
      const commands: CompanionPollResult['commands'] = [];
      let commandBytes = 0;
      const cancelTaskIds: string[] = [];
      for (const task of Object.values(state.tasks)) if (task.deviceId === device.id) {
        // Helpers terminate disconnected work within 30s and all work within 10 minutes.
        // Old terminal records must not grow heartbeat payloads without bound.
        if (['cancelling', 'cancelled', 'failed'].includes(task.state) && now - task.updatedAt <= 600_000) cancelTaskIds.push(task.id);
        if (task.state === 'queued' && task.id === handoffId) {
          if (!isCurrent?.()) fail('LOCAL_CANCELLED');
          if (!device.agents.some((agent) => agent.provider === task.provider)) {
            task.state = 'failed'; task.error = 'LOCAL_VERSION_UNSUPPORTED'; task.updatedAt = now;
            continue;
          }
          const image = task.hasImage ? this.images.get(task.id) : undefined;
          if (image?.signal?.aborted) { requestCancellation(task); continue; }
          if (task.hasImage && (!nativeImageCapability(task.provider)
            || device.agents.find(agent => agent.provider === task.provider)?.imageInput !== true)) {
            task.state = 'failed'; task.error = 'LOCAL_IMAGE_UNSUPPORTED'; task.updatedAt = now; continue;
          }
          if (task.hasImage && (!image || image.owner !== task.owner)) {
            task.state = 'failed'; task.error = 'LOCAL_INVALID_INPUT'; task.updatedAt = now; continue;
          }
          try { validateNativeAgentConfiguration(task.agentSettings, device.agents.find((agent) => agent.provider === task.provider)); }
          catch {
            task.state = 'failed'; task.error = 'LOCAL_CONFIGURATION_UNSUPPORTED'; task.updatedAt = now;
            continue;
          }
          const command: CompanionPollResult['commands'][number] = { id: task.id, kind: task.kind, provider: task.provider,
            ...(image ? { image: image.image, hasImage: true } : {}),
            ...(task.researchBundle ? { researchTools: task.researchBundle } : {}),
            ...(task.kind === 'run' ? { prompt: task.prompt, ...(task.agentSettings ? { agentSettings: task.agentSettings } : {}) } : {}) };
          const bytes = Buffer.byteLength(JSON.stringify(command));
          if (commandBytes + bytes > maxCommandBytes) continue;
          task.state = 'running'; task.updatedAt = now;
          task.commandEmitted = true;
          if (image) pendingImages.set(task.id, { owner: image.owner, signal: image.signal });
          commands.push(command); commandBytes += bytes;
        }
      }
      return { commands, cancelTaskIds: cancelTaskIds.slice(-1000) };
    });
    return this.discardCancelledImages(result, pendingImages);
  }
  private async discardCancelledImages(result: CompanionPollResult,
    pendingImages: Map<string, { owner: string; signal?: AbortSignal }>): Promise<CompanionPollResult> {
    // Persistence yields to cancellation. Recheck before returning any image to the
    // transport, and confirm cancellation while the command is still unsent.
    for (;;) {
      const cancelled = result.commands.filter(command => pendingImages.has(command.id)
        && (pendingImages.get(command.id)!.signal?.aborted || !this.images.has(command.id)));
      if (!cancelled.length) return result;
      const ids = new Set(cancelled.map(command => command.id));
      result.commands = result.commands.filter(command => !ids.has(command.id));
      result.cancelTaskIds = [...new Set([...result.cancelTaskIds, ...ids])].slice(-1000);
      await Promise.all(cancelled.map(command => this.access(true, state => {
        const task = ownedTask(state, pendingImages.get(command.id)!.owner, command.id);
        if (active(task)) { task.state = 'cancelled'; task.error = 'LOCAL_CANCELLED'; task.updatedAt = Date.now(); }
        // This command never left the poll response, so it cannot claim a delivery receipt.
        delete task.commandEmitted;
      })));
    }
  }
}
