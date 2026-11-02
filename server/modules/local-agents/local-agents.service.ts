import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LocalAgentConnection, LocalAgentsStatus, NativeAgentStatus, LocalAgentProvider } from '../../../shared/local-agents.interface';
import { detectNativeAgents, openNativeLogin, runNativeAgent } from '../../local-agents/native';
import { LocalAgentStore, type AgentTask } from './local-agents.store';
import { LocalAgentError, type LocalAgentExecution, type LocalAgentResult } from './local-agents.types';
import { providerCatalog, providerFromId } from './local-agents.requests';

interface Runtime {
  detectNativeAgents(): Promise<NativeAgentStatus[]>;
  openNativeLogin(provider: LocalAgentProvider): Promise<void>;
  runNativeAgent: typeof runNativeAgent;
}
const wait = (ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));

@Injectable()
export class LocalAgentsService implements OnModuleDestroy {
  readonly store: LocalAgentStore;
  private readonly runtime: Runtime;
  private readonly running = new Map<string, { owner: string; agentId: string; abort: AbortController; done: Promise<void> }>();
  private readonly logins = new Set<LocalAgentProvider>();
  private detection?: { until: number; promise: Promise<NativeAgentStatus[]> };
  private stopping = false;

  constructor(@Optional() @Inject('LOCAL_AGENT_RUNTIME') runtime?: Runtime,
    @Optional() @Inject('LOCAL_AGENT_STORE') store?: LocalAgentStore) {
    this.runtime = runtime ?? { detectNativeAgents, openNativeLogin, runNativeAgent };
    this.store = store ?? new LocalAgentStore(resolve(process.env.LOCAL_AGENTS_DATA_DIR || join(homedir(), '.squabble', 'local-agents')));
  }
  get mode(): 'native' | 'companion' {
    if (process.env.SQUABBLE_DESKTOP_ORIGIN) return 'native';
    return process.env.LOCAL_AGENTS_MODE === 'native' && ['127.0.0.1', 'localhost', '::1'].includes(process.env.SERVER_HOST || '') ? 'native' : 'companion';
  }
  private detect(): Promise<NativeAgentStatus[]> {
    if (!this.detection || this.detection.until <= Date.now()) {
      this.detection = { until: Date.now() + 3_000, promise: this.runtime.detectNativeAgents() };
    }
    return this.detection.promise;
  }
  async status(owner: string): Promise<LocalAgentsStatus> {
    const mode = this.mode;
    const device = mode === 'companion' ? await this.store.deviceFor(owner) : undefined;
    const online = mode === 'native' || !!device && Date.now() - device.lastSeen < 15_000;
    const foreign = mode === 'native' && await this.store.nativeClaimedByOther(owner);
    const detected = mode === 'native' && !foreign ? await this.detect() : device?.agents ?? [];
    const connected = mode === 'native' ? await this.store.nativeProviders(owner) : device?.providers ?? [];
    const items: LocalAgentConnection[] = await Promise.all((['codex', 'claude'] as const).map(async (provider) => {
      const native = detected.find((entry) => entry.provider === provider) ?? { ...providerCatalog[provider], state: 'error' as const };
      const id = `${mode}-${provider}`;
      return { ...native, id, connected: connected.includes(provider), available: online && native.state === 'ready' && connected.includes(provider),
        busy: [...this.running.values()].some((run) => run.agentId === id) || await this.store.busy(owner, id), source: mode };
    }));
    return { mode, items, companion: { connected: mode === 'companion' && online, ...(device ? { name: device.name } : {}) } };
  }
  async list(owner: string): Promise<LocalAgentConnection[]> { return (await this.status(owner)).items.filter((item) => item.connected); }
  async validate(owner: string, id: string): Promise<void> {
    const item = (await this.status(owner)).items.find((entry) => entry.id === id);
    if (!item?.connected) throw new LocalAgentError('LOCAL_AGENT_NOT_FOUND');
    if (!item.available) throw new LocalAgentError(item.state === 'login_required' ? 'LOCAL_LOGIN_REQUIRED' : 'LOCAL_UNAVAILABLE');
  }
  async connect(owner: string, id: string): Promise<void> {
    const provider = providerFromId(id, this.mode);
    if (this.mode === 'native') {
      const agent = (await this.detect()).find((entry) => entry.provider === provider);
      if (agent?.state !== 'ready') throw new LocalAgentError('LOCAL_LOGIN_REQUIRED');
      await this.store.connectNative(owner, provider);
    } else await this.store.connectCompanion(owner, provider);
  }
  async disconnect(owner: string, id: string): Promise<void> {
    const provider = providerFromId(id, this.mode);
    if (this.mode === 'native') await this.store.disconnectNative(owner, provider);
    else await this.store.disconnectCompanion(owner, provider);
    for (const [taskId, execution] of this.running) {
      if (execution.owner === owner && (await this.store.task(owner, taskId)).agentId === id) execution.abort.abort();
    }
  }
  async login(owner: string, id: string): Promise<void> {
    const provider = providerFromId(id, this.mode);
    if (this.mode === 'native') {
      await this.store.claimNative(owner);
      if (this.logins.has(provider)) throw new LocalAgentError('LOCAL_BUSY');
      this.logins.add(provider);
      try { await this.runtime.openNativeLogin(provider); this.detection = undefined; }
      finally { setTimeout(() => this.logins.delete(provider), 5_000).unref(); }
    } else {
      const task = await this.store.stage(owner, id, provider, randomUUID(), '', 'login');
      await this.store.activate(owner, task.id);
    }
  }
  async pairing(owner: string) {
    if (this.mode !== 'companion') throw new LocalAgentError('LOCAL_PAIRING_NOT_NEEDED');
    return this.store.createPairing(owner);
  }

  private async launch(task: AgentTask): Promise<void> {
    if (this.stopping || this.running.has(task.id) || !await this.store.takeNative(task.owner, task.id)) return;
    const abort = new AbortController();
    let progressWrites: Promise<void> = Promise.resolve();
    const done = (async () => {
      try {
        const result = await this.runtime.runNativeAgent(task.provider, task.prompt, { root: join(this.store.root, 'workspaces', task.id), signal: abort.signal,
          onProgress: (text: string) => { progressWrites = progressWrites.then(() => this.store.update(task.owner, task.id, { progress: text.slice(0, 500) })); } });
        await progressWrites;
        if (!result.text?.trim() || Buffer.byteLength(result.text) > 512_000) throw new LocalAgentError('LOCAL_INVALID_RESULT');
        await this.store.update(task.owner, task.id, { state: 'completed', text: result.text, usageTokens: result.usageTokens });
      } catch (error) {
        await progressWrites.catch(() => undefined);
        await this.store.update(task.owner, task.id, { state: abort.signal.aborted ? 'cancelled' : 'failed',
          error: abort.signal.aborted ? 'LOCAL_CANCELLED' : error instanceof LocalAgentError ? error.code : 'LOCAL_TASK_FAILED' });
      } finally { this.running.delete(task.id); }
    })();
    this.running.set(task.id, { owner: task.owner, agentId: task.agentId, abort, done });
    // Awaited by execute/shutdown; keep background rejection handled if persistence fails.
    void done.catch(() => undefined);
  }

  async execute(owner: string, options: LocalAgentExecution): Promise<LocalAgentResult> {
    if (this.stopping) throw new LocalAgentError('LOCAL_UNAVAILABLE');
    const provider = providerFromId(options.agentId, this.mode);
    let task = options.remoteTaskId ? await this.store.task(owner, options.remoteTaskId) : await this.store.findMessage(owner, options.messageId);
    if (task && (task.agentId !== options.agentId || task.messageId !== options.messageId)) throw new LocalAgentError('LOCAL_DISPATCH_UNCERTAIN');
    if (!task) {
      // Cancellation changes the durable state before the OS has finished killing
      // the process tree. Its execution slot remains reserved until done settles.
      if ([...this.running.values()].some((run) => run.agentId === options.agentId)) throw new LocalAgentError('LOCAL_BUSY');
      await this.validate(owner, options.agentId);
      if (!options.prompt.trim() || Buffer.byteLength(options.prompt) > 256_000) throw new LocalAgentError('LOCAL_INVALID_INPUT');
      task = await this.store.stage(owner, options.agentId, provider, options.messageId, options.prompt);
      try {
        await options.onTask({ taskId: task.id, contextId: task.id });
        await options.onDispatch?.();
        await this.store.activate(owner, task.id);
      } catch (error) { await this.store.cancel(owner, task.id); throw error; }
    }
    if (!task.deviceId) await this.launch(task);
    let progress = '';
    for (;;) {
      task = await this.store.task(owner, task.id);
      if (task.state === 'completed') return { taskId: task.id, contextId: task.id, text: task.text || '', usageTokens: task.usageTokens ?? null };
      if (task.state === 'failed' || task.state === 'cancelled') throw new LocalAgentError(task.error || 'LOCAL_TASK_FAILED', task.id, task.id);
      if (task.state === 'staged') throw new LocalAgentError('LOCAL_DISPATCH_UNCERTAIN', task.id, task.id);
      if (!await options.shouldContinue()) {
        await this.store.cancel(owner, task.id); this.running.get(task.id)?.abort.abort();
        throw new LocalAgentError('LOCAL_CANCELLED', task.id, task.id);
      }
      const device = task.deviceId ? await this.store.deviceFor(owner) : undefined;
      if (Date.now() - task.createdAt > 600_000 || task.deviceId && (!device || Date.now() - device.lastSeen > 30_000)) {
        await this.store.update(owner, task.id, { state: 'failed', error: 'LOCAL_INTERRUPTED' });
        this.running.get(task.id)?.abort.abort();
        throw new LocalAgentError('LOCAL_INTERRUPTED', task.id, task.id);
      }
      if (task.progress && task.progress !== progress) { progress = task.progress; await options.onProgress(progress); }
      await wait(300);
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const execution of this.running.values()) execution.abort.abort();
    await Promise.allSettled([...this.running.values()].map((execution) => execution.done));
  }
}
