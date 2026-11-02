import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CouncilMember } from '@shared/council.interface';
import { fetchIntegrationSettings } from '@/api/settings';
import { fetchModelConnections } from '@/api/model-connections';
import { fetchLocalAgents, type LocalAgentConnection } from '@/api/local-agents';

export interface CouncilModelOption {
  value: string;
  label: string;
  model: CouncilMember['model'];
  connectionId?: string;
  disabled: boolean;
}

export function councilModelValue(member: Pick<CouncilMember, 'connectionId' | 'model'>): string {
  return `${member.connectionId || 'default'}:${member.model}`;
}

export function assignLocalAgents(members: CouncilMember[], agents: LocalAgentConnection[]): CouncilMember[] {
  const available = agents.filter(agent => agent.connected && agent.available);
  if (!available.length) return members;
  return members.map((member, index) => {
    const agentId = available[index % available.length].id;
    return { ...member, executionMode: 'local', agentId, connectionId: undefined,
      agentSettings: member.executionMode === 'local' && member.agentId === agentId ? member.agentSettings : undefined };
  });
}

export function useCouncilModels() {
  const { t } = useTranslation();
  const integration = useQuery({ queryKey: ['settings', 'integrations'], queryFn: fetchIntegrationSettings });
  const connections = useQuery({ queryKey: ['settings', 'model-connections'], queryFn: fetchModelConnections });
  const localAgents = useQuery({ queryKey: ['settings', 'local-agents'], queryFn: fetchLocalAgents });
  const options: CouncilModelOption[] = (['fast', 'slow'] as const).map((model) => ({
    value: `default:${model}`, model, disabled: false,
    label: [t('council.members.defaultConnection'), integration.data?.llm[model === 'fast' ? 'fastModel' : 'slowModel'],
      t(`council.members.modelTier.${model}`)].filter(Boolean).join(' · '),
  }));
  for (const connection of connections.data ?? []) {
    for (const model of ['fast', 'slow'] as const) options.push({
      value: `${connection.id}:${model}`, connectionId: connection.id, model,
      disabled: !connection.available || Boolean(connection.needsReentry),
      label: `${connection.name} · ${connection[model === 'fast' ? 'fastModel' : 'slowModel']} · ${t(`council.members.modelTier.${model}`)}${connection.available && !connection.needsReentry ? '' : ` (${t('council.members.unavailable')})`}`,
    });
  }
  const memberLabel = (member: CouncilMember): string => {
    if (member.executionMode !== 'local') return options.find(option => option.value === councilModelValue(member))?.label
      ?? t('council.members.connectionMissing');
    const agent = localAgents.data?.find(item => item.id === member.agentId);
    if (!agent) return t('council.localAgents.unavailable');
    const state = !agent.available ? agent.state === 'ready' ? 'offline' : agent.state : agent.busy ? 'busy' : null;
    const model = agent.models?.find(item => item.id === member.agentSettings?.model)?.name ?? member.agentSettings?.model;
    const effort = member.agentSettings?.reasoningEffort;
    return [t('council.localAgents.routeAgent'), agent.name, model,
      effort ? t(`council.localAgents.effortLevels.${effort}`, { defaultValue: effort }) : null,
      state ? t(`council.localAgents.states.${state}`) : null]
      .filter(Boolean).join(' · ');
  };
  return { options, localAgents: localAgents.data ?? [], memberLabel,
    loading: integration.isLoading || connections.isLoading || localAgents.isLoading,
    error: integration.error ?? connections.error ?? localAgents.error,
    refetch: () => { void integration.refetch(); void connections.refetch(); void localAgents.refetch(); } };
}
