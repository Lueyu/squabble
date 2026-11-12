import { createHash, randomUUID } from 'node:crypto';
import type { A2aCapabilities, A2aSkill, A2aTaskState } from '../../../shared/a2a-agents.interface';
import { ToolTransportPolicy, type RegisteredToolService } from '../tool-connections/tool-transport-policy';

type ObjectValue = Record<string, unknown>;
const record = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A2A_INVALID_OUTPUT');
  return value as ObjectValue;
};
const string = (value: unknown, max = 1000): string => {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new Error('A2A_INVALID_OUTPUT');
  return value;
};
export interface DiscoveredA2aCard {
  cardName: string; cardVersion: string; cardHash: string; interfaceUrl: string; tenant?: string;
  skills: A2aSkill[]; capabilities: A2aCapabilities;
}
export interface A2aProtocolOutput { state: A2aTaskState; remoteTaskId?: string; contextId?: string; text?: string; data?: unknown }

/** Separate explicit deployment registry: MCP grants never authorize an A2A destination. */
export function registeredA2aServices(): RegisteredToolService[] {
  if (!process.env.A2A_LOCAL_SERVICES_JSON) return [];
  const values: unknown = JSON.parse(process.env.A2A_LOCAL_SERVICES_JSON);
  if (!Array.isArray(values) || values.length > 40) throw new Error('A2A_INVALID_LOCAL_REGISTRY');
  return values.map(value => {
    const item = record(value), endpoint = new URL(string(item.endpoint, 500));
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('A2A_INVALID_LOCAL_REGISTRY');
    return { id: string(item.id, 100), endpoint: endpoint.href };
  });
}

/** Restricted v1 profile. No URL artifacts, redirects, callbacks, streaming, or arbitrary telemetry. */
export class A2aProtocolAdapter {
  constructor(readonly policy = new ToolTransportPolicy(registeredA2aServices())) {}
  parseCard(value: unknown, cardUrl: string): DiscoveredA2aCard {
    const card = record(value);
    if (!Array.isArray(card.supportedInterfaces)) throw new Error('A2A_VERSION_UNSUPPORTED');
    const selected = card.supportedInterfaces.map(record).find(item => item.protocolVersion === '1.0' && item.protocolBinding === 'JSONRPC');
    if (!selected) throw new Error('A2A_VERSION_UNSUPPORTED');
    const endpoint = new URL(string(selected.url, 500));
    if (endpoint.origin !== new URL(cardUrl).origin || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('A2A_ENDPOINT_RESTRICTED');
    const skills = Array.isArray(card.skills) ? card.skills.slice(0, 100).map(value => {
      const skill = record(value);
      return { id: string(skill.id, 200), name: string(skill.name, 200), description: typeof skill.description === 'string' ? skill.description.slice(0, 2000) : '' };
    }) : [];
    return { cardName: string(card.name, 200), cardVersion: string(card.version, 100),
      cardHash: createHash('sha256').update(JSON.stringify(value)).digest('hex'), interfaceUrl: endpoint.href,
      ...(typeof selected.tenant === 'string' && selected.tenant.length <= 200 ? { tenant: selected.tenant } : {}), skills,
      capabilities: { structuredOutput: Array.isArray(card.defaultOutputModes) && card.defaultOutputModes.includes('application/json'),
        structuredOutputVerified: false, toolsKnown: false, feesKnown: false } };
  }
  async discover(cardUrl: string, credential?: string): Promise<DiscoveredA2aCard> {
    const normalized = await this.policy.normalizeEndpoint(cardUrl);
    const response = await this.policy.fetch(normalized, { headers: { accept: 'application/json', 'A2A-Version': '1.0', ...(credential ? { authorization: 'Bearer ' + credential } : {}) }, signal: AbortSignal.timeout(15_000) }, normalized, 256_000);
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'A2A_AUTH_REQUIRED' : 'A2A_CARD_UNAVAILABLE');
    const card = this.parseCard(await response.json(), normalized);
    await this.policy.normalizeEndpoint(card.interfaceUrl);
    return card;
  }
  async rpc(endpoint: string, method: 'SendMessage' | 'GetTask' | 'CancelTask', params: unknown, credential?: string, timeoutMs = 30_000): Promise<unknown> {
    const id = randomUUID();
    const response = await this.policy.fetch(endpoint, { method: 'POST', headers: {
      accept: 'application/json', 'content-type': 'application/json', 'A2A-Version': '1.0', ...(credential ? { authorization: 'Bearer ' + credential } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, timeoutMs))) }, endpoint, 1_000_000);
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'A2A_AUTH_REQUIRED' : 'A2A_REMOTE_ERROR');
    // Return the envelope intact: the service encrypts it before protocol/output parsing.
    return { requestId: id, body: await response.text() };
  }
  unwrap(raw: unknown): unknown {
    const wire = raw && typeof raw === 'object' ? raw as ObjectValue : undefined;
    const envelope = record(wire && typeof wire.body === 'string' ? JSON.parse(wire.body) : typeof raw === 'string' ? JSON.parse(raw) : raw);
    if (envelope.jsonrpc !== '2.0') throw new Error('A2A_INVALID_OUTPUT');
    if (wire?.requestId && envelope.id !== wire.requestId) throw new Error('A2A_RESPONSE_MISMATCH');
    if (envelope.error) throw new Error('A2A_REMOTE_ERROR');
    return envelope.result;
  }
  isRemoteError(raw: unknown): boolean {
    const wire = record(raw);
    const envelope = record(typeof wire.body === 'string' ? JSON.parse(wire.body) : raw);
    if (wire.requestId && envelope.id !== wire.requestId) throw new Error('A2A_RESPONSE_MISMATCH');
    return Boolean(envelope.error);
  }
  output(raw: unknown, sendResult = false): A2aProtocolOutput {
    const result = record(raw);
    if (sendResult && result.message) {
      const message = record(result.message);
      if (message.role !== 'ROLE_AGENT') throw new Error('A2A_INVALID_OUTPUT');
      string(message.messageId, 200);
      const text = this.parts(message.parts);
      return { state: 'completed', text, ...this.json(text), contextId: string(message.contextId, 200) };
    }
    const task = sendResult ? record(result.task) : result;
    const remoteTaskId = string(task.id, 200), status = record(task.status);
    const states: Record<string, A2aTaskState> = { TASK_STATE_SUBMITTED: 'submitted', TASK_STATE_WORKING: 'working', TASK_STATE_COMPLETED: 'completed', TASK_STATE_FAILED: 'failed', TASK_STATE_CANCELED: 'cancelled', TASK_STATE_INPUT_REQUIRED: 'input_required', TASK_STATE_AUTH_REQUIRED: 'auth_required', TASK_STATE_REJECTED: 'rejected' };
    const state = typeof status.state === 'string' ? states[status.state] : undefined;
    if (!state) throw new Error('A2A_INVALID_OUTPUT');
    const base = { state, remoteTaskId, ...(typeof task.contextId === 'string' ? { contextId: string(task.contextId, 200) } : {}) };
    if (state !== 'completed') return base;
    if (!Array.isArray(task.artifacts) || !task.artifacts.length || task.artifacts.length > 30) throw new Error('A2A_INVALID_OUTPUT');
    const text = task.artifacts.map(value => this.parts(record(value).parts)).join('\n');
    return { ...base, text, ...this.json(text) };
  }
  private parts(value: unknown): string {
    if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error('A2A_INVALID_OUTPUT');
    const text = value.map(value => {
      const part = record(value);
      if (part.url !== undefined || part.raw !== undefined) throw new Error('A2A_INVALID_OUTPUT');
      if (typeof part.text === 'string' && part.data === undefined) return part.text;
      if (part.data !== undefined && part.text === undefined) return JSON.stringify(part.data);
      throw new Error('A2A_INVALID_OUTPUT');
    }).join('\n');
    if (!text.trim() || Buffer.byteLength(text) > 500_000) throw new Error('A2A_INVALID_OUTPUT');
    return text;
  }
  private json(text: string): { data?: unknown } {
    try { return { data: JSON.parse(text.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')) }; }
    catch { return {}; }
  }
}
