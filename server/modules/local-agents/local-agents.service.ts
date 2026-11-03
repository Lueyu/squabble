import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { LOCAL_AGENT_PROVIDERS, type LocalAgentConnection, type LocalAgentsStatus, type NativeAgentStatus,
  type LocalAgentProvider, type NativeAgentConfiguration } from '../../../shared/local-agents.interface';
import { detectNativeAgents, openNativeLogin, runNativeAgent } from '../../local-agents/native';
import { LocalAgentStore, type AgentTask } from './local-agents.store';
import { LocalAgentError, nativeFailureCode, type LocalAgentExecution, type LocalAgentResult } from './local-agents.types';
import { providerCatalog, providerFromId, parseNativeAgentConfiguration, validateNativeAgentConfiguration } from './local-agents.requests';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import type { ResearchToolRequest, ResearchToolResult } from '../../../shared/research-tools.interface';
import { researchFailure } from '../research-tools/research-tools.output';
import { createHash } from 'node:crypto';

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
  private readonly toolCalls = new Map<string, { fingerprint: string; promise: Promise<ResearchToolResult>; controller: AbortController }>();

  constructor(@Optional() @Inject('LOCAL_AGENT_RUNTIME') runtime?: Runtime,
    @Optional() @Inject('LOCAL_AGENT_STORE') store?: LocalAgentStore,
    @Optional() private readonly researchTools?: ResearchToolsService) {
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
    const items: LocalAgentConnection[] = await Promise.all(LOCAL_AGENT_PROVIDERS.map(async (provider) => {
      const native = detected.find((entry) => entry.provider === provider) ?? { ...providerCatalog[provider], state: 'error' as const };
      const id = `${mode}-${provider}`;
      return { ...native, id, connected: connected.includes(provider), available: online && native.state === 'ready' && connected.includes(provider),
        busy: [...this.running.values()].some((run) => run.agentId === id) || await this.store.busy(owner, id), source: mode };
    }));
    return { mode, items, companion: { connected: mode === 'companion' && online, ...(device ? { name: device.name } : {}) } };
  }
  async list(owner: string): Promise<LocalAgentConnection[]> { return (await this.status(owner)).items.filter((item) => item.connected); }
  async validate(owner: string, id: string, agentSettings?: NativeAgentConfiguration): Promise<void> {
    const item = (await this.status(owner)).items.find((entry) => entry.id === id);
    if (!item?.connected) throw new LocalAgentError('LOCAL_AGENT_NOT_FOUND');
    if (!item.available) throw new LocalAgentError(item.state === 'login_required' ? 'LOCAL_LOGIN_REQUIRED' : 'LOCAL_UNAVAILABLE');
    validateNativeAgentConfiguration(agentSettings, item);
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
          agentSettings: task.agentSettings,
          ...(task.researchBundle ? { researchTools: { ...task.researchBundle,
            call: (request: ResearchToolRequest, signal: AbortSignal) => this.callResearchTool(task.owner, task.id, request, signal) } } : {}),
          onEvent: event => { progressWrites = progressWrites.then(() => this.store.appendEvents(task.owner, task.id, [event])); },
          onProgress: (text: string) => { progressWrites = progressWrites.then(() => this.store.update(task.owner, task.id, { progress: text.slice(0, 500) })); } });
        await progressWrites;
        if (abort.signal.aborted) {
          await this.store.update(task.owner, task.id, { state: 'cancelled', error: 'LOCAL_CANCELLED' });
          return;
        }
        if (!result.text?.trim() || Buffer.byteLength(result.text) > 512_000) throw new LocalAgentError('LOCAL_INVALID_RESULT');
        await this.store.update(task.owner, task.id, { state: 'completed', text: result.text, usageTokens: result.usageTokens });
      } catch (error) {
        await progressWrites.catch(() => undefined);
        const code = nativeFailureCode(error);
        const cancelled = abort.signal.aborted && code !== 'LOCAL_DISPATCH_UNCERTAIN';
        await this.store.update(task.owner, task.id, { state: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? 'LOCAL_CANCELLED' : code });
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
      const agentSettings = parseNativeAgentConfiguration(options.agentSettings);
      await this.validate(owner, options.agentId, agentSettings);
      if (!options.prompt.trim() || Buffer.byteLength(options.prompt) > 256_000) throw new LocalAgentError('LOCAL_INVALID_INPUT');
      const research = options.researchScope && this.researchTools
        ? { scope: options.researchScope, bundle: await this.researchTools.bundle(owner, options.researchScope) } : undefined;
      task = await this.store.stage(owner, options.agentId, provider, options.messageId, options.prompt, 'run', agentSettings, research);
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
        const cancellation = await this.store.cancel(owner, task.id);
        this.running.get(task.id)?.abort.abort();
        // A running upstream task must acknowledge its stop before the council
        // clears this task reference and permits a new assignment.
        // A report completed during changed steering is already stopped and must
        // be discarded, so the next revision cannot reuse the superseded result.
        const stopped = cancellation === 'cancelled' || cancellation === 'completed';
        throw new LocalAgentError(stopped ? 'LOCAL_CANCELLED' : 'LOCAL_PAUSED', task.id, task.id);
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

  /** The CLI only gets a task-specific local bridge; device/account credentials stay here. */
  async cancelResearchTool(owner: string, taskId: string, callId: string): Promise<boolean> {
    const cancelled = await this.store.cancelToolCall(owner, taskId, callId);
    if (cancelled) this.toolCalls.get(`${owner}:${taskId}:${callId}`)?.controller.abort();
    return cancelled;
  }

  async callResearchTool(owner: string, taskId: string, request: ResearchToolRequest, incomingSignal?: AbortSignal): Promise<ResearchToolResult> {
    const controller = new AbortController();
    const signal = incomingSignal ? AbortSignal.any([incomingSignal, controller.signal]) : controller.signal;
    const failure = (code: string): ResearchToolResult => researchFailure(signal?.aborted ? 'cancelled' : 'failed', code);
    if (!this.researchTools || signal?.aborted) return failure('RESEARCH_UNAVAILABLE');
    if (!request || typeof request.name !== 'string' || typeof request.callId !== 'string'
      || !request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) return failure('RESEARCH_INVALID_CALL');
    const fingerprint = createHash('sha256').update(JSON.stringify([request.name, request.arguments])).digest('hex');
    const eventKey = createHash('sha256').update(request.callId).digest('hex');
    const key = `${owner}:${taskId}:${request.callId}`;
    const previous = this.toolCalls.get(key);
    if (previous) return previous.fingerprint === fingerprint ? previous.promise : failure('RESEARCH_CALL_CONFLICT');
    const promise = (async (): Promise<ResearchToolResult> => {
      let claimed = false;
      const started = Date.now();
      try {
        const task = await this.store.task(owner, taskId);
        if (!task.researchBundle?.descriptors.some(tool => tool.name === request.name)) return failure('RESEARCH_TOOL_NOT_ALLOWED');
        if (!task.researchScope || !await this.researchTools!.isCurrent(owner, task.researchScope)) return failure('RESEARCH_SCOPE_EXPIRED');
        const claim = await this.store.beginToolCall(owner, taskId, request);
        if (!claim.run) return claim.result!;
        claimed = true;
        const en = task.researchScope.language === 'en';
        await this.store.appendEvents(owner, taskId, [{ id: `tool:${eventKey}:start`, kind: 'tool', status: 'running',
          at: new Date().toISOString(), callId: request.callId, toolName: request.name,
          summary: en ? `Reading ${task.researchScope.ticker} research data` : `正在读取 ${task.researchScope.ticker} 的研究资料` }]);
        const shouldContinue = async (): Promise<boolean> => {
          const latest = await this.store.task(owner, taskId);
          const device = latest.deviceId ? await this.store.deviceFor(owner) : undefined;
          return !signal.aborted && !latest.cancelledToolCallIds?.includes(request.callId)
            && latest.state === 'running' && latest.researchScope!.expiresAt > Date.now()
            && (!latest.deviceId || device?.id === latest.deviceId && Date.now() - device.lastSeen < 30_000)
            && await this.researchTools!.isCurrent(owner, latest.researchScope!);
        };
        let result = await shouldContinue()
          ? await this.researchTools!.call(owner, task.researchScope, request, { signal, shouldContinue })
          : researchFailure('cancelled', 'RESEARCH_CALL_CANCELLED');
        if (!await shouldContinue()) result = researchFailure('cancelled', 'RESEARCH_TASK_INACTIVE', true);
        result = await this.store.finishToolCall(owner, taskId, request.callId, result);
        await this.store.appendEvents(owner, taskId, [{ id: `tool:${eventKey}:end`, kind: 'tool',
          status: result.status === 'partial' ? 'succeeded' : result.status, at: new Date().toISOString(),
          callId: request.callId, toolName: request.name, durationMs: Date.now() - started, sources: result.sources,
          summary: result.status === 'succeeded'
            ? en ? `Received research data (${result.sources.length} sources)` : `已取得研究资料（${result.sources.length} 个来源）`
            : result.status === 'partial' ? en ? 'Partial data received; see source gaps.' : '已取得部分资料，请核对数据缺口。'
              : en ? `Tool unavailable: ${result.errorCode ?? result.status}` : `工具未完成：${result.errorCode ?? result.status}` }]);
        return result;
      } catch (error) {
        const code = error instanceof Error && /^(RESEARCH|LOCAL)_[A-Z_]+$/u.test(error.message) ? error.message : 'RESEARCH_TOOL_FAILED';
        let result = failure(code);
        if (claimed) {
          result = await this.store.finishToolCall(owner, taskId, request.callId, result);
          await this.store.appendEvents(owner, taskId, [{ id: `tool:${eventKey}:end`, kind: 'tool', status: result.status === 'cancelled' ? 'cancelled' : 'failed',
            at: new Date().toISOString(), callId: request.callId, toolName: request.name, durationMs: Date.now() - started,
            summary: `Research tool stopped: ${code}` }]);
        }
        return result;
      }
    })();
    this.toolCalls.set(key, { fingerprint, promise, controller });
    try { return await promise; } finally { this.toolCalls.delete(key); }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const execution of this.running.values()) execution.abort.abort();
    await Promise.allSettled([...this.running.values()].map((execution) => execution.done));
  }
}
