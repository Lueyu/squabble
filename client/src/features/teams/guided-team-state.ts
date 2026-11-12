import type { AgentProfile } from '@shared/agent-roster.interface';
import type { ModelConnection } from '@shared/model-connections.interface';
import type { TeamExecutor, TeamSemanticConfig } from '@shared/team-workspace.interface';
import type { TeamRunBudget } from '@shared/team-run.interface';

export function rosterTeamConfig(agents: AgentProfile[], models: ModelConnection[], roleIds: string[]): TeamSemanticConfig {
  if (!agents.length || agents.length > 6 || agents.length !== roleIds.length || new Set(agents.map(a => a.id)).size !== agents.length || agents.some(a => a.status !== 'active' || a.availability === 'unavailable')) throw new Error('Choose 1–6 different active agents');
  const roles = agents.map((agent, index) => {
    const source = agent.currentVersion.config.executor;
    let executor: TeamExecutor;
    if (source.executionMode === 'model') {
      const model = models.find(row => row.id === source.connectionId && row.available);
      const name = source.model === 'slow' ? model?.slowModel : model?.fastModel;
      if (!model || !name) throw new Error('Restore the saved model connection before creating the team');
      executor = { executionMode: 'model', connectionId: model.id, model: name, tier: source.model, settings: {} };
    } else if (source.executionMode === 'local') executor = { executionMode: 'local', localAgentId: source.localAgentId, settings: { ...source.settings } };
    else executor = { executionMode: 'a2a', connectionId: source.connectionId };
    return { id: roleIds[index], departmentId: null, participation: 'enabled' as const, responsibility: agent.specialty.slice(0, 1000), expectedOutput: 'Evidence, judgment, uncertainty and a reasoned next step', executor, agentId: agent.id, agentVersionId: agent.currentVersionId, allowedToolIds: [...agent.currentVersion.config.allowedToolIds], sourceGrantIds: [] };
  });
  const leadIndex = agents.findIndex(a => a.currentVersion.config.templateId === 'moderator');
  return { schemaVersion: 1, departments: [], roles, relations: [], defaults: { leadRoleId: roles[leadIndex < 0 ? roles.length - 1 : leadIndex].id, parallelism: 1 } };
}

export function guidedRunBudget(daily: string, external: boolean, callLimit = 8): TeamRunBudget {
  const amount = Number(daily);
  if (!Number.isFinite(amount) || amount < 0.02 || amount > 1000) throw new Error('Enter a finite daily limit between USD 0.02 and 1000');
  if (!Number.isSafeInteger(callLimit) || callLimit < 2 || callLimit > 500) throw new Error('Invalid finite call limit');
  return { perRun: { budgetMode: external ? 'calls_only' : 'cost_and_calls', ceiling: { amount: (amount / 2).toFixed(2), currency: 'USD' }, callLimit, paidRevisionLimit: 0 }, daily: { costUsd: amount.toFixed(2), calls: callLimit * 2 }, monthly: { costUsd: (amount * 20).toFixed(2), calls: callLimit * 40 } };
}

/** Opening simulated inventory is sellable, and the reviewed copied cash total becomes available virtual cash. */
export function guidedSeedBlockers(needsInput: string[]): string[] {
  return needsInput.filter(code => !code.startsWith('SELLABILITY_UNKNOWN:') && !code.startsWith('CASH_AVAILABILITY_UNKNOWN:'));
}
