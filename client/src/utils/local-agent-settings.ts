import type { NativeAgentConfiguration, NativeAgentStatus } from '@shared/local-agents.interface';

export const AGENT_MODEL_MAX_LENGTH = 160;

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function agentReasoningEfforts(agent: NativeAgentStatus | undefined, model?: string): string[] | undefined {
  return agent?.models?.find(item => item.id === model?.trim())?.reasoningEfforts ?? agent?.reasoningEfforts;
}

export function agentSettingsProblem(
  settings: NativeAgentConfiguration | undefined, agent: NativeAgentStatus | undefined,
): 'modelInvalid' | 'modelUnsupported' | 'reasoningInvalid' | null {
  const model = settings?.model;
  if (model !== undefined && (model.length > AGENT_MODEL_MAX_LENGTH
    || hasControlCharacters(model))) return 'modelInvalid';
  if (model?.trim() && agent?.models === undefined) return 'modelUnsupported';
  const effort = settings?.reasoningEffort;
  if (effort && (effort.length > 32 || hasControlCharacters(effort)
    || !agentReasoningEfforts(agent, model)?.includes(effort))) return 'reasoningInvalid';
  return null;
}

export function cleanAgentSettings(settings?: NativeAgentConfiguration): NativeAgentConfiguration | undefined {
  const model = settings?.model?.trim();
  const reasoningEffort = settings?.reasoningEffort;
  return model || reasoningEffort ? { ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) } : undefined;
}
