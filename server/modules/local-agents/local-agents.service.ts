/**
 * local-agents.service.ts — 本地智能体（桌面 Agent）执行服务。
 *
 * 职责边界：
 *  - 管理本地智能体的状态查询、连接/断开/登录、companion 配对，以及任务生命周期（stage→activate→launch→轮询）。
 *  - 为本地智能体任务桥接研究工具（callResearchTool），把结果经 LocalAgentStore 持久化。
 *  - 不直接调用模型：真正的执行由 native runtime（本机进程）或桌面 companion 完成。
 * 上下游：
 *  - 上游：LocalAgentsController、CompanionController、CouncilService（成员发言 execute）。
 *  - 下游：LocalAgentStore（持久化）、ResearchToolsService（研究工具）、local-agents/native（进程执行）。
 * 关键约定：
 *  - 模式判定：SQUABBLE_DESKTOP_ORIGIN 存在，或 LOCAL_AGENTS_MODE=native 且 SERVER_HOST 为回环地址 → native，否则 companion。
 *  - 任务轮询间隔 300ms；任务 10 分钟超时；companion 设备 15s 内视为在线、30s 内视为任务有效。
 *  - prompt ≤256KB；结果非空且 ≤512KB；进度文本截断到 500 字符。
 */
import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentConnection,
  type LocalAgentsStatus,
  type NativeAgentStatus,
  type LocalAgentProvider,
  type NativeAgentConfiguration,
} from '../../../shared/local-agents.interface';
import { detectNativeAgents, openNativeLogin, runNativeAgent } from '../../local-agents/native';
import { LocalAgentStore, type AgentTask } from './local-agents.store';
import {
  LocalAgentError,
  nativeFailureCode,
  type LocalAgentExecution,
  type LocalAgentResult,
} from './local-agents.types';
import {
  providerCatalog,
  providerFromId,
  parseNativeAgentConfiguration,
  validateNativeAgentConfiguration,
} from './local-agents.requests';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import type {
  ResearchToolRequest,
  ResearchToolResult,
} from '../../../shared/research-tools.interface';
import { researchFailure } from '../research-tools/research-tools.output';
import { createHash } from 'node:crypto';

/** 测试可替换的运行时边界：原生智能体探测/登录/执行。 */
interface Runtime {
  detectNativeAgents(): Promise<NativeAgentStatus[]>;
  openNativeLogin(provider: LocalAgentProvider): Promise<void>;
  runNativeAgent: typeof runNativeAgent;
}
/** 简单的轮询等待助手。 */
const wait = (ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));

@Injectable()
export class LocalAgentsService implements OnModuleDestroy {
  readonly store: LocalAgentStore;
  private readonly runtime: Runtime;
  private readonly running = new Map<
    string,
    { owner: string; agentId: string; abort: AbortController; done: Promise<void> }
  >();
  private readonly logins = new Set<LocalAgentProvider>();
  private detection?: { until: number; promise: Promise<NativeAgentStatus[]> };
  private stopping = false;
  private readonly toolCalls = new Map<
    string,
    { fingerprint: string; promise: Promise<ResearchToolResult>; controller: AbortController }
  >();

  constructor(
    @Optional() @Inject('LOCAL_AGENT_RUNTIME') runtime?: Runtime,
    @Optional() @Inject('LOCAL_AGENT_STORE') store?: LocalAgentStore,
    @Optional() private readonly researchTools?: ResearchToolsService,
  ) {
    this.runtime = runtime ?? { detectNativeAgents, openNativeLogin, runNativeAgent };
    this.store =
      store ??
      new LocalAgentStore(
        resolve(process.env.LOCAL_AGENTS_DATA_DIR || join(homedir(), '.squabble', 'local-agents')),
      );
  }
  /** 运行模式判定：desktop origin 存在，或显式 native 模式且服务监听回环地址 → native，否则 companion。 */
  get mode(): 'native' | 'companion' {
    if (process.env.SQUABBLE_DESKTOP_ORIGIN) return 'native';
    return process.env.LOCAL_AGENTS_MODE === 'native' &&
      ['127.0.0.1', 'localhost', '::1'].includes(process.env.SERVER_HOST || '')
      ? 'native'
      : 'companion';
  }
  /** 3 秒缓存的智能体探测，避免每次状态查询都拉起子进程扫描。 */
  private detect(): Promise<NativeAgentStatus[]> {
    if (!this.detection || this.detection.until <= Date.now()) {
      this.detection = { until: Date.now() + 3_000, promise: this.runtime.detectNativeAgents() };
    }
    return this.detection.promise;
  }
  /** 聚合当前用户的智能体连接状态（模式、在线、占用与可用性）。 */
  async status(owner: string): Promise<LocalAgentsStatus> {
    const mode = this.mode;
    const device = mode === 'companion' ? await this.store.deviceFor(owner) : undefined;
    const online = mode === 'native' || (!!device && Date.now() - device.lastSeen < 15_000);
    const foreign = mode === 'native' && (await this.store.nativeClaimedByOther(owner));
    const detected = mode === 'native' && !foreign ? await this.detect() : (device?.agents ?? []);
    const connected =
      mode === 'native' ? await this.store.nativeProviders(owner) : (device?.providers ?? []);
    const items: LocalAgentConnection[] = await Promise.all(
      LOCAL_AGENT_PROVIDERS.map(async (provider) => {
        const native = detected.find((entry) => entry.provider === provider) ?? {
          ...providerCatalog[provider],
          state: 'error' as const,
        };
        const id = `${mode}-${provider}`;
        return {
          ...native,
          id,
          connected: connected.includes(provider),
          available: online && native.state === 'ready' && connected.includes(provider),
          busy:
            [...this.running.values()].some((run) => run.agentId === id) ||
            (await this.store.busy(owner, id)),
          source: mode,
        };
      }),
    );
    return {
      mode,
      items,
      companion: {
        connected: mode === 'companion' && online,
        ...(device ? { name: device.name } : {}),
      },
    };
  }
  /** 仅返回当前已连接的智能体列表。 */
  async list(owner: string): Promise<LocalAgentConnection[]> {
    return (await this.status(owner)).items.filter((item) => item.connected);
  }
  /** 校验智能体可用并验证其配置；不可用/未连接时抛对应错误码。 */
  async validate(
    owner: string,
    id: string,
    agentSettings?: NativeAgentConfiguration,
  ): Promise<void> {
    const item = (await this.status(owner)).items.find((entry) => entry.id === id);
    if (!item?.connected) throw new LocalAgentError('LOCAL_AGENT_NOT_FOUND');
    if (!item.available)
      throw new LocalAgentError(
        item.state === 'login_required' ? 'LOCAL_LOGIN_REQUIRED' : 'LOCAL_UNAVAILABLE',
      );
    validateNativeAgentConfiguration(agentSettings, item);
  }
  /** 连接智能体：native 模式要求探测到 ready，companion 模式写入设备 provider 列表。 */
  async connect(owner: string, id: string): Promise<void> {
    const provider = providerFromId(id, this.mode);
    if (this.mode === 'native') {
      const agent = (await this.detect()).find((entry) => entry.provider === provider);
      if (agent?.state !== 'ready') throw new LocalAgentError('LOCAL_LOGIN_REQUIRED');
      await this.store.connectNative(owner, provider);
    } else await this.store.connectCompanion(owner, provider);
  }
  /** 断开智能体：同时中止该智能体名下仍在运行的任务。 */
  async disconnect(owner: string, id: string): Promise<void> {
    const provider = providerFromId(id, this.mode);
    if (this.mode === 'native') await this.store.disconnectNative(owner, provider);
    else await this.store.disconnectCompanion(owner, provider);
    for (const [taskId, execution] of this.running) {
      if (execution.owner === owner && (await this.store.task(owner, taskId)).agentId === id)
        execution.abort.abort();
    }
  }
  /** 打开原生登录界面：native 模式需先抢占本机所有权并防并发登录；companion 模式下发 login 任务。 */
  async login(owner: string, id: string): Promise<void> {
    const provider = providerFromId(id, this.mode);
    if (this.mode === 'native') {
      await this.store.claimNative(owner);
      if (this.logins.has(provider)) throw new LocalAgentError('LOCAL_BUSY');
      this.logins.add(provider);
      try {
        await this.runtime.openNativeLogin(provider);
        this.detection = undefined;
      } finally {
        setTimeout(() => this.logins.delete(provider), 5_000).unref();
      }
    } else {
      const task = await this.store.stage(owner, id, provider, randomUUID(), '', 'login');
      await this.store.activate(owner, task.id);
    }
  }
  /** 创建 companion 配对码（仅 companion 模式需要）。 */
  async pairing(owner: string) {
    if (this.mode !== 'companion') throw new LocalAgentError('LOCAL_PAIRING_NOT_NEEDED');
    return this.store.createPairing(owner);
  }

  /** 拉起本机任务执行：抢占执行槽后串行落盘进度/事件，结束时写入终态并释放执行槽。 */
  private async launch(task: AgentTask): Promise<void> {
    if (
      this.stopping ||
      this.running.has(task.id) ||
      !(await this.store.takeNative(task.owner, task.id))
    )
      return;
    const abort = new AbortController();
    let progressWrites: Promise<void> = Promise.resolve();
    const done = (async () => {
      try {
        const result = await this.runtime.runNativeAgent(task.provider, task.prompt, {
          root: join(this.store.root, 'workspaces', task.id),
          signal: abort.signal,
          agentSettings: task.agentSettings,
          ...(task.researchBundle
            ? {
                researchTools: {
                  ...task.researchBundle,
                  call: (request: ResearchToolRequest, signal: AbortSignal) =>
                    this.callResearchTool(task.owner, task.id, request, signal),
                },
              }
            : {}),
          onEvent: (event) => {
            progressWrites = progressWrites.then(() =>
              this.store.appendEvents(task.owner, task.id, [event]),
            );
          },
          onProgress: (text: string) => {
            progressWrites = progressWrites.then(() =>
              this.store.update(task.owner, task.id, { progress: text.slice(0, 500) }),
            );
          },
        });
        await progressWrites;
        // 已取消：落 cancelled 终态。
        if (abort.signal.aborted) {
          await this.store.update(task.owner, task.id, {
            state: 'cancelled',
            error: 'LOCAL_CANCELLED',
          });
          return;
        }
        if (!result.text?.trim() || Buffer.byteLength(result.text) > 512_000)
          throw new LocalAgentError('LOCAL_INVALID_RESULT');
        await this.store.update(task.owner, task.id, {
          state: 'completed',
          text: result.text,
          usageTokens: result.usageTokens,
        });
      } catch (error) {
        // 失败处理：区分“已确认取消”与真实失败（LOCAL_DISPATCH_UNCERTAIN 视为派发不确定，不算取消）。
        await progressWrites.catch(() => undefined);
        const code = nativeFailureCode(error);
        const cancelled = abort.signal.aborted && code !== 'LOCAL_DISPATCH_UNCERTAIN';
        await this.store.update(task.owner, task.id, {
          state: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? 'LOCAL_CANCELLED' : code,
        });
      } finally {
        this.running.delete(task.id);
      }
    })();
    this.running.set(task.id, { owner: task.owner, agentId: task.agentId, abort, done });
    // execute/shutdown 会 await 它；持久化失败时也要处理掉后台 rejection。
    void done.catch(() => undefined);
  }

  /**
   * 执行一次本地智能体任务（委员会成员发言或独立指令）：
   * 幂等派发（同 messageId 复用既有任务）、300ms 轮询到终态，支持上游叫停与超时看护。
   */
  async execute(owner: string, options: LocalAgentExecution): Promise<LocalAgentResult> {
    if (this.stopping) throw new LocalAgentError('LOCAL_UNAVAILABLE');
    const provider = providerFromId(options.agentId, this.mode);
    let task = options.remoteTaskId
      ? await this.store.task(owner, options.remoteTaskId)
      : await this.store.findMessage(owner, options.messageId);
    if (task && (task.agentId !== options.agentId || task.messageId !== options.messageId))
      throw new LocalAgentError('LOCAL_DISPATCH_UNCERTAIN');
    if (!task) {
      // 全新任务：占用校验 → 配置校验 → 输入校验 → 研究包准备 → stage→通知→activate。
      // 取消操作会在操作系统结束进程树之前就更新持久化状态；
      // 在 done 落定之前，执行槽一直保持占用。
      if ([...this.running.values()].some((run) => run.agentId === options.agentId))
        throw new LocalAgentError('LOCAL_BUSY');
      const agentSettings = parseNativeAgentConfiguration(options.agentSettings);
      await this.validate(owner, options.agentId, agentSettings);
      if (!options.prompt.trim() || Buffer.byteLength(options.prompt) > 256_000)
        throw new LocalAgentError('LOCAL_INVALID_INPUT');
      const research =
        options.researchScope && this.researchTools
          ? {
              scope: options.researchScope,
              bundle: await this.researchTools.bundle(owner, options.researchScope),
            }
          : undefined;
      task = await this.store.stage(
        owner,
        options.agentId,
        provider,
        options.messageId,
        options.prompt,
        'run',
        agentSettings,
        research,
      );
      try {
        await options.onTask({ taskId: task.id, contextId: task.id });
        await options.onDispatch?.();
        await this.store.activate(owner, task.id);
      } catch (error) {
        await this.store.cancel(owner, task.id);
        throw error;
      }
    }
    if (!task.deviceId) await this.launch(task);
    // 轮询任务状态直到完成/失败/取消/叫停。
    let progress = '';
    for (;;) {
      task = await this.store.task(owner, task.id);
      if (task.state === 'completed')
        return {
          taskId: task.id,
          contextId: task.id,
          text: task.text || '',
          usageTokens: task.usageTokens ?? null,
        };
      if (task.state === 'failed' || task.state === 'cancelled')
        throw new LocalAgentError(task.error || 'LOCAL_TASK_FAILED', task.id, task.id);
      if (task.state === 'staged')
        throw new LocalAgentError('LOCAL_DISPATCH_UNCERTAIN', task.id, task.id);
      // 上游（council）要求停止：取消任务并区分“已确认停止”与“未确认停止”。
      if (!(await options.shouldContinue())) {
        const cancellation = await this.store.cancel(owner, task.id);
        this.running.get(task.id)?.abort.abort();
        // 上游任务必须先确认停止，委员会才会清除该任务引用并允许新指派。
        // 引导（steering）变更期间完成的报告已被叫停，必须丢弃，
        // 下一次修订不能复用被取代的结果。
        const stopped = cancellation === 'cancelled' || cancellation === 'completed';
        throw new LocalAgentError(stopped ? 'LOCAL_CANCELLED' : 'LOCAL_PAUSED', task.id, task.id);
      }
      // 超时与断线看护：任务 10 分钟上限；companion 设备 30s 无心跳视为中断。
      const device = task.deviceId ? await this.store.deviceFor(owner) : undefined;
      if (
        Date.now() - task.createdAt > 600_000 ||
        (task.deviceId && (!device || Date.now() - device.lastSeen > 30_000))
      ) {
        await this.store.update(owner, task.id, { state: 'failed', error: 'LOCAL_INTERRUPTED' });
        this.running.get(task.id)?.abort.abort();
        throw new LocalAgentError('LOCAL_INTERRUPTED', task.id, task.id);
      }
      // 推送最新进度（仅在变化时）。
      if (task.progress && task.progress !== progress) {
        progress = task.progress;
        await options.onProgress(progress);
      }
      await wait(300);
    }
  }

  /** CLI 只拿到任务专属的本地桥接；设备/账号凭据保留在服务端。 */
  async cancelResearchTool(owner: string, taskId: string, callId: string): Promise<boolean> {
    const cancelled = await this.store.cancelToolCall(owner, taskId, callId);
    if (cancelled) this.toolCalls.get(`${owner}:${taskId}:${callId}`)?.controller.abort();
    return cancelled;
  }

  /**
   * 执行一次研究工具调用（由本地智能体进程经本地桥接发起）：
   * 参数指纹幂等去重，工具白名单与 scope 时效校验后执行，并把事件写回任务日志。
   */
  async callResearchTool(
    owner: string,
    taskId: string,
    request: ResearchToolRequest,
    incomingSignal?: AbortSignal,
  ): Promise<ResearchToolResult> {
    // 组合外部中止信号与本地取消控制器。
    const controller = new AbortController();
    const signal = incomingSignal
      ? AbortSignal.any([incomingSignal, controller.signal])
      : controller.signal;
    const failure = (code: string): ResearchToolResult =>
      researchFailure(signal?.aborted ? 'cancelled' : 'failed', code);
    // 前置校验：服务可用性与请求结构。
    if (!this.researchTools || signal?.aborted) return failure('RESEARCH_UNAVAILABLE');
    if (
      !request ||
      typeof request.name !== 'string' ||
      typeof request.callId !== 'string' ||
      !request.arguments ||
      typeof request.arguments !== 'object' ||
      Array.isArray(request.arguments)
    )
      return failure('RESEARCH_INVALID_CALL');
    // 以参数指纹做幂等去重：同 callId 不同参数视为冲突。
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([request.name, request.arguments]))
      .digest('hex');
    const eventKey = createHash('sha256').update(request.callId).digest('hex');
    const key = `${owner}:${taskId}:${request.callId}`;
    const previous = this.toolCalls.get(key);
    if (previous)
      // 指纹一致则复用在途 Promise；不一致直接拒绝。
      return previous.fingerprint === fingerprint
        ? previous.promise
        : failure('RESEARCH_CALL_CONFLICT');
    // 执行体：工具白名单 → scope 时效 → 认领 → 执行 → 落结果与事件。
    const promise = (async (): Promise<ResearchToolResult> => {
      let claimed = false;
      const started = Date.now();
      try {
        const task = await this.store.task(owner, taskId);
        if (!task.researchBundle?.descriptors.some((tool) => tool.name === request.name))
          return failure('RESEARCH_TOOL_NOT_ALLOWED');
        if (
          !task.researchScope ||
          !(await this.researchTools!.isCurrent(owner, task.researchScope))
        )
          return failure('RESEARCH_SCOPE_EXPIRED');
        const claim = await this.store.beginToolCall(owner, taskId, request);
        if (!claim.run) return claim.result!;
        claimed = true;
        const en = task.researchScope.language === 'en';
        await this.store.appendEvents(owner, taskId, [
          {
            id: `tool:${eventKey}:start`,
            kind: 'tool',
            status: 'running',
            at: new Date().toISOString(),
            callId: request.callId,
            toolName: request.name,
            summary: en
              ? `Reading ${task.researchScope.ticker} research data`
              : `正在读取 ${task.researchScope.ticker} 的研究资料`,
          },
        ]);
        // 执行期持续校验：任务仍在运行、scope 未过期、设备心跳正常。
        const shouldContinue = async (): Promise<boolean> => {
          const latest = await this.store.task(owner, taskId);
          const device = latest.deviceId ? await this.store.deviceFor(owner) : undefined;
          return (
            !signal.aborted &&
            !latest.cancelledToolCallIds?.includes(request.callId) &&
            latest.state === 'running' &&
            latest.researchScope!.expiresAt > Date.now() &&
            (!latest.deviceId ||
              (device?.id === latest.deviceId && Date.now() - device.lastSeen < 30_000)) &&
            (await this.researchTools!.isCurrent(owner, latest.researchScope!))
          );
        };
        // 执行后再次校验：任务已失效则强制标记取消。
        let result = (await shouldContinue())
          ? await this.researchTools!.call(owner, task.researchScope, request, {
              signal,
              shouldContinue,
            })
          : researchFailure('cancelled', 'RESEARCH_CALL_CANCELLED');
        if (!(await shouldContinue()))
          result = researchFailure('cancelled', 'RESEARCH_TASK_INACTIVE', true);
        result = await this.store.finishToolCall(owner, taskId, request.callId, result);
        await this.store.appendEvents(owner, taskId, [
          {
            id: `tool:${eventKey}:end`,
            kind: 'tool',
            status: result.status === 'partial' ? 'succeeded' : result.status,
            at: new Date().toISOString(),
            callId: request.callId,
            toolName: request.name,
            durationMs: Date.now() - started,
            sources: result.sources,
            summary:
              result.status === 'succeeded'
                ? en
                  ? `Received research data (${result.sources.length} sources)`
                  : `已取得研究资料（${result.sources.length} 个来源）`
                : result.status === 'partial'
                  ? en
                    ? 'Partial data received; see source gaps.'
                    : '已取得部分资料，请核对数据缺口。'
                  : en
                    ? `Tool unavailable: ${result.errorCode ?? result.status}`
                    : `工具未完成：${result.errorCode ?? result.status}`,
          },
        ]);
        return result;
      } catch (error) {
        // 异常兜底：把可识别的错误码回填为失败结果并写回事件日志。
        const code =
          error instanceof Error && /^(RESEARCH|LOCAL)_[A-Z_]+$/u.test(error.message)
            ? error.message
            : 'RESEARCH_TOOL_FAILED';
        let result = failure(code);
        if (claimed) {
          result = await this.store.finishToolCall(owner, taskId, request.callId, result);
          await this.store.appendEvents(owner, taskId, [
            {
              id: `tool:${eventKey}:end`,
              kind: 'tool',
              status: result.status === 'cancelled' ? 'cancelled' : 'failed',
              at: new Date().toISOString(),
              callId: request.callId,
              toolName: request.name,
              durationMs: Date.now() - started,
              summary: `Research tool stopped: ${code}`,
            },
          ]);
        }
        return result;
      }
    })();
    this.toolCalls.set(key, { fingerprint, promise, controller });
    try {
      return await promise;
    } finally {
      // 调用结束后清理在途记录（结果已由 store 持久化）。
      this.toolCalls.delete(key);
    }
  }
  /** 模块销毁：停止接收新任务，中止全部在跑执行并等待其落定。 */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const execution of this.running.values()) execution.abort.abort();
    await Promise.allSettled([...this.running.values()].map((execution) => execution.done));
  }
}
