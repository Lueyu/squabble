import { AGENT_TEMPLATE_IDS } from '@shared/agent-roster.interface';
import type { AgentProfile, AgentTemplateId } from '@shared/agent-roster.interface';
import type { ModelConnection } from '@shared/model-connections.interface';
import { rosterTeamConfig } from './guided-team-state';
import type { TeamEditorState } from './team-graph';

/**
 * Pure staffing helpers shared by the roster page and the team canvas.
 * These functions never create agents, never touch permissions or sources, and never
 * call a model: they only recommend, and the UI always lets the user confirm candidates.
 */

export type RosterLike = {
  id: string;
  status: 'active' | 'archived';
  availability: 'configured' | 'unavailable';
  currentVersion: { config: { templateId: AgentTemplateId } };
};

/** Specialty ids actually owned by active, configured agents. */
export function ownedSpecialtyIds(agents: readonly RosterLike[], catalogIds: readonly AgentTemplateId[] = AGENT_TEMPLATE_IDS): Set<AgentTemplateId> {
  const owned = new Set<AgentTemplateId>();
  for (const agent of agents) {
    if (agent.status !== 'active' || agent.availability !== 'configured') continue;
    const id = agent.currentVersion?.config?.templateId;
    if (id && catalogIds.includes(id)) owned.add(id);
  }
  return owned;
}

/** Specialty ids missing from the owned set, in catalog order. */
export function missingSpecialtyIds(agents: readonly RosterLike[], catalogIds: readonly AgentTemplateId[] = AGENT_TEMPLATE_IDS): AgentTemplateId[] {
  const owned = ownedSpecialtyIds(agents, catalogIds);
  return catalogIds.filter(id => !owned.has(id));
}

export interface StaffingSlot {
  roleId: string;
  recommendedTemplateId: AgentTemplateId;
  required: boolean;
}

export interface StaffingMatch {
  /** roleId -> agentId for auto-recommended seats (explicitly confirmed by the user before use). */
  assignments: Record<string, string>;
  /** Seats that stay open because no distinct active configured agent matched. */
  open: StaffingSlot[];
  /** Eligible candidate lists per seat, in roster order, so the UI can offer explicit choice. */
  candidates: Record<string, AgentProfile[]>;
}

/**
 * Assigns one distinct active, configured agent per slot in slot order. A single agent
 * identity can never fill two independent seats: once consumed it is removed from later
 * candidates. Missing matches leave the seat open; nothing is ever created here.
 */
export function matchStaffing(slots: readonly StaffingSlot[], agents: readonly AgentProfile[]): StaffingMatch {
  const used = new Set<string>();
  const assignments: Record<string, string> = {};
  const candidates: Record<string, AgentProfile[]> = {};
  const open: StaffingSlot[] = [];
  for (const slot of slots) {
    const eligible = agents.filter(agent =>
      agent.status === 'active'
      && agent.availability === 'configured'
      && agent.currentVersion.config.templateId === slot.recommendedTemplateId
      && !used.has(agent.id));
    candidates[slot.roleId] = eligible;
    const chosen = eligible[0];
    if (chosen) {
      assignments[slot.roleId] = chosen.id;
      used.add(chosen.id);
    } else {
      open.push(slot);
    }
  }
  return { assignments, open, candidates };
}

type StaffingFailureCode = 'read_only' | 'role_missing' | 'agent_missing' | 'agent_archived' | 'agent_unavailable' | 'connection_unavailable';

export class TeamStaffingError extends Error {
  constructor(public readonly code: StaffingFailureCode) {
    super(code);
    this.name = 'TeamStaffingError';
  }
}

/** Both explicit assignment and canvas drop use the same existing roster binding rules. */
export function assignAgentToRole(state: TeamEditorState, roleId: string, agentId: string, agents: readonly AgentProfile[], models: ModelConnection[], options: { readOnly?: boolean } = {}): TeamEditorState {
  if (options.readOnly) throw new TeamStaffingError('read_only');
  const role = state.config.roles.find(item => item.id === roleId);
  if (!role) throw new TeamStaffingError('role_missing');
  const agent = agents.find(item => item.id === agentId);
  if (!agent) throw new TeamStaffingError('agent_missing');
  if (agent.status !== 'active') throw new TeamStaffingError('agent_archived');
  if (agent.availability !== 'configured') throw new TeamStaffingError('agent_unavailable');
  let binding;
  try {
    binding = rosterTeamConfig([agent], models, [roleId]).roles[0];
  } catch {
    throw new TeamStaffingError('connection_unavailable');
  }
  const assigned = { ...role, agentId: binding.agentId, agentVersionId: binding.agentVersionId, executor: binding.executor, allowedToolIds: binding.allowedToolIds, participation: binding.participation };
  return { ...state, config: { ...state.config, roles: state.config.roles.map(item => item.id === roleId ? assigned : item) } };
}

export function staffingFailureMessage(error: unknown, zh: boolean): string {
  const code = error instanceof TeamStaffingError ? error.code : 'connection_unavailable';
  const messages: Record<StaffingFailureCode, [string, string]> = {
    read_only: ['当前团队只读，不能指派股友。', 'This team is read-only; agents cannot be assigned.'],
    role_missing: ['请先选择一个现有岗位，再指派股友。', 'Select an existing seat before assigning an agent.'],
    agent_missing: ['这位股友已不在当前名单中，请刷新后重试。', 'This agent is no longer in the current roster. Refresh and try again.'],
    agent_archived: ['这位股友已归档，不能指派到岗位。', 'This agent is archived and cannot be assigned.'],
    agent_unavailable: ['这位股友的连接待配置，请先在股友库设置连接。', 'This agent needs a connection. Configure it in the friend roster first.'],
    connection_unavailable: ['这位股友的已保存连接不可用，请先修复连接后再指派。', 'This agent’s saved connection is unavailable. Restore it before assigning.'],
  };
  return messages[code][zh ? 0 : 1];
}
