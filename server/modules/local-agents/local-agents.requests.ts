import { z } from 'zod';
import { COMPANION_FAILURE_CODES, LOCAL_AGENT_PROVIDERS, type CompanionPoll, type LocalAgentProvider, type NativeAgentConfiguration,
  type NativeAgentStatus } from '../../../shared/local-agents.interface';
import { providerCatalog } from '../../../shared/local-agent-catalog';
import { LocalAgentError } from './local-agents.types';
import { nativeImageCapability } from '../../local-agents/native-image';

export { providerCatalog };
const provider = z.enum(LOCAL_AGENT_PROVIDERS);
const configurationText = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001f\u007f]*$/u).trim().min(1);
const reasoningEfforts = z.array(configurationText(32)).max(16).refine((items) => new Set(items).size === items.length);
const configuration = z.object({ model: configurationText(160).optional(), reasoningEffort: configurationText(32).optional() }).strict();
export function parseNativeAgentConfiguration(input: unknown): NativeAgentConfiguration | undefined {
  if (input === undefined) return undefined;
  const result = configuration.safeParse(input);
  if (!result.success) throw new LocalAgentError('LOCAL_INVALID_CONFIGURATION');
  return result.data.model || result.data.reasoningEffort ? result.data : undefined;
}
export function validateNativeAgentConfiguration(input: unknown, status?: NativeAgentStatus): NativeAgentConfiguration | undefined {
  const settings = parseNativeAgentConfiguration(input);
  if (!settings) return undefined;
  // Presence of the model list advertises manual model overrides; an empty list
  // means discovery found no suggestions, not that all model identifiers are invalid.
  const efforts = status?.models?.find((model) => model.id === settings.model)?.reasoningEfforts ?? status?.reasoningEfforts;
  if (settings.model && !status?.models || settings.reasoningEffort && !efforts?.includes(settings.reasoningEffort)) {
    throw new LocalAgentError('LOCAL_CONFIGURATION_UNSUPPORTED');
  }
  return settings;
}
export const pairRequest = z.object({ code: z.string().regex(/^[a-f0-9]{48}$/u), name: z.string().trim().min(1).max(80) }).strict();
export const researchToolRequest = z.object({ taskId: z.string().uuid(), callId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u),
  name: z.string().regex(/^[a-z_]{1,80}$/u), arguments: z.record(z.string(), z.unknown()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 4096),
}).strict();
export const researchToolCancelRequest = researchToolRequest.pick({ taskId: true, callId: true });
const activity = z.object({ id: z.string().min(1).max(128), kind: z.enum(['task', 'tool', 'summary', 'capability']),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'unavailable']),
  at: z.string().max(40).refine(value => Number.isFinite(Date.parse(value))), summary: z.string().max(2000),
  toolName: z.string().max(101).optional(), callId: z.string().max(128).optional(), durationMs: z.number().finite().min(0).max(600_000).optional(),
  sources: z.array(z.object({ title: z.string().max(160), url: z.string().max(2048).optional(), fetchedAt: z.string().max(40) }).strict()).max(8).optional(),
}).strict();
const diagnostic = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u), stage: z.enum(['preflight', 'process', 'output', 'result']),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  at: z.string().max(40).refine(value => Number.isFinite(Date.parse(value))), code: z.enum(COMPANION_FAILURE_CODES).optional(),
  exitCode: z.number().int().min(-2147483648).max(4294967295).optional(), outputBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  stderrBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), terminalEvent: z.boolean().optional(),
}).strict();
const failure = z.object({ code: z.enum(COMPANION_FAILURE_CODES), stage: z.enum(['preflight', 'dispatch', 'runtime', 'parse']),
  fieldPath: z.string().max(160).regex(/^[A-Za-z0-9_. ()–-]+$/u).optional(),
  expectedType: z.string().max(120).regex(/^[A-Za-z0-9_. ()–-]+$/u).optional(), actualType: z.string().max(80).regex(/^[A-Za-z0-9_. ()–-]+$/u).optional(),
  exitCode: z.number().int().min(-2147483648).max(4294967295).optional(), outputBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  stderrBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), terminalEvent: z.boolean().optional(),
  recoveries: z.array(z.enum(['check_existing', 'reparse_existing', 'retry_member', 'fix_configuration'])).max(4),
}).strict();
const pollRequest = z.object({
  agents: z.array(z.object({ provider, state: z.enum(['not_installed', 'login_required', 'ready', 'error']), version: z.string().max(120).optional(),
    imageInput: z.boolean().optional(),
    researchTools: z.object({ mode: z.enum(['mcp', 'snapshot']), reason: z.enum(['supported', 'version_unsupported', 'runtime_unsupported']) }).strict().optional(),
    models: z.array(z.object({ id: configurationText(160), name: configurationText(160), reasoningEfforts: reasoningEfforts.optional() }).strict())
      .max(256).refine((models) => new Set(models.map((model) => model.id)).size === models.length).optional(),
    reasoningEfforts: reasoningEfforts.optional(), configurationHelp: z.string().max(1000).optional(),
  })).max(LOCAL_AGENT_PROVIDERS.length),
  updates: z.array(z.object({ id: z.string().uuid(), state: z.enum(['running', 'completed', 'failed', 'cancelled']),
    events: z.array(activity).max(64).optional(),
    diagnostics: z.array(diagnostic).max(64).optional(), diagnosticsTruncated: z.boolean().optional(), eventsTruncated: z.boolean().optional(),
    activityCapability: z.enum(['tools', 'starts_only', 'phases', 'none']).optional(),
    failure: failure.optional(), error: z.enum(COMPANION_FAILURE_CODES).optional(),
    progress: z.string().max(500).optional(), text: z.string().max(512_000).refine((value) => Buffer.byteLength(value) <= 512_000).optional(),
    usageTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional() }).strict()).max(16),
}).strict();
export function parseCompanionPoll(input: unknown): CompanionPoll {
  const value = pollRequest.parse(input);
  if (new Set(value.agents.map((agent) => agent.provider)).size !== value.agents.length) throw new Error('Duplicate provider');
  return { ...value, agents: value.agents.map((agent) => ({ ...providerCatalog[agent.provider], ...agent,
    imageInput: agent.imageInput === true && nativeImageCapability(agent.provider) })) };
}
export function providerFromId(id: string, mode: 'native' | 'companion'): LocalAgentProvider {
  const parsed = provider.safeParse(id.startsWith(`${mode}-`) ? id.slice(mode.length + 1) : undefined);
  if (!parsed.success) throw new Error('LOCAL_AGENT_NOT_FOUND');
  return parsed.data;
}
