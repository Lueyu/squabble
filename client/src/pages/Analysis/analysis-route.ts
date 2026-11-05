import type { ModelRoute } from '@shared/model-route.interface';
import type { NativeAgentConfiguration } from '@shared/local-agents.interface';
import type { LocalAgentConnection } from '@/api/local-agents';
import { agentSettingsProblem, cleanAgentSettings } from '@/utils/local-agent-settings';

export type AnalysisRouteChoice = 'default' | 'basic' | 'api' | 'local';
export type AnalysisRouteProblem = 'apiUnavailable' | 'agentMissing' | 'agentUnavailable' | 'agentBusy'
  | 'modelInvalid' | 'modelUnsupported' | 'reasoningInvalid';

export function analysisRouteOverride(
  choice: AnalysisRouteChoice, agentId: string, settings: NativeAgentConfiguration | undefined,
): ModelRoute | undefined {
  if (choice === 'default') return undefined;
  if (choice !== 'local') return { mode: choice };
  return { mode: 'local', agentId, agentSettings: cleanAgentSettings(settings) };
}

export function analysisRouteProblem(
  route: ModelRoute | undefined, agents: LocalAgentConnection[], apiReady: boolean,
): AnalysisRouteProblem | null {
  if (!route || route.mode === 'basic') return null;
  if (route.mode === 'api') return apiReady ? null : 'apiUnavailable';
  if (!route.agentId) return 'agentMissing';
  const agent = agents.find(item => item.id === route.agentId);
  if (!agent?.connected || !agent.available) return 'agentUnavailable';
  if (agent.busy) return 'agentBusy';
  return agentSettingsProblem(route.agentSettings, agent);
}
