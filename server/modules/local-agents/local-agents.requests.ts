import { z } from 'zod';
import { LOCAL_AGENT_PROVIDERS, type CompanionPoll, type LocalAgentProvider, type NativeAgentConfiguration,
  type NativeAgentStatus } from '../../../shared/local-agents.interface';
import { providerCatalog } from '../../../shared/local-agent-catalog';
import { LocalAgentError } from './local-agents.types';

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
const pollRequest = z.object({
  agents: z.array(z.object({ provider, state: z.enum(['not_installed', 'login_required', 'ready', 'error']), version: z.string().max(120).optional(),
    models: z.array(z.object({ id: configurationText(160), name: configurationText(160), reasoningEfforts: reasoningEfforts.optional() }).strict())
      .max(256).refine((models) => new Set(models.map((model) => model.id)).size === models.length).optional(),
    reasoningEfforts: reasoningEfforts.optional(), configurationHelp: z.string().max(1000).optional(),
  })).max(LOCAL_AGENT_PROVIDERS.length),
  updates: z.array(z.object({ id: z.string().uuid(), state: z.enum(['running', 'completed', 'failed', 'cancelled']),
    error: z.enum(['LOCAL_INVALID_CONFIGURATION', 'LOCAL_CONFIGURATION_UNSUPPORTED', 'LOCAL_VERSION_UNSUPPORTED', 'LOCAL_LOGIN_REQUIRED', 'LOCAL_DISPATCH_UNCERTAIN']).optional(),
    progress: z.string().max(500).optional(), text: z.string().max(512_000).refine((value) => Buffer.byteLength(value) <= 512_000).optional(),
    usageTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional() }).strict()).max(16),
}).strict();
export function parseCompanionPoll(input: unknown): CompanionPoll {
  const value = pollRequest.parse(input);
  if (new Set(value.agents.map((agent) => agent.provider)).size !== value.agents.length) throw new Error('Duplicate provider');
  return { ...value, agents: value.agents.map((agent) => ({ ...providerCatalog[agent.provider], ...agent })) };
}
export function providerFromId(id: string, mode: 'native' | 'companion'): LocalAgentProvider {
  const parsed = provider.safeParse(id.startsWith(`${mode}-`) ? id.slice(mode.length + 1) : undefined);
  if (!parsed.success) throw new Error('LOCAL_AGENT_NOT_FOUND');
  return parsed.data;
}
