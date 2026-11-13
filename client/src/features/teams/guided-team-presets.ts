import type { AgentProfile, AgentTemplateId } from '@shared/agent-roster.interface';

/**
 * Member presets for the guided team creation flow. A preset names an ordered set
 * of agent template specialties; applying it selects the user's existing agents
 * that carry those specialties, so the user does not have to pick companions one
 * by one. Presets never create agents and never bypass the ready-connection
 * checks: they resolve against the ready agents the caller provides.
 */
export type GuidedPresetId = 'recommended' | 'valuation' | 'defensive' | 'full';

export interface GuidedTeamPreset {
  id: GuidedPresetId;
  /**
   * Ordered agent template specialties this preset selects. The order decides
   * the selected member order; a specialty never appears twice, and each agent
   * carries exactly one templateId, so resolution cannot pick a duplicate.
   */
  templateIds: readonly AgentTemplateId[];
  name: Record<'zh-CN' | 'en', string>;
  description: Record<'zh-CN' | 'en', string>;
}

/** The guided flow's implicit default: research, challenge and synthesis. */
export const GUIDED_RECOMMENDED_PRESET: GuidedTeamPreset = {
  id: 'recommended',
  templateIds: ['financials', 'bear', 'moderator'],
  name: { 'zh-CN': '推荐组合', en: 'Recommended' },
  description: { 'zh-CN': '财报研究 + 反方核查 + 主持收束', en: 'Financials + challenge + moderation' },
};

export const GUIDED_TEAM_PRESETS: readonly GuidedTeamPreset[] = [
  GUIDED_RECOMMENDED_PRESET,
  { id: 'valuation', templateIds: ['financials', 'valuation', 'moderator'], name: { 'zh-CN': '估值组合', en: 'Valuation' }, description: { 'zh-CN': '财报研究 + 估值核对 + 主持收束', en: 'Financials + valuation + moderation' } },
  { id: 'defensive', templateIds: ['bear', 'risk', 'moderator'], name: { 'zh-CN': '防守组合', en: 'Defensive' }, description: { 'zh-CN': '反方核查 + 风险复核 + 主持收束', en: 'Challenge + risk + moderation' } },
  { id: 'full', templateIds: ['financials', 'valuation', 'bear', 'moderator'], name: { 'zh-CN': '全面组合', en: 'Full research' }, description: { 'zh-CN': '四位成员：财报 + 估值 + 反方 + 主持', en: 'Four members: financials + valuation + challenge + moderation' } },
];

/**
 * Resolve a preset to concrete agents: the first ready agent carrying each
 * template specialty, in template order. Missing specialties are skipped so a
 * preset stays usable with an incomplete roster. The caller passes only
 * available agents, so the result is safe to select without further checks.
 */
export function resolveGuidedPresetMembers(preset: GuidedTeamPreset, readyAgents: readonly AgentProfile[]): AgentProfile[] {
  return preset.templateIds.flatMap(templateId => readyAgents.find(agent => agent.currentVersion.config.templateId === templateId) ?? []);
}

/**
 * Derive which preset the current selection matches, without persisting extra
 * state. A null selection is the not-yet-materialized implicit default, so it
 * reads as 'recommended'. Selection order does not matter; a selection that
 * matches no preset (including an empty one) reads as 'custom'. A preset that
 * resolves to no agent never matches, so it cannot capture an empty selection.
 */
export function activeGuidedPreset(selected: readonly string[] | null, readyAgents: readonly AgentProfile[]): GuidedPresetId | 'custom' {
  if (selected === null) return GUIDED_RECOMMENDED_PRESET.id;
  const selectedSet = new Set(selected);
  for (const preset of GUIDED_TEAM_PRESETS) {
    const members = resolveGuidedPresetMembers(preset, readyAgents);
    if (members.length > 0 && members.length === selectedSet.size && members.every(agent => selectedSet.has(agent.id))) return preset.id;
  }
  return 'custom';
}
