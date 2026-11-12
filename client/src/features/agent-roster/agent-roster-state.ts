import type { AgentExecutor, AgentProfile, AgentSelection } from '@shared/agent-roster.interface';
import type { ModelConnection } from '@shared/model-connections.interface';
import type { LocalAgentConnection } from '@shared/local-agents.interface';

export function defaultAgentExecutor(models: ModelConnection[], locals: LocalAgentConnection[]): AgentExecutor | null {
  const model = models.find(row => row.available && (row.fastModel || row.slowModel));
  if (model) return { executionMode: 'model', connectionId: model.id, model: model.fastModel ? 'fast' : 'slow' };
  const local = locals.find(row => row.available && row.connected);
  return local ? { executionMode: 'local', localAgentId: local.id } : null;
}

export function activeAgentSelections(profiles: AgentProfile[]): AgentSelection[] {
  return profiles.filter(row => row.status === 'active').map(row => ({ agentId: row.id, agentVersionId: row.currentVersionId }));
}
