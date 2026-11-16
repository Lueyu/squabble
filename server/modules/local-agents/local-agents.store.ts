/**
 * local-agents.store.ts — 本地智能体任务的进程内持久化存储（JSON 文件库）。
 *
 * 职责边界：
 *  - 单进程持有的状态库：native 所有权、companion 设备/配对凭据、任务记录、事件日志，全部落盘在 root 目录。
 *  - 所有变更经 access() 串行化排队；先写任务文件再写 connections.json，全部写入成功后才更新内存态。
 *  - 不管模型调用与进程执行（由 LocalAgentsService/runtime 负责）。
 * 上下游：
 *  - 上游：LocalAgentsService（任务编排）、CompanionController（companionTask/poll）。
 *  - 下游：research-journal（事件追加与生命周期记录）、local-agents.requests（配置校验）。
 * 关键约定：
 *  - 任务状态机 staged→queued→running→completed/failed/cancelled（cancelling 为过渡态）。
 *  - 启动加载时把遗留的活动任务标记为 failed/LOCAL_INTERRUPTED，绝不二次派发。
 *  - 设备 token 仅存 sha256 哈希并用 timingSafeEqual 比较；配对码 24 字节随机、默认 5 分钟有效。
 *  - 研究工具：每任务 ≤24 次调用、≤128 次取消登记；callId 指纹冲突返回 RESEARCH_CALL_CONFLICT。
 *  - 任务 600s 超时；companion 心跳 30s；poll 时回收断线/超时任务并下发待取消列表（最多 1000 条）。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CompanionPoll,
  CompanionPollResult,
  LocalAgentProvider,
  NativeAgentConfiguration,
  NativeAgentStatus,
} from '../../../shared/local-agents.interface';
import { LocalAgentError } from './local-agents.types';
import {
  parseNativeAgentConfiguration,
  validateNativeAgentConfiguration,
} from './local-agents.requests';
import type {
  ResearchActivity,
  ResearchEventPage,
} from '../../../shared/research-events.interface';
import type {
  ResearchToolBundle,
  ResearchToolRequest,
  ResearchToolResult,
  ResearchToolScope,
} from '../../../shared/research-tools.interface';
import { appendResearchEvents, recordTaskLifecycle } from './research-journal';
import { researchFailure } from '../research-tools/research-tools.output';

/** 一次本地智能体任务：状态机、事件日志、研究工具调用记录、远端设备引用与输入快照。 */
export interface AgentTask {
  researchScope?: ResearchToolScope;
  researchBundle?: ResearchToolBundle;
  events?: ResearchEventPage['events'];
  eventSequence?: number;
  eventIds?: string[];
  eventsTruncated?: boolean;
  toolCalls?: Record<string, { fingerprint: string; result?: ResearchToolResult }>;
  cancelledToolCallIds?: string[];
  id: string;
  owner: string;
  agentId: string;
  provider: LocalAgentProvider;
  deviceId?: string;
  kind: 'run' | 'login';
  messageId: string;
  prompt: string;
  agentSettings?: NativeAgentConfiguration;
  state: 'staged' | 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  progress?: string;
  text?: string;
  usageTokens?: number | null;
  error?: string;
}
/** 已配对的 companion 设备：token 哈希、可见 provider 与最近心跳。 */
export interface AgentDevice {
  id: string;
  owner: string;
  name: string;
  tokenHash: string;
  providers: LocalAgentProvider[];
  agents: NativeAgentStatus[];
  lastSeen: number;
}
interface State {
  nativeOwner?: string;
  nativeProviders: LocalAgentProvider[];
  devices: AgentDevice[];
  tasks: Record<string, AgentTask>;
}
// 状态机助手：active 判定、取消请求登记、迟到的不确定态回写、错误抛出与哈希工具。
const active = (task: AgentTask) =>
  ['staged', 'queued', 'running', 'cancelling'].includes(task.state);
const requestCancellation = (task: AgentTask): void => {
  if (!active(task)) return;
  const dispatched = task.state === 'running' || task.state === 'cancelling';
  task.state = dispatched ? 'cancelling' : 'cancelled';
  task.error = dispatched ? 'LOCAL_PAUSED' : 'LOCAL_CANCELLED';
  task.updatedAt = Date.now();
};
const recordLateUncertainty = (
  task: AgentTask,
  change: { state?: string; error?: string },
): boolean => {
  if (
    task.state !== 'failed' ||
    task.error !== 'LOCAL_INTERRUPTED' ||
    change.state !== 'failed' ||
    change.error !== 'LOCAL_DISPATCH_UNCERTAIN'
  )
    return false;
  task.error = 'LOCAL_DISPATCH_UNCERTAIN';
  task.updatedAt = Date.now();
  return true;
};
const fail = (code: string): never => {
  throw new LocalAgentError(code);
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ownedTask = (state: State, owner: string, id: string): AgentTask => {
  const task = state.tasks[id];
  if (!task || task.owner !== owner) return fail('LOCAL_TASK_NOT_FOUND');
  return task;
};

/** 本日志由单进程独占：所有变更加串行化处理，并在派发前持久化写入。 */
export class LocalAgentStore {
  private state: State = { nativeProviders: [], devices: [], tasks: {} };
  private tail: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private readonly pairs = new Map<string, { owner: string; expiresAt: number }>();
  constructor(readonly root: string) {}

  /** 原子写：临时文件（0o600、独占创建）+ rename，失败时清理临时文件。 */
  private async atomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  /** 首次访问时加载：connections.json + tasks/*.json；遗留的活动任务标记为 LOCAL_INTERRUPTED。 */
  private async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(join(this.root, 'tasks'), { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(join(this.root, 'connections.json'), 'utf8'));
      if (!Array.isArray(saved.devices) || !Array.isArray(saved.nativeProviders))
        fail('LOCAL_STATE_INVALID');
      this.state = { ...saved, tasks: {} };
      this.state.devices.forEach((device) => {
        device.lastSeen = 0;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of await readdir(join(this.root, 'tasks'))) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
      const task = JSON.parse(await readFile(join(this.root, 'tasks', name), 'utf8')) as AgentTask;
      if (`${task.id}.json` !== name || !task.owner || !task.state) fail('LOCAL_STATE_INVALID');
      if (active(task)) {
        const previousState = task.state;
        task.state = 'failed';
        task.error = 'LOCAL_INTERRUPTED';
        task.updatedAt = Date.now();
        recordTaskLifecycle(task, previousState);
        await this.atomic(join(this.root, 'tasks', name), task);
      }
      this.state.tasks[task.id] = task;
    }
    this.loaded = true;
  }

  /** 串行化执行器：读操作克隆后执行，写操作在副本上变更并全量落盘，失败不影响后续排队。 */
  private access<T>(mutate: boolean, action: (state: State) => T): Promise<T> {
    const result = this.tail.then(async () => {
      await this.load();
      if (!mutate) return structuredClone(action(this.state));
      const next = structuredClone(this.state);
      const value = action(next);
      const { tasks, ...connections } = next;
      const { tasks: previousTasks, ...previousConnections } = this.state;
      // 先写任务文件：被中断的任务可以恢复，但绝不能被二次派发。
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
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** 生成配对码：同一 owner 只保留一个有效码；全局在途配对 ≤128。 */
  createPairing(owner: string, ttl = 300_000): Promise<{ code: string; expiresAt: string }> {
    return this.access(false, () => {
      const now = Date.now();
      for (const [code, entry] of this.pairs)
        if (entry.owner === owner || entry.expiresAt <= now) this.pairs.delete(code);
      if (this.pairs.size >= 128) fail('LOCAL_BUSY');
      const code = randomBytes(24).toString('hex');
      const expiresAt = now + ttl;
      this.pairs.set(code, { owner, expiresAt });
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  /** 消费配对码并注册设备：同 owner 的旧设备被撤销，返回一次性明文 token。 */
  pair(code: string, name: string): Promise<{ token: string; deviceId: string }> {
    return this.access(true, (state) => {
      const entry = this.pairs.get(code);
      if (!entry || entry.expiresAt <= Date.now()) return fail('LOCAL_PAIRING_EXPIRED');
      this.pairs.delete(code);
      this.revokeIn(state, entry.owner);
      const token = randomBytes(32).toString('hex');
      const deviceId = randomUUID();
      state.devices.push({
        id: deviceId,
        owner: entry.owner,
        name: name.slice(0, 80),
        tokenHash: hash(token),
        providers: [],
        agents: [],
        lastSeen: Date.now(),
      });
      return { token, deviceId };
    });
  }

  /** 撤销 owner 的全部设备，并把其派发中任务标记为 LOCAL_DISPATCH_UNCERTAIN。 */
  private revokeIn(state: State, owner: string): void {
    state.devices = state.devices.filter((device) => device.owner !== owner);
    for (const task of Object.values(state.tasks))
      if (task.owner === owner && task.deviceId && active(task)) {
        const dispatched = task.state === 'running' || task.state === 'cancelling';
        task.state = dispatched ? 'failed' : 'cancelled';
        task.error = dispatched ? 'LOCAL_DISPATCH_UNCERTAIN' : 'LOCAL_CANCELLED';
        task.updatedAt = Date.now();
      }
  }
  /** 显式撤销 companion 设备。 */
  revoke(owner: string): Promise<void> {
    return this.access(true, (state) => this.revokeIn(state, owner));
  }
  /** 读取 owner 的 companion 设备（无则 undefined）。 */
  deviceFor(owner: string): Promise<AgentDevice | undefined> {
    return this.access(false, (state) => state.devices.find((device) => device.owner === owner));
  }
  /** native 模式下 owner 拥有的 provider 列表。 */
  nativeProviders(owner: string): Promise<LocalAgentProvider[]> {
    return this.access(false, (state) =>
      state.nativeOwner === owner ? state.nativeProviders : [],
    );
  }
  /** 本机是否已被其他用户认领。 */
  nativeClaimedByOther(owner: string): Promise<boolean> {
    return this.access(false, (state) => !!state.nativeOwner && state.nativeOwner !== owner);
  }
  /** 认领本机（native）：已被他人占用时抛 LOCAL_AGENT_OWNED。 */
  claimNative(owner: string): Promise<void> {
    return this.access(true, (state) => {
      if (state.nativeOwner && state.nativeOwner !== owner) fail('LOCAL_AGENT_OWNED');
      state.nativeOwner = owner;
    });
  }
  /** 连接 native provider：需先持有本机所有权。 */
  connectNative(owner: string, provider: LocalAgentProvider): Promise<void> {
    return this.access(true, (state) => {
      if (state.nativeOwner && state.nativeOwner !== owner) fail('LOCAL_AGENT_OWNED');
      state.nativeOwner = owner;
      if (!state.nativeProviders.includes(provider)) state.nativeProviders.push(provider);
    });
  }
  /** 断开 native provider：取消其名下任务；最后一个 provider 断开时释放本机所有权。 */
  disconnectNative(owner: string, provider: LocalAgentProvider): Promise<void> {
    return this.access(true, (state) => {
      if (state.nativeOwner !== owner) fail('LOCAL_AGENT_OWNED');
      state.nativeProviders = state.nativeProviders.filter((id) => id !== provider);
      this.cancelProvider(state, owner, `native-${provider}`);
      if (!state.nativeProviders.length) delete state.nativeOwner;
    });
  }
  /** 连接 companion provider：设备 15s 内有心跳且智能体 ready 才允许。 */
  connectCompanion(owner: string, provider: LocalAgentProvider): Promise<void> {
    return this.access(true, (state) => {
      const device = state.devices.find((item) => item.owner === owner);
      if (!device || Date.now() - device.lastSeen > 15_000) fail('LOCAL_COMPANION_OFFLINE');
      if (!device!.agents.some((item) => item.provider === provider && item.state === 'ready'))
        fail('LOCAL_LOGIN_REQUIRED');
      if (!device!.providers.includes(provider)) device!.providers.push(provider);
    });
  }
  /** 断开 companion provider：取消其名下任务。 */
  disconnectCompanion(owner: string, provider: LocalAgentProvider): Promise<void> {
    return this.access(true, (state) => {
      const device = state.devices.find((item) => item.owner === owner);
      if (!device) fail('LOCAL_COMPANION_OFFLINE');
      device!.providers = device!.providers.filter((item) => item !== provider);
      this.cancelProvider(state, owner, `companion-${provider}`);
    });
  }
  /** 取消指定智能体名下的全部活动任务。 */
  private cancelProvider(state: State, owner: string, agentId: string): void {
    for (const task of Object.values(state.tasks))
      if (task.owner === owner && task.agentId === agentId && active(task)) {
        requestCancellation(task);
      }
  }
  /** 按 messageId 幂等查找任务（派发去重依据）。 */
  findMessage(owner: string, messageId: string): Promise<AgentTask | undefined> {
    return this.access(false, (state) =>
      Object.values(state.tasks).find(
        (task) => task.owner === owner && task.messageId === messageId,
      ),
    );
  }
  /** 读取属主匹配的任务；不存在抛 LOCAL_TASK_NOT_FOUND。 */
  task(owner: string, id: string): Promise<AgentTask> {
    return this.access(false, (state) => ownedTask(state, owner, id));
  }
  /** 智能体当前是否有活动任务。 */
  busy(owner: string, agentId: string): Promise<boolean> {
    return this.access(false, (state) =>
      Object.values(state.tasks).some(
        (task) => task.owner === owner && task.agentId === agentId && active(task),
      ),
    );
  }

  /** 登记任务（staged）：按 messageId 幂等；同智能体已有活动任务抛 LOCAL_BUSY；companion/native 分别校验可用性。 */
  stage(
    owner: string,
    agentId: string,
    provider: LocalAgentProvider,
    messageId: string,
    prompt: string,
    kind: 'run' | 'login' = 'run',
    inputSettings?: NativeAgentConfiguration,
    research?: { scope: ResearchToolScope; bundle: ResearchToolBundle },
  ): Promise<AgentTask> {
    const agentSettings = parseNativeAgentConfiguration(inputSettings);
    return this.access(true, (state) => {
      const existing = Object.values(state.tasks).find(
        (task) => task.owner === owner && task.messageId === messageId,
      );
      if (existing) return existing;
      if (
        Object.values(state.tasks).some(
          (task) => task.owner === owner && task.agentId === agentId && active(task),
        )
      )
        fail('LOCAL_BUSY');
      const device = agentId.startsWith('companion-')
        ? state.devices.find((item) => item.owner === owner)
        : undefined;
      if (agentId.startsWith('companion-')) {
        if (!device || Date.now() - device.lastSeen > 15_000) fail('LOCAL_COMPANION_OFFLINE');
        if (!device!.agents.some((agent) => agent.provider === provider))
          fail('LOCAL_VERSION_UNSUPPORTED');
        if (kind === 'run' && !device!.providers.includes(provider)) fail('LOCAL_AGENT_NOT_FOUND');
        validateNativeAgentConfiguration(
          agentSettings,
          device?.agents.find((agent) => agent.provider === provider),
        );
      } else if (
        state.nativeOwner !== owner ||
        (kind === 'run' && !state.nativeProviders.includes(provider))
      )
        fail('LOCAL_AGENT_NOT_FOUND');
      const task: AgentTask = {
        id: randomUUID(),
        owner,
        agentId,
        provider,
        deviceId: device?.id,
        kind,
        messageId,
        prompt,
        ...(agentSettings ? { agentSettings } : {}),
        ...(research ? { researchScope: research.scope, researchBundle: research.bundle } : {}),
        state: 'staged',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.tasks[task.id] = task;
      return task;
    });
  }
  /** staged → queued：onTask/onDispatch 回调成功后调用。 */
  activate(owner: string, id: string): Promise<void> {
    return this.access(true, (state) => {
      const task = ownedTask(state, owner, id);
      if (task.state === 'staged') {
        task.state = 'queued';
        task.updatedAt = Date.now();
      }
    });
  }
  /** 本机任务抢占执行权：queued 且无 deviceId 才返回 true 并置 running。 */
  takeNative(owner: string, id: string): Promise<boolean> {
    return this.access(true, (state) => {
      const task = ownedTask(state, owner, id);
      if (task.deviceId || task.state !== 'queued') return false;
      task.state = 'running';
      task.updatedAt = Date.now();
      return true;
    });
  }
  /** 更新任务状态/进度/结果：cancelling 期间的 completed 会被改写为 cancelled；非活动任务忽略。 */
  update(
    owner: string,
    id: string,
    change: Partial<Pick<AgentTask, 'state' | 'progress' | 'text' | 'usageTokens' | 'error'>>,
  ): Promise<void> {
    return this.access(true, (state) => {
      const task = ownedTask(state, owner, id);
      if (recordLateUncertainty(task, change)) return;
      if (!active(task)) return;
      if (task.state === 'cancelling' && change.state === 'completed') {
        Object.assign(task, {
          state: 'cancelled',
          error: 'LOCAL_CANCELLED',
          updatedAt: Date.now(),
        });
      } else Object.assign(task, change, { updatedAt: Date.now() });
    });
  }
  /** 请求取消：已派发 → cancelling（LOCAL_PAUSED），未派发 → 直接 cancelled（LOCAL_CANCELLED）。 */
  cancel(owner: string, id: string): Promise<AgentTask['state']> {
    return this.access(true, (state) => {
      const task = ownedTask(state, owner, id);
      requestCancellation(task);
      return task.state;
    });
  }

  /** 追加研究活动事件（经 research-journal 校验/脱敏）。 */
  appendEvents(owner: string, id: string, events: ResearchActivity[]): Promise<void> {
    return this.access(true, (state) => appendResearchEvents(ownedTask(state, owner, id), events));
  }

  /** 按会话聚合任务事件（最近 2048 条，按任务创建时间排序）。 */
  eventsForSession(owner: string, sessionId: string): Promise<ResearchEventPage> {
    return this.access(false, (state) => {
      const tasks = Object.values(state.tasks)
        .filter((task) => task.owner === owner && task.researchScope?.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt);
      const events = tasks.flatMap((task) => task.events ?? []);
      return {
        events: events.slice(-2048),
        cursor: events.length,
        truncated: events.length > 2048 || tasks.some((task) => task.eventsTruncated),
      };
    });
  }

  /** 研究任务有效性断言：running + scope 未过期 + 未超 600s。 */
  private assertResearchTask(task: AgentTask): void {
    if (
      task.state !== 'running' ||
      !task.researchScope ||
      task.researchScope.expiresAt <= Date.now() ||
      Date.now() - task.createdAt > 600_000
    )
      fail('RESEARCH_TASK_INACTIVE');
  }

  /** companion 凭据校验：token 哈希 timingSafeEqual 匹配、设备 30s 内有心跳、任务归属该设备。 */
  companionTask(token: string, id: string): Promise<AgentTask> {
    return this.access(false, (state) => {
      const fingerprint = hash(token);
      const device = state.devices.find(
        (item) =>
          item.tokenHash.length === fingerprint.length &&
          timingSafeEqual(Buffer.from(item.tokenHash), Buffer.from(fingerprint)),
      );
      if (!device || Date.now() - device.lastSeen >= 30_000)
        return fail('LOCAL_COMPANION_UNAUTHORIZED');
      const task = ownedTask(state, device.owner, id);
      if (task.deviceId !== device.id) return fail('LOCAL_TASK_NOT_FOUND');
      this.assertResearchTask(task);
      return task;
    });
  }

  /** 研究工具调用认领：幂等（同 callId 同指纹复用）、冲突拒绝、取消登记检查、每任务 ≤24 次调用。 */
  beginToolCall(
    owner: string,
    id: string,
    request: ResearchToolRequest,
  ): Promise<{ run: boolean; result?: ResearchToolResult }> {
    return this.access(true, (state) => {
      const task = ownedTask(state, owner, id);
      this.assertResearchTask(task);
      if (
        !/^[A-Za-z0-9_.:-]{1,128}$/u.test(request.callId) ||
        !/^[a-z_]{1,80}$/u.test(request.name) ||
        !request.arguments ||
        typeof request.arguments !== 'object' ||
        Array.isArray(request.arguments) ||
        Buffer.byteLength(JSON.stringify(request.arguments)) > 4096
      )
        fail('RESEARCH_INVALID_CALL');
      const fingerprint = hash(
        JSON.stringify([
          request.name,
          Object.entries(request.arguments).sort(([a], [b]) => a.localeCompare(b)),
        ]),
      );
      const calls = (task.toolCalls ??= {});
      const existing = Object.hasOwn(calls, request.callId) ? calls[request.callId] : undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('RESEARCH_CALL_CONFLICT');
        return {
          run: false,
          result: existing.result ?? {
            status: 'failed',
            data: { message: 'Prior call completion is unknown; it was not retried.' },
            sources: [],
            asOf: new Date().toISOString(),
            truncated: false,
            errorCode: 'RESEARCH_CALL_UNCERTAIN',
          },
        };
      }
      if (task.cancelledToolCallIds?.includes(request.callId)) {
        return { run: false, result: researchFailure('cancelled', 'RESEARCH_CALL_CANCELLED') };
      }
      if (Object.keys(calls).length >= 24) fail('RESEARCH_TASK_LIMIT');
      Object.defineProperty(calls, request.callId, {
        value: { fingerprint },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return { run: true };
    });
  }

  /** 登记研究工具取消：早于原始认领到达时也写入占位结果；每任务 ≤128 次。 */
  cancelToolCall(owner: string, id: string, callId: string): Promise<boolean> {
    return this.access(true, (state) => {
      const task = ownedTask(state, owner, id);
      this.assertResearchTask(task);
      if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(callId)) fail('RESEARCH_INVALID_CALL');
      const entry =
        task.toolCalls && Object.hasOwn(task.toolCalls, callId)
          ? task.toolCalls[callId]
          : undefined;
      if (entry?.result) return entry.result.status === 'cancelled';
      const cancelled = (task.cancelledToolCallIds ??= []);
      if (cancelled.includes(callId)) return true;
      if (cancelled.length >= 128) fail('RESEARCH_TASK_LIMIT');
      cancelled.push(callId);
      // 取消请求可能先于原始 HTTP 请求认领该 ID 到达。
      if (entry) entry.result = researchFailure('cancelled', 'RESEARCH_CALL_CANCELLED', true);
      return true;
    });
  }

  /** 落定研究工具调用结果：首个写入者生效（早到的取消结果优先保留）。 */
  finishToolCall(
    owner: string,
    id: string,
    callId: string,
    result: ResearchToolResult,
  ): Promise<ResearchToolResult> {
    return this.access(true, (state) => {
      const task = ownedTask(state, owner, id);
      const entry =
        task.toolCalls && Object.hasOwn(task.toolCalls, callId)
          ? task.toolCalls[callId]
          : undefined;
      if (entry && !entry.result) entry.result = result;
      return entry?.result ?? result;
    });
  }

  /** companion 心跳：凭据校验 → 回收超时/断线任务 → 接收状态与事件 → 下发待取消列表与排队命令。 */
  poll(token: string, request: CompanionPoll): Promise<CompanionPollResult> {
    return this.access(true, (state) => {
      const tokenHash = hash(token);
      const device = state.devices.find(
        (item) =>
          item.tokenHash.length === tokenHash.length &&
          timingSafeEqual(Buffer.from(item.tokenHash), Buffer.from(tokenHash)),
      );
      if (!device) return fail('LOCAL_COMPANION_UNAUTHORIZED');
      const now = Date.now();
      // 已失效的租约绝不会因迟到的结果或轮询而复活。
      for (const task of Object.values(state.tasks))
        if (
          task.deviceId === device.id &&
          active(task) &&
          (now - task.createdAt > 600_000 ||
            (['running', 'cancelling'].includes(task.state) && now - device.lastSeen > 30_000))
        ) {
          task.state = 'failed';
          task.error = 'LOCAL_INTERRUPTED';
          task.updatedAt = now;
        }
      device.lastSeen = now;
      device.agents = request.agents;
      for (const update of request.updates) {
        const task = state.tasks[update.id];
        if (!task || task.deviceId !== device.id || task.owner !== device.owner) continue;
        if (recordLateUncertainty(task, update)) continue;
        if (!['running', 'cancelling'].includes(task.state)) continue;
        appendResearchEvents(task, update.events ?? []);
        if (task.state === 'cancelling' && update.state === 'running') continue;
        if (task.state === 'cancelling' && update.state === 'completed') {
          task.state = 'cancelled';
          task.error = 'LOCAL_CANCELLED';
        } else if (update.state === 'completed' && task.kind === 'run' && !update.text?.trim()) {
          task.state = 'failed';
          task.error = 'LOCAL_INVALID_RESULT';
        } else {
          task.state = update.state;
          if (update.progress !== undefined) task.progress = update.progress.slice(0, 500);
          if (update.text !== undefined) task.text = update.text;
          if (update.usageTokens !== undefined) task.usageTokens = update.usageTokens;
          if (update.state === 'failed') task.error = update.error ?? 'LOCAL_TASK_FAILED';
          if (update.state === 'cancelled') task.error = 'LOCAL_CANCELLED';
        }
        task.updatedAt = now;
      }
      const commands: CompanionPollResult['commands'] = [];
      const cancelTaskIds: string[] = [];
      for (const task of Object.values(state.tasks))
        if (task.deviceId === device.id) {
          // companion 会在 30s 内终止断线任务、10 分钟内终止全部任务；
          // 旧的终态记录不能让心跳载荷无限增长。
          if (
            ['cancelling', 'cancelled', 'failed'].includes(task.state) &&
            now - task.updatedAt <= 600_000
          )
            cancelTaskIds.push(task.id);
          if (task.state === 'queued') {
            if (!device.agents.some((agent) => agent.provider === task.provider)) {
              task.state = 'failed';
              task.error = 'LOCAL_VERSION_UNSUPPORTED';
              task.updatedAt = now;
              continue;
            }
            try {
              validateNativeAgentConfiguration(
                task.agentSettings,
                device.agents.find((agent) => agent.provider === task.provider),
              );
            } catch {
              task.state = 'failed';
              task.error = 'LOCAL_CONFIGURATION_UNSUPPORTED';
              task.updatedAt = now;
              continue;
            }
            task.state = 'running';
            task.updatedAt = now;
            commands.push({
              id: task.id,
              kind: task.kind,
              provider: task.provider,
              ...(task.researchBundle ? { researchTools: task.researchBundle } : {}),
              ...(task.kind === 'run'
                ? {
                    prompt: task.prompt,
                    ...(task.agentSettings ? { agentSettings: task.agentSettings } : {}),
                  }
                : {}),
            });
          }
        }
      return { commands, cancelTaskIds: cancelTaskIds.slice(-1000) };
    });
  }
}
