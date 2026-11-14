import { AGENT_TEMPLATE_IDS } from '@shared/agent-roster.interface';
import type { AgentProfile, AgentTemplateId } from '@shared/agent-roster.interface';

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
