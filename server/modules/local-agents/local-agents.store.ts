import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompanionPoll, CompanionPollResult, LocalAgentProvider, NativeAgentStatus } from '../../../shared/local-agents.interface';
import { LocalAgentError } from './local-agents.types';

export interface AgentTask {
  id: string; owner: string; agentId: string; provider: LocalAgentProvider;
  deviceId?: string; kind: 'run' | 'login'; messageId: string; prompt: string;
  state: 'staged' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number; updatedAt: number; progress?: string; text?: string;
  usageTokens?: number | null; error?: string;
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
const active = (task: AgentTask) => ['staged', 'queued', 'running'].includes(task.state);
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
  constructor(readonly root: string) {}

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
        task.state = 'failed'; task.error = 'LOCAL_INTERRUPTED'; task.updatedAt = Date.now();
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
      task.state = 'cancelled'; task.error = 'LOCAL_CANCELLED'; task.updatedAt = Date.now();
    }
  }
  revoke(owner: string): Promise<void> { return this.access(true, (state) => this.revokeIn(state, owner)); }
  deviceFor(owner: string): Promise<AgentDevice | undefined> { return this.access(false, (state) => state.devices.find((device) => device.owner === owner)); }
  nativeProviders(owner: string): Promise<LocalAgentProvider[]> {
    return this.access(false, (state) => state.nativeOwner === owner ? state.nativeProviders : []);
  }
  nativeClaimedByOther(owner: string): Promise<boolean> { return this.access(false, (state) => !!state.nativeOwner && state.nativeOwner !== owner); }
  claimNative(owner: string): Promise<void> {
    return this.access(true, (state) => {
      if (state.nativeOwner && state.nativeOwner !== owner) fail('LOCAL_AGENT_OWNED');
      state.nativeOwner = owner;
    });
  }
  connectNative(owner: string, provider: LocalAgentProvider): Promise<void> {
    return this.access(true, (state) => {
      if (state.nativeOwner && state.nativeOwner !== owner) fail('LOCAL_AGENT_OWNED');
      state.nativeOwner = owner;
      if (!state.nativeProviders.includes(provider)) state.nativeProviders.push(provider);
    });
  }
  disconnectNative(owner: string, provider: LocalAgentProvider): Promise<void> {
    return this.access(true, (state) => {
      if (state.nativeOwner !== owner) fail('LOCAL_AGENT_OWNED');
      state.nativeProviders = state.nativeProviders.filter((id) => id !== provider);
      this.cancelProvider(state, owner, `native-${provider}`);
      if (!state.nativeProviders.length) delete state.nativeOwner;
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
  private cancelProvider(state: State, owner: string, agentId: string): void {
    for (const task of Object.values(state.tasks)) if (task.owner === owner && task.agentId === agentId && active(task)) {
      task.state = 'cancelled'; task.error = 'LOCAL_CANCELLED'; task.updatedAt = Date.now();
    }
  }
  findMessage(owner: string, messageId: string): Promise<AgentTask | undefined> {
    return this.access(false, (state) => Object.values(state.tasks).find((task) => task.owner === owner && task.messageId === messageId));
  }
  task(owner: string, id: string): Promise<AgentTask> { return this.access(false, (state) => ownedTask(state, owner, id)); }
  busy(owner: string, agentId: string): Promise<boolean> { return this.access(false, (state) => Object.values(state.tasks).some((task) => task.owner === owner && task.agentId === agentId && active(task))); }

  stage(owner: string, agentId: string, provider: LocalAgentProvider, messageId: string, prompt: string, kind: 'run' | 'login' = 'run'): Promise<AgentTask> {
    return this.access(true, (state) => {
      const existing = Object.values(state.tasks).find((task) => task.owner === owner && task.messageId === messageId);
      if (existing) return existing;
      if (Object.values(state.tasks).some((task) => task.owner === owner && task.agentId === agentId && active(task))) fail('LOCAL_BUSY');
      const device = agentId.startsWith('companion-') ? state.devices.find((item) => item.owner === owner) : undefined;
      if (agentId.startsWith('companion-')) {
        if (!device || Date.now() - device.lastSeen > 15_000) fail('LOCAL_COMPANION_OFFLINE');
        if (kind === 'run' && !device!.providers.includes(provider)) fail('LOCAL_AGENT_NOT_FOUND');
      } else if (state.nativeOwner !== owner || (kind === 'run' && !state.nativeProviders.includes(provider))) fail('LOCAL_AGENT_NOT_FOUND');
      const task: AgentTask = { id: randomUUID(), owner, agentId, provider, deviceId: device?.id, kind, messageId, prompt,
        state: 'staged', createdAt: Date.now(), updatedAt: Date.now() };
      state.tasks[task.id] = task;
      return task;
    });
  }
  activate(owner: string, id: string): Promise<void> {
    return this.access(true, (state) => { const task = ownedTask(state, owner, id); if (task.state === 'staged') { task.state = 'queued'; task.updatedAt = Date.now(); } });
  }
  takeNative(owner: string, id: string): Promise<boolean> {
    return this.access(true, (state) => {
      const task = ownedTask(state, owner, id);
      if (task.deviceId || task.state !== 'queued') return false;
      task.state = 'running'; task.updatedAt = Date.now(); return true;
    });
  }
  update(owner: string, id: string, change: Partial<Pick<AgentTask, 'state' | 'progress' | 'text' | 'usageTokens' | 'error'>>): Promise<void> {
    return this.access(true, (state) => { const task = ownedTask(state, owner, id); if (active(task)) Object.assign(task, change, { updatedAt: Date.now() }); });
  }
  cancel(owner: string, id: string): Promise<void> { return this.update(owner, id, { state: 'cancelled', error: 'LOCAL_CANCELLED' }); }

  poll(token: string, request: CompanionPoll): Promise<CompanionPollResult> {
    return this.access(true, (state) => {
      const tokenHash = hash(token);
      const device = state.devices.find((item) => item.tokenHash.length === tokenHash.length && timingSafeEqual(Buffer.from(item.tokenHash), Buffer.from(tokenHash)));
      if (!device) return fail('LOCAL_COMPANION_UNAUTHORIZED');
      const now = Date.now();
      // A lost lease is never revived by a late result or poll.
      for (const task of Object.values(state.tasks)) if (task.deviceId === device.id && active(task)
        && (now - task.createdAt > 600_000 || (task.state === 'running' && now - device.lastSeen > 30_000))) {
        task.state = 'failed'; task.error = 'LOCAL_INTERRUPTED'; task.updatedAt = now;
      }
      device.lastSeen = now; device.agents = request.agents;
      for (const update of request.updates) {
        const task = state.tasks[update.id];
        if (!task || task.deviceId !== device.id || task.owner !== device.owner || task.state !== 'running') continue;
        if (update.state === 'completed' && task.kind === 'run' && !update.text?.trim()) {
          task.state = 'failed'; task.error = 'LOCAL_INVALID_RESULT';
        } else {
          task.state = update.state;
          if (update.progress !== undefined) task.progress = update.progress.slice(0, 500);
          if (update.text !== undefined) task.text = update.text;
          if (update.usageTokens !== undefined) task.usageTokens = update.usageTokens;
          if (update.state === 'failed') task.error = 'LOCAL_TASK_FAILED';
          if (update.state === 'cancelled') task.error = 'LOCAL_CANCELLED';
        }
        task.updatedAt = now;
      }
      const commands: CompanionPollResult['commands'] = [];
      const cancelTaskIds: string[] = [];
      for (const task of Object.values(state.tasks)) if (task.deviceId === device.id) {
        // Helpers terminate disconnected work within 30s and all work within 10 minutes.
        // Old terminal records must not grow heartbeat payloads without bound.
        if (['cancelled', 'failed'].includes(task.state) && now - task.updatedAt <= 600_000) cancelTaskIds.push(task.id);
        if (task.state === 'queued') {
          task.state = 'running'; task.updatedAt = now;
          commands.push({ id: task.id, kind: task.kind, provider: task.provider, ...(task.kind === 'run' ? { prompt: task.prompt } : {}) });
        }
      }
      return { commands, cancelTaskIds: cancelTaskIds.slice(-1000) };
    });
  }
}
