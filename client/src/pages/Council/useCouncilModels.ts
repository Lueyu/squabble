/**
 * useCouncilModels.ts — 议会成员可用模型清单 hook：聚合默认连接 / 多连接 / 本地智能体三类来源。
 *
 * 职责边界：
 *  - CouncilModelOption 选项列表：默认 LLM（fast/slow 两档）+ 每条模型连接的 fast/slow +
 *    本地智能体清单（供成员执行方式选择）；
 *  - councilModelValue：成员的"连接:档位"选项值编解码（connectionId 缺省用 'default'）；
 *  - assignLocalAgents：把在线可用本地智能体轮转分配给成员（纯函数）；
 *  - memberLabel：把成员渲染成一行人类可读标签（远程走 options 匹配，本地走智能体明细）。
 * 上下游：
 *  - 上游（路由入口/谁引用）：CouncilMemberEditor、CouncilMembersSheet、CouncilNewDialog、
 *    CouncilTeamEditor。
 *  - 下游（调用哪些 hooks/api/组件）：useQuery×3（['settings','integrations'] /
 *    ['settings','model-connections'] / ['settings','local-agents']）+ fetchIntegrationSettings /
 *    fetchModelConnections / fetchLocalAgents。
 * 关键约定：
 *  - 选项 value 格式 `${connectionId||'default'}:${model}`，model 固定 'fast'|'slow' 两档；
 *  - 连接不可用（!available 或 needsReentry）的选项 disabled，label 追加"不可用"后缀；
 *  - memberLabel 对本地成员按 available/busy/state 归一为 offline/busy/原样，
 *    agent 找不到时回退 council.localAgents.unavailable。
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CouncilMember } from '@shared/council.interface';
import { fetchIntegrationSettings } from '@/api/settings';
import { fetchModelConnections } from '@/api/model-connections';
import { fetchLocalAgents, type LocalAgentConnection } from '@/api/local-agents';

// 单个模型选项：value=选项值；connectionId=来源连接（缺省连接为 undefined）；disabled=不可选
export interface CouncilModelOption {
  value: string;
  label: string;
  model: CouncilMember['model'];
  connectionId?: string;
  disabled: boolean;
}

/** 成员的选项值编码：远程成员为 `${connectionId||'default'}:${model}`。 */
export function councilModelValue(member: Pick<CouncilMember, 'connectionId' | 'model'>): string {
  return `${member.connectionId || 'default'}:${member.model}`;
}

/**
 * 把在线且可用的本地智能体轮转分配给全部成员：
 * 无可用智能体时原样返回；否则每个成员 executionMode='local'、agentId 轮转取值，
 * 且仅当成员本来就是本地且 agentId 未变时保留其 agentSettings（换了智能体则清空）。
 */
export function assignLocalAgents(
  members: CouncilMember[],
  agents: LocalAgentConnection[],
): CouncilMember[] {
  // 步骤 1：筛出在线且可用的智能体；没有则不动
  const available = agents.filter((agent) => agent.connected && agent.available);
  if (!available.length) return members;
  // 步骤 2：按索引轮转分配 agentId；agentId 变化的成员清掉旧 agentSettings
  return members.map((member, index) => {
    const agentId = available[index % available.length].id;
    return {
      ...member,
      executionMode: 'local',
      agentId,
      connectionId: undefined,
      agentSettings:
        member.executionMode === 'local' && member.agentId === agentId
          ? member.agentSettings
          : undefined,
    };
  });
}

export function useCouncilModels() {
  const { t } = useTranslation();
  // 三路数据源：集成配置（默认 LLM 快慢模型名）、模型连接、本地智能体
  const integration = useQuery({
    queryKey: ['settings', 'integrations'],
    queryFn: fetchIntegrationSettings,
  });
  const connections = useQuery({
    queryKey: ['settings', 'model-connections'],
    queryFn: fetchModelConnections,
  });
  const localAgents = useQuery({
    queryKey: ['settings', 'local-agents'],
    queryFn: fetchLocalAgents,
  });

  // 默认连接选项：fast/slow 两档，label=连接名·模型名·档位
  const options: CouncilModelOption[] = (['fast', 'slow'] as const).map((model) => ({
    value: `default:${model}`,
    model,
    disabled: false,
    label: [
      t('council.members.defaultConnection'),
      integration.data?.llm[model === 'fast' ? 'fastModel' : 'slowModel'],
      t(`council.members.modelTier.${model}`),
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  // 各模型连接选项：不可用（!available 或 needsReentry）时 disabled 并在 label 追加后缀
  for (const connection of connections.data ?? []) {
    for (const model of ['fast', 'slow'] as const)
      options.push({
        value: `${connection.id}:${model}`,
        connectionId: connection.id,
        model,
        disabled: !connection.available || Boolean(connection.needsReentry),
        label: `${connection.name} · ${connection[model === 'fast' ? 'fastModel' : 'slowModel']} · ${t(`council.members.modelTier.${model}`)}${connection.available && !connection.needsReentry ? '' : ` (${t('council.members.unavailable')})`}`,
      });
  }

  // 成员一行标签：远程成员在 options 里找 label，找不到提示连接缺失；
  // 本地成员拼路由智能体·名称·模型·思考档位·状态（offline/busy/原始 state）
  const memberLabel = (member: CouncilMember): string => {
    // 远程成员：按选项值匹配 label；匹配不到说明连接已被删除
    if (member.executionMode !== 'local')
      return (
        options.find((option) => option.value === councilModelValue(member))?.label ??
        t('council.members.connectionMissing')
      );
    // 本地成员：先找智能体本体
    const agent = localAgents.data?.find((item) => item.id === member.agentId);
    if (!agent) return t('council.localAgents.unavailable');
    // 状态归一：不可用→（ready 归为 offline，否则原样）；可用且忙→busy；否则 null
    const state = !agent.available
      ? agent.state === 'ready'
        ? 'offline'
        : agent.state
      : agent.busy
        ? 'busy'
        : null;
    // 模型名：优先 agent.models 里的可读名，回退成员设置的原始 id
    const model =
      agent.models?.find((item) => item.id === member.agentSettings?.model)?.name ??
      member.agentSettings?.model;
    const effort = member.agentSettings?.reasoningEffort;
    // 拼接：路由智能体 · 名称 · 模型 · 思考档位 · 状态
    return [
      t('council.localAgents.routeAgent'),
      agent.name,
      model,
      effort ? t(`council.localAgents.effortLevels.${effort}`, { defaultValue: effort }) : null,
      state ? t(`council.localAgents.states.${state}`) : null,
    ]
      .filter(Boolean)
      .join(' · ');
  };
  return {
    options,
    localAgents: localAgents.data ?? [],
    memberLabel,
    loading: integration.isLoading || connections.isLoading || localAgents.isLoading,
    error: integration.error ?? connections.error ?? localAgents.error,
    // refetch：三路数据一起重拉
    refetch: () => {
      void integration.refetch();
      void connections.refetch();
      void localAgents.refetch();
    },
  };
}
